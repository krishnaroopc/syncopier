// Deferred-failure queue.
//
// The requirement: if OneDrive buckles mid-copy, no file may be silently lost -
// track what failed and retry it once everything else has finished.
//
// Design points that matter:
//   * The main pass is never blocked. Robocopy runs with /R:1 /W:2 in OneDrive
//     mode so a stuck placeholder drops out in seconds instead of stalling the
//     job for 30s (robocopy's default /W:30).
//   * Retries happen AFTER the main pass, in backed-off rounds, giving the sync
//     engine room to recover.
//   * The queue is persisted on every change, so a crash or reboot cannot lose
//     the list of missing files.
//   * A job is only "successful" when the queue is empty.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { classifyError } from './onedrive.js';
import { runRobocopy, buildArgs, isFailure } from './robocopy.js';

export const JOBS_DIR = path.join(os.homedir(), '.syncopier', 'jobs');

export const DEFAULT_BACKOFF_MS = [30_000, 120_000, 300_000];

export function createQueue(jobId) {
  /** @type {Map<string, {path:string,size:number,code:number,hex:string,kind:string,attempts:number,lastError:string}>} */
  const items = new Map();
  let persistTimer = null;

  const file = path.join(JOBS_DIR, `${jobId}.json`);

  async function persistNow() {
    try {
      await fs.mkdir(JOBS_DIR, { recursive: true });
      const payload = {
        jobId,
        updated: new Date().toISOString(),
        items: [...items.values()],
      };
      // Write-then-rename so a crash mid-write can't truncate the queue file.
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(tmp, file);
    } catch {
      /* persistence is best-effort; the in-memory queue still drives the job */
    }
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, 500);
  }

  return {
    file,
    get size() {
      return items.size;
    },
    list() {
      return [...items.values()];
    },
    transient() {
      return [...items.values()].filter((i) => i.kind === 'transient');
    },
    permanent() {
      return [...items.values()].filter((i) => i.kind === 'permanent');
    },
    add({ path: p, size = 0, code = 0, hex = '', text = '' }) {
      if (!p) return null;
      const key = p.toLowerCase();
      const existing = items.get(key);
      if (existing) {
        existing.attempts += 1;
        existing.code = code || existing.code;
        existing.lastError = text || existing.lastError;
        existing.kind = classifyError(existing.code);
      } else {
        items.set(key, {
          path: p,
          size,
          code,
          hex,
          kind: classifyError(code),
          attempts: 1,
          lastError: text,
        });
      }
      schedulePersist();
      return items.get(key);
    },
    resolve(p) {
      const key = String(p).toLowerCase();
      if (items.delete(key)) {
        schedulePersist();
        return true;
      }
      return false;
    },
    flush: persistNow,
    async load() {
      try {
        const raw = JSON.parse(await fs.readFile(file, 'utf8'));
        for (const i of raw.items ?? []) items.set(i.path.toLowerCase(), i);
      } catch {
        /* no saved queue */
      }
      return items.size;
    },
    toCSV() {
      const rows = [['path', 'bytes', 'error_code', 'error_hex', 'kind', 'attempts', 'message']];
      for (const i of items.values()) {
        rows.push([
          i.path,
          i.size,
          i.code,
          i.hex,
          i.kind,
          i.attempts,
          String(i.lastError ?? '').replace(/"/g, '""'),
        ]);
      }
      return rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
    },
  };
}

/**
 * Attach the queue to a running copy.
 *
 * Robocopy reports a failure as an ERROR line that FOLLOWS the file line it
 * refers to, so the most recently seen file path is the one being blamed.
 */
export function createErrorTracker(queue) {
  let lastFile = null;
  return {
    observe(ev) {
      if (ev.type === 'file') {
        lastFile = { path: ev.path, bytes: ev.bytes };
        return null;
      }
      if (ev.type === 'error') {
        const target = ev.text?.trim() || lastFile?.path;
        if (!target) return null;
        return queue.add({
          path: target,
          size: lastFile?.bytes ?? 0,
          code: ev.code,
          hex: ev.hex,
          text: ev.text,
        });
      }
      return null;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry the transient failures in backed-off rounds.
 *
 * Each file is retried individually (robocopy accepts a single named file),
 * single-threaded and gently paced. Permanent failures are left alone - they go
 * to the report instead of burning time.
 */
export async function retryRounds(
  queue,
  job,
  { rounds = 3, backoff = DEFAULT_BACKOFF_MS, onEvent, shouldStop } = {},
) {
  const recovered = [];

  for (let round = 1; round <= rounds; round++) {
    const pending = queue.transient();
    if (!pending.length) break;
    if (shouldStop?.()) break;

    const waitMs = backoff[Math.min(round - 1, backoff.length - 1)];
    onEvent?.({
      type: 'retry-wait',
      round,
      rounds,
      pending: pending.length,
      waitMs,
    });

    // Give the sync engine time to recover before hammering it again.
    const waited = Date.now();
    while (Date.now() - waited < waitMs) {
      if (shouldStop?.()) return { recovered, remaining: queue.list() };
      await sleep(Math.min(500, waitMs));
    }

    onEvent?.({ type: 'retry-round', round, rounds, pending: pending.length });

    for (const item of pending) {
      if (shouldStop?.()) break;

      const dir = path.dirname(item.path);
      const name = path.basename(item.path);

      // Mirror the source subdirectory into the destination so retried files
      // land where the main pass would have put them.
      const rel = path.relative(job.source, dir);
      const destDir = rel && !rel.startsWith('..') ? path.join(job.dest, rel) : job.dest;

      const args = buildArgs(
        // resourceLevel 3 -> plain /MT, no /IPG (robocopy rejects the pair).
        { ...job, source: dir, dest: destDir, resourceLevel: 3, retries: 1, wait: 2, mirror: false },
        { files: [name] },
      );

      let failed = false;
      const code = await runRobocopy(args, {
        onEvent: (ev) => {
          if (ev.type === 'error') failed = true;
        },
      }).catch(() => 16);

      if (!isFailure(code) && !failed) {
        queue.resolve(item.path);
        recovered.push(item.path);
        onEvent?.({ type: 'retry-ok', path: item.path, round });
      } else {
        item.attempts += 1;
        onEvent?.({ type: 'retry-fail', path: item.path, round, code });
      }

      await sleep(120); // pacing - do not burst the sync engine
    }
  }

  await queue.flush();
  return { recovered, remaining: queue.list() };
}
