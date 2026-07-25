// OneDrive / Files-On-Demand safety.
//
// Measured on a real OneDrive folder: 245,570 files, of which 22,300 were
// online-only placeholders totalling 49.72 GB (finding 7).
//
// Two things make this dangerous without care:
//   1. Reading a placeholder PERMANENTLY hydrates it. Verified: a file's
//      attributes went 4199968 -> "Archive, ReparsePoint", the
//      RecallOnDataAccess bit cleared and the content stayed on disk
//      (finding 9). A naive full copy quietly pulls ~50 GB onto C:.
//   2. Hydration is network-bound and OneDrive throttles under concurrency, so
//      thread counts must be capped and failures paced and retried rather than
//      hammered (findings 11, 12).
//
// Note on /XJ: OneDrive folders do carry a ReparsePoint attribute, which
// suggests /XJ (exclude junctions) would skip the whole tree. Measured against
// a real 245,570-file OneDrive folder, the file count was IDENTICAL with and
// without /XJ - OneDrive's reparse tag is not a junction or symlink. No guard
// is needed, and adding one would have been cargo-cult safety.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// Windows file attribute bits.
export const FILE_ATTRIBUTE_OFFLINE = 0x00001000;
export const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
export const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x00040000;
export const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000;

/** True if the attribute bitmask describes an online-only placeholder. */
export function isPlaceholder(attrs) {
  const a = Number(attrs) || 0;
  return Boolean(
    a & (FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_OFFLINE),
  );
}

/** Locate OneDrive roots from the environment plus the usual home-dir layout. */
export async function oneDriveRoots() {
  const roots = new Set();
  for (const key of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    if (process.env[key]) roots.add(process.env[key]);
  }
  try {
    const home = os.homedir();
    for (const name of await fs.readdir(home)) {
      if (/^OneDrive($| - )/i.test(name)) roots.add(path.join(home, name));
    }
  } catch {
    /* home unreadable - env vars above are enough */
  }
  return [...roots];
}

export async function isOneDrivePath(p) {
  if (!p) return false;
  const target = path.resolve(p).toLowerCase();
  for (const root of await oneDriveRoots()) {
    const r = path.resolve(root).toLowerCase();
    if (target === r || target.startsWith(r + path.sep)) return true;
  }
  return false;
}

function runPS(script) {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, shell: false },
    );
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => (out += d));
    ps.stderr.on('data', (d) => (err += d));
    ps.on('error', reject);
    ps.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
  });
}

/**
 * Count online-only files under a directory and total their bytes.
 *
 * Reads only directory metadata - never file contents - so this does NOT
 * hydrate anything. Placeholders report their true size from metadata, which is
 * why the estimate can be exact for free (finding 8).
 */
export async function measureHydration(dir, { recurse = true } = {}) {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$files = Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -File ${recurse ? '-Recurse' : ''} -Force
$ph = $files | Where-Object { $_.Attributes -band 0x00400000 -or $_.Attributes -band 0x00001000 }
$sum = ($ph | Measure-Object Length -Sum).Sum
[pscustomobject]@{
  totalFiles = @($files).Count
  onlineOnly = @($ph).Count
  onlineBytes = [long]($sum | ForEach-Object { if ($_) { $_ } else { 0 } })
} | ConvertTo-Json -Compress
`;
  try {
    const out = await runPS(script);
    const json = JSON.parse(out.trim() || '{}');
    return {
      totalFiles: json.totalFiles ?? 0,
      onlineOnly: json.onlineOnly ?? 0,
      onlineBytes: Number(json.onlineBytes ?? 0),
    };
  } catch {
    return { totalFiles: 0, onlineOnly: 0, onlineBytes: 0, unavailable: true };
  }
}

/** Free space on the volume holding `dir`, in bytes. */
export async function freeSpace(dir) {
  const drive = path.parse(path.resolve(dir)).root.replace(/\\$/, '');
  const script = `(Get-PSDrive -Name '${drive.replace(/:.*/, '')}').Free`;
  try {
    const out = await runPS(script);
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Pre-flight report shown before any copying starts.
 *
 * Deliberately returns numbers rather than deciding: the choice of what to do
 * about hydration is presented per job, not baked in.
 */
export async function preflight(job) {
  const src = job.source;
  const isOD = (await isOneDrivePath(src)) || (await isOneDrivePath(job.dest));
  if (!isOD) return { oneDrive: false };

  const measured = await measureHydration(src, { recurse: job.subdirs !== false });
  const free = await freeSpace(job.dest || src);
  const willExceedDisk = measured.onlineBytes > 0 && measured.onlineBytes >= free;

  return {
    oneDrive: true,
    ...measured,
    freeBytes: free,
    freeAfterBytes: Math.max(0, free - measured.onlineBytes),
    // Hard stop: filling the system drive is how the sync engine actually breaks.
    willExceedDisk,
    warnings: buildWarnings(job, measured, willExceedDisk),
  };
}

function buildWarnings(job, measured, willExceedDisk) {
  const w = [];
  if (willExceedDisk) {
    w.push({
      level: 'blocked',
      message: 'Downloading the online-only files would fill the destination drive.',
    });
  }
  if (measured.onlineOnly > 0) {
    w.push({
      level: 'info',
      message:
        `${measured.onlineOnly.toLocaleString()} online-only files ` +
        `(${fmtGB(measured.onlineBytes)}) will be downloaded and kept on disk.`,
    });
  }
  return w;
}

export function fmtGB(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// --- error classification -------------------------------------------------
// Transient = the sync engine is throttling or stalling; worth retrying later.
// Permanent = retrying wastes time, so it goes straight to the final report.
const TRANSIENT_CODES = new Set([
  21,   // device not ready - sync engine unresponsive
  59,   // unexpected network error
  64,   // network name no longer available
  67,   // network path not found
  121,  // semaphore timeout
  392,  // the operation cannot be performed on pinned cloud files
  395,  // access to the cloud file is denied
  433,  // device does not exist
  467,  // cloud provider error (0x1d3 family)
  1223, // cancelled
  1359, // internal error
  4390, 4391, 4392, 4393, // reparse-point errors seen mid-sync
]);

const PERMANENT_CODES = new Set([
  2,   // file not found
  3,   // path not found
  5,   // access denied
  32,  // sharing violation (treated as permanent unless retried once)
  80,  // file exists
  206, // filename or extension too long
]);

export function classifyError(code) {
  const n = Number(code);
  if (TRANSIENT_CODES.has(n)) return 'transient';
  if (PERMANENT_CODES.has(n)) return 'permanent';
  // Unknown codes get one retry - cheaper than silently abandoning a file.
  return 'transient';
}

/**
 * Adaptive pacing governor.
 *
 * Watches the live failure rate and backs the thread count off when OneDrive
 * starts throttling, then recovers gradually once errors stop. Without this a
 * high thread count turns into a burst of ERROR 392/395 rather than throughput
 * (finding 11).
 */
export function createGovernor({ maxThreads = 4, minThreads = 1 } = {}) {
  let threads = maxThreads;
  let errors = 0;
  let successes = 0;

  return {
    get threads() {
      return threads;
    },
    recordError() {
      errors += 1;
      if (errors >= 3) {
        threads = Math.max(minThreads, Math.floor(threads / 2));
        errors = 0;
        successes = 0;
        return { changed: true, threads, direction: 'down' };
      }
      return { changed: false, threads };
    },
    recordSuccess() {
      successes += 1;
      if (successes >= 200 && threads < maxThreads) {
        threads += 1;
        successes = 0;
        return { changed: true, threads, direction: 'up' };
      }
      return { changed: false, threads };
    },
    // Extra breathing room between files once throttling has been seen.
    get interFileDelayMs() {
      return threads <= 1 ? 250 : threads <= 2 ? 100 : 0;
    },
  };
}

/**
 * Set copied files back to online-only to reclaim space.
 * Opt-in, and only ever applied to files confirmed copied.
 */
export async function dehydrate(paths, { onProgress } = {}) {
  let done = 0;
  let failed = 0;
  for (const p of paths) {
    try {
      await runPS(`attrib +U -P '${p.replace(/'/g, "''")}'`);
      done += 1;
    } catch {
      failed += 1;
    }
    onProgress?.({ done, failed, total: paths.length });
  }
  return { done, failed };
}
