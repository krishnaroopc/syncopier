// Syncopier - core robocopy driver.
//
// ALL copying in Syncopier is performed by robocopy.exe, the Microsoft-authored
// "Robust File Copy" utility that ships with Windows. Syncopier does not
// implement any copy logic of its own: it builds robocopy's arguments, spawns
// it, parses its output, and presents the result. Robocopy does the real work.
//
// This module is shaped by behaviour verified against the real robocopy.exe.
// The comments marked "finding N" refer to those verified behaviours and are
// documented in the README; changing this code without re-checking them is how
// it breaks.

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

export const ROBOCOPY = 'robocopy.exe';

// --- exit codes -----------------------------------------------------------
// Robocopy's exit status is a BITMASK, not an error code (finding 4).
// 0 = nothing to copy, 1 = files copied, 2 = extras present, 4 = mismatches,
// 8 = some files failed, 16 = fatal. Treating 1 as failure is the classic
// robocopy-wrapper bug, so success is defined as "< 8".
export const EXIT_BITS = [
  [16, 'Fatal error - no files copied'],
  [8, 'Some files or directories could not be copied'],
  [4, 'Mismatched files or directories detected'],
  [2, 'Extra files or directories detected in destination'],
  [1, 'Files were copied successfully'],
];

export function isFailure(code) {
  return code >= 8;
}

export function describeExit(code) {
  if (code === 0) return 'No files needed copying - destination already up to date';
  const parts = [];
  for (const [bit, text] of EXIT_BITS) {
    if (code & bit) parts.push(text);
  }
  return parts.length ? parts.join('; ') : `Exit code ${code}`;
}

// --- path handling --------------------------------------------------------
// A trailing backslash on a quoted path escapes the closing quote when Windows
// re-parses the command line, so it must be stripped. Root paths (C:\) keep it.
export function normalizeDir(p) {
  let s = String(p ?? '').trim().replace(/["']/g, '');
  if (!s) return s;
  s = s.replace(/\//g, '\\');
  if (/^[A-Za-z]:\\$/.test(s)) return s;
  return s.replace(/\\+$/, '');
}

// --- resource slider ------------------------------------------------------
// Slider 1..10 -> thread count and I/O flags. Shown live in the UI so the
// mapping is never a mystery box.
export function resourceFlags(level, { oneDriveMode = false } = {}) {
  const n = Math.max(1, Math.min(10, Number(level) || 5));

  // VERIFIED CONSTRAINT: robocopy rejects /IPG together with /MT
  // ("The /IPG option cannot be used with the /MT option") and exits 16 without
  // copying anything. So throttled levels must omit /MT entirely - single
  // threaded is robocopy's default, which is what those levels want anyway.

  // In OneDrive mode hydration is network-bound: more threads do not make cloud
  // files arrive faster, they mostly provoke ERROR 392/395 throttling
  // (findings 11, 12). Cap the curve at /MT:4.
  if (oneDriveMode) {
    if (n <= 2) return { threads: 1, flags: ['/IPG:50'] }; // no /MT with /IPG
    const mt = n <= 5 ? 2 : n <= 8 ? 3 : 4;
    return { threads: mt, flags: [`/MT:${mt}`] };
  }

  const table = [
    { mt: 1, extra: ['/IPG:75'] },
    { mt: 1, extra: ['/IPG:20'] },
    { mt: 4, extra: [] },
    { mt: 8, extra: [] },
    { mt: 8, extra: [] },
    { mt: 8, extra: [] },
    { mt: 16, extra: ['/J'] },
    { mt: 20, extra: ['/J'] },
    { mt: 24, extra: ['/J'] },
    { mt: 32, extra: ['/J'] },
  ];
  const { mt, extra } = table[n - 1];
  const throttled = extra.some((f) => f.startsWith('/IPG'));
  // Emit /MT only when not throttling; /MT:1 plus /IPG is a fatal combination.
  const flags = throttled ? [...extra] : [`/MT:${mt}`, ...extra];
  return { threads: mt, flags };
}

export const CONFLICT_FLAGS = {
  overwrite: [],
  // Verified: exits 0 and copies nothing when the destination already matches.
  skip: ['/XC', '/XN', '/XO'],
  // "keep both" has no native flag; the main pass skips, then keepboth.js runs.
  keepboth: ['/XC', '/XN', '/XO'],
};

/**
 * Build the robocopy argv array.
 *
 * Args are always passed as an ARRAY to spawn() with shell:false. They must
 * never be interpolated into a shell string - a POSIX shell rewrites `/E` into
 * a path (finding 6) and quoting rules differ.
 */
export function buildArgs(job, { listOnly = false, files = null } = {}) {
  const src = normalizeDir(job.source);
  const dst = normalizeDir(job.dest);
  const args = [src, dst];

  // File selector: explicit names, wildcards, or the default *.*
  const selectors = files ?? job.files ?? [];
  if (selectors.length) args.push(...selectors);
  else args.push('*.*');

  if (job.mirror) args.push('/MIR');
  else if (job.subdirs !== false) args.push(job.emptyDirs === false ? '/S' : '/E');

  args.push('/BYTES');

  const oneDriveMode = !!job.oneDriveMode;

  if (listOnly) {
    // Dry run: list what would be copied, no header/summary noise.
    args.push('/L', '/NJH', '/NJS', '/NDL');
  } else {
    const { flags } = resourceFlags(job.resourceLevel ?? 5, { oneDriveMode });
    args.push(...flags);
    if (job.restartable) args.push('/Z');

    // Output verbosity. 'normal' is robocopy's default and is left untouched.
    //
    // IMPORTANT: per-file lines are how progress is measured - job.js credits
    // bytes when a file line appears. /NFL (no file list) would therefore
    // freeze the progress bar and ETA at zero. So 'silent' suppresses only the
    // surrounding noise (header, summary, directory lines) and never /NFL.
    if (job.verbosity === 'silent') {
      args.push('/NJH', '/NJS', '/NDL', '/NP');
    } else if (job.verbosity === 'verbose') {
      // Show skipped files and timestamps; the extra lines go to the log pane.
      args.push('/V', '/TS', '/FP');
    }

    // Fail fast into the deferred retry queue rather than blocking 30s per file
    // on robocopy's default /W:30 (retry.js owns the real retry policy).
    const retries = job.retries ?? (oneDriveMode ? 1 : 2);
    const wait = job.wait ?? (oneDriveMode ? 2 : 5);
    args.push(`/R:${retries}`, `/W:${wait}`);
  }

  // Conflict flags are deliberately NOT applied to a /L scan: they exclude the
  // pre-existing files, and those are exactly what the scan needs to report as
  // conflicts. Applying them here would make keep-both find nothing to do.
  if (!listOnly) args.push(...(CONFLICT_FLAGS[job.conflict] ?? []));

  // Skip online-only files entirely: /XA:O excludes the Offline attribute so
  // robocopy never opens a placeholder and nothing is hydrated.
  if (job.skipOnlineOnly) args.push('/XA:O');

  if (job.excludeFiles?.length) args.push('/XF', ...job.excludeFiles);
  if (job.excludeDirs?.length) args.push('/XD', ...job.excludeDirs);

  // /XJ excludes junctions and symlinks. OneDrive folders carry a ReparsePoint
  // attribute too, which makes /XJ look dangerous here - but it was measured
  // against a real 245,570-file OneDrive tree and the count was IDENTICAL with
  // and without the flag: OneDrive's reparse tag is not a junction or symlink,
  // so robocopy still traverses it. The flag is therefore safe to pass through.
  if (job.excludeJunctions) args.push('/XJ');

  return args;
}

// --- output parsing -------------------------------------------------------

// Tab-delimited file line: \t<class>\t\t<bytes>\t<name>  (finding 1)
const FILE_RE = /^\s*(New File|Older|Newer|Changed|Same|Tweaked|EXTRA File|\*EXTRA File)\s+(\d+)\s+(.+?)\s*$/;
const PCT_RE = /^\s*(\d{1,3}(?:\.\d+)?)%\s*$/;
const ERROR_RE = /^\s*ERROR\s+(\d+)\s+\(0x([0-9A-Fa-f]+)\)\s*(.*)$/;
const NEWDIR_RE = /^\s*(?:New Dir|Newer Dir|Older Dir)\s+(\d+)\s+(.+?)\s*$/;

/**
 * Incremental line splitter.
 *
 * Robocopy writes progress with bare \r and no trailing newline, so a chunk can
 * end mid-line. Splitting naively per-chunk corrupts filenames and drops
 * percentages; the remainder must be carried across chunks.
 */
export function createLineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop() ?? '';
      for (const line of parts) onLine(line);
    },
    flush() {
      if (buf) {
        onLine(buf);
        buf = '';
      }
    },
  };
}

/** Classify one line of robocopy output. */
export function parseLine(line) {
  if (!line || !line.trim()) return null;

  const err = ERROR_RE.exec(line);
  if (err) {
    return {
      type: 'error',
      code: Number(err[1]),
      hex: `0x${err[2].toLowerCase()}`,
      text: err[3].trim(),
    };
  }

  const pct = PCT_RE.exec(line);
  if (pct) return { type: 'percent', percent: Number(pct[1]) };

  const dir = NEWDIR_RE.exec(line);
  if (dir) return { type: 'dir', count: Number(dir[1]), path: dir[2] };

  const f = FILE_RE.exec(line);
  if (f) {
    return {
      type: 'file',
      cls: f[1].replace(/^\*/, ''),
      bytes: Number(f[2]),
      path: f[3],
    };
  }

  return { type: 'raw', text: line };
}

/** Classes that mean "this file already exists at the destination". */
export const CONFLICT_CLASSES = new Set(['Older', 'Newer', 'Changed']);

/**
 * Rolling-window throughput meter.
 *
 * A naive total/elapsed average barely moves once a job is underway, which
 * makes the ETA lie badly when speed changes - and speed changes constantly
 * when OneDrive hydration is involved. This keeps a short window instead.
 */
export function createRateMeter(windowMs = 5000) {
  const samples = [];
  return {
    add(bytes, now = Date.now()) {
      samples.push({ t: now, bytes });
      const cutoff = now - windowMs;
      while (samples.length && samples[0].t < cutoff) samples.shift();
    },
    rate(now = Date.now()) {
      if (samples.length < 2) return 0;
      const span = (now - samples[0].t) / 1000;
      if (span <= 0) return 0;
      const total = samples.reduce((a, s) => a + s.bytes, 0);
      return total / span;
    },
  };
}

/** Spawn robocopy and stream parsed events. Resolves with the exit code. */
export function runRobocopy(args, { onEvent, onSpawn, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ROBOCOPY, args, {
      cwd,
      shell: false, // never a shell string - see finding 6
      // stdout is piped and rendered in the log pane, so no console window is
      // ever needed.
      windowsHide: true,
    });

    onSpawn?.(child);

    const splitter = createLineSplitter((line) => {
      const ev = parseLine(line);
      if (ev) onEvent?.(ev, line);
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => splitter.push(d));
    child.stderr.on('data', (d) => splitter.push(d));

    child.on('error', reject);
    child.on('close', (code) => {
      splitter.flush();
      resolve(code ?? 0);
    });
  });
}

/**
 * Dry-run scan (/L). Returns totals plus the file list.
 *
 * This is the backbone of the whole UI: robocopy gives no overall progress, so
 * a genuine bar and ETA are only possible by measuring the job first. On
 * OneDrive it is also free - /L reports true byte sizes for online-only
 * placeholders without hydrating them (finding 8).
 */
export async function scan(job, { files = null, onEvent } = {}) {
  const args = buildArgs(job, { listOnly: true, files });
  const result = {
    files: [],
    conflicts: [],
    totalBytes: 0,
    totalFiles: 0,
    errors: [],
    args,
  };

  await runRobocopy(args, {
    onEvent: (ev) => {
      if (ev.type === 'file') {
        const entry = { path: ev.path, bytes: ev.bytes, cls: ev.cls };
        result.files.push(entry);
        result.totalBytes += ev.bytes;
        result.totalFiles += 1;
        if (CONFLICT_CLASSES.has(ev.cls)) result.conflicts.push(entry);
      } else if (ev.type === 'error') {
        result.errors.push(ev);
      }
      onEvent?.(ev);
    },
  });

  return result;
}

/**
 * Enumerate source files by NAME ONLY, ignoring the destination entirely.
 *
 * CRITICAL, and the cause of the v1.0 "missing files" bug: robocopy prints a
 * per-file line only for files it would ACT on. A file that already exists
 * identically at the destination is tallied under "Skipped" and produces NO
 * output line at all. Verified on a real run: 100 files in range reported as
 * `Files: 100  Skipped: 100` with zero file lines emitted.
 *
 * Existence therefore CANNOT be inferred from a normal scan's file lines - a
 * fully-copied range looks byte-for-byte identical to a range whose files were
 * never there. v1.0 concluded "missing" and alarmed the user about 7,001 files
 * that were present and already copied.
 *
 * The fix is to enumerate against a destination that cannot possibly contain
 * matches, so every existing source file must be listed as "New File" or
 * "*EXTRA File". An empty scratch directory is used rather than the real
 * destination. /L keeps this free on OneDrive: sizes come from metadata and no
 * placeholder is hydrated (finding 8).
 */
export async function enumerateSource(job, { files = null } = {}) {
  const probeDir = await mkdtemp(path.join(os.tmpdir(), 'syncopier-probe-'));
  try {
    const probeJob = {
      ...job,
      dest: probeDir,
      // Conflict/mirror flags would reintroduce destination-dependent
      // suppression - the exact failure this function exists to avoid.
      conflict: 'overwrite',
      mirror: false,
      subdirs: job.subdirs,
    };
    return await scan(probeJob, { files });
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function basename(p) {
  return path.basename(p);
}
