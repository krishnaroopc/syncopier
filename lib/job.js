// Job orchestration: scan -> copy (batched) -> keep-both -> retry rounds.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  buildArgs,
  runRobocopy,
  scan,
  enumerateSource,
  isFailure,
  describeExit,
  createRateMeter,
  resourceFlags,
} from './robocopy.js';
import { resolveSelection } from './select.js';
import { preflight, createGovernor, dehydrate } from './onedrive.js';
import { createQueue, createErrorTracker, retryRounds } from './retry.js';
import { keepBothPass } from './keepboth.js';

export class Job {
  constructor(config, emit) {
    this.id = randomUUID().slice(0, 8);
    this.config = config;
    this.emit = emit;
    this.state = 'idle';
    this.child = null;
    this.cancelled = false;
    this.paused = false;

    this.totalBytes = 0;
    this.totalFiles = 0;
    this.copiedBytes = 0;
    this.copiedFiles = 0;
    this.currentFile = null;
    this.currentPercent = 0;
    this.startedAt = 0;

    this.meter = createRateMeter(5000);
    this.queue = createQueue(this.id);
    this.tracker = createErrorTracker(this.queue);
    this.keepBothResults = null;
    this.hydratedPaths = [];
    this.errorsSeen = 0;
    this.alreadyPresent = 0;
  }

  send(type, data = {}) {
    this.emit({ type, jobId: this.id, ...data });
  }

  stats() {
    const elapsed = this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
    const rate = this.meter.rate();
    const remaining = Math.max(0, this.totalBytes - this.copiedBytes);
    // Outstanding errors, not a running total: queue.resolve() removes an item
    // the moment a retry succeeds, so this figure falls back to 0 as problems
    // are cleared rather than only ever climbing.
    const outstanding = this.queue.size;
    return {
      totalBytes: this.totalBytes,
      totalFiles: this.totalFiles,
      copiedBytes: this.copiedBytes,
      copiedFiles: this.copiedFiles,
      percent: this.totalBytes ? Math.min(100, (this.copiedBytes / this.totalBytes) * 100) : 0,
      currentFile: this.currentFile,
      currentPercent: this.currentPercent,
      bytesPerSec: rate,
      etaSec: rate > 0 ? remaining / rate : null,
      elapsedSec: elapsed,
      deferred: outstanding,
      errors: outstanding,
      errorsTransient: this.queue.transient().length,
      errorsPermanent: this.queue.permanent().length,
      // Every failure ever seen, so "12 seen, 0 outstanding" is expressible.
      errorsSeen: this.errorsSeen,
      state: this.state,
    };
  }

  /** Scan + pre-flight only; nothing is copied. */
  async analyze() {
    this.state = 'scanning';
    this.send('state', { state: this.state });

    const cfg = this.config;
    const od = await preflight(cfg);
    if (od.oneDrive) cfg.oneDriveMode = true;

    // Source enumeration must ignore the destination: robocopy prints no line
    // for files already present identically, so a source->dest scan cannot tell
    // "absent" from "already copied" (the v1.0 false-missing bug).
    const selection = await resolveSelection(cfg, (globs) =>
      enumerateSource(cfg, { files: globs }),
    );

    let scanned;
    if (selection.mode === 'range') {
      // Reuse the enumeration already done by the range pipeline.
      scanned = {
        files: [],
        conflicts: [],
        totalBytes: selection.preview.bytes,
        totalFiles: selection.preview.matched,
      };
      // Conflict detection needs a real source->dest scan. Every batch must be
      // scanned: v1.0 looked at batches[0] only, so in a 7,001-file range
      // everything past the first ~200 names was invisible here.
      const wanted = new Set((selection.names ?? []).map((n) => n.toLowerCase()));
      const conflicts = [];
      for (const batch of selection.batches) {
        if (this.cancelled) break;
        const part = await scan(cfg, { files: batch });
        for (const c of part.conflicts) {
          if (wanted.has(String(c.path).split(/[\\/]/).pop().toLowerCase())) conflicts.push(c);
        }
      }
      scanned.conflicts = conflicts;
    } else {
      scanned = await scan(cfg, { files: selection.batches[0] });
    }

    // Files already at the destination are not re-copied under skip/keepboth,
    // so the progress denominator must exclude them or the bar never reaches
    // 100%.
    if (selection.mode === 'range' && cfg.conflict !== 'overwrite') {
      this.alreadyPresent = scanned.conflicts.length;
    }

    this.totalBytes = scanned.totalBytes;
    this.totalFiles = scanned.totalFiles;
    this.selection = selection;
    this.scanned = scanned;

    this.state = 'scanned';
    this.send('scan', {
      totalBytes: scanned.totalBytes,
      totalFiles: scanned.totalFiles,
      conflicts: scanned.conflicts.length,
      onedrive: od,
      selection: selection.preview
        ? { mode: selection.mode, ...selection.preview, globs: selection.globs }
        : { mode: selection.mode },
      flags: buildArgs(cfg, { files: selection.batches[0] }),
    });

    return { selection, onedrive: od, scanned };
  }

  async run() {
    try {
      const { selection, onedrive } = await this.analyze();

      if (onedrive.oneDrive && onedrive.willExceedDisk && !this.config.skipOnlineOnly) {
        this.state = 'blocked';
        this.send('blocked', {
          reason: 'Downloading the online-only files would fill the destination drive.',
          onedrive,
        });
        return;
      }

      if (this.config.dryRun) {
        this.state = 'done';
        this.send('done', { dryRun: true, ...this.stats() });
        return;
      }

      this.state = 'copying';
      this.startedAt = Date.now();
      this.send('state', { state: this.state });

      const governor = onedrive.oneDrive ? createGovernor({ maxThreads: 4 }) : null;
      const batches = selection.batches;

      for (let i = 0; i < batches.length; i++) {
        if (this.cancelled) break;
        this.send('batch', { index: i + 1, of: batches.length });
        await this.copyBatch(batches[i], governor);
      }

      // keep-both runs after the main pass, which skipped existing files.
      if (!this.cancelled && this.config.conflict === 'keepboth') {
        const conflicts = this.scanned.conflicts ?? [];
        if (conflicts.length) {
          this.state = 'keepboth';
          this.send('state', { state: this.state, conflicts: conflicts.length });
          this.keepBothResults = await keepBothPass(conflicts, this.config, {
            onEvent: (ev) => this.handleEvent(ev),
            shouldStop: () => this.cancelled,
            tracker: this.tracker,
          });
        }
      }

      // Deferred retries last, so the main copy is never blocked by them.
      if (!this.cancelled && this.queue.transient().length) {
        this.state = 'retrying';
        this.send('state', { state: this.state, deferred: this.queue.size });
        const res = await retryRounds(this.queue, this.config, {
          rounds: this.config.retryRounds ?? 3,
          onEvent: (ev) => {
            this.send('retry', ev);
            // Push fresh stats so the error counter drops as files recover.
            this.send('progress', this.stats());
          },
          shouldStop: () => this.cancelled,
        });
        this.send('retry-summary', {
          recovered: res.recovered.length,
          remaining: res.remaining.length,
        });
      }

      if (this.config.dehydrateAfter && this.hydratedPaths.length && !this.cancelled) {
        this.state = 'dehydrating';
        this.send('state', { state: this.state });
        const r = await dehydrate(this.hydratedPaths, {
          onProgress: (p) => this.send('dehydrate', p),
        });
        this.send('dehydrate-done', r);
      }

      await this.queue.flush();

      this.state = this.cancelled ? 'cancelled' : 'done';
      this.send('done', {
        ...this.stats(),
        cancelled: this.cancelled,
        // Only a genuinely empty queue counts as complete success.
        failed: this.queue.list(),
        keepBoth: this.keepBothResults,
        queueFile: this.queue.file,
      });
    } catch (err) {
      this.state = 'error';
      this.send('error', { message: err.message });
    }
  }

  async copyBatch(files, governor) {
    const cfg = { ...this.config };
    if (governor) {
      cfg.resourceLevel = undefined;
      cfg.oneDriveMode = true;
    }

    const args = buildArgs(cfg, { files });
    if (governor) {
      // Apply the governor's current thread count.
      const idx = args.findIndex((a) => a.startsWith('/MT:'));
      if (idx >= 0) args[idx] = `/MT:${governor.threads}`;
    }

    this.send('command', { args: [`robocopy`, ...args].join(' ') });

    const code = await runRobocopy(args, {
      // minimizeWindow is the UI's wording; false means "show the console".
      showWindow: this.config.minimizeWindow === false,
      onSpawn: (child) => {
        this.child = child;
      },
      onEvent: (ev, raw) => this.handleEvent(ev, raw, governor),
    });

    this.child = null;

    // Bytes are credited when the NEXT file line appears, so the last file of
    // each batch is still pending when robocopy exits. Flush it here or the
    // final count lands one short per batch.
    this.creditCurrentFile();

    if (isFailure(code)) {
      this.send('log', { text: `robocopy exit ${code}: ${describeExit(code)}` });
    }
    this.send('progress', this.stats());
    return code;
  }

  creditCurrentFile() {
    if (!this.currentFile) return;
    this.copiedBytes += this.currentFile.bytes;
    this.copiedFiles += 1;
    this.meter.add(this.currentFile.bytes);
    this.currentFile = null;
    this.currentPercent = 0;
  }

  handleEvent(ev, raw, governor) {
    switch (ev.type) {
      case 'file': {
        // Credit the previous file's bytes now that a new one has started.
        if (this.currentFile) {
          this.creditCurrentFile();
          governor?.recordSuccess();
        }
        this.currentFile = { path: ev.path, bytes: ev.bytes };
        this.currentPercent = 0;
        this.tracker.observe(ev);
        this.hydratedPaths.push(ev.path);
        break;
      }
      case 'percent':
        // Only meaningful at /MT:1 - with more threads the lines interleave
        // across files and cannot be attributed (finding 2).
        this.currentPercent = ev.percent;
        break;
      case 'error': {
        const item = this.tracker.observe(ev);
        this.errorsSeen += 1;
        const g = governor?.recordError();
        if (g?.changed) {
          this.send('governor', { threads: g.threads, direction: g.direction });
        }
        this.send('failure', {
          path: item?.path,
          code: ev.code,
          hex: ev.hex,
          kind: item?.kind,
          deferred: this.queue.size,
        });
        break;
      }
      default:
        if (raw) this.send('log', { text: raw });
    }
    this.send('progress', this.stats());
  }

  pause() {
    if (!this.child) return false;
    this.paused = true;
    // No SIGSTOP on Windows; PowerShell suspends the threads instead.
    spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$p=Get-Process -Id ${this.child.pid} -ErrorAction SilentlyContinue; if($p){$p.Threads|ForEach-Object{$_.Suspend()}}`,
      ],
      { windowsHide: true },
    );
    this.send('state', { state: 'paused' });
    return true;
  }

  resume() {
    if (!this.child) return false;
    this.paused = false;
    spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$p=Get-Process -Id ${this.child.pid} -ErrorAction SilentlyContinue; if($p){$p.Threads|ForEach-Object{$_.Resume()}}`,
      ],
      { windowsHide: true },
    );
    this.send('state', { state: 'copying' });
    return true;
  }

  cancel() {
    this.cancelled = true;
    if (this.child) {
      // /T kills the process tree - robocopy spawns children with /MT.
      spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
    }
    this.send('state', { state: 'cancelled' });
    return true;
  }
}
