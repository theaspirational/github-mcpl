/**
 * state.ts — checkpoint lineage, rollback planning, and the atomic state file
 * (TASK-SRHKG.1.7).
 *
 * Every test works in its own temp directory; nothing here touches the network
 * or a real state file path.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GithubState, ROOT_BUCKET, STATE_VERSION, emptySnapshot, type GithubStateSnapshot } from '../src/state.js';
import { POLL_DEDUP_RING, POLL_HEAD_MEMORY, type Logger } from '../src/types.js';

const REPO = 'anima-research/rayforce';

function tempFile(name = 'state.json'): string {
  return join(mkdtempSync(join(tmpdir(), 'github-mcpl-state-')), name);
}

/** A Logger that keeps what it was told, so a test can assert on diagnostics. */
function capturingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: string) => {
    lines.push(`${level} ${message}`);
  };
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

function readSnapshot(file: string): GithubStateSnapshot {
  return JSON.parse(readFileSync(file, 'utf8')) as GithubStateSnapshot;
}

function strayTempFiles(file: string): string[] {
  const dir = join(file, '..');
  return readdirSync(dir).filter((n) => n.includes('.tmp-'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkpoint lineage (§8.2)
// ─────────────────────────────────────────────────────────────────────────────

test('checkpoints form a lineage, and a rollback branches it', async () => {
  const state = GithubState.empty();
  assert.equal(state.current(), null);

  const first = state.createCheckpoint();
  const second = state.createCheckpoint();
  assert.equal(first.parent, null);
  assert.equal(second.parent, first.id);
  assert.equal(state.current(), second.id);
  assert.ok(Date.parse(first.createdAt) > 0);
  assert.deepEqual(
    state.lineage().map((c) => [c.id, c.parent]),
    [
      [first.id, null],
      [second.id, first.id],
    ],
  );

  // Rolling back moves `current` back; the next checkpoint branches from there.
  assert.ok(state.rollback(first.id));
  assert.equal(state.current(), first.id);
  const branch = state.createCheckpoint();
  assert.equal(branch.parent, first.id);
  assert.equal(state.lineage().length, 3);
  assert.deepEqual(
    state.lineage().filter((c) => c.parent === first.id).map((c) => c.id),
    [second.id, branch.id],
  );
});

test('an unknown checkpoint plans nothing (the caller answers -32005)', () => {
  const state = GithubState.empty();
  state.createCheckpoint();
  assert.equal(state.rollback('chk_nope'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rollback planning
// ─────────────────────────────────────────────────────────────────────────────

test('rollback plans the writes recorded after the checkpoint, newest first', () => {
  const state = GithubState.empty();
  const base = state.createCheckpoint();

  state.recordCreatedComment({ repo: REPO, commentId: 11, review: false, thread: { number: 7, kind: 'issue' } });
  const afterFirst = state.createCheckpoint();
  state.recordCreatedComment({ repo: REPO, commentId: 12, review: true, thread: { number: 7, kind: 'pull' } });
  state.recordEditedComment({ repo: REPO, commentId: 5, previousBody: 'before', review: false });
  state.createCheckpoint();
  state.recordDeletedComment({ repo: REPO, commentId: 6, previousBody: 'gone', review: false });

  const plan = state.rollback(base.id);
  assert.ok(plan);
  assert.deepEqual(plan.created.map((c) => c.commentId), [12, 11]);
  assert.equal(plan.created[0].review, true);
  assert.deepEqual(plan.created[1].thread, { number: 7, kind: 'issue' });
  assert.deepEqual(plan.edited.map((e) => [e.commentId, e.previousBody]), [[5, 'before']]);
  assert.deepEqual(plan.deleted.map((d) => d.commentId), [6]);

  // The buckets are consumed: a second rollback to the same checkpoint is a
  // no-op, not a double undo.
  const again = state.rollback(base.id);
  assert.ok(again);
  assert.deepEqual(again, { created: [], edited: [], deleted: [] });
  // The checkpoints the first rollback left behind are no longer rollable:
  // their undo records are spent and nothing can rebuild the state they named.
  assert.equal(state.checkpointStatus(afterFirst.id), 'abandoned');
  assert.equal(state.rollback(afterFirst.id), null);
});

test('a rollback leaves alone what was written before the checkpoint existed', () => {
  const state = GithubState.empty();
  state.recordCreatedComment({ repo: REPO, commentId: 1, review: false });
  const base = state.createCheckpoint();
  state.recordCreatedComment({ repo: REPO, commentId: 2, review: false });

  const plan = state.rollback(base.id);
  assert.ok(plan);
  assert.deepEqual(plan.created.map((c) => c.commentId), [2]);
  assert.deepEqual(state.snapshot().created[ROOT_BUCKET].map((c) => c.commentId), [1]);
});

test('two edits of one comment restore the oldest body last', () => {
  const state = GithubState.empty();
  const base = state.createCheckpoint();
  state.recordEditedComment({ repo: REPO, commentId: 5, previousBody: 'first', review: false });
  state.recordEditedComment({ repo: REPO, commentId: 5, previousBody: 'second', review: false });

  const plan = state.rollback(base.id);
  assert.ok(plan);
  // Applied in order, the last write wins, so the oldest body is the one left.
  assert.deepEqual(plan.edited.map((e) => e.previousBody), ['second', 'first']);
});

// ─────────────────────────────────────────────────────────────────────────────
// The state file
// ─────────────────────────────────────────────────────────────────────────────

test('flush writes a versioned state file atomically and leaves no temp file', async () => {
  const file = tempFile();
  const state = GithubState.load(file);
  const cp = state.createCheckpoint();
  state.recordCreatedComment({ repo: REPO, commentId: 11, review: false });
  state.setLastPollAt('2026-10-14T00:00:00.000Z');
  await state.flush();

  const written = readSnapshot(file);
  assert.equal(written.version, STATE_VERSION);
  assert.equal(written.current, cp.id);
  assert.deepEqual(written.created[cp.id].map((c) => c.commentId), [11]);
  assert.equal(written.lastPollAt, '2026-10-14T00:00:00.000Z');
  assert.deepEqual(strayTempFiles(file), []);
  // The file holds this server's bookkeeping; no group or other access.
  assert.equal(statSync(file).mode & 0o077, 0);
});

test('a flushed state reloads with its lineage and its rollback reach', async () => {
  const file = tempFile();
  const first = GithubState.load(file);
  const base = first.createCheckpoint();
  first.recordCreatedComment({ repo: REPO, commentId: 11, review: false, thread: { number: 7, kind: 'issue' } });
  first.createCheckpoint();
  first.recordEditedComment({ repo: REPO, commentId: 5, previousBody: 'before', review: false });
  await first.flush();

  const reloaded = GithubState.load(file);
  assert.equal(reloaded.lineage().length, 2);
  assert.equal(reloaded.current(), first.current());
  const plan = reloaded.rollback(base.id);
  assert.ok(plan);
  assert.deepEqual(plan.created.map((c) => c.commentId), [11]);
  assert.deepEqual(plan.edited.map((e) => e.previousBody), ['before']);
});

test('a crash between the write and the rename never replaces the state', () => {
  const file = tempFile();
  // node:fs/promises' named exports, as state.ts imports them, follow a change
  // to its CommonJS exports only once syncBuiltinESMExports() has run.
  const firstFlush = `${file}.first-flush`;
  const crash = `
    import { copyFileSync } from 'node:fs';
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    import { GithubState } from ${JSON.stringify(new URL('../src/state.ts', import.meta.url).href)};
    const state = GithubState.load(${JSON.stringify(file)});
    state.createCheckpoint();
    state.recordCreatedComment({ repo: ${JSON.stringify(REPO)}, commentId: 11, review: false });
    await state.flush();
    copyFileSync(${JSON.stringify(file)}, ${JSON.stringify(firstFlush)});
    createRequire(import.meta.url)('node:fs/promises').rename = () => process.exit(7);
    syncBuiltinESMExports();
    state.recordCreatedComment({ repo: ${JSON.stringify(REPO)}, commentId: 12, review: false });
    await state.flush();
  `;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', crash], { encoding: 'utf8' });
  assert.equal(r.status, 7, `the second flush should have stopped at its rename:\n${r.stderr}`);

  assert.equal(readFileSync(file, 'utf8'), readFileSync(firstFlush, 'utf8'), 'the state file is the first flush\'s, byte for byte');
  const reloaded = GithubState.load(file);
  const [cp] = reloaded.lineage();
  assert.deepEqual(reloaded.rollback(cp.id)?.created.map((c) => c.commentId), [11]);
});

test('concurrent flushes serialize and the file always parses', async () => {
  const file = tempFile();
  const state = GithubState.load(file);
  state.createCheckpoint();
  const flushes = [state.flush(), state.flush(), state.flush()];
  state.setLastPollAt('2026-10-14T01:00:00.000Z');
  flushes.push(state.flush());
  await Promise.all(flushes);

  assert.equal(readSnapshot(file).lastPollAt, '2026-10-14T01:00:00.000Z');
  assert.deepEqual(strayTempFiles(file), []);
});

test('a damaged or foreign state file starts empty with one stderr line', () => {
  const broken = tempFile();
  writeFileSync(broken, '{"version":1,"checkpoints":[');
  const log = capturingLogger();
  const fromBroken = GithubState.load(broken, log);
  assert.deepEqual(fromBroken.lineage(), []);
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /^warn state: .*not valid JSON/);

  const future = tempFile();
  writeFileSync(future, JSON.stringify({ version: STATE_VERSION + 1, checkpoints: [{ id: 'chk_x' }] }));
  const futureLog = capturingLogger();
  assert.deepEqual(GithubState.load(future, futureLog).lineage(), []);
  assert.match(futureLog.lines[0], /not a version 1 snapshot/);

  // An absent file is the normal first start: no diagnostics at all.
  const fresh = capturingLogger();
  assert.deepEqual(GithubState.load(tempFile(), fresh).lineage(), []);
  assert.deepEqual(fresh.lines, []);
});

test('without a state file the store works in memory and flush is a no-op', async () => {
  const state = GithubState.empty();
  const cp = state.createCheckpoint();
  state.recordCreatedComment({ repo: REPO, commentId: 11, review: false });
  await state.flush();
  assert.equal(state.file, null);
  assert.equal(state.current(), cp.id);
});

// ─────────────────────────────────────────────────────────────────────────────
// Poll cursor and dedup ring (amendment 1)
// ─────────────────────────────────────────────────────────────────────────────

test('the poll dedup ring remembers the last 2000 keys and no more', () => {
  const state = GithubState.empty();
  assert.equal(state.lastPollAt(), null);
  state.setLastPollAt('2026-10-14T00:00:00.000Z');
  assert.equal(state.lastPollAt(), '2026-10-14T00:00:00.000Z');

  assert.equal(state.seenPollKey('comment:1:t0'), false);
  assert.equal(state.seenPollKey('comment:1:t0'), true);
  // A new updated_at is a new key: an edit of the same comment is not a replay.
  assert.equal(state.seenPollKey('comment:1:t1'), false);

  for (let i = 0; i < POLL_DEDUP_RING; i++) state.seenPollKey(`issue:${i}:t`);
  assert.equal(state.snapshot().pollKeys.length, POLL_DEDUP_RING);
  // The oldest keys fell out of the ring, the newest are still there.
  assert.equal(state.seenPollKey('comment:1:t0'), false);
  assert.equal(state.seenPollKey(`issue:${POLL_DEDUP_RING - 1}:t`), true);
});

test('the polled heads are bounded, oldest out first, and re-recording a head refreshes its place', async () => {
  const state = GithubState.empty();
  assert.equal(state.polledHead('github:anima-research/rayforce#58'), null);
  state.setPolledHead('github:anima-research/rayforce#58', 'a'.repeat(40));
  assert.equal(state.polledHead('github:anima-research/rayforce#58'), 'a'.repeat(40));
  // Last write wins: this is "the head the last pass saw", not a history.
  state.setPolledHead('github:anima-research/rayforce#58', 'b'.repeat(40));
  assert.equal(state.polledHead('github:anima-research/rayforce#58'), 'b'.repeat(40));

  // Bounded, and the *oldest* entry is the one that goes.
  for (let i = 0; i < POLL_HEAD_MEMORY; i++) state.setPolledHead(`github:${REPO}#${1000 + i}`, 'c'.repeat(40));
  assert.equal(Object.keys(state.snapshot().pollHeads).length, POLL_HEAD_MEMORY);
  assert.equal(state.polledHead('github:anima-research/rayforce#58'), null);
  assert.equal(state.polledHead(`github:${REPO}#${1000 + POLL_HEAD_MEMORY - 1}`), 'c'.repeat(40));

  // Re-recording an unchanged head refreshes its place in the eviction order,
  // so a pull request polled every minute is not evicted ahead of heads
  // nobody has looked at since.
  const oldest = `github:${REPO}#1000`;
  state.setPolledHead(oldest, 'c'.repeat(40));
  state.setPolledHead(`github:${REPO}#9999`, 'd'.repeat(40));
  assert.equal(state.polledHead(oldest), 'c'.repeat(40));
  assert.equal(state.polledHead(`github:${REPO}#1001`), null);
});

test('a state file written before amendment 2a still loads, with no heads known', () => {
  const file = tempFile();
  // A version-1 snapshot from before `pollHeads` existed: the field is
  // additive, so this is still a valid file and not a damaged one.
  writeFileSync(
    file,
    JSON.stringify({
      version: STATE_VERSION,
      checkpoints: [],
      current: null,
      created: {},
      edited: {},
      deleted: {},
      lastPollAt: '2026-10-14T00:00:00.000Z',
      pollKeys: ['issue:1:t0'],
    }),
  );
  const log = capturingLogger();
  const state = GithubState.load(file, log);
  // Loaded, not reset: the cursor and the ring are the ones on disk.
  assert.equal(state.lastPollAt(), '2026-10-14T00:00:00.000Z');
  assert.equal(state.seenPollKey('issue:1:t0'), true);
  assert.deepEqual(state.snapshot().pollHeads, {});
  // Nor per-list cursors, so every list starts from `lastPollAt`.
  assert.deepEqual(state.pollCursors(), {});
  assert.deepEqual(state.polledNew(), {});
  assert.deepEqual(log.lines, []);
});

test('poll cursors and announced rows round-trip through a flush, and a cursor without an instant is dropped', async () => {
  const file = tempFile();
  const first = GithubState.load(file, capturingLogger());
  first.setPollCursors({
    'anima-research/rayforce:issues': { since: '2026-10-14T00:00:00.000Z', resumeAt: '2026-10-14T06:00:00Z' },
    'anima-research/rayforce:issue_comments': { since: '2026-10-14T07:00:00.000Z' },
  });
  first.setPolledNew({ 'anima-research/rayforce:issues': { '7': '2026-10-14T01:00:00Z' } });
  await first.flush();
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  onDisk.pollCursors = {
    ...(onDisk.pollCursors as object),
    'x/y:issues': { resumeAt: '2026-10-14T06:00:00Z' },
    'x/y:issue_comments': 'w',
    'x/y:review_comments': null,
    'x/z:issues': { since: 'not a time' },
    'x/z:issue_comments': { since: '2026-10-14T07:00:00.000Z', resumeAt: 'not a time' },
  };
  onDisk.pollNew = {
    ...(onDisk.pollNew as object),
    'x/y:issues': ['a'],
    'x/z:issues': { '3': 5, '4': '2026-10-14T02:00:00Z' },
  };
  writeFileSync(file, JSON.stringify(onDisk));

  const loaded = GithubState.load(file, capturingLogger());
  assert.deepEqual(loaded.pollCursors(), {
    'anima-research/rayforce:issues': { since: '2026-10-14T00:00:00.000Z', resumeAt: '2026-10-14T06:00:00Z' },
    'anima-research/rayforce:issue_comments': { since: '2026-10-14T07:00:00.000Z' },
    'x/z:issue_comments': { since: '2026-10-14T07:00:00.000Z' },
  });
  assert.deepEqual(loaded.polledNew(), {
    'anima-research/rayforce:issues': { '7': '2026-10-14T01:00:00Z' },
    'x/y:issues': {},
    'x/z:issues': { '4': '2026-10-14T02:00:00Z' },
  });
});

test('a lastPollAt that is not an instant loads as none, says so, and keeps the rest, cursors included', () => {
  const file = tempFile();
  const checkpoint = { id: 'chk_1', parent: null, createdAt: '2026-10-14T00:00:00.000Z' };
  writeFileSync(
    file,
    JSON.stringify({ version: STATE_VERSION, checkpoints: [checkpoint], current: 'chk_1', created: {}, edited: {}, deleted: {}, lastPollAt: 'soon', pollKeys: ['issue:1:t0'], pollCursors: { 'x/y:issues': { since: '2026-10-14T00:00:00.000Z' } } }),
  );
  const log = capturingLogger();
  const state = GithubState.load(file, log);
  assert.equal(state.lastPollAt(), null);
  assert.equal(state.current(), 'chk_1');
  assert.equal(state.seenPollKey('issue:1:t0'), true);
  assert.deepEqual(state.pollCursors(), { 'x/y:issues': { since: '2026-10-14T00:00:00.000Z' } });
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /lastPollAt that isn't a time/);
});

test('a lastPollAt that is null or left out loads quietly', () => {
  for (const lastPollAt of [null, undefined]) {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({ version: STATE_VERSION, checkpoints: [], current: null, created: {}, edited: {}, deleted: {}, lastPollAt, pollKeys: [] }),
    );
    const log = capturingLogger();
    assert.equal(GithubState.load(file, log).lastPollAt(), null);
    assert.deepEqual(log.lines, [], `lastPollAt ${String(lastPollAt)}`);
  }
});

test('a polled head round-trips through a flush (amendment 2a)', async () => {
  const file = tempFile();
  const first = GithubState.load(file, capturingLogger());
  first.setPolledHead('github:anima-research/rayforce#58', 'e'.repeat(40));
  await first.flush();

  const reloaded = GithubState.load(file, capturingLogger());
  assert.equal(reloaded.polledHead('github:anima-research/rayforce#58'), 'e'.repeat(40));
  // A non-string value in the file is dropped rather than trusted.
  const raw = readSnapshot(file) as unknown as { pollHeads: Record<string, unknown> };
  raw.pollHeads['github:anima-research/rayforce#59'] = 42;
  writeFileSync(file, JSON.stringify(raw));
  const third = GithubState.load(file, capturingLogger());
  assert.equal(third.polledHead('github:anima-research/rayforce#59'), null);
  assert.equal(third.polledHead('github:anima-research/rayforce#58'), 'e'.repeat(40));
});

test('a checkpoint abandoned by an earlier rollback is refused, not accepted empty', () => {
  const state = GithubState.empty();
  const a = state.createCheckpoint();
  state.recordEditedComment({ repo: REPO, commentId: 5, previousBody: 'A', review: false });
  const b = state.createCheckpoint();

  assert.equal(state.checkpointStatus(a.id), 'live');
  assert.equal(state.checkpointStatus(b.id), 'live');
  assert.ok(state.rollback(a.id));

  // The rollback spent A's records and moved off B's branch. B named a state
  // this server can no longer rebuild, so it stops being rollable — answering
  // it with an empty plan would report a restoration that never happened.
  state.recordEditedComment({ repo: REPO, commentId: 5, previousBody: 'A', review: false });
  assert.equal(state.checkpointStatus(b.id), 'abandoned');
  assert.equal(state.rollback(b.id), null);
  // A itself stays live: it is still the current lineage.
  assert.equal(state.checkpointStatus(a.id), 'live');
  assert.ok(state.rollback(a.id));
  assert.equal(state.checkpointStatus('chk_never'), 'unknown');
});

test('a notifications watermark that does not read as an instant is dropped on load, with its Last-Modified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-state-'));
  const file = join(dir, 'state.json');
  const snap = emptySnapshot();
  writeFileSync(
    file,
    JSON.stringify({
      ...snap,
      notifications: {
        since: 'not a time',
        lastModified: 'Wed, 15 Oct 2026 00:00:00 GMT',
        retry: [
          { owner: 'o', name: 'n', number: 1, kind: 'issue', attempts: 2 },
          { bogus: true },
          { owner: 'o', name: 'n', number: 10, kind: 'issue', attempts: 5, updatedAt: 'bad-date' },
          { owner: 'o', name: 'n', number: 11, kind: 'issue', attempts: 5, stopped: 'yes' },
          { owner: 'o', name: 'n', number: 12, kind: 'issue', attempts: 5, dropAnnounced: 'yes' },
          { owner: 'o', name: 'n', number: 0, kind: 'issue', attempts: 0 },
          { owner: '', name: 'n', number: 2, kind: 'issue', attempts: 0 },
          { owner: 'o', name: '', number: 4, kind: 'issue', attempts: 0 },
          { owner: 'o', name: 'n', number: 5, kind: 'issue', attempts: 0, cursor: 7 },
          { owner: 'o', name: 'n', number: 3, kind: 'pull', attempts: -1000 },
          { owner: 'o', name: 'n', number: 6, kind: 'pull', attempts: 0, reviewRequest: { id: 'n-6', updatedAt: '2026-10-15T00:09:00Z' } },
          { owner: 'o', name: 'n', number: 7, kind: 'pull', attempts: 0, reviewRequest: null },
          { owner: 'o', name: 'n', number: 8, kind: 'pull', attempts: 0, reviewRequest: { id: '', updatedAt: '2026-10-15T00:09:00Z' } },
          { owner: 'o', name: 'n', number: 9, kind: 'pull', attempts: 0, reviewRequest: { id: 'n-9', updatedAt: 'not a time' } },
        ],
      },
    }),
  );
  const state = GithubState.load(file);
  assert.deepEqual(state.notificationsWatermark(), { since: null, lastModified: null, answeredAt: null });
  assert.deepEqual(state.notificationRetries(), [
    { owner: 'o', name: 'n', number: 1, kind: 'issue', attempts: 2 },
    { owner: 'o', name: 'n', number: 6, kind: 'pull', attempts: 0, reviewRequest: { id: 'n-6', updatedAt: '2026-10-15T00:09:00Z' } },
  ]);
});

test('a state file from before the retry list loads with an empty one, its watermark kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-state-'));
  const file = join(dir, 'state.json');
  writeFileSync(
    file,
    JSON.stringify({ ...emptySnapshot(), notifications: { since: '2026-10-15T00:09:00Z', lastModified: 'Wed, 15 Oct 2026 00:09:00 GMT' } }),
  );
  const state = GithubState.load(file);
  assert.deepEqual(state.notificationsWatermark(), { since: '2026-10-15T00:09:00Z', lastModified: 'Wed, 15 Oct 2026 00:09:00 GMT', answeredAt: null });
  assert.deepEqual(state.notificationRetries(), []);
});

test('a stored watermark or answer time that is only loosely a date is dropped on load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-state-'));
  const file = join(dir, 'state.json');
  writeFileSync(
    file,
    JSON.stringify({ ...emptySnapshot(), notifications: { since: '2026-10-15T00:09:00Z', lastModified: null, answeredAt: '12' } }),
  );
  assert.equal(GithubState.load(file).notificationsWatermark().answeredAt, null);
  writeFileSync(file, JSON.stringify({ ...emptySnapshot(), notifications: { since: '12', lastModified: null, answeredAt: null } }));
  assert.equal(GithubState.load(file).notificationsWatermark().since, null);
});

test('a retry entry keeps its cursor across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-state-'));
  const file = join(dir, 'state.json');
  const cursor = ['2026-10-15T00:09:30Z', '2026-10-15T00:09:30Z', 'issue:open:abc', 'issue_comment:5:2026-10-15T00:09:30Z'].join('\u0000');
  writeFileSync(
    file,
    JSON.stringify({
      ...emptySnapshot(),
      notifications: { since: '2026-10-15T00:09:00Z', lastModified: null, answeredAt: null, retry: [{ owner: 'o', name: 'n', number: 1, kind: 'issue', attempts: 2, cursor }] },
    }),
  );
  assert.deepEqual(GithubState.load(file).notificationRetries(), [{ owner: 'o', name: 'n', number: 1, kind: 'issue', attempts: 2, cursor }]);
});

test('App poll cursors and contributor notification state coexist across flush and reload', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'github-mcpl-state-')), 'state.json');
  const state = GithubState.empty(file);
  const since = '2026-10-15T00:09:00Z';
  const resumeAt = '2026-10-15T00:10:00Z';
  state.setLastPollAt(since);
  state.setPollCursors({ 'o/n:issues': { since, resumeAt } });
  state.setPolledNew({ 'o/n:issues': { '7': since } });
  state.setNotificationsWatermark({ since: resumeAt, lastModified: 'Thu, 15 Oct 2026 00:10:00 GMT', answeredAt: resumeAt });
  state.setNotificationRetries([{ owner: 'o', name: 'n', number: 7, kind: 'pull', attempts: 1, cursor: 'saved cursor', reviewRequest: { id: 'n7', updatedAt: resumeAt } }]);
  state.setPolledHead('github:o/n#7', 'app-head');
  state.setPolledHead('notif:github:o/n#7', 'notification-cursor');
  await state.flush();
  const loaded = GithubState.load(file);
  assert.deepEqual(loaded.snapshot(), state.snapshot());
  assert.deepEqual(loaded.pollCursors(), { 'o/n:issues': { since, resumeAt } });
  assert.deepEqual(loaded.polledNew(), { 'o/n:issues': { '7': since } });
  // Updating either mode does not replace the other's progress.
  loaded.setNotificationsWatermark({ since: resumeAt, lastModified: null, answeredAt: resumeAt });
  assert.equal(loaded.lastPollAt(), since);
  loaded.setPollCursors({});
  assert.equal(loaded.notificationRetries()[0].reviewRequest?.id, 'n7');
});
