import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GithubState } from '../src/state.js';
import { summarizeChecks } from '../src/github-adapter.js';
import { checksCases, checkRuns } from './checks-cases.js';
/**
 * Polling ingress (TASK-SRHKG.1.3, contract amendment 1).
 *
 * The two acceptance properties are asserted directly:
 *
 *   - the interval floor, including what an `X-Poll-Interval` may and may not
 *     do to it (`observePollInterval`);
 *   - "marks read only after delivery" — the amendment's equivalent of a
 *     notification mark-read is the dedup gate and the cursor, so a key is
 *     written only once the listener took its event, and a failed delivery is
 *     re-attempted on the next pass instead of being consumed.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  MAX_CHECKED_PULLS_PER_POLL,
  MAX_HEAD_ATTEMPTS,
  MAX_HEAD_BACKLOG,
  Poller,
  type IngressState,
  type PollerApi,
} from '../src/poller.js';
import { CheckGate, checkMarkOf, type CheckMark } from '../src/normalize.js';
import {
  MIN_POLL_INTERVAL_MS,
  POLL_DEDUP_RING,
  type ChecksSummary,
  type NormalizedEvent,
  type PollCursor,
  type RepoRef,
} from '../src/types.js';
import { FakeGitHubApi, TEST_BOT, TEST_REPO } from './harness.js';

const OTHER_REPO = { owner: 'other-org', name: 'other-repo' };

/**
 * `IngressState` over a Map, with `StateStore`'s own gate semantics:
 * `seenPollKey` records on a miss, `snapshot()` only reads.
 */
class MemoryIngressState implements IngressState {
  private cursor: string | null = null;
  private readonly keys: string[] = [];
  /** Amendment 2a: the last polled head of each pull request, by channel id. */
  readonly heads = new Map<string, string>();
  /** Every `setLastPollAt`, in order — the cursor's whole history. */
  readonly cursorWrites: string[] = [];

  constructor(cursor: string | null = null) {
    this.cursor = cursor;
  }

  lastPollAt(): string | null {
    return this.cursor;
  }

  setLastPollAt(when: string): void {
    this.cursor = when;
    this.cursorWrites.push(when);
  }

  seenPollKey(key: string): boolean {
    if (this.keys.includes(key)) return true;
    this.keys.push(key);
    if (this.keys.length > POLL_DEDUP_RING) this.keys.shift();
    return false;
  }

  polledHead(channel: string): string | null {
    return this.heads.get(channel) ?? null;
  }

  setPolledHead(channel: string, sha: string): void {
    this.heads.set(channel, sha);
  }

  snapshot(): { pollKeys: string[] } {
    return { pollKeys: [...this.keys] };
  }

  cursors: Record<string, PollCursor> = {};

  pollCursors(): Readonly<Record<string, PollCursor>> {
    return this.cursors;
  }

  setPollCursors(cursors: Record<string, PollCursor>): void {
    this.cursors = { ...cursors };
  }

  fresh: Record<string, Record<string, string>> = {};

  polledNew(): Readonly<Record<string, Record<string, string>>> {
    return this.fresh;
  }

  setPolledNew(rows: Record<string, Record<string, string>>): void {
    this.fresh = rows;
  }
}

interface Rig {
  api: FakeGitHubApi;
  state: MemoryIngressState;
  poller: Poller;
  events: NormalizedEvent[];
  /** Every sha `getCheckRuns` was asked about, in order, across all passes. */
  checkCalls: string[];
}

interface RigOptions {
  checksEmit?: 'all' | 'failures';
  cursor?: string | null;
  intervalMs?: number;
  api?: FakeGitHubApi;
  now?: string;
  maxCheckedPulls?: number;
  maxHeadBacklog?: number;
  maxHeadAttempts?: number;
  checkGate?: CheckGate;
  onEvent?: (event: NormalizedEvent) => void;
  repos?: readonly { owner: string; name: string }[];
  /**
   * Stand in for `getCheckRuns`. `call` is the 1-based number of the lookup
   * for this rig, so a test can script "throw once, then answer".
   */
  getCheckRuns?: (repo: RepoRef, sha: string, call: number) => Promise<ChecksSummary>;
}

function rig(opts: RigOptions = {}): Rig {
  const api = opts.api ?? new FakeGitHubApi();
  const state = new MemoryIngressState(opts.cursor === undefined ? '2026-10-13T00:00:00.000Z' : opts.cursor);
  const events: NormalizedEvent[] = [];
  const now = new Date(opts.now ?? '2026-10-14T00:00:00.000Z');
  const checkCalls: string[] = [];
  // Delegate to the fake (so its own call log keeps working) but record the
  // shas here too, because the backlog's drain order is the thing under test.
  const pollerApi: PollerApi = {
    listIssuesSince: (repo, since) => api.listIssuesSince(repo, since),
    listIssueCommentsSince: (repo, since) => api.listIssueCommentsSince(repo, since),
    listReviewCommentsSince: (repo, since) => api.listReviewCommentsSince(repo, since),
    getCheckRuns: (repo, sha) => {
      checkCalls.push(sha);
      return opts.getCheckRuns ? opts.getCheckRuns(repo, sha, checkCalls.length) : api.getCheckRuns(repo, sha);
    },
  };
  const poller = new Poller({
    api: pollerApi,
    repos: opts.repos ?? [TEST_REPO],
    state,
    intervalMs: opts.intervalMs ?? MIN_POLL_INTERVAL_MS,
    now: () => now,
    maxCheckedPulls: opts.maxCheckedPulls,
    maxHeadBacklog: opts.maxHeadBacklog,
    maxHeadAttempts: opts.maxHeadAttempts,
    checkGate: opts.checkGate,
    checksEmit: opts.checksEmit,
    onEvent: (event) => {
      events.push(event);
      opts.onEvent?.(event);
    },
  });
  return { api, state, poller, events, checkCalls };
}

async function onePass(r: Rig) {
  const before = r.checkCalls.length;
  const result = await r.poller.pollOnce();
  const lookups = r.checkCalls.length - before;
  assert.ok(lookups <= 1, `${lookups} check-run lookups for one head in one pass`);
  return result;
}

/** A completed summary for `sha`, failing on one job. */
function failedSummary(sha: string): ChecksSummary {
  return {
    sha,
    conclusion: 'failure',
    total: 2,
    failed: [{ name: 'clippy', url: 'https://github.com/anima-research/rayforce/runs/2700001235' }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The interval floor and X-Poll-Interval
// ─────────────────────────────────────────────────────────────────────────────

test('the effective interval never drops below the 60 s floor', () => {
  // readConfig already refuses a sub-floor GITHUB_POLL_INTERVAL_MS; the poller
  // does not rely on that and floors it again.
  assert.equal(rig({ intervalMs: 1 }).poller.effectiveIntervalMs, MIN_POLL_INTERVAL_MS);
  assert.equal(rig({ intervalMs: MIN_POLL_INTERVAL_MS }).poller.effectiveIntervalMs, MIN_POLL_INTERVAL_MS);
  assert.equal(rig({ intervalMs: 300_000 }).poller.effectiveIntervalMs, 300_000);
  assert.equal(MIN_POLL_INTERVAL_MS, 60_000);
});

test('X-Poll-Interval raises the interval and can never lower it', () => {
  const { poller } = rig({ intervalMs: 300_000 });

  // Below the configured interval: honoured (recorded) but not obeyed downward.
  assert.equal(poller.observePollInterval('60'), 300_000);
  assert.equal(poller.observePollInterval('120'), 300_000);
  // Above it: obeyed.
  assert.equal(poller.observePollInterval('900'), 900_000);
  assert.equal(poller.effectiveIntervalMs, 900_000);
  // And a later smaller value drops back only to the configured floor.
  assert.equal(poller.observePollInterval('65'), 300_000);
});

test('X-Poll-Interval cannot push the interval below 60 s even with polling at the floor', () => {
  const { poller } = rig({ intervalMs: MIN_POLL_INTERVAL_MS });
  assert.equal(poller.observePollInterval('1'), MIN_POLL_INTERVAL_MS);
  assert.equal(poller.observePollInterval(5), MIN_POLL_INTERVAL_MS);
  assert.equal(poller.observePollInterval('120'), 120_000);
});

test('a missing or unparseable X-Poll-Interval leaves the interval alone', () => {
  const { poller } = rig({ intervalMs: 120_000 });
  for (const value of [undefined, null, '', 'soon', '-5', 0, NaN]) {
    assert.equal(poller.observePollInterval(value), 120_000, `value ${String(value)}`);
  }
});

test('GITHUB_POLL_INTERVAL_MS = 0 is polling off and start() does nothing', async () => {
  const r = rig({ intervalMs: 0 });
  assert.equal(r.poller.enabled, false);
  r.poller.start();
  r.poller.stop();
  await r.poller.whenIdle();
  assert.deepEqual(r.api.callLog(), []);
  assert.equal(rig({ intervalMs: MIN_POLL_INTERVAL_MS }).poller.enabled, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// The cursor
// ─────────────────────────────────────────────────────────────────────────────

test('a pass queries every allow-listed repo since the cursor and advances it', async () => {
  const r = rig({ cursor: '2026-10-13T00:00:00.000Z', now: '2026-10-14T00:00:00.000Z' });
  const result = await r.poller.pollOnce();
  assert.equal(result.since, '2026-10-13T00:00:00.000Z');
  assert.deepEqual(r.api.callLog(), ['listIssuesSince', 'listIssueCommentsSince', 'listReviewCommentsSince']);
  for (const call of r.api.calls) {
    assert.deepEqual(call.args[0], TEST_REPO, `${call.method} asked the wrong repo`);
    assert.equal(call.args[1], '2026-10-13T00:00:00.000Z');
  }
  assert.equal(result.cursorAdvanced, true);
  assert.equal(r.state.lastPollAt(), '2026-10-14T00:00:00.000Z');
});

test('a first pass with no cursor looks back exactly one interval', async () => {
  const r = rig({ cursor: null, intervalMs: 300_000, now: '2026-10-14T00:00:00.000Z' });
  const result = await r.poller.pollOnce();
  assert.equal(result.since, '2026-10-13T23:55:00.000Z');
});

test('every allow-listed repository is polled, in one pass', async () => {
  const api = new FakeGitHubApi();
  const second = { owner: TEST_REPO.owner, name: 'chronicle' };
  api.seedIssue({ repo: TEST_REPO, number: 41, updatedAt: '2026-10-13T12:00:00.000Z' });
  api.seedIssue({ repo: second, number: 3, updatedAt: '2026-10-13T12:00:01.000Z' });
  api.seedIssue({ repo: OTHER_REPO, number: 9, updatedAt: '2026-10-13T12:00:02.000Z' });
  const r = rig({ api, repos: [TEST_REPO, second] });
  const result = await r.poller.pollOnce();
  assert.deepEqual(
    result.delivered.map((e) => [e.repo.name, e.thread?.number]),
    [['rayforce', 41], ['chronicle', 3]],
  );
  assert.deepEqual(r.state.snapshot().pollKeys, ['issue:41:2026-10-13T12:00:00.000Z', 'issue:3:2026-10-13T12:00:01.000Z']);
});

test('only the allow-listed repositories are ever asked', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ repo: TEST_REPO, number: 41, updatedAt: '2026-10-13T12:00:00.000Z' });
  api.seedIssue({ repo: OTHER_REPO, number: 3, updatedAt: '2026-10-13T12:00:00.000Z' });
  const r = rig({ api });
  const result = await r.poller.pollOnce();
  assert.equal(result.delivered.length, 1);
  assert.deepEqual(result.delivered[0].repo, TEST_REPO);
  for (const call of api.calls) assert.deepEqual(call.args[0], TEST_REPO);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rows → events
// ─────────────────────────────────────────────────────────────────────────────

// ── Amendment 2a through the real poller ──

test('a freshly opened issue arrives as issue.opened, an older one as issue.edited (amendment 2a)', async () => {
  const api = new FakeGitHubApi();
  // Created after the cursor: this pass is the first that could have seen it.
  api.seedIssue({ number: 41, createdAt: '2026-10-13T10:00:00.000Z', updatedAt: '2026-10-13T10:00:00.000Z' });
  // Created before it, touched since: an edit, and a poll cannot say of what.
  api.seedIssue({ number: 42, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-13T11:00:00.000Z' });

  const r = rig({ api, cursor: '2026-10-13T09:00:00.000Z' });
  const result = await r.poller.pollOnce();
  assert.deepEqual(
    result.delivered.map((e) => `${e.thread?.number}:${e.kind}`),
    ['41:issue.opened', '42:issue.edited'],
  );
  // The tag the recipes key on follows the kind.
  assert.equal(result.delivered[0].kind, 'issue.opened');
});

test('an open pull request whose head did not move is dropped on the next pass (amendment 2a)', async () => {
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-13T12:00:00.000Z' });

  const r = rig({ api, cursor: '2026-10-13T09:00:00.000Z' });
  // Pass one: never seen before, so its head counts as moved — one sighting.
  const first = await r.poller.pollOnce();
  assert.deepEqual(
    first.delivered.map((e) => e.kind),
    ['pull.synchronize'],
  );
  assert.equal(r.state.heads.get('github:anima-research/rayforce#58'), pull.head.sha);

  // Pass two: a comment bumps the pull request's row without moving its head.
  // The comment is the event; re-announcing the pull request beside it is the
  // duplicate amendment 2a removes.
  api.seedComment({ repo: TEST_REPO, number: 58, kind: 'pull' }, { id: 7002, updatedAt: '2026-10-14T01:00:00.000Z' });
  pull.updatedAt = '2026-10-14T01:00:00.000Z';
  const second = await r.poller.pollOnce();
  assert.deepEqual(
    second.delivered.map((e) => e.kind),
    ['comment.created'],
  );

  // Pass three: new commits. The head moved, so the row is a synchronize again.
  pull.head = { ...pull.head, sha: 'f'.repeat(40) };
  pull.updatedAt = '2026-10-14T02:00:00.000Z';
  const third = await r.poller.pollOnce();
  assert.deepEqual(
    third.delivered.map((e) => e.kind),
    ['pull.synchronize'],
  );
  assert.equal(third.delivered[0].sha, 'f'.repeat(40));
  assert.equal(r.state.heads.get('github:anima-research/rayforce#58'), 'f'.repeat(40));
});

test('a pull request opened since the cursor is pull.opened, not synchronize (amendment 2a)', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 59, createdAt: '2026-10-13T10:00:00.000Z', updatedAt: '2026-10-13T10:00:00.000Z' });
  const r = rig({ api, cursor: '2026-10-13T09:00:00.000Z' });
  const result = await r.poller.pollOnce();
  assert.deepEqual(
    result.delivered.map((e) => e.kind),
    ['pull.opened'],
  );
});

test('a refused pull.synchronize is retried on the next pass and delivered once (finding 1)', async () => {
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({
    number: 58,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-13T12:00:00.000Z',
  });

  // Pass one: never seen, so the head counts as moved — and the host refuses.
  let refuse = true;
  const attempts: string[] = [];
  const r = rig({
    api,
    cursor: '2026-10-13T09:00:00.000Z',
    onEvent: (event) => {
      attempts.push(event.kind);
      if (refuse && event.kind === 'pull.synchronize') throw new Error('transient host refusal');
    },
  });

  const first = await r.poller.pollOnce();
  assert.equal(first.failed, 1);
  assert.deepEqual(first.delivered, []);
  // The cursor is held back, as it always was…
  assert.equal(first.cursorAdvanced, false);
  // …and the head must be held back with it. Committing it here is what lost
  // the event for good: the next pass would compare the row against this very
  // sha, find no change, drop it, and let the cursor move past it.
  assert.equal(r.state.heads.get('github:anima-research/rayforce#58'), undefined);

  // Pass two: the same row is queried again (the cursor never moved) and the
  // host takes it this time.
  refuse = false;
  const second = await r.poller.pollOnce();
  assert.deepEqual(
    second.delivered.map((e) => e.kind),
    ['pull.synchronize'],
    'retried, and delivered exactly once',
  );
  assert.equal(second.delivered[0].sha, pull.head.sha);
  assert.equal(second.cursorAdvanced, true);
  assert.equal(second.failed, 0);
  assert.deepEqual(attempts, ['pull.synchronize', 'pull.synchronize'], 'attempted twice, delivered once');
  // Accepted, so now it is committed.
  assert.equal(r.state.heads.get('github:anima-research/rayforce#58'), pull.head.sha);

  // Pass three: nothing moved since, so the row is dropped as usual.
  pull.updatedAt = '2026-10-14T01:00:00.000Z';
  const third = await r.poller.pollOnce();
  assert.deepEqual(third.delivered, [], 'and the retry did not leave it announcing forever');
});

test('a collection failure after a changed head does not advance the head (finding 1)', async () => {
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({
    number: 58,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-13T12:00:00.000Z',
  });
  // The issue rows are read first and this one is read after them, so it
  // throws with the changed head already in hand but nothing delivered.
  api.listIssueCommentsSince = async () => {
    throw new Error('GitHub 502 on the comment page');
  };

  const r = rig({ api, cursor: '2026-10-13T09:00:00.000Z' });
  await assert.rejects(() => r.poller.pollOnce(), /502 on the comment page/);
  assert.equal(
    r.state.heads.get('github:anima-research/rayforce#58'),
    undefined,
    'a pass that delivered nothing advanced nothing',
  );

  // So the recovered pass still announces the commits.
  delete (api as { listIssueCommentsSince?: unknown }).listIssueCommentsSince;
  const recovered = await r.poller.pollOnce();
  assert.deepEqual(
    recovered.delivered.map((e) => e.kind),
    ['pull.synchronize'],
  );
  assert.equal(r.state.heads.get('github:anima-research/rayforce#58'), pull.head.sha);
});

test('a dropped pull-request row still records its head, so the next pass agrees (amendment 2a)', async () => {
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-13T12:00:00.000Z' });
  const r = rig({ api, cursor: '2026-10-13T09:00:00.000Z' });
  await r.poller.pollOnce();

  // Two further passes, each with a comment that bumps the pull request's row.
  // The comment is delivered every time — which is what proves the pass really
  // collected these rows — while the pull-request row beside it is dropped
  // every time: the head is recorded on a drop as well as on a delivery, so no
  // pass ever mistakes the unchanged head for a change.
  let id = 7100;
  for (const at of ['2026-10-14T01:00:00.000Z', '2026-10-14T02:00:00.000Z']) {
    api.seedComment({ repo: TEST_REPO, number: 58, kind: 'pull' }, { id: id++, updatedAt: at });
    pull.updatedAt = at;
    const pass = await r.poller.pollOnce();
    assert.deepEqual(
      pass.delivered.map((e) => e.kind),
      ['comment.created'],
    );
  }
  assert.equal(r.state.heads.get('github:anima-research/rayforce#58'), pull.head.sha);
});

test('issues, comments and review comments updated since the cursor are delivered oldest first', async () => {
  const api = new FakeGitHubApi();
  const issue = api.seedIssue({ number: 41, updatedAt: '2026-10-13T10:00:00.000Z' });
  api.seedComment({ repo: TEST_REPO, number: 41, kind: 'issue' }, { id: 7001, updatedAt: '2026-10-13T11:00:00.000Z' });
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  api.seedReviewThread(
    { repo: TEST_REPO, number: 58, kind: 'pull' },
    {
      path: 'src/scheduler/tick.rs',
      line: 118,
      side: 'RIGHT',
      isResolved: false,
      comments: [
        {
          id: 9001,
          author: { login: 'octocat', isBot: false },
          body: 'this drains twice',
          createdAt: '2026-10-13T13:00:00.000Z',
          updatedAt: '2026-10-13T13:00:00.000Z',
        },
      ],
    },
  );

  const r = rig({ api });
  const result = await r.poller.pollOnce();
  assert.deepEqual(
    result.delivered.map((e) => e.kind),
    // `pull.synchronize`, not `pull.opened`: amendment 2a reserves `opened`
    // for a row created at or after the cursor, and this one predates it.
    ['issue.edited', 'comment.created', 'pull.synchronize', 'review_comment.created'],
  );
  assert.deepEqual(
    result.delivered.map((e) => e.id),
    [
      `poll:issue:${issue.number}:2026-10-13T10:00:00.000Z`,
      'poll:issue_comment:7001:2026-10-13T11:00:00.000Z',
      `poll:issue:${pull.number}:2026-10-13T12:00:00.000Z`,
      'poll:review_comment:9001:2026-10-13T13:00:00.000Z',
    ],
  );
  // The acceptance fields: thread, actor, sha, review-comment detail.
  assert.deepEqual(result.delivered[3].thread, { repo: TEST_REPO, number: 58, kind: 'pull' });
  assert.equal(result.delivered[3].reviewComment?.path, 'src/scheduler/tick.rs');
  assert.equal(result.delivered[2].sha, pull.head.sha);
  assert.deepEqual(result.delivered[0].actor, { login: 'human-one', isBot: false });
  // `receivedAt` is the start of the pass, not the row's timestamp.
  for (const e of result.delivered) assert.equal(e.receivedAt, '2026-10-14T00:00:00.000Z');
});

test('an open pull-request head gets one checks event per conclusion, and none without runs', async () => {
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  api.seedCheckRuns(TEST_REPO, {
    sha: pull.head.sha,
    conclusion: 'failure',
    total: 2,
    failed: [{ name: 'clippy', url: 'https://github.com/anima-research/rayforce/runs/2700001235' }],
  });

  const r = rig({ api });
  const first = await r.poller.pollOnce();
  const checks = first.delivered.filter((e) => e.kind === 'checks.completed');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].sha, pull.head.sha);
  assert.deepEqual(checks[0].checks, {
    conclusion: 'failure',
    failed: [{ name: 'clippy', url: 'https://github.com/anima-research/rayforce/runs/2700001235' }],
  });
  assert.deepEqual(checks[0].thread, { repo: TEST_REPO, number: 58, kind: 'pull' });
  assert.deepEqual(api.callsTo('getCheckRuns')[0].args, [TEST_REPO, pull.head.sha]);

  // A head with no runs at all produces nothing.
  const bare = new FakeGitHubApi();
  bare.seedPullRequest({ number: 59, updatedAt: '2026-10-13T12:00:00.000Z' });
  const r2 = rig({ api: bare });
  const second = await r2.poller.pollOnce();
  assert.deepEqual(
    second.delivered.filter((e) => e.kind === 'checks.completed'),
    [],
  );
});

test('a settled head whose failed jobs change with the same count is news, not a duplicate', async () => {
  // Review round 4: the poll key must distinguish failure *sets*, not counts.
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  const sets = [
    [{ name: 'lint', url: 'https://github.com/anima-research/rayforce/runs/1' }],
    [{ name: 'test', url: 'https://github.com/anima-research/rayforce/runs/2' }],
  ];
  const r = rig({
    api,
    getCheckRuns: async (_repo, sha, call) => ({ sha, conclusion: 'failure', total: 4, failed: sets[Math.min(call, 2) - 1] }),
  });

  const first = await r.poller.pollOnce();
  assert.deepEqual(first.delivered.filter((e) => e.kind === 'checks.completed').map((e) => e.checks?.failed.map((f) => f.name)), [['lint']]);

  // The same open head is updated again; its runs now fail on a different job.
  api.seedPullRequest({ number: 58, head: pull.head, updatedAt: '2026-10-14T01:00:00.000Z' });
  const second = await r.poller.pollOnce();
  assert.equal(second.duplicates, 0, 'a different failed set is not a duplicate');
  assert.deepEqual(second.delivered.filter((e) => e.kind === 'checks.completed').map((e) => e.checks?.failed.map((f) => f.name)), [['test']]);
});

test('a closed pull request is not asked for its check runs', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, state: 'closed', updatedAt: '2026-10-13T12:00:00.000Z' });
  const r = rig({ api });
  const result = await r.poller.pollOnce();
  assert.deepEqual(api.callsTo('getCheckRuns'), []);
  assert.deepEqual(
    result.delivered.map((e) => e.kind),
    ['pull.closed'],
  );
});

test('at most 20 pull-request heads are checked in one pass', async () => {
  const api = new FakeGitHubApi();
  for (let i = 1; i <= 25; i++) {
    const pull = api.seedPullRequest({ number: 100 + i, updatedAt: '2026-10-13T12:00:00.000Z' });
    api.seedCheckRuns(TEST_REPO, { sha: pull.head.sha, conclusion: 'success', total: 1, failed: [] });
  }
  const r = rig({ api });
  const result = await r.poller.pollOnce();
  assert.equal(MAX_CHECKED_PULLS_PER_POLL, 20);
  assert.ok(api.callsTo('getCheckRuns').length <= 20);
  assert.ok(result.delivered.filter((e) => e.kind === 'checks.completed').length <= 20);
});

test('a check-runs lookup that throws does not lose the rest of the pass, and the head is kept', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  const r = rig({
    api,
    getCheckRuns: async () => {
      throw new Error('502 from the API');
    },
  });
  const result = await r.poller.pollOnce();
  assert.deepEqual(
    result.delivered.map((e) => e.kind),
    // Amendment 2a: this pull request was created before the cursor and the
    // poll state has no head for it yet, so its first sighting is a synchronize.
    ['pull.synchronize'],
  );
  // A lookup failure is not a delivery failure, so the cursor still moves —
  // which is only safe because the head itself is retained for another pass.
  assert.equal(result.failed, 0);
  assert.equal(result.cursorAdvanced, true);
  assert.equal(result.checkLookups, 1);
  assert.equal(result.checksBacklog, 1, 'the unfinished head must be kept');
  assert.equal(r.poller.checkBacklogSize, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// "Marked only after delivery": the gate and the cursor
// ─────────────────────────────────────────────────────────────────────────────

test('a row already in the gate is not delivered twice', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, updatedAt: '2026-10-13T10:00:00.000Z' });
  const r = rig({ api });

  const first = await r.poller.pollOnce();
  assert.equal(first.delivered.length, 1);
  assert.deepEqual(r.state.snapshot().pollKeys, ['issue:41:2026-10-13T10:00:00.000Z']);

  // Rewind the cursor so the very same row is queried again, and forget its
  // marker as an eviction would: now the gate, and not the cursor or the
  // marker, is the only thing that can stop the duplicate.
  r.state.setLastPollAt('2026-10-13T00:00:00.000Z');
  r.state.setPollCursors({});
  r.state.heads.clear();
  const second = await r.poller.pollOnce();
  assert.deepEqual(second.delivered, []);
  assert.equal(second.duplicates, 1);
});

test('an edit of the same row is a fresh event: the key carries updated_at', async () => {
  const api = new FakeGitHubApi();
  const issue = api.seedIssue({ number: 41, updatedAt: '2026-10-13T10:00:00.000Z' });
  const r = rig({ api });
  assert.equal((await r.poller.pollOnce()).delivered.length, 1);

  // Edited after the pass that first delivered it, so the next pass sees it.
  issue.body = 'edited body';
  issue.updatedAt = '2026-10-14T01:00:00.000Z';
  const second = await r.poller.pollOnce();
  assert.equal(second.delivered.length, 1);
  assert.equal(second.delivered[0].id, 'poll:issue:41:2026-10-14T01:00:00.000Z');
  assert.deepEqual(r.state.snapshot().pollKeys, [
    'issue:41:2026-10-13T10:00:00.000Z',
    'issue:41:2026-10-14T01:00:00.000Z',
  ]);
});

test('a key is recorded only after its event was delivered', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, updatedAt: '2026-10-13T10:00:00.000Z' });
  const ringDuringDelivery: string[][] = [];
  const r = rig({
    api,
    onEvent: (event) => {
      // Inside the listener the key is not in the gate yet.
      ringDuringDelivery.push(r.state.snapshot().pollKeys);
      assert.equal(event.kind, 'issue.edited');
    },
  });
  await r.poller.pollOnce();
  assert.deepEqual(ringDuringDelivery, [[]]);
  assert.deepEqual(r.state.snapshot().pollKeys, ['issue:41:2026-10-13T10:00:00.000Z']);
});

test('a failed delivery leaves its key unrecorded, holds the cursor, and is retried', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, updatedAt: '2026-10-13T10:00:00.000Z' });
  let attempts = 0;
  const r = rig({
    api,
    onEvent: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('host refused the event');
    },
  });

  const first = await r.poller.pollOnce();
  assert.equal(first.failed, 1);
  assert.deepEqual(first.delivered, []);
  assert.deepEqual(r.state.snapshot().pollKeys, [], 'the key must not be recorded');
  assert.equal(first.cursorAdvanced, false);
  assert.equal(r.state.lastPollAt(), '2026-10-13T00:00:00.000Z', 'the cursor must not move');

  // The next pass therefore sees the row again and delivers it.
  const second = await r.poller.pollOnce();
  assert.equal(attempts, 2);
  assert.equal(second.delivered.length, 1);
  assert.deepEqual(r.state.snapshot().pollKeys, ['issue:41:2026-10-13T10:00:00.000Z']);
  assert.equal(second.cursorAdvanced, true);
});

test('one failure does not block the rows around it, and only it is retried', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, updatedAt: '2026-10-13T10:00:00.000Z' });
  api.seedIssue({ number: 42, updatedAt: '2026-10-13T11:00:00.000Z' });
  api.seedIssue({ number: 43, updatedAt: '2026-10-13T12:00:00.000Z' });
  let failOnce = true;
  const r = rig({
    api,
    onEvent: (event) => {
      if (failOnce && event.thread?.number === 42) throw new Error('transient');
    },
  });

  const first = await r.poller.pollOnce();
  assert.deepEqual(
    first.delivered.map((e) => e.thread?.number),
    [41, 43],
  );
  assert.equal(first.failed, 1);
  assert.equal(first.cursorAdvanced, false);

  failOnce = false;
  const second = await r.poller.pollOnce();
  assert.deepEqual(
    second.delivered.map((e) => e.thread?.number),
    [42],
  );
  // The two that already landed recorded their markers, so their unchanged
  // rows drop before the gate; the refused one never recorded its marker.
  assert.equal(second.duplicates, 0);
  assert.equal(second.cursorAdvanced, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// A comment's bump is not an issue change (the 2026-10-15 rehearsal)
// ─────────────────────────────────────────────────────────────────────────────

test('the bot\'s comment and close on an issue that mentions it do not come back as a human mention', async () => {
  const api = new FakeGitHubApi();
  const issue = api.seedIssue({
    number: 10,
    body: `@${TEST_BOT.login.replace('[bot]', '')} please confirm you see this`,
    createdAt: '2026-10-13T09:00:00.000Z',
    updatedAt: '2026-10-13T09:00:00.000Z',
  });
  const r = rig({ api });
  const first = await r.poller.pollOnce();
  assert.deepEqual(first.delivered.map((e) => e.kind), ['issue.opened']);

  // The bot comments: the comment bumps the issue's updated_at, nothing else.
  const bot = { login: TEST_BOT.login, isBot: true };
  api.seedComment({ repo: TEST_REPO, number: 10, kind: 'issue' }, { author: bot, body: 'Seen.', updatedAt: '2026-10-14T01:00:00.000Z' });
  issue.updatedAt = '2026-10-14T01:00:00.000Z';
  const second = await r.poller.pollOnce();
  assert.deepEqual(second.delivered.map((e) => e.kind), ['comment.created'], 'no issue row beside the comment');
  assert.equal(second.delivered[0].actor.login, TEST_BOT.login);

  // The bot closes it: delivered once, as the bot's own act.
  issue.state = 'closed';
  issue.updatedAt = '2026-10-14T02:00:00.000Z';
  api.closedBy.set(10, bot);
  const third = await r.poller.pollOnce();
  assert.deepEqual(third.delivered.map((e) => e.kind), ['issue.closed']);
  assert.equal(third.delivered[0].actor.login, TEST_BOT.login, 'closed_by, not the author');

  // A human comments on the closed issue: the comment, and no second close.
  api.seedComment({ repo: TEST_REPO, number: 10, kind: 'issue' }, { body: 'thanks', updatedAt: '2026-10-14T03:00:00.000Z' });
  issue.updatedAt = '2026-10-14T03:00:00.000Z';
  const fourth = await r.poller.pollOnce();
  assert.deepEqual(fourth.delivered.map((e) => e.kind), ['comment.created']);
});

test('a title or body edit, and a reopen, still arrive under polling', async () => {
  const api = new FakeGitHubApi();
  const issue = api.seedIssue({ number: 12, createdAt: '2026-10-13T09:00:00.000Z', updatedAt: '2026-10-13T09:00:00.000Z' });
  const r = rig({ api });
  await r.poller.pollOnce();

  issue.title = 'A better title';
  issue.updatedAt = '2026-10-14T01:00:00.000Z';
  assert.deepEqual((await r.poller.pollOnce()).delivered.map((e) => e.kind), ['issue.edited']);

  issue.state = 'closed';
  issue.updatedAt = '2026-10-14T02:00:00.000Z';
  assert.deepEqual((await r.poller.pollOnce()).delivered.map((e) => e.kind), ['issue.closed']);

  issue.state = 'open';
  issue.updatedAt = '2026-10-14T03:00:00.000Z';
  assert.deepEqual((await r.poller.pollOnce()).delivered.map((e) => e.kind), ['issue.edited'],
    'a reopen changes the state half of the marker');
});

// ─────────────────────────────────────────────────────────────────────────────
// The state seam
// ─────────────────────────────────────────────────────────────────────────────

test('each list starts from lastPollAt until it has a cursor of its own, then keeps it', async () => {
  // A state file from before per-list cursors carries `lastPollAt` alone, and
  // one cursor for a repository no longer polled.
  const r = rig({ cursor: '2026-10-13T00:00:00.000Z', repos: [TEST_REPO, OTHER_REPO] });
  r.state.setPollCursors({ 'gone/repo:issues': { since: '2026-10-01T00:00:00.000Z' } });

  await r.poller.pollOnce();
  const asked = () => r.api.calls.filter((c) => String(c.method).endsWith('Since')).map((c) => c.args[1]);
  assert.deepEqual(asked(), Array(6).fill('2026-10-13T00:00:00.000Z'));
  const start = '2026-10-14T00:00:00.000Z';
  assert.deepEqual(r.state.pollCursors(), {
    'anima-research/rayforce:issues': { since: start },
    'anima-research/rayforce:issue_comments': { since: start },
    'anima-research/rayforce:review_comments': { since: start },
    'other-org/other-repo:issues': { since: start },
    'other-org/other-repo:issue_comments': { since: start },
    'other-org/other-repo:review_comments': { since: start },
  });

  // A list catching up reads from where it stopped; the others from their own.
  r.state.setPollCursors({
    ...r.state.pollCursors(),
    'anima-research/rayforce:issues': { since: '2026-10-13T00:00:00.000Z', resumeAt: '2026-10-13T06:00:00Z' },
  });
  r.api.calls.length = 0;
  await r.poller.pollOnce();
  assert.deepEqual(asked(), ['2026-10-13T06:00:00.000Z', start, start, start, start, start]);
});

test('a failed delivery leaves every list’s cursor where it was', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ updatedAt: '2026-10-13T12:00:00.000Z' });
  const r = rig({
    api,
    onEvent: () => {
      throw new Error('host refused the event');
    },
  });
  const before = { 'anima-research/rayforce:issues': { since: '2026-10-13T00:00:00.000Z', resumeAt: '2026-10-13T06:00:00Z' } };
  r.state.setPollCursors(before);

  const result = await r.poller.pollOnce();
  assert.equal(result.failed, 1);
  assert.deepEqual(r.state.pollCursors(), before);
});

test('a refused pass keeps the rows it announced as new, so a retry does not open them again', async () => {
  const api = new FakeGitHubApi();
  const issue = api.seedIssue({ number: 41, createdAt: '2026-10-13T12:00:00.000Z', updatedAt: '2026-10-13T12:00:00.000Z' });
  const pull = api.seedPullRequest({ number: 58, createdAt: '2026-10-13T12:00:00.000Z', updatedAt: '2026-10-13T12:00:00.000Z' });
  api.seedComment({ repo: TEST_REPO, number: 41, kind: 'issue' }, { id: 7001, updatedAt: '2026-10-13T12:00:01.000Z' });
  let refusals = 0;
  const r = rig({
    api,
    onEvent: (event) => {
      if (event.kind === 'comment.created' && refusals++ === 0) throw new Error('host refused the event');
    },
  });

  const first = await r.poller.pollOnce();
  assert.deepEqual(first.delivered.map((e) => e.kind).sort(), ['issue.opened', 'pull.opened']);
  assert.equal(first.cursorAdvanced, false);
  assert.deepEqual(r.state.fresh, {
    'anima-research/rayforce:issues': { '41': '2026-10-13T12:00:00.000Z', '58': '2026-10-13T12:00:00.000Z' },
  });

  // Both change before the retry: the issue is edited, the pull request pushed.
  issue.body = 'edited';
  issue.updatedAt = '2026-10-13T13:00:00.000Z';
  pull.head = { ...pull.head, sha: 'f'.repeat(40) };
  pull.updatedAt = '2026-10-13T13:00:00.000Z';
  const second = await r.poller.pollOnce();
  assert.deepEqual(second.delivered.map((e) => e.kind).sort(), ['comment.created', 'issue.edited', 'pull.synchronize']);
  // The pass delivered, and its window starts after both were created.
  assert.deepEqual(r.state.fresh, {});
});

test('a refused opening leaves nothing remembered, so its retry announces it as opened', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, createdAt: '2026-10-13T12:00:00.000Z', updatedAt: '2026-10-13T12:00:00.000Z' });
  let refusals = 0;
  const r = rig({
    api,
    onEvent: (event) => {
      if (event.kind === 'issue.opened' && refusals++ === 0) throw new Error('host refused the event');
    },
  });

  await r.poller.pollOnce();
  assert.deepEqual(r.state.fresh, {});
  const second = await r.poller.pollOnce();
  assert.deepEqual(second.delivered.map((e) => e.kind), ['issue.opened']);
});

test('lastPollAt is the earliest place a list stopped, and never past the pass start', async () => {
  const api = new FakeGitHubApi();
  const r = rig({ api });
  api.listIssuesSince = async () => ({ rows: [], resumeAt: '2026-10-13T08:00:00Z' });
  api.listIssueCommentsSince = async () => ({ rows: [], resumeAt: '2026-10-13T07:00:00Z' });
  await r.poller.pollOnce();
  assert.equal(r.state.lastPollAt(), '2026-10-13T07:00:00Z');

  // A stop stamped after the pass started, as a row changed during it can be.
  api.listIssuesSince = async () => ({ rows: [] });
  api.listIssueCommentsSince = async () => ({ rows: [], resumeAt: '2026-10-14T00:00:05Z' });
  await r.poller.pollOnce();
  assert.equal(r.state.lastPollAt(), '2026-10-14T00:00:00.000Z');
});

test('a first pass whose read throws keeps the window it read', async () => {
  const api = new FakeGitHubApi();
  // The very first read throws, so the window must be kept before any read.
  api.listIssuesSince = async () => {
    throw new Error('GitHub 502 on the issues page');
  };
  const r = rig({ api, cursor: null, now: '2026-10-14T00:00:00.700Z' });
  await assert.rejects(() => r.poller.pollOnce(), /502 on the issues page/);
  assert.equal(r.state.lastPollAt(), '2026-10-13T23:59:00.000Z');
});

test('a stored position with milliseconds is read from its whole second', async () => {
  const r = rig({ cursor: '2026-10-13T00:00:00.700Z' });
  r.state.setPollCursors({
    'anima-research/rayforce:issues': { since: '2026-10-13T00:00:00.000Z', resumeAt: '2026-10-13T06:00:00.300Z' },
    'anima-research/rayforce:issue_comments': { since: '2026-10-13T00:00:00.500Z' },
  });
  await r.poller.pollOnce();
  assert.deepEqual(
    r.api.calls.filter((c) => String(c.method).endsWith('Since')).map((c) => c.args[1]),
    ['2026-10-13T06:00:00.000Z', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'],
  );
});

test('a refused first pass keeps the window it read', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, updatedAt: '2026-10-13T23:59:30.000Z' });
  const r = rig({
    api,
    cursor: null,
    now: '2026-10-14T00:00:00.700Z',
    onEvent: () => {
      throw new Error('host refused the event');
    },
  });

  const first = await r.poller.pollOnce();
  assert.equal(first.failed, 1);
  assert.equal(first.since, '2026-10-13T23:59:00.000Z', 'one interval back, in whole seconds');
  assert.equal(r.state.lastPollAt(), first.since, 'the retry asks from the same start, not one moved on by the clock');
});

// ─────────────────────────────────────────────────────────────────────────────
// The check backlog: unfinished check work survives the cursor
// ─────────────────────────────────────────────────────────────────────────────

test('a transient lookup failure is retried on the next pass, after the cursor moved on', async () => {
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  api.seedCheckRuns(TEST_REPO, failedSummary(pull.head.sha));
  const r = rig({
    api,
    getCheckRuns: async (repo, sha, call) => {
      if (call === 1) throw new Error('502 from the API');
      return api.getCheckRuns(repo, sha);
    },
  });

  // Pass one: the row lands, the lookup fails, the head is kept.
  const first = await onePass(r);
  assert.deepEqual(
    first.delivered.map((e) => e.kind),
    // Amendment 2a: this pull request was created before the cursor and the
    // poll state has no head for it yet, so its first sighting is a synchronize.
    ['pull.synchronize'],
  );
  assert.equal(first.checksBacklog, 1);
  assert.equal(first.cursorAdvanced, true);

  // Pass two: the cursor has moved past the row, so `listIssuesSince` returns
  // nothing — the backlog is the only reason the checks are asked about again.
  const second = await onePass(r);
  assert.deepEqual((await api.listIssuesSince(TEST_REPO, r.state.lastPollAt() as string)).rows, []);
  assert.deepEqual(
    second.delivered.map((e) => e.kind),
    ['checks.completed'],
  );
  assert.equal(second.delivered[0].sha, pull.head.sha);
  assert.deepEqual(second.delivered[0].checks?.failed.map((f) => f.name), ['clippy']);
  assert.equal(second.checksBacklog, 0, 'a settled head leaves the backlog');
});

test('a head whose checks are still running waits, then reports when they finish', async () => {
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  let finished = false;
  const r = rig({
    api,
    // A short attempt budget: a pending head must not spend attempts, or it
    // would be given up on before CI finishes.
    maxHeadAttempts: 2,
    getCheckRuns: async (_repo, sha) =>
      finished ? failedSummary(sha) : { sha, conclusion: null, total: 3, failed: [] },
  });

  // Three passes with runs still going: no event, and the head is still held
  // even though that is more passes than maxHeadAttempts.
  for (const pass of [1, 2, 3]) {
    const result = await onePass(r);
    assert.deepEqual(
      result.delivered.filter((e) => e.kind === 'checks.completed'),
      [],
      `pass ${pass} must not claim checks.completed while runs are going`,
    );
    assert.equal(result.checksBacklog, 1, `pass ${pass} must keep the head`);
  }

  finished = true;
  const last = await onePass(r);
  assert.deepEqual(
    last.delivered.map((e) => e.kind),
    ['checks.completed'],
  );
  assert.equal(last.delivered[0].checks?.conclusion, 'failure');
  assert.equal(last.checksBacklog, 0);
});

test('a head that never gets check runs is given up on after its attempts', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  // Unseeded sha: the fake answers `{ total: 0 }`, as a head no workflow
  // matches does.
  const r = rig({ api, maxHeadAttempts: 3 });

  assert.equal((await onePass(r)).checksBacklog, 1);
  assert.equal((await onePass(r)).checksBacklog, 1);
  const last = await onePass(r);
  assert.equal(last.checksBacklog, 0, 'the head aged out');
  assert.deepEqual(
    r.events.filter((e) => e.kind === 'checks.completed'),
    [],
  );
  // And it is not asked about a fourth time.
  assert.equal((await onePass(r)).checkLookups, 0);
  assert.equal(MAX_HEAD_ATTEMPTS, 10);
});

test('heads beyond the per-pass cap are drained by the following passes', async () => {
  const api = new FakeGitHubApi();
  const shas: string[] = [];
  for (let i = 1; i <= 25; i++) {
    const pull = api.seedPullRequest({ number: 100 + i, updatedAt: '2026-10-13T12:00:00.000Z' });
    api.seedCheckRuns(TEST_REPO, { sha: pull.head.sha, conclusion: 'success', total: 1, failed: [] });
    shas.push(pull.head.sha);
  }
  const r = rig({ api });

  const first = await r.poller.pollOnce();
  assert.equal(first.checkLookups, MAX_CHECKED_PULLS_PER_POLL);
  assert.equal(first.delivered.filter((e) => e.kind === 'checks.completed').length, 20);
  assert.equal(first.checksBacklog, 5, 'the five the cap cut off are kept');

  // The cursor has moved past every row, so without the backlog this pass
  // would do nothing at all — the regression the reviewer reproduced.
  const second = await r.poller.pollOnce();
  assert.equal(second.checkLookups, 5);
  assert.equal(second.delivered.filter((e) => e.kind === 'checks.completed').length, 5);
  assert.equal(second.checksBacklog, 0);

  // Every one of the 25 heads was reported, exactly once.
  const reported = r.events.filter((e) => e.kind === 'checks.completed').map((e) => e.sha);
  assert.equal(reported.length, 25);
  assert.deepEqual([...reported].sort(), [...shas].sort());
});

test('an over-cap backlog drains round-robin instead of starving the tail', async () => {
  const api = new FakeGitHubApi();
  const shas: string[] = [];
  for (let i = 1; i <= 25; i++) {
    const pull = api.seedPullRequest({ number: 200 + i, updatedAt: '2026-10-13T12:00:00.000Z' });
    shas.push(pull.head.sha);
  }
  // Nothing ever settles, so the only question is who gets asked.
  const r = rig({ api, getCheckRuns: async (_repo, sha) => ({ sha, conclusion: null, total: 3, failed: [] }) });

  await r.poller.pollOnce();
  assert.deepEqual(r.checkCalls, shas.slice(0, 20), 'pass one takes the oldest 20');

  r.checkCalls.length = 0;
  await r.poller.pollOnce();
  // The five that were starved are asked first, because the 20 that were
  // examined went to the back of the queue.
  assert.deepEqual(r.checkCalls.slice(0, 5), shas.slice(20, 25));
  assert.deepEqual(r.checkCalls.slice(5), shas.slice(0, 15));
  assert.equal(r.poller.checkBacklogSize, 25);
});

test('the backlog is bounded: past its cap the oldest head waiting is forgotten', async () => {
  const api = new FakeGitHubApi();
  const pulls: ReturnType<typeof api.seedPullRequest>[] = [];
  for (let i = 1; i <= 6; i++) {
    pulls.push(api.seedPullRequest({ number: 300 + i, updatedAt: '2026-10-13T12:00:00.000Z' }));
  }
  const r = rig({
    api,
    maxHeadBacklog: 4,
    maxCheckedPulls: 4,
    getCheckRuns: async (_repo, sha) => ({ sha, conclusion: null, total: 1, failed: [] }),
  });
  const result = await r.poller.pollOnce();
  assert.equal(result.checksBacklog, 4);
  assert.deepEqual([...r.checkCalls].sort(), pulls.slice(2).map((p) => p.head.sha).sort(), 'the two oldest heads are the ones gone');
  assert.equal(MAX_HEAD_BACKLOG, 200);
});

test('a closed pull request is never enqueued for a check lookup', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, state: 'closed', updatedAt: '2026-10-13T12:00:00.000Z' });
  api.seedIssue({ number: 41, updatedAt: '2026-10-13T12:00:00.000Z' });
  const r = rig({ api });
  const result = await r.poller.pollOnce();
  assert.equal(result.checkLookups, 0);
  assert.equal(result.checksBacklog, 0);
  assert.deepEqual(r.checkCalls, []);
});

test('the poller reports a head sha once: a second conclusion must be worse', async () => {
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  let conclusion: ChecksSummary = { sha: pull.head.sha, conclusion: 'failure', total: 2, failed: [] };
  const r = rig({ api, getCheckRuns: async () => conclusion });

  assert.equal((await r.poller.pollOnce()).delivered.filter((e) => e.kind === 'checks.completed').length, 1);

  // The same head settles green later (a second workflow): not news.
  conclusion = { sha: pull.head.sha, conclusion: 'success', total: 3, failed: [] };
  api.seedIssue({ number: 41, updatedAt: '2026-10-14T01:00:00.000Z' });
  const pr = api.seedPullRequest({ number: 58, updatedAt: '2026-10-14T01:00:00.000Z' });
  assert.equal(pr.head.sha, pull.head.sha);
  const second = await r.poller.pollOnce();
  assert.deepEqual(
    second.delivered.filter((e) => e.kind === 'checks.completed'),
    [],
  );
});

test('a poller and a listener sharing a CheckGate report a head sha once', async () => {
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  const gate = new CheckGate();
  // The webhook path got there first and had this exact result accepted.
  const mark: CheckMark = { rank: 7, failed: ['clippy'] };
  assert.equal(await gate.emit(TEST_REPO, pull.head.sha, mark, async () => {}), true);
  const r = rig({ api, checkGate: gate, getCheckRuns: async (_r, sha) => failedSummary(sha) });
  const result = await r.poller.pollOnce();
  assert.deepEqual(
    result.delivered.filter((e) => e.kind === 'checks.completed'),
    [],
  );
  assert.equal(result.checkLookups, 1, 'the lookup still happened; only the event was dropped');
});

test('a refused checks event commits no mark and keeps the backlog slot it needs', async () => {
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  const gate = new CheckGate();
  let attempts = 0;
  const r = rig({
    api,
    checkGate: gate,
    getCheckRuns: async (_repo, sha) => failedSummary(sha),
    onEvent: (event) => {
      if (event.kind !== 'checks.completed') return;
      attempts += 1;
      if (attempts === 1) throw new Error('host refused the event');
    },
  });

  const first = await r.poller.pollOnce();
  assert.equal(first.failed, 1);
  assert.equal(gate.size, 0, 'a refused event must commit nothing');
  assert.equal(first.cursorAdvanced, false, 'a failed delivery holds the cursor');
  assert.equal(first.checksBacklog, 1, 'and the head stays queued');

  // The retry lands, and only then is the mark committed and the head retired.
  const second = await r.poller.pollOnce();
  assert.equal(attempts, 2);
  const delivered = second.delivered.filter((e) => e.kind === 'checks.completed');
  assert.equal(delivered.length, 1);
  assert.deepEqual(gate.committedMark(TEST_REPO, pull.head.sha), checkMarkOf(delivered[0]) as CheckMark);
  assert.equal(second.checksBacklog, 0, 'the accepted head left the backlog');
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 2: a head leaves the lifecycle only once its event is accepted
// ─────────────────────────────────────────────────────────────────────────────

test('a checks event refused long after the cursor moved past its row is still retried', async () => {
  // The regression the reviewer reproduced. Three passes:
  //   1. the PR row lands, the checks are still running   → cursor advances
  //   2. the checks settle, the listener refuses the event
  //   3. the retry, with the row long gone from the since-query
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  const gate = new CheckGate();
  let settled = false;
  let refusals = 0;
  const r = rig({
    api,
    checkGate: gate,
    getCheckRuns: async (_repo, sha) => (settled ? failedSummary(sha) : { sha, conclusion: null, total: 3, failed: [] }),
    onEvent: (event) => {
      if (event.kind !== 'checks.completed') return;
      if (refusals === 0) {
        refusals += 1;
        throw new Error('host refused the event');
      }
    },
  });

  // Pass one: the row is delivered, the checks are pending, the cursor moves.
  const first = await onePass(r);
  assert.deepEqual(
    first.delivered.map((e) => e.kind),
    // Amendment 2a: this pull request was created before the cursor and the
    // poll state has no head for it yet, so its first sighting is a synchronize.
    ['pull.synchronize'],
  );
  assert.equal(first.cursorAdvanced, true);
  assert.equal(first.checksBacklog, 1);

  // From here on the pull-request row is behind the cursor: the backlog is
  // the only thing that can produce this checks event.
  const cursor = r.state.lastPollAt() as string;
  assert.deepEqual((await api.listIssuesSince(TEST_REPO, cursor)).rows, []);

  // Pass two: the checks settle and the listener refuses.
  settled = true;
  const second = await onePass(r);
  assert.equal(second.failed, 1);
  assert.equal(second.delivered.length, 0);
  assert.equal(second.checksBacklog, 1, 'the head must survive the refusal');
  assert.equal(gate.size, 0, 'and nothing must be committed for it');
  assert.equal(second.cursorAdvanced, false);

  // Pass three: the retry lands, and only now is the head retired.
  const third = await onePass(r);
  assert.deepEqual(
    third.delivered.map((e) => e.kind),
    ['checks.completed'],
  );
  assert.equal(third.delivered[0].sha, pull.head.sha);
  assert.deepEqual(third.delivered[0].checks?.failed.map((f) => f.name), ['clippy']);
  assert.equal(third.checksBacklog, 0);
  assert.equal(refusals, 1);
});

test('a checks event the gate has already spoken for retires its head instead of waiting forever', async () => {
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  const gate = new CheckGate();
  const r = rig({ api, checkGate: gate, getCheckRuns: async (_repo, sha) => failedSummary(sha) });

  // The webhook path had this exact result accepted first.
  assert.equal(
    await gate.emit(TEST_REPO, pull.head.sha, { rank: 7, failed: ['clippy'] }, async () => {}),
    true,
  );

  const first = await r.poller.pollOnce();
  assert.equal(first.delivered.filter((e) => e.kind === 'checks.completed').length, 0);
  assert.equal(first.duplicates, 1);
  assert.equal(first.checksBacklog, 0, 'dedup confirms delivery, so the head is done');
  // And it is not looked up again.
  assert.equal((await r.poller.pollOnce()).checkLookups, 0);
});

test('a head whose event was accepted is not re-delivered by the durable gate either', async () => {
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  const r = rig({ api, getCheckRuns: async (_repo, sha) => failedSummary(sha) });

  const first = await r.poller.pollOnce();
  assert.equal(first.delivered.filter((e) => e.kind === 'checks.completed').length, 1);
  // Both share the row's `updated_at`, so the key breaks the tie.
  const keys = r.state.snapshot().pollKeys;
  assert.equal(keys.length, 2);
  assert.match(keys[0], new RegExp(`^checks:${pull.head.sha}:failure:1:[0-9a-f]{12}$`));
  assert.equal(keys[1], `issue:${pull.number}:2026-10-13T12:00:00.000Z`);
  // The head is retired, so nothing re-queues it and nothing re-delivers it.
  const second = await r.poller.pollOnce();
  assert.equal(second.checkLookups, 0);
  assert.equal(second.delivered.length, 0);
});

for (const scenario of checksCases) {
  test(`App poll checks filter: ${scenario.name}, with byte-identical default/all output`, async () => {
    const outputs: string[] = [];
    for (const checksEmit of [undefined, 'all', 'failures'] as const) {
      const api = new FakeGitHubApi();
      api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
      const r = rig({ api, checksEmit, getCheckRuns: async (_repo, sha) => summarizeChecks(sha, checkRuns(scenario.conclusions), { checksEmit }) });
      const result = await r.poller.pollOnce();
      const events = r.events.filter((e) => e.kind === 'checks.completed');
      assert.equal(events.length, checksEmit !== 'failures' || scenario.emits ? 1 : 0);
      assert.equal(result.checksBacklog, 0, 'suppression retires the head');
      assert.equal(result.failed, 0);
      assert.ok(r.state.snapshot().pollKeys.some((key) => key.startsWith('checks:')));
      outputs.push(JSON.stringify(r.events));
      assert.equal((await r.poller.pollOnce()).checkLookups, 0);
    }
    assert.equal(outputs[0], outputs[1]);
  });
}

test('App poll suppression survives disk reload and a fresh gate, then permits a failing rerun', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'github-app-checks-filter-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const state = GithubState.load(file);
  state.setLastPollAt('2026-10-13T00:00:00Z');
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  const events: NormalizedEvent[] = [];
  let conclusion: 'success' | 'failure' = 'success';
  let now = '2026-10-14T00:00:00Z';
  const makePoller = (state: GithubState) => new Poller({
    api: { listIssuesSince: (...args) => api.listIssuesSince(...args),
      listIssueCommentsSince: (...args) => api.listIssueCommentsSince(...args),
      listReviewCommentsSince: (...args) => api.listReviewCommentsSince(...args),
      getCheckRuns: async (_repo, sha) => summarizeChecks(sha, checkRuns([conclusion])) },
    state, repos: [TEST_REPO], intervalMs: MIN_POLL_INTERVAL_MS, checksEmit: 'failures',
    now: () => new Date(now), onEvent: (event) => { events.push(event); },
  });
  await makePoller(state).pollOnce();
  await state.flush();
  const restored = GithubState.load(file);
  assert.ok(restored.snapshot().pollKeys.some((key) => key.startsWith(`checks:${pull.head.sha}:success:`)));
  now = '2026-10-14T02:00:00Z';
  const restarted = makePoller(restored);
  api.seedPullRequest({ number: 58, head: pull.head, updatedAt: '2026-10-14T01:00:00Z' });
  assert.equal((await restarted.pollOnce()).duplicates, 1);
  conclusion = 'failure';
  api.seedPullRequest({ number: 58, head: pull.head, updatedAt: '2026-10-14T03:00:00Z' });
  await restarted.pollOnce();
  await restarted.pollOnce();
  assert.deepEqual(events.filter((e) => e.kind === 'checks.completed').map((e) => e.checks?.conclusion), ['failure']);
  await restored.flush();
});
