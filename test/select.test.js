// Tests for numeric-range selection.
//
// The boundary-exactness test below is the important one. Robocopy globs cannot
// express a numeric range: covering file000234..file001234 with globs also
// matches file000230-000233 and file001235-001239. That was verified against the
// real robocopy.exe, and a glob-only implementation would silently copy those
// nine extra files. If this test ever fails, Syncopier is copying files the user
// did not ask for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNumbered,
  parseRange,
  formatName,
  globCover,
  filterExact,
  batchNames,
  resolveSelection,
  ARG_BUDGET,
} from '../lib/select.js';

test('REGRESSION: already-copied files are not reported as missing', async () => {
  // The v1.0 bug. Robocopy prints a per-file line only for files it would ACT
  // on; a file already present identically at the destination is counted under
  // "Skipped" and produces NO line at all. Verified on a real run: 100 files in
  // range came back as `Files: 100  Skipped: 100` with zero file lines.
  //
  // v1.0 inferred existence from those lines, so a fully-copied range looked
  // exactly like a range whose files were never there - and it told the user
  // 7,001 present files were missing.
  //
  // The scan function must therefore enumerate the SOURCE independently of the
  // destination. This test pins that contract: given an enumerator that reports
  // every source file, nothing may be reported missing.
  const job = { selection: { mode: 'range', from: 'Img000001.tif', to: 'Img000005.tif' } };

  const sourceHasEverything = async () => ({
    files: [1, 2, 3, 4, 5].map((n) => ({
      path: `C:\\src\\Img00000${n}.tif`,
      bytes: 1000,
      cls: 'New File',
    })),
  });

  const sel = await resolveSelection(job, sourceHasEverything);
  assert.equal(sel.preview.matched, 5);
  assert.equal(sel.preview.missing.length, 0, 'present files must never be reported missing');
  assert.equal(sel.preview.missingTotal, 0);

  // And a genuinely absent file must still be caught - the fix must not paper
  // over real gaps.
  const sourceMissingTwo = async () => ({
    files: [1, 2, 5].map((n) => ({
      path: `C:\\src\\Img00000${n}.tif`,
      bytes: 1000,
      cls: 'New File',
    })),
  });
  const sel2 = await resolveSelection(job, sourceMissingTwo);
  assert.equal(sel2.preview.matched, 3);
  assert.deepEqual(sel2.preview.missing, ['Img000003.tif', 'Img000004.tif']);
  assert.equal(sel2.preview.missingTotal, 2);
});

test('missingTotal counts beyond the 100-item display cap', async () => {
  const job = { selection: { mode: 'range', from: 'f00001.d', to: 'f00500.d' } };
  const sel = await resolveSelection(job, async () => ({ files: [] }));
  assert.equal(sel.preview.missing.length, 100, 'display list stays capped');
  assert.equal(sel.preview.missingTotal, 500, 'but the total is honest');
});

test('parseNumbered keeps zero padding', () => {
  const p = parseNumbered('file000234.ext');
  assert.equal(p.prefix, 'file');
  assert.equal(p.suffix, '.ext');
  assert.equal(p.width, 6);
  assert.equal(p.value, 234);
});

test('parseNumbered uses the last digit run', () => {
  const p = parseNumbered('scan2024_000117.tif');
  assert.equal(p.value, 117);
  assert.equal(p.width, 6);
});

test('parseRange rejects mismatched input', () => {
  assert.throws(() => parseRange('a001.txt', 'b010.txt'), /prefix/);
  assert.throws(() => parseRange('f001.txt', 'f010.dat'), /extension/);
  assert.throws(() => parseRange('f1.txt', 'f000010.txt'), /padding/i);
  assert.throws(() => parseRange('f010.txt', 'f001.txt'), /backwards/);
  assert.throws(() => parseRange('x.txt', 'y.txt'), /no number/);
});

test('globCover covers the whole range', () => {
  const r = parseRange('file000234.ext', 'file001234.ext');
  const globs = globCover(r);
  assert.ok(globs.length > 0 && globs.length < 20, 'should be a small pattern set');
  // Every glob must be a valid robocopy wildcard for this prefix/suffix.
  for (const g of globs) assert.match(g, /^file[\d?]{6}\.ext$/);
});

test('BOUNDARY EXACTNESS: files just outside the range are excluded', () => {
  const r = parseRange('file000234.ext', 'file001234.ext');

  // Simulate what the /L scan returns for the globs: the real robocopy run
  // produced exactly this overshoot.
  const candidates = [];
  for (let n = 230; n <= 1239; n++) {
    candidates.push({ path: `C:\\src\\${formatName(r, n)}`, bytes: 100 });
  }

  const { kept, excluded } = filterExact(candidates, r);

  assert.equal(kept.length, 1001, 'exactly the requested range');
  assert.equal(kept[0].name, 'file000234.ext');
  assert.equal(kept.at(-1).name, 'file001234.ext');

  // The nine files a glob-only implementation would have wrongly copied.
  assert.deepEqual(
    excluded.map((e) => e.n),
    [230, 231, 232, 233, 1235, 1236, 1237, 1238, 1239],
  );
  assert.equal(kept.filter((k) => k.n < 234 || k.n > 1234).length, 0);
});

test('filterExact ignores files that only look similar', () => {
  const r = parseRange('file000234.ext', 'file001234.ext');
  const { kept } = filterExact(
    [
      { path: 'C:\\src\\file000500.ext' },   // in range
      { path: 'C:\\src\\file000500.txt' },   // wrong extension
      { path: 'C:\\src\\other000500.ext' },  // wrong prefix
      { path: 'C:\\src\\file0005000.ext' },  // wrong digit width
    ],
    r,
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name, 'file000500.ext');
});

test('batchNames stays under the Windows command-line limit', () => {
  const r = parseRange('file000234.ext', 'file001234.ext');
  const short = [];
  for (let n = 234; n <= 1234; n++) short.push(formatName(r, n));
  for (const b of batchNames(short)) {
    assert.ok(b.join(' ').length <= ARG_BUDGET);
  }

  // Long names: this range would be ~51,000 chars in a single call, well past
  // the 32,767-char CreateProcess limit, so it must split.
  const lr = parseRange(
    'a_very_long_descriptive_filename_prefix_000234.ext',
    'a_very_long_descriptive_filename_prefix_001234.ext',
  );
  const long = [];
  for (let n = 234; n <= 1234; n++) long.push(formatName(lr, n));
  assert.ok(long.join(' ').length > 32767, 'precondition: would overflow in one call');

  const batches = batchNames(long);
  assert.ok(batches.length > 1, 'must split into batches');
  for (const b of batches) assert.ok(b.join(' ').length <= ARG_BUDGET);
  assert.equal(batches.flat().length, long.length, 'no names lost');
});
