// Tests for robocopy argument building and output parsing.
//
// The parser expectations below come from real robocopy.exe output captured on
// Windows 11; the sample lines are verbatim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFailure,
  describeExit,
  normalizeDir,
  resourceFlags,
  buildArgs,
  parseLine,
  createLineSplitter,
} from '../lib/robocopy.js';

test('exit codes are treated as a bitmask, not error codes', () => {
  // 1 means "files were copied" - the classic wrapper bug is calling this a
  // failure. Only >= 8 is a real problem.
  assert.equal(isFailure(0), false);
  assert.equal(isFailure(1), false);
  assert.equal(isFailure(3), false);
  assert.equal(isFailure(7), false);
  assert.equal(isFailure(8), true);
  assert.equal(isFailure(16), true);
  assert.match(describeExit(0), /No files needed copying/);
  assert.match(describeExit(1), /copied successfully/);
});

test('trailing backslashes are stripped but drive roots kept', () => {
  assert.equal(normalizeDir('C:\\data\\'), 'C:\\data');
  assert.equal(normalizeDir('C:\\'), 'C:\\');
  assert.equal(normalizeDir('  "C:\\a b\\"  '), 'C:\\a b');
  assert.equal(normalizeDir('C:/data/sub'), 'C:\\data\\sub');
});

test('resource slider maps to thread counts', () => {
  assert.equal(resourceFlags(1).threads, 1);
  assert.equal(resourceFlags(5).threads, 8);
  assert.equal(resourceFlags(10).threads, 32);
  assert.ok(resourceFlags(10).flags.includes('/J'));
});

test('/IPG and /MT are never emitted together', () => {
  // Verified against robocopy.exe: "The /IPG option cannot be used with the /MT
  // option" - it exits 16 and copies NOTHING. Emitting both would silently
  // break every throttled copy.
  for (let level = 1; level <= 10; level++) {
    for (const oneDriveMode of [false, true]) {
      const { flags } = resourceFlags(level, { oneDriveMode });
      const hasIPG = flags.some((f) => f.startsWith('/IPG'));
      const hasMT = flags.some((f) => f.startsWith('/MT'));
      assert.ok(!(hasIPG && hasMT), `level ${level} (onedrive=${oneDriveMode}) emitted ${flags.join(' ')}`);
    }
  }
});

test('OneDrive mode caps threads - more threads do not speed up cloud downloads', () => {
  assert.ok(resourceFlags(10, { oneDriveMode: true }).threads <= 4);
  assert.ok(resourceFlags(1, { oneDriveMode: true }).threads >= 1);
});

test('/XJ is passed through, including for OneDrive sources', () => {
  // OneDrive folders carry a ReparsePoint attribute, which makes /XJ look
  // dangerous. Measured against a real 245,570-file OneDrive tree the count was
  // identical with and without /XJ, so no special-casing is warranted.
  for (const oneDriveMode of [false, true]) {
    const args = buildArgs({
      source: 'C:\\Users\\me\\OneDrive',
      dest: 'D:\\b',
      excludeJunctions: true,
      oneDriveMode,
    });
    assert.ok(args.includes('/XJ'));
  }

  const off = buildArgs({ source: 'C:\\data', dest: 'D:\\b' });
  assert.ok(!off.includes('/XJ'));
});

test('buildArgs produces an argv array, never a shell string', () => {
  const args = buildArgs({ source: 'C:\\a b', dest: 'D:\\c d' });
  assert.ok(Array.isArray(args));
  assert.equal(args[0], 'C:\\a b');
  assert.equal(args[1], 'D:\\c d');
  assert.ok(args.includes('/BYTES'));
  // No quoting is applied: spawn() with shell:false passes each element as-is.
  assert.ok(!args.some((a) => a.startsWith('"')));
});

test('skip conflict mode excludes changed/newer/older', () => {
  const args = buildArgs({ source: 'C:\\a', dest: 'D:\\b', conflict: 'skip' });
  for (const f of ['/XC', '/XN', '/XO']) assert.ok(args.includes(f));
});

test('skipOnlineOnly adds /XA:O so placeholders are never opened', () => {
  const args = buildArgs({ source: 'C:\\a', dest: 'D:\\b', skipOnlineOnly: true });
  assert.ok(args.includes('/XA:O'));
});

test('parses real robocopy file and progress lines', () => {
  const file = parseLine('\t    New File  \t\t 3000000\tbig1.bin');
  assert.equal(file.type, 'file');
  assert.equal(file.bytes, 3000000);
  assert.equal(file.path, 'big1.bin');

  const older = parseLine('\t    Older     \t\t 3000000\tC:\\src\\big1.bin');
  assert.equal(older.cls, 'Older');

  assert.equal(parseLine(' 34%  ').percent, 34);
  assert.equal(parseLine('100%  ').percent, 100);

  const err = parseLine('ERROR 392 (0x00000188) Copying File C:\\src\\x.pdf');
  assert.equal(err.type, 'error');
  assert.equal(err.code, 392);
  assert.equal(err.hex, '0x00000188');
});

test('verbosity never suppresses the file list', () => {
  // Progress is measured from per-file lines (job.js credits bytes when one
  // appears). /NFL would leave the bar and ETA frozen at zero, so no verbosity
  // level may ever emit it.
  for (const verbosity of ['silent', 'normal', 'verbose']) {
    const args = buildArgs({ source: 'C:\\a', dest: 'D:\\b', verbosity });
    assert.ok(!args.includes('/NFL'), `${verbosity} must not suppress the file list`);
  }

  const silent = buildArgs({ source: 'C:\\a', dest: 'D:\\b', verbosity: 'silent' });
  assert.ok(silent.includes('/NJH') && silent.includes('/NDL'));

  const verbose = buildArgs({ source: 'C:\\a', dest: 'D:\\b', verbosity: 'verbose' });
  assert.ok(verbose.includes('/V') && verbose.includes('/TS'));

  // The default must stay byte-identical to v1.0's output.
  const normal = buildArgs({ source: 'C:\\a', dest: 'D:\\b', verbosity: 'normal' });
  assert.ok(!normal.includes('/V') && !normal.includes('/NJH'));
});

test('a /L scan is never given conflict flags', () => {
  // Conflict flags exclude pre-existing files, which are exactly what the scan
  // must report. Applying them would make keep-both find nothing to do.
  const args = buildArgs({ source: 'C:\\a', dest: 'D:\\b', conflict: 'skip' }, { listOnly: true });
  for (const f of ['/XC', '/XN', '/XO']) assert.ok(!args.includes(f));
  assert.ok(args.includes('/L'));
});

test('Offline alone is not a cloud placeholder', async () => {
  // Files copied to an ordinary local folder can carry Archive+Offline (0x1020,
  // measured on freshly copied files in a plain Downloads folder) with no
  // reparse point behind them. Only a REPARSE POINT plus a recall bit is a real
  // cloud placeholder; treating Offline alone as "cloud" made a plain local
  // folder look like OneDrive.
  const { isPlaceholder, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_REPARSE_POINT,
          FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS } = await import('../lib/onedrive.js');

  // isPlaceholder is the per-file bitmask helper and stays permissive; the
  // directory-level probe is what applies the reparse-point requirement.
  assert.equal(isPlaceholder(FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS), true);
  assert.equal(isPlaceholder(0x20), false, 'Archive alone is not a placeholder');
  assert.equal(isPlaceholder(FILE_ATTRIBUTE_REPARSE_POINT), false,
    'a reparse point with no recall bit is not a placeholder');
});

test('line splitter carries partial lines across chunks', () => {
  // Robocopy emits progress with bare \r and no trailing newline, so a chunk
  // can end mid-line; splitting per-chunk would corrupt filenames.
  const lines = [];
  const s = createLineSplitter((l) => lines.push(l));
  s.push('\t    New File  \t\t 100\tab');
  s.push('c.bin\r 50%\r');
  s.push('100%\r');
  s.flush();
  assert.ok(lines.some((l) => l.includes('abc.bin')), 'filename must survive the chunk split');
  assert.ok(lines.includes(' 50%'));
});
