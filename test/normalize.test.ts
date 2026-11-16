import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  CheckGate,
  HANDLED_WEBHOOK_EVENTS,
  actorFrom,
  checkMarkOf,
  checksPollKey,
  coversMark,
  isCompletedSummary,
  normalizePolledChecks,
  normalizePolledComment,
  normalizePolledIssue,
  normalizeWebhook,
  pollEventId,
  pollKey,
  repoFrom,
  resolveCheckEvents,
  threadKindFromUrl,
  type CheckMark,
  type WebhookDelivery,
} from '../src/normalize.js';
import type {
  CheckConclusion,
  ChecksSummary,
  NormalizedEvent,
  PolledComment,
  PolledIssue,
  ThreadRef,
} from '../src/types.js';
import { FakeGitHubApi, TEST_REPO } from './harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const RECEIVED_AT = '2026-10-14T00:00:00.000Z';
const HEAD = '4d7b2e8c1a93f05627de4b1c8a0f3927e5c6d418';
const FIRST_HEAD = '1f0c9a4d2b7e55c3a81d6e40b9f27c3d5a8e1b02';
const DEV_SHA = '9ab3c1d7e5f20418b6c93d7a2e1f08c4d6b5a397';

function eventNameOf(fixture: string): string {
  return fixture.split('.', 1)[0];
}

function load(fixture: string): WebhookDelivery {
  return {
    id: `delivery-${fixture}`,
    event: eventNameOf(fixture),
    payload: JSON.parse(readFileSync(join(FIXTURES, fixture), 'utf8')),
    receivedAt: RECEIVED_AT,
  };
}

const ISSUE_41: ThreadRef = { repo: TEST_REPO, number: 41, kind: 'issue' };
const PULL_58: ThreadRef = { repo: TEST_REPO, number: 58, kind: 'pull' };

interface Expectation {
  events: Partial<NormalizedEvent>[];
  foreignRepo?: boolean;
}

const EXPECTED: Record<string, Expectation> = {
  'issues.opened.json': {
    events: [
      {
        kind: 'issue.opened',
        thread: ISSUE_41,
        actor: { login: 'octocat', isBot: false },
        title: 'Scheduler drops the last batch when the queue drains mid-tick',
        html_url: 'https://github.com/anima-research/rayforce/issues/41',
      },
    ],
  },
  'issues.closed.json': {
    events: [
      {
        kind: 'issue.closed',
        thread: ISSUE_41,
        actor: { login: 'hubot', isBot: false },
        html_url: 'https://github.com/anima-research/rayforce/issues/41',
      },
    ],
  },
  'issue_comment.created.json': {
    events: [
      {
        kind: 'comment.created',
        thread: ISSUE_41,
        actor: { login: 'hubot', isBot: false },
        body: '@rayforce-clone[bot] can you reproduce this on dev?',
        html_url: 'https://github.com/anima-research/rayforce/issues/41#issuecomment-2200000007',
        comment: { id: 2200000007 },
      },
    ],
  },
  'issue_comment.created.on_pull.json': {
    events: [
      {
        kind: 'comment.created',
        // `issue.pull_request` present ⇒ the thread is a pull request.
        thread: PULL_58,
        actor: { login: 'octocat', isBot: false },
        html_url: 'https://github.com/anima-research/rayforce/pull/58#issuecomment-2200000031',
        comment: { id: 2200000031 },
      },
    ],
  },
  'pull_request.opened.json': {
    events: [
      {
        kind: 'pull.opened',
        thread: PULL_58,
        actor: { login: 'rayforce-clone[bot]', isBot: true },
        title: 'fix(scheduler): dispatch the final batch',
        sha: FIRST_HEAD,
        html_url: 'https://github.com/anima-research/rayforce/pull/58',
      },
    ],
  },
  'pull_request.synchronize.json': {
    events: [{ kind: 'pull.synchronize', thread: PULL_58, actor: { login: 'rayforce-clone[bot]', isBot: true }, sha: HEAD }],
  },
  'pull_request.ready_for_review.json': {
    events: [{ kind: 'pull.ready_for_review', thread: PULL_58, sha: FIRST_HEAD }],
  },
  'pull_request.review_requested.json': {
    events: [{ kind: 'pull.review_requested', thread: PULL_58, sha: FIRST_HEAD }],
  },
  'pull_request.closed.json': {
    events: [{ kind: 'pull.closed', thread: PULL_58, actor: { login: 'octocat', isBot: false }, sha: HEAD }],
  },
  'pull_request_review.submitted.json': {
    events: [
      {
        kind: 'review.submitted',
        thread: PULL_58,
        actor: { login: 'octocat', isBot: false },
        body: 'Two things before this goes in.',
        sha: HEAD,
        review: { id: 2400000012, state: 'changes_requested' },
        html_url: 'https://github.com/anima-research/rayforce/pull/58#pullrequestreview-2400000012',
      },
    ],
  },
  'pull_request_review.submitted.stale_commit.json': {
    events: [
      {
        kind: 'review.submitted',
        thread: PULL_58,
        actor: { login: 'octocat', isBot: false },
        // The commit reviewed, not the pull request's current head.
        sha: FIRST_HEAD,
        review: { id: 2400000044, state: 'approved' },
      },
    ],
  },
  'pull_request_review_comment.created.json': {
    events: [
      {
        kind: 'review_comment.created',
        thread: PULL_58,
        actor: { login: 'octocat', isBot: false },
        sha: HEAD,
        reviewComment: {
          id: 2500000077,
          path: 'src/scheduler/tick.rs',
          line: 118,
          side: 'RIGHT',
          diffHunk:
            '@@ -112,6 +112,10 @@ impl Tick {\n     fn finish(&mut self) {\n+        self.drain_pending();\n     }',
        },
      },
    ],
  },
  'pull_request_review_comment.created.reply.json': {
    events: [
      {
        kind: 'review_comment.created',
        thread: PULL_58,
        actor: { login: 'rayforce-clone[bot]', isBot: true },
        sha: HEAD,
        reviewComment: {
          id: 2500000078,
          path: 'src/scheduler/tick.rs',
          line: 118,
          side: 'RIGHT',
          diffHunk:
            '@@ -112,6 +112,10 @@ impl Tick {\n     fn finish(&mut self) {\n+        self.drain_pending();\n     }',
          inReplyTo: 2500000077,
        },
      },
    ],
  },
  'check_suite.completed.json': {
    events: [
      {
        kind: 'checks.completed',
        thread: PULL_58,
        actor: { login: 'rayforce-clone[bot]', isBot: true },
        sha: HEAD,
        checks: { conclusion: 'failure', failed: [] },
      },
    ],
  },
  'check_suite.completed.second_suite_failed.json': {
    events: [
      {
        kind: 'checks.completed',
        thread: PULL_58,
        sha: HEAD,
        checks: { conclusion: 'failure', failed: [] },
      },
    ],
  },
  'check_suite.completed.second_suite.json': {
    events: [
      {
        kind: 'checks.completed',
        thread: PULL_58,
        sha: HEAD,
        checks: { conclusion: 'success', failed: [] },
      },
    ],
  },
  'check_suite.completed.no_pull.json': {
    events: [
      {
        kind: 'checks.completed',
        thread: undefined,
        actor: { login: 'octocat', isBot: false },
        sha: DEV_SHA,
        checks: { conclusion: 'success', failed: [] },
        html_url: `https://github.com/anima-research/rayforce/commit/${DEV_SHA}`,
      },
    ],
  },
  'check_run.completed.json': {
    events: [
      {
        kind: 'checks.completed',
        thread: PULL_58,
        sha: HEAD,
        checks: {
          conclusion: 'failure',
          failed: [{ name: 'test (ubuntu-latest)', url: 'https://github.com/anima-research/rayforce/runs/2700001234' }],
        },
        html_url: 'https://github.com/anima-research/rayforce/runs/2700001234',
      },
    ],
  },
  'push.json': {
    events: [
      {
        kind: 'push',
        thread: undefined,
        actor: { login: 'rayforce-clone[bot]', isBot: true },
        sha: HEAD,
        html_url: 'https://github.com/anima-research/rayforce/compare/1f0c9a4d2b7e...4d7b2e8c1a93',
      },
    ],
  },
  // GitHub's ping checks the webhook's reachability; it carries no event.
  'ping.json': { events: [] },
  'issues.opened.foreign_repo.json': {
    events: [{ kind: 'issue.opened', thread: { repo: { owner: 'other-org', name: 'other-repo' }, number: 3, kind: 'issue' } }],
    foreignRepo: true,
  },
};

function fixtureFiles(): string[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

test('every fixture has a documented expectation and every expectation a fixture', () => {
  assert.deepEqual(fixtureFiles(), Object.keys(EXPECTED).sort());
});

for (const fixture of fixtureFiles()) {
  test(`fixture ${fixture} normalizes as documented`, () => {
    const delivery = load(fixture);
    const events = normalizeWebhook(delivery);
    const expectation = EXPECTED[fixture];
    assert.equal(events.length, expectation.events.length, `event count for ${fixture}`);

    events.forEach((event, i) => {
      const want = expectation.events[i];
      for (const [field, value] of Object.entries(want)) {
        assert.deepEqual(
          event[field as keyof NormalizedEvent],
          value,
          `${fixture} event ${i}: field ${field}`,
        );
      }
      assert.equal(event.id, delivery.id);
      assert.equal(event.receivedAt, RECEIVED_AT);
      assert.ok(event.html_url.startsWith('https://github.com/'), 'html_url is a github URL');
      assert.ok(event.actor.login.length > 0, 'actor has a login');
      if (!expectation.foreignRepo) assert.deepEqual(event.repo, TEST_REPO);
      assert.equal(event.raw, delivery.payload);
    });
  });
}

test('an unhandled event or action is dropped rather than guessed at', () => {
  const payload = JSON.parse(readFileSync(join(FIXTURES, 'issues.opened.json'), 'utf8'));
  assert.deepEqual(normalizeWebhook({ ...load('issues.opened.json'), payload: { ...payload, action: 'labeled' } }), []);
  assert.deepEqual(normalizeWebhook({ ...load('issues.opened.json'), event: 'installation_repositories' }), []);
  assert.deepEqual(normalizeWebhook({ ...load('issues.opened.json'), payload: { action: 'opened' } }), []);
  assert.deepEqual(normalizeWebhook({ ...load('issues.opened.json'), payload: 42 }), []);
  assert.deepEqual(normalizeWebhook({ ...load('issues.opened.json'), payload: null }), []);
});

test('the handled-event list matches the fixtures and the mapping', () => {
  const fromFixtures = new Set(fixtureFiles().map(eventNameOf).filter((e) => e !== 'ping'));
  assert.deepEqual([...fromFixtures].sort(), [...HANDLED_WEBHOOK_EVENTS].sort());
});

test('a deleted review comment lands as comment.deleted carrying reviewComment', () => {
  const payload = JSON.parse(readFileSync(join(FIXTURES, 'pull_request_review_comment.created.json'), 'utf8'));
  const [event] = normalizeWebhook({
    ...load('pull_request_review_comment.created.json'),
    payload: { ...payload, action: 'deleted' },
  });
  assert.equal(event.kind, 'comment.deleted');
  assert.equal(event.reviewComment?.id, 2500000077);
});

test('a review state the contract does not name becomes commented', () => {
  const payload = JSON.parse(readFileSync(join(FIXTURES, 'pull_request_review.submitted.json'), 'utf8'));
  const [event] = normalizeWebhook({
    ...load('pull_request_review.submitted.json'),
    payload: { ...payload, review: { ...payload.review, state: 'DISMISSED' } },
  });
  assert.equal(event.review?.state, 'commented');
});

test('actor and repo extraction', () => {
  assert.deepEqual(actorFrom({ login: 'octocat', type: 'User' }), { login: 'octocat', isBot: false });
  assert.deepEqual(actorFrom({ login: 'dependabot[bot]' }), { login: 'dependabot[bot]', isBot: true });
  assert.deepEqual(actorFrom({ login: 'some-app', type: 'Bot' }), { login: 'some-app', isBot: true });
  assert.equal(actorFrom({}), undefined);
  assert.deepEqual(repoFrom({ repository: { full_name: 'anima-research/rayforce' } }), TEST_REPO);
  assert.deepEqual(repoFrom({ repository: { owner: { login: 'a' }, name: 'b' } }), { owner: 'a', name: 'b' });
  assert.equal(repoFrom({ repository: { full_name: 'not-a-slug' } }), undefined);
});

test('threadKindFromUrl tells an issue comment on a PR from one on an issue', () => {
  assert.equal(threadKindFromUrl('https://github.com/a/b/pull/7#issuecomment-1'), 'pull');
  assert.equal(threadKindFromUrl('https://github.com/a/b/issues/7#issuecomment-1'), 'issue');
  assert.equal(threadKindFromUrl(undefined), 'issue');
});

const POLLED_ISSUE: PolledIssue = {
  id: 2100000001,
  number: 41,
  isPullRequest: false,
  title: 'Scheduler drops the last batch',
  body: 'Steps to reproduce inside.',
  state: 'open',
  author: { login: 'octocat', isBot: false },
  createdAt: '2026-10-12T08:00:00Z',
  updatedAt: '2026-10-13T09:00:00Z',
  html_url: 'https://github.com/anima-research/rayforce/issues/41',
};

const SINCE = '2026-10-13T08:00:00.000Z';

test('poll ids and dedup keys have the documented shape', () => {
  assert.equal(pollKey('issue', 41, '2026-10-13T09:00:00Z'), 'issue:41:2026-10-13T09:00:00Z');
  assert.equal(pollEventId('issue:41:X'), 'poll:issue:41:X');
});

test('a polled issue row normalizes by state, and an edit keeps issue.edited', () => {
  const open = normalizePolledIssue(TEST_REPO, POLLED_ISSUE, RECEIVED_AT, SINCE);
  assert.ok(open);
  // Created before the cursor: GitHub's list gives updated_at, not which
  // field changed.
  assert.equal(open.kind, 'issue.edited');
  assert.equal(open.id, 'poll:issue:2100000001:2026-10-13T09:00:00Z');
  assert.deepEqual(open.thread, ISSUE_41);
  assert.deepEqual(open.actor, { login: 'octocat', isBot: false });
  assert.equal(open.title, 'Scheduler drops the last batch');
  assert.equal(open.sha, undefined);

  const closed = normalizePolledIssue(TEST_REPO, { ...POLLED_ISSUE, state: 'closed' }, RECEIVED_AT, SINCE);
  assert.ok(closed);
  assert.equal(closed.kind, 'issue.closed');
});

test('an issue created at or after the cursor is issue.opened (amendment 2a)', () => {
  const after = normalizePolledIssue(TEST_REPO, { ...POLLED_ISSUE, createdAt: '2026-10-13T08:30:00Z' }, RECEIVED_AT, SINCE);
  assert.ok(after);
  assert.equal(after.kind, 'issue.opened');

  const exactly = normalizePolledIssue(TEST_REPO, { ...POLLED_ISSUE, createdAt: SINCE }, RECEIVED_AT, SINCE);
  assert.ok(exactly);
  assert.equal(exactly.kind, 'issue.opened');

  const before = normalizePolledIssue(TEST_REPO, { ...POLLED_ISSUE, createdAt: '2026-10-13T07:59:59.999Z' }, RECEIVED_AT, SINCE);
  assert.ok(before);
  assert.equal(before.kind, 'issue.edited');
});

test('created_at is compared as an instant, not as a string (amendment 2a)', () => {
  // GitHub stamps a row without milliseconds while the cursor carries them,
  // and 'Z' sorts after '.', so 12:00:00Z must compare before 12:00:00.500Z.
  const row = { ...POLLED_ISSUE, createdAt: '2026-10-13T12:00:00Z' };
  const edited = normalizePolledIssue(TEST_REPO, row, RECEIVED_AT, '2026-10-13T12:00:00.500Z');
  assert.ok(edited);
  assert.equal(edited.kind, 'issue.edited');

  const unparseable = normalizePolledIssue(TEST_REPO, { ...POLLED_ISSUE, createdAt: '' }, RECEIVED_AT, SINCE);
  assert.ok(unparseable);
  assert.equal(unparseable.kind, 'issue.edited');
});

test('a polled pull-request row normalizes by state and keeps the head sha', () => {
  const row: PolledIssue = {
    ...POLLED_ISSUE,
    id: 2300000058,
    number: 58,
    isPullRequest: true,
    headSha: HEAD,
    createdAt: '2026-10-13T08:30:00Z',
  };
  const open = normalizePolledIssue(TEST_REPO, row, RECEIVED_AT, SINCE);
  assert.ok(open);
  assert.equal(open.kind, 'pull.opened');
  assert.deepEqual(open.thread, PULL_58);
  assert.equal(open.sha, HEAD);

  const closed = normalizePolledIssue(TEST_REPO, { ...row, state: 'closed', createdAt: '2026-10-01T00:00:00Z' }, RECEIVED_AT, SINCE);
  assert.ok(closed);
  assert.equal(closed.kind, 'pull.closed');
});

test('an open pull-request row seen again is synchronize on a new head, and dropped otherwise (amendment 2a)', () => {
  const row: PolledIssue = {
    ...POLLED_ISSUE,
    id: 2300000058,
    number: 58,
    isPullRequest: true,
    headSha: HEAD,
    createdAt: '2026-10-12T08:00:00Z',
  };

  const moved = normalizePolledIssue(TEST_REPO, row, RECEIVED_AT, SINCE, 'a'.repeat(40));
  assert.ok(moved);
  assert.equal(moved.kind, 'pull.synchronize');
  assert.equal(moved.sha, HEAD);

  // Same head: a comment bumped the row's updated_at.
  assert.equal(normalizePolledIssue(TEST_REPO, row, RECEIVED_AT, SINCE, HEAD), null);

  assert.equal(normalizePolledIssue(TEST_REPO, { ...row, headSha: undefined }, RECEIVED_AT, SINCE, HEAD), null);
  assert.equal(normalizePolledIssue(TEST_REPO, { ...row, headSha: '' }, RECEIVED_AT, SINCE, undefined), null);
});

test('a polled top-level comment carries its own id, a review comment does not (amendment 2b)', () => {
  const top: PolledComment = {
    id: 2200000031,
    number: 41,
    author: { login: 'octocat', isBot: false },
    body: 'a followup',
    updatedAt: '2026-10-13T09:00:00Z',
    html_url: 'https://github.com/anima-research/rayforce/issues/41#issuecomment-2200000031',
  };
  assert.deepEqual(normalizePolledComment(TEST_REPO, top, 'issue_comment', RECEIVED_AT).comment, { id: 2200000031 });

  // GitHub numbers issue comments and review comments separately, so an id
  // from one endpoint must never be read as an id from the other.
  const review = normalizePolledComment(TEST_REPO, { ...top, path: 'src/lib.rs' }, 'review_comment', RECEIVED_AT);
  assert.equal(review.comment, undefined);
  assert.equal(review.reviewComment?.id, 2200000031);
});

test('a polled issue comment takes its thread kind from the html_url', () => {
  const row: PolledComment = {
    id: 2200000031,
    number: 58,
    author: { login: 'octocat', isBot: false },
    body: 'Looks right.',
    updatedAt: '2026-10-13T09:05:00Z',
    html_url: 'https://github.com/anima-research/rayforce/pull/58#issuecomment-2200000031',
  };
  const event = normalizePolledComment(TEST_REPO, row, 'issue_comment', RECEIVED_AT);
  assert.equal(event.kind, 'comment.created');
  assert.equal(event.id, 'poll:issue_comment:2200000031:2026-10-13T09:05:00Z');
  assert.deepEqual(event.thread, PULL_58);
  assert.equal(event.reviewComment, undefined);

  const onIssue = normalizePolledComment(
    TEST_REPO,
    { ...row, number: 41, html_url: 'https://github.com/anima-research/rayforce/issues/41#issuecomment-1' },
    'issue_comment',
    RECEIVED_AT,
  );
  assert.deepEqual(onIssue.thread, ISSUE_41);
});

test('a polled review comment carries path and inReplyTo and is always on a pull', () => {
  const row: PolledComment = {
    id: 2500000078,
    number: 58,
    author: { login: 'rayforce-clone[bot]', isBot: true },
    body: 'Guarded now.',
    updatedAt: '2026-10-13T13:02:00Z',
    html_url: 'https://github.com/anima-research/rayforce/pull/58#discussion_r2500000078',
    path: 'src/scheduler/tick.rs',
    inReplyTo: 2500000077,
  };
  const event = normalizePolledComment(TEST_REPO, row, 'review_comment', RECEIVED_AT);
  assert.equal(event.kind, 'review_comment.created');
  assert.deepEqual(event.thread, PULL_58);
  assert.deepEqual(event.reviewComment, {
    id: 2500000078,
    path: 'src/scheduler/tick.rs',
    line: null,
    side: 'RIGHT',
    diffHunk: '',
    inReplyTo: 2500000077,
  });
});

test('a polled check summary is keyed on the conclusion, not on a timestamp', () => {
  const summary = {
    sha: HEAD,
    conclusion: 'failure' as CheckConclusion,
    total: 3,
    failed: [{ name: 'clippy', url: 'https://github.com/anima-research/rayforce/runs/2700001235' }],
  };
  const event = normalizePolledChecks(TEST_REPO, PULL_58, summary, PULL_58.repo.name, RECEIVED_AT);
  assert.equal(event.kind, 'checks.completed');
  assert.match(event.id, new RegExp(`^poll:checks:${HEAD}:failure:1:[0-9a-f]{12}$`));
  assert.equal(event.sha, HEAD);
  assert.deepEqual(event.checks, { conclusion: 'failure', failed: summary.failed });
});

test('isCompletedSummary is what stops a pending head becoming checks.completed', () => {
  const settled: ChecksSummary = { sha: HEAD, conclusion: 'success', total: 2, failed: [] };
  assert.equal(isCompletedSummary(settled), true);
  assert.equal(isCompletedSummary({ ...settled, conclusion: null }), false);
  assert.equal(isCompletedSummary({ sha: HEAD, conclusion: null, total: 0, failed: [] }), false);
  if (isCompletedSummary(settled)) {
    assert.match(
      normalizePolledChecks(TEST_REPO, PULL_58, settled, 'u', RECEIVED_AT).id,
      new RegExp(`^poll:checks:${HEAD}:success:0:[0-9a-f]{12}$`),
    );
  }
});

function mark(rank: number, ...failed: string[]): CheckMark {
  return { rank, failed: [...new Set(failed)].sort() };
}

const RANK_NONE = -1;
const RANK_SUCCESS = 0;
const RANK_SKIPPED = 1;
const RANK_CANCELLED = 4;
const RANK_FAILURE = 7;

test('checkMarkOf reads a mark off a checks event and nothing off any other', () => {
  const [checks] = normalizeWebhook(load('check_suite.completed.json'));
  assert.deepEqual(checkMarkOf(checks), mark(RANK_FAILURE));
  const [green] = normalizeWebhook(load('check_suite.completed.second_suite.json'));
  assert.deepEqual(checkMarkOf(green), mark(RANK_SUCCESS));
  const [run] = normalizeWebhook(load('check_run.completed.json'));
  assert.deepEqual(checkMarkOf(run), mark(RANK_FAILURE, 'test (ubuntu-latest)'));
  const [issue] = normalizeWebhook(load('issues.opened.json'));
  assert.equal(checkMarkOf(issue), null);
  const [push] = normalizeWebhook(load('push.json'));
  assert.equal(checkMarkOf(push), null);
});

test('a mark names its failed jobs sorted and deduplicated, so it compares by set', () => {
  const event: NormalizedEvent = {
    ...normalizeWebhook(load('check_suite.completed.json'))[0],
    checks: {
      conclusion: 'failure',
      failed: [
        { name: 'test', url: 'u1' },
        { name: 'lint', url: 'u2' },
        { name: 'test', url: 'u3' },
      ],
    },
  };
  assert.deepEqual(checkMarkOf(event), { rank: RANK_FAILURE, failed: ['lint', 'test'] });
});

test('coversMark is what decides dedup against supersession', () => {
  assert.equal(coversMark(mark(RANK_FAILURE, 'lint'), mark(RANK_FAILURE, 'lint')), true);
  assert.equal(coversMark(mark(RANK_SUCCESS), mark(RANK_FAILURE)), false);
  assert.equal(coversMark(mark(RANK_FAILURE), mark(RANK_SUCCESS)), true);
  assert.equal(coversMark(mark(RANK_SKIPPED), mark(RANK_SUCCESS)), true);
  assert.equal(coversMark(mark(RANK_FAILURE), mark(RANK_CANCELLED)), true);
  assert.equal(coversMark(mark(RANK_FAILURE, 'lint'), mark(RANK_FAILURE, 'lint', 'test')), false);
  assert.equal(coversMark(mark(RANK_FAILURE), mark(RANK_FAILURE, 'lint')), false);
  assert.equal(coversMark(mark(RANK_FAILURE, 'lint', 'test'), mark(RANK_FAILURE, 'lint')), true);
  assert.equal(coversMark(mark(RANK_FAILURE, 'lint', 'test'), mark(RANK_FAILURE)), true);
  assert.equal(coversMark(mark(RANK_SUCCESS), mark(RANK_NONE)), true);
  assert.equal(coversMark(mark(RANK_NONE), mark(RANK_SUCCESS)), false);
});

async function emit(
  gate: CheckGate,
  sha: string,
  m: CheckMark,
  deliver: () => Promise<void> = async () => {},
): Promise<boolean> {
  return gate.emit(TEST_REPO, sha, m, deliver);
}

test('the gate commits a mark only after the delivery was accepted', async () => {
  const gate = new CheckGate();
  assert.equal(gate.committedMark(TEST_REPO, HEAD), undefined);
  assert.equal(await emit(gate, HEAD, mark(RANK_FAILURE, 'lint')), true);
  assert.deepEqual(gate.committedMark(TEST_REPO, HEAD), mark(RANK_FAILURE, 'lint'));
  assert.equal(gate.size, 1);
});

test('a refused delivery commits nothing, so the next emission still delivers', async () => {
  const gate = new CheckGate();
  await assert.rejects(
    () =>
      emit(gate, HEAD, mark(RANK_FAILURE, 'lint'), async () => {
        throw new Error('host refused the event');
      }),
    /host refused/,
  );
  assert.equal(gate.committedMark(TEST_REPO, HEAD), undefined, 'a refusal leaves no trace');
  assert.equal(gate.size, 0);
  assert.equal(await emit(gate, HEAD, mark(RANK_FAILURE, 'lint')), true);
  assert.deepEqual(gate.committedMark(TEST_REPO, HEAD), mark(RANK_FAILURE, 'lint'));
});

test('the gate drops an emission the committed mark covers, without calling the listener', async () => {
  const gate = new CheckGate();
  assert.equal(await emit(gate, HEAD, mark(RANK_FAILURE, 'lint', 'test')), true);
  let called = 0;
  const deliver = async (): Promise<void> => {
    called += 1;
  };
  assert.equal(await emit(gate, HEAD, mark(RANK_FAILURE, 'lint', 'test'), deliver), false);
  assert.equal(await emit(gate, HEAD, mark(RANK_FAILURE, 'lint'), deliver), false);
  assert.equal(await emit(gate, HEAD, mark(RANK_SUCCESS), deliver), false);
  assert.equal(called, 0, 'the listener is never told something it already has');
  assert.equal(await emit(gate, HEAD, mark(RANK_FAILURE, 'lint', 'test', 'audit'), deliver), true);
  assert.equal(called, 1);
});

test('a committed mark accumulates, so an older result cannot undo a newer one', async () => {
  const gate = new CheckGate();
  await emit(gate, HEAD, mark(RANK_FAILURE, 'test'));
  await emit(gate, HEAD, mark(RANK_FAILURE, 'lint'));
  assert.deepEqual(gate.committedMark(TEST_REPO, HEAD), mark(RANK_FAILURE, 'lint', 'test'));
  assert.equal(await emit(gate, HEAD, mark(RANK_SUCCESS)), false);
  assert.deepEqual(gate.committedMark(TEST_REPO, HEAD), mark(RANK_FAILURE, 'lint', 'test'));
});

test('a different head sha, and the same sha in another repo, are their own stories', async () => {
  const gate = new CheckGate();
  await emit(gate, HEAD, mark(RANK_FAILURE));
  assert.equal(gate.committedMark(TEST_REPO, DEV_SHA), undefined);
  assert.equal(gate.committedMark({ owner: 'other-org', name: 'other-repo' }, HEAD), undefined);
  assert.equal(await emit(gate, DEV_SHA, mark(RANK_SUCCESS)), true);
  assert.equal(
    await gate.emit({ owner: 'other-org', name: 'other-repo' }, HEAD, mark(RANK_SUCCESS), async () => {}),
    true,
  );
});

test('the gate forgets the oldest head sha past its capacity', async () => {
  const gate = new CheckGate(3);
  for (const sha of ['a', 'b', 'c']) await emit(gate, sha, mark(RANK_SUCCESS));
  assert.equal(gate.size, 3);
  await emit(gate, 'd', mark(RANK_SUCCESS));
  assert.equal(gate.size, 3);
  assert.equal(gate.committedMark(TEST_REPO, 'a'), undefined);
  assert.deepEqual(gate.committedMark(TEST_REPO, 'd'), mark(RANK_SUCCESS));
  await emit(gate, 'b', mark(RANK_FAILURE));
  await emit(gate, 'e', mark(RANK_SUCCESS));
  assert.equal(gate.committedMark(TEST_REPO, 'b'), undefined, 'b was evicted despite re-emitting');
});

test('two emissions for one head sha run one after another, never interleaved', async () => {
  const gate = new CheckGate();
  const trace: string[] = [];
  let letFirstFinish: (() => void) | undefined;
  const firstHeld = new Promise<void>((resolve) => {
    letFirstFinish = resolve;
  });

  const first = emit(gate, HEAD, mark(RANK_FAILURE, 'lint'), async () => {
    trace.push('first in');
    await firstHeld;
    trace.push('first out');
  });
  const second = emit(gate, HEAD, mark(RANK_FAILURE, 'lint', 'test'), async () => {
    trace.push('second in');
    trace.push('second out');
  });
  assert.equal(gate.inFlight, 1, 'one queue for one sha');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(trace, ['first in'], 'the second must not start while the first is working');

  letFirstFinish?.();
  assert.deepEqual([await first, await second], [true, true]);
  assert.deepEqual(trace, ['first in', 'first out', 'second in', 'second out']);
  assert.deepEqual(gate.committedMark(TEST_REPO, HEAD), mark(RANK_FAILURE, 'lint', 'test'));
  assert.equal(gate.inFlight, 0, 'the queue is dropped once it drains');
});

test('emissions for different head shas do not wait for each other', async () => {
  const gate = new CheckGate();
  let letFirstFinish: (() => void) | undefined;
  const firstHeld = new Promise<void>((resolve) => {
    letFirstFinish = resolve;
  });
  const first = emit(gate, HEAD, mark(RANK_FAILURE), async () => {
    await firstHeld;
  });
  assert.equal(await emit(gate, DEV_SHA, mark(RANK_SUCCESS)), true);
  assert.equal(gate.inFlight, 1, 'only the blocked sha still has a queue');
  letFirstFinish?.();
  assert.equal(await first, true);
});

test('an emission queued behind a refused one still runs, and sees no mark', async () => {
  const gate = new CheckGate();
  let letFirstFail: (() => void) | undefined;
  const firstHeld = new Promise<void>((resolve) => {
    letFirstFail = resolve;
  });
  let secondSaw: CheckMark | undefined | 'not-run' = 'not-run';

  const first = emit(gate, HEAD, mark(RANK_FAILURE, 'lint'), async () => {
    await firstHeld;
    throw new Error('host refused the event');
  });
  const second = emit(gate, HEAD, mark(RANK_FAILURE, 'lint'), async () => {
    secondSaw = gate.committedMark(TEST_REPO, HEAD);
  });

  letFirstFail?.();
  await assert.rejects(() => first, /host refused/);
  assert.equal(await second, true, 'the queued emission runs and delivers');
  assert.equal(secondSaw, undefined, 'and sees nothing committed by the refusal');
  assert.deepEqual(gate.committedMark(TEST_REPO, HEAD), mark(RANK_FAILURE, 'lint'));
});

test('a refusal cannot erase what a later accepted emission committed', async () => {
  const gate = new CheckGate();
  let letAFail: (() => void) | undefined;
  const aHeld = new Promise<void>((resolve) => {
    letAFail = resolve;
  });

  const a = emit(gate, HEAD, mark(RANK_FAILURE, 'lint'), async () => {
    await aHeld;
    throw new Error('host refused A');
  });
  const b = emit(gate, HEAD, mark(RANK_FAILURE, 'lint', 'test'), async () => {});

  letAFail?.();
  await assert.rejects(() => a, /refused A/);
  assert.equal(await b, true);
  assert.deepEqual(gate.committedMark(TEST_REPO, HEAD), mark(RANK_FAILURE, 'lint', 'test'));
  let cDelivered = false;
  assert.equal(
    await emit(gate, HEAD, mark(RANK_FAILURE, 'lint', 'test'), async () => {
      cDelivered = true;
    }),
    false,
  );
  assert.equal(cDelivered, false);
});

test('supersession is decided inside the queue, against the mark committed by then', async () => {
  const gate = new CheckGate();
  let letFirstFinish: (() => void) | undefined;
  const firstHeld = new Promise<void>((resolve) => {
    letFirstFinish = resolve;
  });
  let secondDelivered = false;

  const first = emit(gate, HEAD, mark(RANK_FAILURE, 'lint', 'test'), async () => {
    await firstHeld;
  });
  const second = emit(gate, HEAD, mark(RANK_FAILURE, 'lint'), async () => {
    secondDelivered = true;
  });

  letFirstFinish?.();
  assert.equal(await first, true);
  assert.equal(await second, false, 'covered by the time it ran');
  assert.equal(secondDelivered, false);
});

test('resolveCheckEvents holds back a head whose other suite is still running', async () => {
  const api = new FakeGitHubApi();
  api.seedCheckRuns(TEST_REPO, {
    sha: HEAD,
    conclusion: null,
    total: 4,
    failed: [{ name: 'lint', url: 'https://github.com/anima-research/rayforce/runs/1' }],
  });
  assert.deepEqual(await resolveCheckEvents(normalizeWebhook(load('check_suite.completed.json')), api), []);
});

test('resolveCheckEvents emits the settled sha with every failed job on it', async () => {
  const api = new FakeGitHubApi();
  api.seedCheckRuns(TEST_REPO, {
    sha: HEAD,
    conclusion: 'failure',
    total: 4,
    failed: [
      { name: 'lint', url: 'https://github.com/anima-research/rayforce/runs/1' },
      { name: 'test', url: 'https://github.com/anima-research/rayforce/runs/2' },
    ],
  });
  const [event] = await resolveCheckEvents(normalizeWebhook(load('check_suite.completed.json')), api);
  assert.equal(event.checks?.conclusion, 'failure');
  assert.deepEqual(event.checks?.failed.map((f) => f.name), ['lint', 'test']);
  assert.deepEqual(api.callsTo('getCheckRuns')[0].args, [TEST_REPO, HEAD]);
});

test('resolveCheckEvents leaves a non-checks event alone and never calls the API for it', async () => {
  const api = new FakeGitHubApi();
  const events = await resolveCheckEvents(normalizeWebhook(load('issues.opened.json')), api);
  assert.equal(events[0].kind, 'issue.opened');
  assert.deepEqual(api.callLog(), []);
});

test('resolveCheckEvents forwards the event unchanged when the lookup throws', async () => {
  const api = {
    async getCheckRuns(): Promise<ChecksSummary> {
      throw new Error('502 from the API');
    },
  };
  const [event] = await resolveCheckEvents(normalizeWebhook(load('check_run.completed.json')), api);
  assert.equal(event.kind, 'checks.completed');
  assert.deepEqual(event.checks?.failed.map((f) => f.name), ['test (ubuntu-latest)']);
});

test('resolveCheckEvents keeps the payload conclusion when the API knows no runs', async () => {
  // GitHub answers a sha with no check runs with an empty list, as the fake
  // does for an unseeded sha.
  const [event] = await resolveCheckEvents(normalizeWebhook(load('check_suite.completed.json')), new FakeGitHubApi());
  assert.equal(event.checks?.conclusion, 'failure');
  assert.deepEqual(event.checks?.failed, []);
});

test('checksPollKey and the polled event id carry the conclusion, the job count and the failed set', () => {
  const one: ChecksSummary & { conclusion: CheckConclusion } = {
    sha: HEAD,
    conclusion: 'failure',
    total: 2,
    failed: [{ name: 'lint', url: 'u' }],
  };
  assert.match(checksPollKey(one), new RegExp(`^checks:${HEAD}:failure:1:[0-9a-f]{12}$`));
  const two = { ...one, failed: [...one.failed, { name: 'test', url: 'u' }] };
  assert.match(checksPollKey(two), new RegExp(`^checks:${HEAD}:failure:2:[0-9a-f]{12}$`));
  const other = { ...one, failed: [{ name: 'test', url: 'u' }] };
  assert.notEqual(checksPollKey(other), checksPollKey(one));
  const reordered = { ...two, failed: [{ name: 'test', url: 'x' }, { name: 'lint', url: 'y' }] };
  assert.equal(checksPollKey(reordered), checksPollKey(two));
  assert.equal(normalizePolledChecks(TEST_REPO, PULL_58, two, 'u', RECEIVED_AT).id, `poll:${checksPollKey(two)}`);
});
