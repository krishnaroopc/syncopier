// Tests for the deferred-retry loop.
//
// retryRounds() used to stop after a fixed 3-round cap (~7.5 min of total
// backoff) and report anything still failing as permanently failed. Under
// sustained OneDrive throttling that gave up on files that were still
// perfectly recoverable - they just needed the sync engine to settle for
// longer than 7.5 minutes. It is now unbounded: the only exits are the queue
// draining to empty, or the caller cancelling via shouldStop.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createQueue, retryRounds, DEFAULT_BACKOFF_MS } from '../lib/retry.js';

let jobCounter = 0;
const createdQueueFiles = [];
// Distinct jobId per test so createQueue's real (debounced, best-effort) file
// persistence never collides between tests or with a real job's queue file.
function freshQueue() {
  jobCounter += 1;
  const q = createQueue(`test-retry-${Date.now()}-${jobCounter}`);
  createdQueueFiles.push(q.file);
  return q;
}

// createQueue's persistNow() debounces writes 500ms and is best-effort, so
// queue files this suite creates in the real ~/.syncopier/jobs directory may
// land after the test that created them finishes. Give the debounce time to
// settle, then remove anything this run wrote.
after(async () => {
  await new Promise((r) => setTimeout(r, 600));
  await Promise.all(createdQueueFiles.map((f) => fs.rm(f, { force: true }).catch(() => {})));
});

// classifyError() (lib/onedrive.js) treats unrecognized codes as transient and
// specific codes (2, 3, 5, 32, 80, 206) as permanent. These pick one of each
// without depending on the exact throttling codes, which may change.
const TRANSIENT_CODE = 392; // pinned cloud file - a real OneDrive throttling code
const PERMANENT_CODE = 2; // file not found

test('REGRESSION: retries continue past the old 3-round cap', async () => {
  const queue = freshQueue();
  queue.add({ path: 'C:\\src\\stuck.tif', size: 100, code: TRANSIENT_CODE, text: 'file unavailable' });

  let calls = 0;
  const res = await retryRounds(
    queue,
    { source: 'C:\\src', dest: 'C:\\dst' },
    {
      backoff: [1, 1, 1, 1, 1, 1], // near-zero waits so the test runs fast
      deps: {
        runRobocopy: async () => {
          calls += 1;
          // Fails on rounds 1-4 (the old cap), only succeeds on round 5 -
          // proving the loop did not stop at round 3/4 the way it used to.
          return calls < 5 ? 8 : 0; // isFailure(code) is `code >= 8`
        },
      },
    },
  );

  assert.equal(calls, 5, 'must have kept retrying past the old 3-round cap');
  assert.deepEqual(res.recovered, ['C:\\src\\stuck.tif']);
  assert.equal(res.remaining.length, 0, 'the file must end up recovered, not abandoned');
});

test('a permanently-classified error is never retried', async () => {
  const queue = freshQueue();
  queue.add({ path: 'C:\\src\\gone.tif', size: 100, code: PERMANENT_CODE, text: 'file not found' });

  let calls = 0;
  const res = await retryRounds(
    queue,
    { source: 'C:\\src', dest: 'C:\\dst' },
    {
      backoff: [1],
      deps: { runRobocopy: async () => { calls += 1; return 0; } },
    },
  );

  assert.equal(calls, 0, 'a permanent failure must never enter the retry loop');
  assert.deepEqual(res.recovered, []);
  // Still present in the full list (it is a real, reportable failure) but
  // excluded from `transient()`, which is what the loop iterates.
  assert.equal(queue.permanent().length, 1);
});

test('shouldStop halts the loop immediately, including mid-wait', async () => {
  const queue = freshQueue();
  queue.add({ path: 'C:\\src\\a.tif', size: 100, code: TRANSIENT_CODE, text: 'x' });
  queue.add({ path: 'C:\\src\\b.tif', size: 100, code: TRANSIENT_CODE, text: 'x' });

  let cancelled = false;
  let robocopyCalls = 0;

  const resultPromise = retryRounds(
    queue,
    { source: 'C:\\src', dest: 'C:\\dst' },
    {
      backoff: [5000], // long enough that the test would time out if not interrupted
      shouldStop: () => cancelled,
      deps: { runRobocopy: async () => { robocopyCalls += 1; return 0; } },
    },
  );

  // Cancel almost immediately, while still inside the wait tick.
  await new Promise((r) => setTimeout(r, 20));
  cancelled = true;

  const res = await resultPromise;
  assert.equal(robocopyCalls, 0, 'must not have reached a retry attempt before stopping');
  assert.equal(res.remaining.length, 2, 'cancellation must leave items in the queue, unresolved');
});

test('backoff grows per round then plateaus at the last configured entry', () => {
  // Mirrors the internal lookup in retryRounds: backoff[min(round-1, len-1)].
  const lookup = (round) => DEFAULT_BACKOFF_MS[Math.min(round - 1, DEFAULT_BACKOFF_MS.length - 1)];

  assert.equal(lookup(1), 30_000);
  assert.equal(lookup(2), 60_000);
  assert.equal(lookup(3), 120_000);
  assert.equal(lookup(4), 300_000);
  // Round 10 - far past the array length - must plateau at the last entry,
  // not grow unboundedly or throw.
  assert.equal(lookup(10), 300_000);
  assert.equal(lookup(4), lookup(10), 'pacing must not degrade the longer a job keeps retrying');
});

test('retry-summary is only non-empty when the job was cancelled', async () => {
  // With no round cap, `remaining` can only be non-empty if shouldStop() fired
  // mid-loop - an uncapped loop has no other way to exit with pending items.
  const queue = freshQueue();
  queue.add({ path: 'C:\\src\\x.tif', size: 100, code: TRANSIENT_CODE, text: 'x' });

  const res = await retryRounds(
    queue,
    { source: 'C:\\src', dest: 'C:\\dst' },
    {
      backoff: [1],
      deps: { runRobocopy: async () => 0 }, // succeeds immediately
    },
  );

  assert.equal(res.remaining.length, 0);
  assert.equal(queue.size, 0, 'a fully recovered queue must end up empty');
});
