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

/**
 * The single source of truth for "is this file a cloud placeholder", as a
 * PowerShell filter expression over $_.
 *
 * A placeholder is a REPARSE POINT plus a recall bit. The Offline bit ALONE is
 * not sufficient: ordinary local files can carry Archive+Offline (measured:
 * attribute 4128 on freshly copied files in a plain Downloads folder) with no
 * reparse point and no sync engine behind them.
 *
 * This existed in two divergent copies. measureHydration() - the function that
 * produces the numbers shown in the hydration warning - used the LOOSE form
 * with no reparse-point requirement, the same looseness that once made a plain
 * local folder look like OneDrive. Verified against a real 72,789-file library:
 * both forms report 68,361 placeholders, so unifying them changes no number
 * today and closes the latent misclassification.
 *
 * Keep every attribute check in this module routed through this constant.
 */
export const PS_PLACEHOLDER_FILTER =
  '($_.Attributes -band 0x00000400) -and ' +
  '(($_.Attributes -band 0x00400000) -or ($_.Attributes -band 0x00040000) -or ' +
  '($_.Attributes -band 0x00001000))';

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
  // Path-prefix matching alone is NOT sufficient. SharePoint and Teams document
  // libraries sync to their own top-level folder - C:\Users\<user>\<TENANT>\...
  // - which is nowhere under the %OneDrive% root and is not listed in any
  // OneDrive* environment variable. %OneDrive% points at
  // "C:\Users\<user>\OneDrive - <TENANT>", a sibling of the library, so the
  // prefix never matches.
  //
  // Measured on a real tenant library: 72,789 files, 68,361 of them online-only
  // placeholders totalling ~33 GB. Prefix matching returned false, so OneDrive
  // mode never engaged: no thread cap, no pacing, no hydration warning and no
  // disk-space guard on that download.
  //
  // Placeholder attributes are set by the sync engine itself, so checking them
  // detects any synced location regardless of where it was mounted.
  return await hasPlaceholders(p);
}

/**
 * True if a directory contains cloud placeholders - i.e. it is backed by a sync
 * engine, wherever it happens to live on disk.
 *
 * Samples the directory rather than walking it: this runs on every path change
 * in the UI and a full recursive scan of a large library would stall it. Reads
 * only metadata, so nothing is hydrated.
 */
export async function hasPlaceholders(dir) {
  // Node's fs.stat exposes no Windows attribute bitmask, so the sync-engine
  // check has to go through the shell.
  try {
    return await probeAttributes(dir);
  } catch {
    return false;
  }
}

async function probeAttributes(dir) {
  // See PS_PLACEHOLDER_FILTER for why the reparse-point bit is required.
  const script = `
$ErrorActionPreference='SilentlyContinue'
$f = Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -File -Force | Select-Object -First 200
$ph = $f | Where-Object { ${PS_PLACEHOLDER_FILTER} }
if (@($ph).Count -gt 0) { 'yes' } else { 'no' }
`;
  try {
    return (await runPS(script)).trim() === 'yes';
  } catch {
    return false;
  }
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
$ph = $files | Where-Object { ${PS_PLACEHOLDER_FILTER} }
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

// The Node spawn() argv Windows builds is capped well under the textbook
// 32,767-char CreateProcess limit - measured empirically (binary search on the
// live `script` argument, shell:false, same spawn call as runPS below) at
// 32,691 chars for the -Command argument alone. select.js's ARG_BUDGET guards
// the analogous robocopy limit.
//
// The PowerShell scripts below repeat the FULL DIRECTORY PATH once per
// filename - unlike robocopy's argv, where the directory is a single separate
// argument - so a chunk sized only for filename length silently blows the
// limit on a deeply nested path. Measured failures, both against the real
// spawn(): a 128-char OneDrive path with a fixed chunk of 400 produced a
// 55,199-char list; a later revision that budgeted only the LIST portion
// (ignoring the ~550 chars of fixed script text around it, plus
// PS_PLACEHOLDER_FILTER) produced a 33,323-char full script against a
// 58-char path - still over the 32,691 ceiling. Both were initially masked by
// a catch-and-return-zero, which reported "0 online-only" for a range that was
// genuinely 2,573 online-only.
//
// PS_SCRIPT_BUDGET therefore bounds the LIST portion only, and is set well
// under (32,691 - FIXED_SCRIPT_OVERHEAD) so the two budgets combined always
// clear the measured ceiling with real margin, regardless of how the fixed
// script text around the list happens to change size.
const FIXED_SCRIPT_OVERHEAD = 800; // measured ~650-700; padded for headroom
export const PS_SCRIPT_BUDGET = 24_000;

export function namesPerChunk(dirLen, perNameOverhead) {
  const perItem = dirLen + perNameOverhead;
  return Math.max(1, Math.floor(PS_SCRIPT_BUDGET / perItem));
}

// Sanity check at module load: if PS_PLACEHOLDER_FILTER or the surrounding
// script text ever grows past what FIXED_SCRIPT_OVERHEAD assumes, fail loudly
// here rather than at a random spawn() deep in a job.
if (PS_SCRIPT_BUDGET + FIXED_SCRIPT_OVERHEAD >= 32_691) {
  throw new Error('PS_SCRIPT_BUDGET + FIXED_SCRIPT_OVERHEAD exceeds the measured Windows command-line ceiling');
}

/**
 * Measure hydration for a SPECIFIC set of filenames rather than a whole tree.
 *
 * Why this exists: the hydration warning must describe the job, not the folder.
 * Measured on a real library, a 7,001-file range with 4,428 already copied
 * needed 2,573 files / 1.26 GB, while the whole-folder walk reported 68,361
 * files / 33.40 GB - a 26x overstatement that also fed willExceedDisk and could
 * refuse a job that fits comfortably.
 *
 * Reads directory METADATA only (.Attributes, .Length), never file contents, so
 * nothing is hydrated. Placeholders report their true size from metadata.
 *
 * @param {string} dir
 * @param {string[]} names basenames to measure
 * @param {{recurse?: boolean}} [opts]
 */
export async function measureHydrationForNames(dir, names, { recurse = true } = {}) {
  const wanted = (names ?? []).filter(Boolean);
  // Nothing selected: skip the spawn entirely.
  if (!wanted.length) return { totalFiles: 0, onlineOnly: 0, onlineBytes: 0 };

  const q = (s) => String(s).replace(/'/g, "''");
  const qDir = q(dir);

  // Recursive: a $want hashtable is built inline, one line per name - so this
  // must be chunked too (finding above), or it fails identically for any
  // subdirs-enabled job. Each chunk still does its OWN full tree walk, so this
  // is only cheap when few chunks are needed; a huge scattered selection with
  // subdirs on will re-walk the tree per chunk.
  if (recurse) {
    // Overhead per name: "$want['" + name + "']=$true\n" - about 16 chars of
    // literal text plus the name itself.
    const perChunk = namesPerChunk(qDir.length, 20);
    const totals = { totalFiles: 0, onlineOnly: 0, onlineBytes: 0 };
    for (let i = 0; i < wanted.length; i += perChunk) {
      const slice = wanted.slice(i, i + perChunk);
      const script = `
$ErrorActionPreference='Stop'
$want = @{}
${slice.map((n) => `$want['${q(n).toLowerCase()}']=$true`).join('\n')}
$files = Get-ChildItem -LiteralPath '${qDir}' -File -Recurse -Force |
  Where-Object { $want.ContainsKey($_.Name.ToLower()) }
$ph = $files | Where-Object { ${PS_PLACEHOLDER_FILTER} }
$sum = ($ph | Measure-Object Length -Sum).Sum
[pscustomobject]@{
  totalFiles = @($files).Count
  onlineOnly = @($ph).Count
  onlineBytes = [long]($sum | ForEach-Object { if ($_) { $_ } else { 0 } })
} | ConvertTo-Json -Compress
`;
      const json = JSON.parse((await runPS(script)).trim() || '{}');
      totals.totalFiles += json.totalFiles ?? 0;
      totals.onlineOnly += json.onlineOnly ?? 0;
      totals.onlineBytes += Number(json.onlineBytes ?? 0);
    }
    return totals;
  }

  // Flat: address the wanted entries directly, chunked to the actual
  // directory length rather than a fixed count.
  const perChunk = namesPerChunk(qDir.length, 6); // "'" + '\' + name + "',"
  const totals = { totalFiles: 0, onlineOnly: 0, onlineBytes: 0 };
  for (let i = 0; i < wanted.length; i += perChunk) {
    const slice = wanted.slice(i, i + perChunk);
    const list = slice.map((n) => `'${qDir}\\${q(n)}'`).join(',');
    const script = `
$ErrorActionPreference='Stop'
$files = Get-Item -LiteralPath ${list} -Force -ErrorAction SilentlyContinue | Where-Object { -not $_.PSIsContainer }
$ph = $files | Where-Object { ${PS_PLACEHOLDER_FILTER} }
$sum = ($ph | Measure-Object Length -Sum).Sum
[pscustomobject]@{
  totalFiles = @($files).Count
  onlineOnly = @($ph).Count
  onlineBytes = [long]($sum | ForEach-Object { if ($_) { $_ } else { 0 } })
} | ConvertTo-Json -Compress
`;
    const json = JSON.parse((await runPS(script)).trim() || '{}');
    totals.totalFiles += json.totalFiles ?? 0;
    totals.onlineOnly += json.onlineOnly ?? 0;
    totals.onlineBytes += Number(json.onlineBytes ?? 0);
  }
  return totals;
}

/**
 * Index the destination by basename -> size, for deciding what a resume still
 * has to copy.
 *
 * This CANNOT be derived from a robocopy scan. Robocopy prints no line at all
 * for a file already present identically at the destination, so scan output
 * makes copied files indistinguishable from absent ones - the v1.0 "missing
 * files" bug. Reading the destination's own metadata is authoritative.
 *
 * Measured: 4,428 files indexed in 214ms.
 */
export async function indexDestination(dir, { recurse = false } = {}) {
  const map = new Map();
  if (!dir) return map;
  const script = `
$ErrorActionPreference='SilentlyContinue'
Get-ChildItem -LiteralPath '${String(dir).replace(/'/g, "''")}' -File ${recurse ? '-Recurse' : ''} -Force |
  ForEach-Object { $_.Name + '|' + $_.Length }
`;
  try {
    const out = await runPS(script);
    for (const line of out.split(/\r?\n/)) {
      const i = line.lastIndexOf('|');
      if (i < 1) continue;
      const name = line.slice(0, i).trim();
      const size = Number(line.slice(i + 1).trim());
      if (name && Number.isFinite(size)) map.set(name.toLowerCase(), size);
    }
  } catch {
    /* unreadable destination - treat as empty, i.e. copy everything */
  }
  return map;
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
export async function preflight(job, scope = null, deps = {}) {
  const {
    isOneDrivePath: isOD_ = isOneDrivePath,
    measureHydration: measureAll = measureHydration,
    measureHydrationForNames: measureNames = measureHydrationForNames,
    freeSpace: free_ = freeSpace,
  } = deps;

  const src = job.source;
  const isOD = (await isOD_(src)) || (await isOD_(job.dest));
  if (!isOD) return { oneDrive: false };

  const recurse = job.subdirs !== false;

  // Scoped: measure only the files this job will actually copy. Unscoped
  // (mode 'all', or a wildcard job where no name list exists) keeps the
  // whole-folder walk, which is correct there.
  //
  // A failure here (e.g. a PowerShell spawn error) must not abort the whole
  // pre-flight or the job - it degrades to "hydration unknown" rather than
  // silently reporting zero online-only files, which would look like nothing
  // needs downloading when the truth is simply unmeasured.
  let measured;
  try {
    measured = scope?.names
      ? await measureNames(src, scope.names, { recurse })
      : await measureAll(src, { recurse });
  } catch {
    measured = { totalFiles: 0, onlineOnly: 0, onlineBytes: 0, unavailable: true };
  }

  const free = await free_(job.dest || src);
  // Computed from the SCOPED byte total. Using the whole-folder figure here
  // would refuse jobs that fit: 33.40 GB folder-wide vs 1.26 GB actually needed.
  const willExceedDisk = measured.onlineBytes > 0 && measured.onlineBytes >= free;

  return {
    oneDrive: true,
    ...measured,
    freeBytes: free,
    freeAfterBytes: Math.max(0, free - measured.onlineBytes),
    // Hard stop: filling the system drive is how the sync engine actually breaks.
    willExceedDisk,
    warnings: buildWarnings(job, measured, willExceedDisk, scope),
    // Additive fields - older UI payloads simply see these as undefined.
    scoped: Boolean(scope?.names),
    selectedFiles: scope?.selectedFiles ?? null,
    alreadyPresent: scope?.alreadyPresent ?? 0,
    remainingFiles: scope?.names?.length ?? null,
  };
}

export function buildWarnings(job, measured, willExceedDisk, scope = null) {
  const w = [];
  if (measured.unavailable) {
    w.push({
      level: 'info',
      message:
        'Could not measure how many files are online-only. Copying will still work; ' +
        'this only affects the estimate shown here.',
    });
  }
  if (willExceedDisk) {
    w.push({
      level: 'blocked',
      message: 'Downloading the online-only files would fill the destination drive.',
    });
  }
  if (measured.onlineOnly > 0) {
    const tail =
      `${measured.onlineOnly.toLocaleString()} online-only files ` +
      `(${fmtGB(measured.onlineBytes)}) will be downloaded and kept on disk.`;
    // Make a resume legible: without this the user cannot tell "copying N files"
    // from "N already done, this many left".
    const resuming = scope?.names && scope.alreadyPresent > 0;
    w.push({
      level: 'info',
      message: resuming
        ? `Resuming: ${scope.alreadyPresent.toLocaleString()} of ` +
          `${scope.selectedFiles.toLocaleString()} selected files are already at the ` +
          `destination. ${tail}`
        : tail,
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
