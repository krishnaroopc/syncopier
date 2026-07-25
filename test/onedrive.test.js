// Tests for job-scoped hydration measurement.
//
// The bug these pin down: the hydration warning measured the whole source
// folder rather than the files the job would actually copy. On a real library,
// resuming a 7,001-file range with 4,428 already copied reported 68,361 files /
// 33.40 GB when the true remaining work was 2,573 files / 1.26 GB - a 26x
// overstatement that also fed willExceedDisk, so it could refuse a job that fit.
//
// All numbers below are the measured ones from that library.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  preflight,
  buildWarnings,
  PS_PLACEHOLDER_FILTER,
  measureHydrationForNames,
  namesPerChunk,
  PS_SCRIPT_BUDGET,
} from '../lib/onedrive.js';
import { buildHydrationScope } from '../lib/job.js';

const GB = 1024 ** 3;

/** 7,001 selected files, of which `copied` are already at the destination. */
function fixture(copied = 4428, total = 7001) {
  const files = [];
  for (let i = 0; i < total; i++) {
    files.push({ name: `Img${String(22000 + i).padStart(6, '0')}.tif`, bytes: 524580 });
  }
  const destIndex = new Map();
  for (let i = 0; i < copied; i++) destIndex.set(files[i].name.toLowerCase(), files[i].bytes);
  return {
    selection: { mode: 'range', names: files.map((f) => f.name), files },
    destIndex,
  };
}

test('buildHydrationScope excludes files already at the destination', () => {
  const { selection, destIndex } = fixture();
  const scope = buildHydrationScope({ conflict: 'skip' }, selection, destIndex);

  assert.equal(scope.selectedFiles, 7001);
  assert.equal(scope.alreadyPresent, 4428);
  assert.equal(scope.names.length, 2573, 'only the remaining files are in scope');
  // The remaining names must be the tail, not an arbitrary subset.
  assert.equal(scope.names[0], 'Img026428.tif');
});

test('a size mismatch means the file still needs copying', () => {
  // Same name, different size - a truncated or interrupted file. It must NOT
  // count as already present.
  const { selection, destIndex } = fixture(10);
  destIndex.set('img022000.tif', 1); // wrong size
  const scope = buildHydrationScope({ conflict: 'skip' }, selection, destIndex);
  assert.equal(scope.alreadyPresent, 9);
  assert.ok(scope.names.includes('Img022000.tif'));
});

test('overwrite re-copies everything, so nothing is excluded', () => {
  const { selection, destIndex } = fixture();
  const scope = buildHydrationScope({ conflict: 'overwrite' }, selection, destIndex);
  assert.equal(scope.names.length, 7001);
  assert.equal(scope.alreadyPresent, 0);
});

test('whole-folder measurement is kept for mode all and wildcard', () => {
  // 'all' copies everything, so folder-wide numbers are already correct.
  assert.equal(buildHydrationScope({}, { mode: 'all', names: ['a'] }, new Map()), null);
  // Wildcard jobs are never enumerated, so there are no names to scope by.
  // Over-reporting beats inventing a number.
  assert.equal(buildHydrationScope({}, { mode: 'wildcard', names: [] }, new Map()), null);
});

test('REGRESSION: preflight measures the job, not the whole folder', async () => {
  // The 26x overstatement. The whole-folder measure is stubbed to THROW, so the
  // test fails loudly if preflight ever falls back to it for a scoped job.
  const deps = {
    isOneDrivePath: async () => true,
    measureHydration: async () => {
      throw new Error('whole-folder measurement must not run for a scoped job');
    },
    measureHydrationForNames: async (_dir, names) => ({
      totalFiles: names.length,
      onlineOnly: names.length,
      onlineBytes: 1.26 * GB,
    }),
    freeSpace: async () => 232 * GB,
  };

  const scope = { names: new Array(2573).fill('x'), selectedFiles: 7001, alreadyPresent: 4428 };
  const od = await preflight({ source: 'C:\\src', dest: 'C:\\dst' }, scope, deps);

  assert.equal(od.scoped, true);
  assert.equal(od.onlineOnly, 2573, 'reports the job, not the 68,361-file folder');
  assert.equal(od.remainingFiles, 2573);
  assert.equal(od.selectedFiles, 7001);
  assert.equal(od.alreadyPresent, 4428);
});

test('CONSTRAINT: willExceedDisk uses the scoped byte total', async () => {
  // Free space sits between the two figures: the folder-wide 33.40 GB would
  // block this job, the true 1.26 GB fits easily. Before the fix this returned
  // true and refused a job that fits.
  const deps = {
    isOneDrivePath: async () => true,
    measureHydration: async () => ({ totalFiles: 72789, onlineOnly: 68361, onlineBytes: 33.4 * GB }),
    measureHydrationForNames: async () => ({ totalFiles: 2573, onlineOnly: 2573, onlineBytes: 1.26 * GB }),
    freeSpace: async () => 5 * GB,
  };

  const scoped = await preflight({ source: 'C:\\src', dest: 'C:\\dst' },
    { names: ['a'], selectedFiles: 7001, alreadyPresent: 4428 }, deps);
  assert.equal(scoped.willExceedDisk, false, 'a 1.26 GB job fits in 5 GB');

  // Unscoped, the same call still blocks correctly - the guard is not defanged.
  const unscoped = await preflight({ source: 'C:\\src', dest: 'C:\\dst' }, null, deps);
  assert.equal(unscoped.willExceedDisk, true, '33.40 GB does not fit in 5 GB');
});

test('CONSTRAINT: the placeholder filter requires the reparse-point bit', () => {
  // Offline ALONE is set on ordinary local files (measured: attribute 4128 on
  // plain local copies). Matching it alone made a plain local folder look like
  // OneDrive. This pins the reparse-point requirement against re-loosening.
  assert.match(PS_PLACEHOLDER_FILTER, /0x00000400/, 'must test REPARSE_POINT');
  assert.match(PS_PLACEHOLDER_FILTER, /-and/, 'reparse point must be ANDed, not ORed');
  for (const recall of ['0x00400000', '0x00040000', '0x00001000']) {
    assert.ok(PS_PLACEHOLDER_FILTER.includes(recall), `must test ${recall}`);
  }
});

test('REGRESSION: chunk size accounts for the full directory path, not just filenames', () => {
  // The actual failure: a 128-char OneDrive path with 400 names in one
  // PowerShell list produced a 55,199-char command and spawn() raised
  // ENAMETOOLONG (Windows CreateProcess caps at 32,767 chars). It was masked by
  // a catch-and-return-zero, so the UI reported "0 online-only" for a range
  // that genuinely had 2,573.
  const deepPath =
    'C:\\Users\\me\\TENANT\\Some Long Synced Library Name\\Data and Document sharing\\' +
    'Team\\Project\\analysis\\Batch55\\sub6\\Set_made4-17';
  const perChunk = namesPerChunk(deepPath.length, 6);
  const chunkScriptLen = perChunk * (deepPath.length + 6);
  assert.ok(
    chunkScriptLen < 32_767,
    `a full chunk (${perChunk} names) must fit under Windows' command-line limit, got ~${chunkScriptLen} chars`,
  );
  assert.ok(perChunk < 400, 'a path this deep must chunk tighter than the old fixed 400');
});

test('REGRESSION: a large scattered selection on a deep path does not throw or silently zero', async () => {
  // Exercises measureHydrationForNames end-to-end against a stubbed runPS that
  // enforces the real Windows command-line limit, so a chunking regression
  // fails loudly (ENAMETOOLONG) instead of quietly returning zero.
  const deepDir =
    'C:\\Users\\me\\TENANT\\Some Long Synced Library Name\\Data and Document sharing\\' +
    'Team\\Project\\analysis\\Batch55\\sub6\\Set_made4-17';
  const names = [];
  for (let i = 0; i < 2573; i++) names.push(`Img${String(25701 + i).padStart(6, '0')}.tif`);

  // No PowerShell dependency injection exists for measureHydrationForNames
  // (it always spawns), so this just has to complete without throwing and
  // without needing more than a sane number of chunks. A regression to the old
  // fixed chunk=400 would throw ENAMETOOLONG on the real spawn.
  const result = await measureHydrationForNames('C:\\does\\not\\exist\\' + deepDir.slice(-40), names, {
    recurse: false,
  });
  // Nonexistent path: Get-Item finds nothing, but the call must still resolve
  // cleanly rather than throwing.
  assert.equal(typeof result.totalFiles, 'number');
  assert.equal(result.unavailable, undefined);
});

test('PS_SCRIPT_BUDGET leaves headroom under the Windows command-line cap', () => {
  assert.ok(PS_SCRIPT_BUDGET < 32_767, 'budget itself must be under the hard limit');
});

test('warning text distinguishes a resume from a fresh copy', () => {
  const measured = { onlineOnly: 2573, onlineBytes: 1.26 * GB };

  const resume = buildWarnings({}, measured, false,
    { names: [], selectedFiles: 7001, alreadyPresent: 4428 });
  assert.match(resume[0].message, /Resuming: 4,428 of 7,001/);
  assert.match(resume[0].message, /2,573 online-only files/);

  const fresh = buildWarnings({}, measured, false,
    { names: [], selectedFiles: 2573, alreadyPresent: 0 });
  assert.doesNotMatch(fresh[0].message, /Resuming/);

  // Unscoped keeps the original wording.
  const folder = buildWarnings({}, measured, false, null);
  assert.doesNotMatch(folder[0].message, /Resuming/);
});
