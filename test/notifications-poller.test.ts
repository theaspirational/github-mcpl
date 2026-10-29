/**
 * Contributor mode's notifications poller (anima-research/github-mcpl#5).
 *
 * `NotificationsPollerApi` is faked in memory here; the HTTP side of each read
 * (paging, the 304, the headers) is tested against a real `GitHubAdapter` and
 * a fake GitHub in githubAdapter.test.ts ("Contributor mode"). What this file
 * proves is the poller's own logic: what a pass lists and reads, which rows
 * become which events, the cursors and the watermark across passes, failures
 * and restarts.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { method } from '@animalabs/mcpl-core';
import { Poller } from '../src/poller.js';
import { GitHubMcplServer } from '../src/server.js';
import { FakeGitHubApi, harness, initialize, grant } from './harness.js';
import { NotificationsPoller, type NotificationsPollerApi } from '../src/notifications-poller.js';
import { GithubState } from '../src/state.js';
import { GitHubApiError, ReadCapError, type NotificationRow, type NotificationsPage, type OwnPull } from '../src/github-adapter.js';
import { checksPollKey } from '../src/normalize.js';
import { tagsFor } from '../src/tags.js';
import {
  channelId,
  MIN_POLL_INTERVAL_MS,
  POLL_DEDUP_RING,
  type ChecksSummary,
  type EventActor,
  type NormalizedEvent,
  type PolledComment,
  type PolledIssue,
  type PolledReview,
  type RepoRef,
  type ThreadRef,
} from '../src/types.js';

const REPO: RepoRef = { owner: 'anima-research', name: 'rayforce' };
const ELSEWHERE: RepoRef = { owner: 'someone', name: 'private-thing' };
const ISSUE: ThreadRef = { repo: REPO, number: 7, kind: 'issue' };
const PULL: ThreadRef = { repo: REPO, number: 12, kind: 'pull' };
const HUMAN: EventActor = { login: 'human-one', isBot: false };
const MAINTAINER: EventActor = { login: 'maintainer', isBot: false };

/** The rig's clock: every pass runs at this instant unless a test moves it. */
const START = '2026-10-15T00:10:00.000Z';
/** A first start's watermark: one 60 s interval before START. */
const FIRST_W = '2026-10-15T00:09:00Z';
/** Where a thread first seen after the first start reads from: a notification's delay before FIRST_W. */
const FIRST_READ = '2026-10-15T00:04:00Z';

function threadRow(thread: ThreadRef, partial: Partial<PolledIssue> = {}): PolledIssue {
  return {
    id: thread.number * 1000,
    number: thread.number,
    isPullRequest: thread.kind === 'pull',
    title: thread.kind === 'pull' ? 'Fix it' : 'A bug',
    body: 'text',
    state: 'open',
    author: HUMAN,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-15T00:09:30Z',
    html_url: `https://github.com/anima-research/rayforce/${thread.kind === 'pull' ? 'pull' : 'issues'}/${thread.number}`,
    ...partial,
  };
}

function comment(id: number, number: number, updatedAt: string, author: EventActor = HUMAN): PolledComment {
  return { id, number, author, body: `comment ${id}`, updatedAt, html_url: `https://github.com/x/${id}` };
}

/** In-memory GitHub as the poller reads it: an inbox and each thread's rows. */
class FakeGitHub implements NotificationsPollerApi {
  /** The inbox: every participating thread, read or not. */
  inbox: NotificationRow[] = [];
  lastModified = 'Wed, 15 Oct 2026 00:09:40 GMT';
  /** Set to make the next listing a 304 when its If-Modified-Since matches `lastModified`. */
  conditional = true;
  pollInterval: number | null = null;
  /** The answer's Date; null leaves If-Modified-Since to Last-Modified alone. */
  date: string | null = null;
  /** Set to answer as a listing stopped at its page cap. */
  truncated = false;
  readonly threads = new Map<string, PolledIssue>();
  readonly comments = new Map<string, PolledComment[]>();
  readonly reviewComments = new Map<string, PolledComment[]>();
  readonly reviews = new Map<string, PolledReview[]>();
  /** A failure each thread's next reads throw, by channel. */
  readonly failing = new Map<string, Error>();
  /** The token user's open pull requests, as the search finds them. */
  ownPulls: OwnPull[] = [];
  /** Each pull request's head sha, by channel. */
  readonly heads = new Map<string, string>();
  /** The check runs on a sha, or what looking them up throws. */
  readonly checks = new Map<string, ChecksSummary | Error>();
  readonly calls: string[] = [];

  notify(thread: ThreadRef, updatedAt: string, repo: RepoRef = thread.repo, reason = 'mention'): void {
    this.inbox = this.inbox.filter((n) => !(n.repo.owner === repo.owner && n.repo.name === repo.name && n.number === thread.number));
    this.inbox.push({ id: `n-${repo.name}-${thread.number}`, updatedAt, reason, unread: true, repo, kind: thread.kind, number: thread.number, title: 't' });
  }

  async listNotifications(opts: { since: string; ifModifiedSince: string | null }): Promise<NotificationsPage> {
    this.calls.push(`list since=${opts.since} ims=${opts.ifModifiedSince}`);
    if (this.conditional && opts.ifModifiedSince === this.lastModified) {
      return { notifications: [], notModified: true, lastModified: this.lastModified, date: this.date, pollIntervalSeconds: this.pollInterval, truncated: false };
    }
    const notifications = this.inbox.filter((n) => Date.parse(n.updatedAt) > Date.parse(opts.since));
    return { notifications, notModified: false, lastModified: this.lastModified, date: this.date, pollIntervalSeconds: this.pollInterval, truncated: this.truncated };
  }

  private fail(thread: ThreadRef): void {
    const err = this.failing.get(channelId(thread));
    if (err) throw err;
  }

  async getPolledThread(thread: ThreadRef): Promise<PolledIssue> {
    this.calls.push(`thread ${channelId(thread)}`);
    this.fail(thread);
    const row = this.threads.get(channelId(thread));
    if (!row) throw new Error(`no thread seeded for ${channelId(thread)}`);
    return row;
  }

  async listCommentsSince(thread: ThreadRef, since: string): Promise<PolledComment[]> {
    this.calls.push(`comments ${channelId(thread)} since=${since}`);
    return (this.comments.get(channelId(thread)) ?? []).filter((c) => Date.parse(c.updatedAt) >= Date.parse(since));
  }

  async listPullReviewCommentsSince(pull: ThreadRef, since: string): Promise<PolledComment[]> {
    this.calls.push(`review comments ${channelId(pull)} since=${since}`);
    return (this.reviewComments.get(channelId(pull)) ?? []).filter((c) => Date.parse(c.updatedAt) >= Date.parse(since));
  }

  async listReviewsSince(pull: ThreadRef, since: string): Promise<PolledReview[]> {
    this.calls.push(`reviews ${channelId(pull)} since=${since}`);
    return (this.reviews.get(channelId(pull)) ?? []).filter((r) => Date.parse(r.submittedAt) >= Date.parse(since));
  }

  async listOwnOpenPulls(login: string, repos: readonly RepoRef[]): Promise<OwnPull[]> {
    this.calls.push(`list own pulls ${login}`);
    return this.ownPulls.filter((p) => repos.some((r) => r.owner === p.repo.owner && r.name === p.repo.name));
  }

  async getPullHeadSha(pull: ThreadRef): Promise<string> {
    this.calls.push(`head ${channelId(pull)}`);
    const sha = this.heads.get(channelId(pull));
    if (!sha) throw new Error(`no head seeded for ${channelId(pull)}`);
    return sha;
  }

  async getCheckRuns(_repo: RepoRef, sha: string): Promise<ChecksSummary> {
    this.calls.push(`checks ${sha}`);
    const answer = this.checks.get(sha);
    if (answer instanceof Error) throw answer;
    return answer ?? { sha, conclusion: null, total: 0, failed: [] };
  }
}

interface Rig {
  github: FakeGitHub;
  state: GithubState;
  poller: NotificationsPoller;
  events: NormalizedEvent[];
  /** Deliveries to refuse, by event id. */
  refuse: Set<string>;
  /** Every log line, `<level> <message> <fields>`. */
  logs: string[];
  setNow(at: string): void;
}

function rig(options: { stateFile?: string | null; state?: GithubState; github?: FakeGitHub; repos?: RepoRef[]; login?: string } = {}): Rig {
  const github = options.github ?? new FakeGitHub();
  const state = options.state ?? GithubState.load(options.stateFile ?? null);
  const events: NormalizedEvent[] = [];
  const refuse = new Set<string>();
  const logs: string[] = [];
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    logs.push(`${level} ${message} ${fields ? JSON.stringify(fields) : ''}`);
  };
  let now = Date.parse(START);
  const poller = new NotificationsPoller({
    api: github,
    state,
    intervalMs: MIN_POLL_INTERVAL_MS,
    repos: options.repos ?? [REPO],
    ...(options.login === undefined ? {} : { login: options.login }),
    onEvent: (event) => {
      if (refuse.has(event.id)) throw new Error('listener refused it');
      events.push(event);
    },
    now: () => new Date(now),
    logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
  });
  return { github, state, poller, events, refuse, logs, setNow: (at) => { now = Date.parse(at); } };
}

// ─────────────────────────────────────────────────────────────────────────────
// The watermark

test('a start stores a first W one interval before it, and a failed first pass keeps it', async () => {
  const r = rig();
  r.poller.start();
  r.poller.stop();
  assert.deepEqual(r.state.notificationsWatermark(), { since: FIRST_W, lastModified: null, answeredAt: null });
  assert.ok(r.logs.some((line) => line.includes('delivery begins one interval before this start') && line.includes(FIRST_W)));

  r.github.listNotifications = async () => {
    throw new Error('network down');
  };
  r.setNow('2026-10-15T00:11:00.000Z');
  await assert.rejects(() => r.poller.pollOnce(), /network down/);
  assert.deepEqual(r.state.notificationsWatermark(), { since: FIRST_W, lastModified: null, answeredAt: null });
});

test('a pass that gets through moves W to its Last-Modified less a second, in whole seconds, and sends that Last-Modified next', async () => {
  const r = rig();
  await r.poller.pollOnce();
  assert.equal(r.github.calls[0], `list since=${FIRST_W} ims=null`);
  assert.deepEqual(r.state.notificationsWatermark(), {
    since: '2026-10-15T00:09:39Z',
    lastModified: 'Wed, 15 Oct 2026 00:09:40 GMT',
    answeredAt: '2026-10-15T00:10:00Z',
  });
  const result = await r.poller.pollOnce();
  assert.equal(result.notModified, true, 'an unchanged inbox is a 304');
  assert.deepEqual(r.github.calls.slice(-1), ['list since=2026-10-15T00:09:39Z ims=Wed, 15 Oct 2026 00:09:40 GMT']);
});

test('a listing whose Last-Modified is in the second GitHub answered makes the next listing unconditional', async () => {
  const r = rig();
  r.github.date = 'Wed, 15 Oct 2026 00:09:40 GMT';
  await r.poller.pollOnce();
  assert.equal(r.state.notificationsWatermark().lastModified, null);
  r.github.date = 'Wed, 15 Oct 2026 00:09:45 GMT';
  await r.poller.pollOnce();
  assert.equal(r.github.calls[1], 'list since=2026-10-15T00:09:39Z ims=null');
  assert.equal(r.state.notificationsWatermark().lastModified, 'Wed, 15 Oct 2026 00:09:40 GMT');
});

test('W rests only on stamps a listing showed: an empty listing without Last-Modified leaves it, and it never goes back', async () => {
  const r = rig();
  r.github.listNotifications = async () => ({ notifications: [], notModified: false, lastModified: null, date: 'Wed, 15 Oct 2026 00:09:50 GMT', pollIntervalSeconds: null, truncated: false });
  await r.poller.pollOnce();
  assert.equal(r.state.notificationsWatermark().since, FIRST_W, 'not the answer\'s Date');
  assert.equal(r.state.notificationsWatermark().lastModified, null, 'no ISO stamp is ever sent as If-Modified-Since');

  r.github.listNotifications = async () => ({ notifications: [], notModified: false, lastModified: 'Wed, 15 Oct 2026 00:00:00 GMT', date: null, pollIntervalSeconds: null, truncated: false });
  await r.poller.pollOnce();
  assert.equal(r.state.notificationsWatermark().since, FIRST_W, 'never back before the W it listed from');
});

test('truncated listing: the page cap holds W, and the log names the retained window', async () => {
  const r = rig();
  r.github.truncated = true;
  const result = await r.poller.pollOnce();
  assert.equal(result.truncated, true);
  assert.equal(r.state.notificationsWatermark().since, FIRST_W);
  assert.equal(r.state.notificationsWatermark().lastModified, null);
  assert.equal(r.state.notificationsWatermark().answeredAt, null);
  assert.ok(r.logs.some((line) => line.startsWith('error') && line.includes('page cap') && line.includes(FIRST_W)));

  // The log names the retained window, even when a later listing moves its upper bound.
  r.github.lastModified = 'Wed, 15 Oct 2026 00:09:50 GMT';
  await r.poller.pollOnce();
  assert.ok(r.logs.some((line) => line.includes('page cap') && line.includes('"since":"2026-10-15T00:09:00Z","until":"2026-10-15T00:09:49Z"')));
});

test('X-Poll-Interval sets the interval on a 304 too, and a later, shorter one lowers it', async () => {
  const r = rig();
  await r.poller.pollOnce();
  r.github.pollInterval = 180;
  await r.poller.pollOnce();
  assert.equal(r.poller.effectiveIntervalMs, 180_000);
  r.github.pollInterval = 90;
  await r.poller.pollOnce();
  assert.equal(r.poller.effectiveIntervalMs, 90_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// What a pass reads

test('an interval longer than setTimeout keeps waits as long as it can, not a millisecond', () => {
  const poller = new NotificationsPoller({ api: new FakeGitHub(), state: GithubState.load(null), intervalMs: 10 ** 12, repos: [REPO], onEvent: async () => {} });
  assert.equal(poller.effectiveIntervalMs, 2 ** 31 - 1);
});

test('a notification from a repository outside GITHUB_REPOS is dropped unread', async () => {
  const r = rig();
  const outside: ThreadRef = { repo: ELSEWHERE, number: 3, kind: 'issue' };
  r.github.notify(outside, '2026-10-15T00:09:30Z');
  const result = await r.poller.pollOnce();
  assert.equal(result.outOfScope, 1);
  assert.equal(result.threads, 0);
  assert.deepEqual(r.github.calls.filter((c) => !c.startsWith('list')), [], 'nothing of it was read');
  assert.deepEqual(r.events, []);
});

test('comments are delivered once, keyed in the ring as the repository poll keys them, and the next read starts a second before the thread\'s last update', async () => {
  const r = rig();
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.comments.set(channelId(ISSUE), [comment(1, 7, '2026-10-15T00:09:10Z'), comment(2, 7, '2026-10-15T00:09:30Z')]);
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  await r.poller.pollOnce();
  assert.deepEqual(r.events.map((e) => e.id), ['poll:issue_comment:1:2026-10-15T00:09:10Z', 'poll:issue_comment:2:2026-10-15T00:09:30Z']);
  assert.ok(r.github.calls.includes(`comments ${channelId(ISSUE)} since=${FIRST_READ}`), 'a thread first seen reads from a notification\'s delay before W');
  assert.ok(r.state.snapshot().pollKeys.includes('issue_comment:1:2026-10-15T00:09:10Z'));

  // A comment in the same second as the thread's last update, written after the read, still arrives.
  r.github.comments.get(channelId(ISSUE))!.push(comment(3, 7, '2026-10-15T00:09:30Z'), comment(4, 7, '2026-10-15T00:10:30Z'));
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE, { updatedAt: '2026-10-15T00:10:30Z' }));
  r.github.notify(ISSUE, '2026-10-15T00:10:30Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:10:30 GMT';
  await r.poller.pollOnce();
  assert.ok(r.github.calls.includes(`comments ${channelId(ISSUE)} since=2026-10-15T00:09:29Z`));
  assert.deepEqual(r.events.map((e) => e.id).slice(2), ['poll:issue_comment:3:2026-10-15T00:09:30Z', 'poll:issue_comment:4:2026-10-15T00:10:30Z']);
});

test('a thread quiet while the dedup ring turned over doesn\'t bring its last comments again when it moves, across a restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'gh-notif-')), 'state.json');
  const r = rig({ stateFile: file });
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  // Two comments at the cursor's edge: the second the thread's update names, and the one before it.
  r.github.comments.set(channelId(ISSUE), [comment(1, 7, '2026-10-15T00:09:29Z'), comment(3, 7, '2026-10-15T00:09:30Z')]);
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  await r.poller.pollOnce();
  assert.equal(r.events.length, 2);
  // Other threads' rows push both keys out of the ring while this thread sits quiet, and the process restarts.
  for (let n = 0; n < POLL_DEDUP_RING; n++) r.state.seenPollKey(`issue_comment:${100_000 + n}:2026-10-16T00:00:00Z`);
  await r.state.flush();
  const restarted = rig({ stateFile: file, github: r.github });
  assert.ok(!restarted.state.snapshot().pollKeys.some((key) => key.startsWith('issue_comment:1:') || key.startsWith('issue_comment:3:')));

  r.github.comments.get(channelId(ISSUE))!.push(comment(2, 7, '2026-10-20T00:00:00Z'));
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE, { updatedAt: '2026-10-20T00:00:00Z' }));
  r.github.notify(ISSUE, '2026-10-20T00:00:00Z');
  r.github.lastModified = 'Tue, 20 Oct 2026 00:00:00 GMT';
  const result = await restarted.poller.pollOnce();
  assert.ok(r.github.calls.includes(`comments ${channelId(ISSUE)} since=2026-10-15T00:09:29Z`), 'the read takes its last second again');
  assert.deepEqual(restarted.events.map((e) => e.id), ['poll:issue_comment:2:2026-10-20T00:00:00Z']);
  assert.equal(result.duplicates, 2);
});

test('a pull request\'s review comments and reviews are read for it alone, since its cursor, with its title and the review\'s commit', async () => {
  const r = rig();
  r.github.threads.set(channelId(PULL), threadRow(PULL));
  r.github.reviewComments.set(channelId(PULL), [{ ...comment(40, 12, '2026-10-15T00:09:20Z'), path: 'src/a.ts' }]);
  r.github.reviews.set(channelId(PULL), [
    { id: 50, author: MAINTAINER, body: 'looks good', state: 'approved', submittedAt: '2026-10-15T00:09:00Z', html_url: 'https://x/50', commitId: 'reviewed-sha' },
    { id: 51, author: MAINTAINER, body: 'and this', state: 'commented', submittedAt: '2026-10-15T00:09:25Z', html_url: 'https://x/51' },
  ]);
  r.github.notify(PULL, '2026-10-15T00:09:30Z');
  await r.poller.pollOnce();
  const byId = Object.fromEntries(r.events.map((e) => [e.id, e]));
  assert.equal(byId['poll:review_comment:40:2026-10-15T00:09:20Z']?.kind, 'review_comment.created');
  assert.equal(byId['poll:review_comment:40:2026-10-15T00:09:20Z']?.thread?.number, 12);
  const atW = byId['poll:review:50:2026-10-15T00:09:00Z'];
  assert.ok(atW, 'a review submitted in the second W names is read, not dropped');
  assert.equal(atW.kind, 'review.submitted');
  assert.equal(atW.actor.login, 'maintainer');
  assert.equal(atW.review?.state, 'approved');
  assert.equal(atW.title, 'Fix it');
  assert.equal(atW.sha, 'reviewed-sha');
  const noCommit = byId['poll:review:51:2026-10-15T00:09:25Z'];
  assert.ok(noCommit, 'a review without a commit is read');
  assert.equal(noCommit.sha, undefined, 'and carries no sha, since the poller reads no head');

  // A review that came in after the thread's row was read moves no cursor past the row's own update.
  r.github.reviews.get(channelId(PULL))!.push({ id: 52, author: MAINTAINER, body: 'later', state: 'commented', submittedAt: '2026-10-15T00:10:30Z', html_url: 'https://x/52' });
  r.github.threads.set(channelId(PULL), threadRow(PULL, { updatedAt: '2026-10-15T00:10:30Z' }));
  r.github.notify(PULL, '2026-10-15T00:10:30Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:10:30 GMT';
  await r.poller.pollOnce();
  assert.ok(r.github.calls.includes(`review comments ${channelId(PULL)} since=2026-10-15T00:09:29Z`));
  assert.ok(r.github.calls.includes(`reviews ${channelId(PULL)} since=2026-10-15T00:09:29Z`));
});

test('a cursor of another shape names nothing, and the thread is read as first seen', async () => {
  const r = rig();
  r.state.setPolledHead(`notif:${channelId(ISSUE)}`, `2026-10-15T00:00:00Z\u0000issue:open:abc`);
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.comments.set(channelId(ISSUE), [comment(1, 7, '2026-10-15T00:09:10Z')]);
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  await r.poller.pollOnce();
  assert.ok(r.github.calls.includes(`comments ${channelId(ISSUE)} since=${FIRST_READ}`));
  assert.equal(r.events.length, 1);
});

test('a cursor whose times aren\'t instants names nothing, and the pass goes on', async () => {
  const r = rig();
  r.state.setPolledHead(`notif:${channelId(ISSUE)}`, ['not a time', '', 'issue:open:abc', ''].join('\u0000'));
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.comments.set(channelId(ISSUE), [comment(1, 7, '2026-10-15T00:09:10Z')]);
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  await r.poller.pollOnce();
  assert.ok(r.github.calls.includes(`comments ${channelId(ISSUE)} since=${FIRST_READ}`));
  assert.equal(r.events.length, 1);
  assert.equal(r.state.notificationsWatermark().since, '2026-10-15T00:09:39Z');
});

test('a cursor whose seen isn\'t an instant, or whose since is only loosely a date, names nothing', async () => {
  for (const value of [['2026-10-15T00:00:00Z', 'yesterday', 'issue:open:abc', ''], ['12', '', '', '']]) {
    const r = rig();
    r.state.setPolledHead(`notif:${channelId(ISSUE)}`, value.join('\u0000'));
    r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
    r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
    await r.poller.pollOnce();
    assert.ok(r.github.calls.includes(`comments ${channelId(ISSUE)} since=${FIRST_READ}`), value.join(' | '));
  }
});

test('a stored W with milliseconds is listed from in whole seconds', async () => {
  const r = rig();
  r.state.setNotificationsWatermark({ since: '2026-10-15T00:09:00.750Z', lastModified: null, answeredAt: null });
  await r.poller.pollOnce();
  assert.equal(r.github.calls[0], 'list since=2026-10-15T00:09:00Z ims=null');
});

test('a listing with neither Last-Modified nor Date leaves W where it was', async () => {
  const r = rig();
  r.github.listNotifications = async () => ({ notifications: [], notModified: false, lastModified: null, date: null, pollIntervalSeconds: null, truncated: false });
  await r.poller.pollOnce();
  assert.deepEqual(r.state.notificationsWatermark(), { since: FIRST_W, lastModified: null, answeredAt: '2026-10-15T00:10:00Z' });
});

// ─────────────────────────────────────────────────────────────────────────────
// State events

test('a thread first seen that opened within its reach-back arrives as opened; one opened before it arrives as nothing but its rows', async () => {
  const r = rig();
  const fresh: ThreadRef = { repo: REPO, number: 8, kind: 'issue' };
  // Opened and not touched since: its updated_at is its created_at, so the next read starts a second before its opening.
  r.github.threads.set(channelId(fresh), threadRow(fresh, { createdAt: '2026-10-15T00:09:20Z', updatedAt: '2026-10-15T00:09:20Z', body: 'cc @agent' }));
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.notify(fresh, '2026-10-15T00:09:20Z');
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  await r.poller.pollOnce();
  assert.deepEqual(r.events.map((e) => `${e.kind} #${e.thread?.number}`), ['issue.opened #8']);
  assert.equal(r.events[0].body, 'cc @agent');

  // Its next move is a comment, not a second opening.
  r.github.threads.set(channelId(fresh), threadRow(fresh, { createdAt: '2026-10-15T00:09:20Z', updatedAt: '2026-10-15T00:10:30Z', body: 'cc @agent' }));
  r.github.comments.set(channelId(fresh), [comment(9, 8, '2026-10-15T00:10:30Z')]);
  r.github.notify(fresh, '2026-10-15T00:10:30Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:10:30 GMT';
  await r.poller.pollOnce();
  assert.deepEqual(r.events.slice(1).map((e) => e.kind), ['comment.created']);
});

test('a thread notified 20 s after it opened, with W already past its opening, still arrives opened and with its comment', async () => {
  const r = rig();
  await r.poller.pollOnce();
  assert.equal(r.state.notificationsWatermark().since, '2026-10-15T00:09:39Z');

  // GitHub stamps a notification when it writes it, about 20 s after the activity.
  const fresh: ThreadRef = { repo: REPO, number: 8, kind: 'issue' };
  r.github.threads.set(channelId(fresh), threadRow(fresh, { createdAt: '2026-10-15T00:09:30Z', updatedAt: '2026-10-15T00:09:35Z', body: 'cc @agent' }));
  r.github.comments.set(channelId(fresh), [comment(81, 8, '2026-10-15T00:09:35Z')]);
  r.github.notify(fresh, '2026-10-15T00:09:55Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:09:55 GMT';
  await r.poller.pollOnce();
  assert.deepEqual(r.events.map((e) => `${e.kind} #${e.thread?.number}`), ['comment.created #8', 'issue.opened #8']);
  assert.equal(r.events[1].body, 'cc @agent');
});

test('days of 304s leave W, and a thread first listed after them reads only from GitHub\'s previous answer, not from W', async () => {
  const r = rig();
  const busy: ThreadRef = { repo: REPO, number: 8, kind: 'issue' };
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  await r.poller.pollOnce();
  assert.equal(r.state.notificationsWatermark().since, '2026-10-15T00:09:39Z');
  // Two quiet days: each pass is a 304, which leaves W and records when GitHub answered.
  for (const at of ['2026-10-16T00:00:00.000Z', '2026-10-17T00:00:00.000Z']) {
    r.setNow(at);
    assert.equal((await r.poller.pollOnce()).notModified, true);
  }
  assert.deepEqual(r.state.notificationsWatermark(), {
    since: '2026-10-15T00:09:39Z',
    lastModified: 'Wed, 15 Oct 2026 00:09:40 GMT',
    answeredAt: '2026-10-17T00:00:00Z',
  });
  // Then the agent is mentioned in a thread it never took part in, which had 30 comments over those days.
  const old = Array.from({ length: 30 }, (_, i) =>
    comment(8000 + i, 8, new Date(Date.parse('2026-10-15T01:00:00Z') + i * 3_600_000).toISOString().replace('.000Z', 'Z')),
  );
  r.github.comments.set(channelId(busy), [...old, comment(8100, 8, '2026-10-17T00:10:00Z')]);
  r.github.threads.set(channelId(busy), threadRow(busy, { updatedAt: '2026-10-17T00:10:00Z' }));
  r.github.notify(busy, '2026-10-17T00:10:20Z');
  r.github.lastModified = 'Fri, 17 Oct 2026 00:10:20 GMT';
  r.setNow('2026-10-17T00:11:00.000Z');
  const before = r.events.length;
  await r.poller.pollOnce();
  assert.ok(r.github.calls.includes(`comments ${channelId(busy)} since=2026-10-16T23:55:00Z`), 'five minutes before the previous answer');
  assert.deepEqual(r.events.slice(before).map((e) => e.id), ['poll:issue_comment:8100:2026-10-17T00:10:00Z']);
});

test('a merge arrives as pull.closed with whoever merged it as the actor, so it isn\'t muted as the author\'s own', async () => {
  const r = rig();
  r.github.threads.set(channelId(PULL), threadRow(PULL));
  r.github.notify(PULL, '2026-10-15T00:09:30Z');
  await r.poller.pollOnce();
  assert.equal(r.events.length, 0);

  r.github.threads.set(
    channelId(PULL),
    threadRow(PULL, { state: 'closed', updatedAt: '2026-10-15T00:10:20Z', closedAt: '2026-10-15T00:10:20Z', closedBy: MAINTAINER }),
  );
  r.github.notify(PULL, '2026-10-15T00:10:20Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:10:20 GMT';
  await r.poller.pollOnce();
  assert.deepEqual(r.events.map((e) => [e.kind, e.actor.login]), [['pull.closed', 'maintainer']]);
});

test('a thread first seen arrives as closed only if it closed within its reach-back, which starts five minutes before W at a first start', async () => {
  const r = rig();
  const recent: ThreadRef = { repo: REPO, number: 20, kind: 'issue' };
  const old: ThreadRef = { repo: REPO, number: 21, kind: 'issue' };
  const beforeW: ThreadRef = { repo: REPO, number: 22, kind: 'issue' };
  r.github.threads.set(channelId(beforeW), threadRow(beforeW, { state: 'closed', closedAt: '2026-10-15T00:06:00Z', closedBy: MAINTAINER }));
  r.github.notify(beforeW, '2026-10-15T00:09:30Z');
  r.github.threads.set(channelId(recent), threadRow(recent, { state: 'closed', closedAt: '2026-10-15T00:09:30Z', closedBy: MAINTAINER }));
  r.github.threads.set(channelId(old), threadRow(old, { state: 'closed', closedAt: '2026-10-02T00:00:00Z', closedBy: MAINTAINER }));
  r.github.notify(recent, '2026-10-15T00:09:30Z');
  r.github.notify(old, '2026-10-15T00:09:30Z');
  await r.poller.pollOnce();
  assert.deepEqual(
    r.events.map((e) => `${e.kind} #${e.thread?.number} by ${e.actor.login}`).sort(),
    ['issue.closed #20 by maintainer', 'issue.closed #22 by maintainer'],
  );
});

for (const [thread, kinds] of [
  [ISSUE, ['issue.closed', 'issue.edited', 'issue.closed', 'issue.closed']],
  // A reopened pull request arrives as nothing, but its close after that still comes.
  [PULL, ['pull.closed', 'pull.closed', 'pull.closed']],
] as const) {
  test(`an edit to a closed ${thread.kind === 'pull' ? 'pull request' : 'issue'} is no second close; a close after a reopen is, seen or not`, async () => {
    const r = rig();
    const closed = (at: string, partial: Partial<PolledIssue> = {}): PolledIssue => threadRow(thread, { state: 'closed', updatedAt: at, closedAt: at, closedBy: MAINTAINER, ...partial });
    const step = async (row: PolledIssue): Promise<void> => {
      r.github.threads.set(channelId(thread), row);
      r.github.notify(thread, row.updatedAt);
      r.github.lastModified = new Date(Date.parse(row.updatedAt)).toUTCString();
      await r.poller.pollOnce();
    };
    await step(threadRow(thread));
    await step(closed('2026-10-15T00:10:00Z'));
    await step(closed('2026-10-15T00:10:00Z', { updatedAt: '2026-10-15T00:11:00Z', body: 'edited after closing' }));
    await step(threadRow(thread, { updatedAt: '2026-10-15T00:12:00Z', closedAt: '2026-10-15T00:10:00Z' }));
    await step(closed('2026-10-15T00:13:00Z'));
    // Reopened and closed again between two passes: no pass saw it open.
    await step(closed('2026-10-15T00:15:00Z'));
    assert.deepEqual(r.events.map((e) => e.kind), kinds);
    assert.equal(new Set(r.events.map((e) => e.id)).size, kinds.length);
  });
}

test('a refused comment beside a delivered close doesn\'t bring the close again', async () => {
  const r = rig();
  r.github.threads.set(channelId(PULL), threadRow(PULL));
  r.github.notify(PULL, '2026-10-15T00:09:30Z');
  await r.poller.pollOnce();

  const merged = threadRow(PULL, { state: 'closed', updatedAt: '2026-10-15T00:10:20Z', closedAt: '2026-10-15T00:10:20Z', closedBy: MAINTAINER });
  r.github.threads.set(channelId(PULL), merged);
  r.github.comments.set(channelId(PULL), [comment(60, 12, '2026-10-15T00:10:10Z')]);
  r.github.notify(PULL, '2026-10-15T00:10:20Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:10:20 GMT';
  r.refuse.add('poll:issue_comment:60:2026-10-15T00:10:10Z');
  await r.poller.pollOnce();
  assert.deepEqual(r.events.map((e) => e.kind), ['pull.closed']);

  // The thread moves again; the comment arrives, and the close doesn't come twice.
  r.refuse.clear();
  r.github.threads.set(channelId(PULL), { ...merged, updatedAt: '2026-10-15T00:11:00Z' });
  r.github.notify(PULL, '2026-10-15T00:11:00Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:11:00 GMT';
  await r.poller.pollOnce();
  assert.deepEqual(r.events.map((e) => e.kind), ['pull.closed', 'comment.created']);
});

test('a thread whose cursor the head memory evicted reads from GitHub\'s previous answer, with no opening or close it already had', async () => {
  const r = rig();
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  await r.poller.pollOnce();
  for (let n = 0; n < 200; n++) r.state.setPolledHead(`other#${n}`, 'x');
  assert.equal(r.state.polledHead(`notif:${channelId(ISSUE)}`), null);

  r.github.comments.set(channelId(ISSUE), [comment(11, 7, '2026-10-15T00:10:10Z')]);
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE, { updatedAt: '2026-10-15T00:10:10Z' }));
  r.github.notify(ISSUE, '2026-10-15T00:10:10Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:10:10 GMT';
  r.setNow('2026-10-15T00:30:00.000Z');
  await r.poller.pollOnce();
  assert.ok(r.github.calls.includes(`comments ${channelId(ISSUE)} since=2026-10-15T00:05:00Z`), 'five minutes before the previous answer, not from now less an interval');
  assert.deepEqual(r.events.map((e) => e.kind), ['comment.created']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Failures

test('a failing thread is read again next pass, listed or not, while W moves on and the rest aren\'t read again', async () => {
  const r = rig();
  const other: ThreadRef = { repo: REPO, number: 9, kind: 'issue' };
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.threads.set(channelId(other), threadRow(other));
  r.github.comments.set(channelId(ISSUE), [comment(1, 7, '2026-10-15T00:09:30Z')]);
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  r.github.notify(other, '2026-10-15T00:09:30Z');
  r.github.failing.set(channelId(ISSUE), new GitHubApiError(502, 'Bad gateway', 'getPolledThread'));
  const first = await r.poller.pollOnce();
  assert.equal(first.failed, 1);
  assert.equal(r.state.notificationsWatermark().since, '2026-10-15T00:09:39Z', 'W moves on');
  assert.deepEqual(r.state.notificationRetries().map((x) => [x.number, x.attempts]), [[7, 1]]);

  r.github.failing.clear();
  r.github.lastModified = 'Wed, 15 Oct 2026 00:10:00 GMT';
  const reads = r.github.calls.length;
  await r.poller.pollOnce();
  assert.ok(!r.github.calls.slice(reads).some((c) => c.includes(channelId(other))), 'the thread that got through isn\'t read again');
  assert.ok(r.github.calls.includes(`comments ${channelId(ISSUE)} since=2026-10-15T00:03:59Z`), 'the failed one reads from where it would have started, a second early');
  assert.deepEqual(r.events.map((e) => e.id), ['poll:issue_comment:1:2026-10-15T00:09:30Z']);
  assert.deepEqual(r.state.notificationRetries(), []);
});

test('a thread that fails five passes in a row is dropped with one event on its channel, and read from its cursor when it next moves', async () => {
  const r = rig();
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  r.github.failing.set(channelId(ISSUE), new GitHubApiError(502, 'Bad gateway', 'getPolledThread'));
  for (let pass = 1; pass <= 5; pass++) {
    r.github.lastModified = `Wed, 15 Oct 2026 00:1${pass}:00 GMT`;
    await r.poller.pollOnce();
  }
  assert.deepEqual(r.state.notificationRetries().filter((retry) => !retry.stopped), []);
  assert.equal(r.events.length, 1);
  const notice = r.events[0];
  assert.equal(notice.kind, 'thread.read_failed');
  assert.equal(notice.thread?.number, 7);
  assert.ok(
    !tagsFor(notice, { botLogin: 'github-mcpl', maintainers: [] }).tags.includes('chat:from-self'),
    'never from-self, even for a token whose account is named github-mcpl',
  );
  assert.match(notice.body ?? '', /its last 5 attempts in a row failed \(the last: GitHub answered 502: Bad gateway\)/);
  assert.doesNotMatch(notice.body ?? '', /getPolledThread/, 'no adapter method names reach the agent');

  // It moves again and reads: from where its first read would have started, a second early.
  r.github.failing.clear();
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE, { updatedAt: '2026-10-15T00:20:00Z' }));
  r.github.comments.set(channelId(ISSUE), [comment(1, 7, '2026-10-15T00:09:30Z')]);
  r.github.notify(ISSUE, '2026-10-15T00:20:00Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:20:00 GMT';
  await r.poller.pollOnce();
  assert.ok(r.github.calls.includes(`comments ${channelId(ISSUE)} since=2026-10-15T00:03:59Z`));
  assert.deepEqual(r.events.slice(1).map((e) => e.id), ['poll:issue_comment:1:2026-10-15T00:09:30Z']);
});

test('a thread gone or out of reach is dropped at once, with its event, and W moves on', async () => {
  const r = rig();
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  r.github.failing.set(channelId(ISSUE), new GitHubApiError(404, 'Not Found', 'getPolledThread'));
  const result = await r.poller.pollOnce();
  assert.equal(result.dropped, 1);
  assert.deepEqual(r.state.notificationRetries().filter((retry) => !retry.stopped), []);
  assert.deepEqual(r.events.map((e) => e.kind), ['thread.read_failed']);
  assert.match(r.events[0].body ?? '', /GitHub answered 404: Not Found, so the thread is gone or out of this token's reach/);
  assert.doesNotMatch(r.events[0].body ?? '', /passes|in a row/);
  assert.doesNotMatch(r.events[0].body ?? '', /read tools/, 'the token can\'t reach the thread, so no read tool can either');
  assert.equal(r.state.notificationsWatermark().since, '2026-10-15T00:09:39Z');
});

test('a refused delivery is retried; the next pass delivers only what was refused', async () => {
  const r = rig();
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.comments.set(channelId(ISSUE), [comment(1, 7, '2026-10-15T00:09:10Z'), comment(2, 7, '2026-10-15T00:09:30Z')]);
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  r.refuse.add('poll:issue_comment:2:2026-10-15T00:09:30Z');
  const first = await r.poller.pollOnce();
  assert.equal(first.failed, 1);
  assert.deepEqual(r.state.notificationRetries().map((x) => x.number), [7]);

  r.refuse.clear();
  const second = await r.poller.pollOnce();
  assert.equal(second.duplicates, 1);
  assert.deepEqual(r.events.map((e) => e.id), ['poll:issue_comment:1:2026-10-15T00:09:10Z', 'poll:issue_comment:2:2026-10-15T00:09:30Z']);
  assert.deepEqual(r.state.notificationRetries(), []);
});

test('a thread on the retry list from a repository since taken out of GITHUB_REPOS is dropped unread', async () => {
  const r = rig();
  r.state.setNotificationRetries([{ owner: ELSEWHERE.owner, name: ELSEWHERE.name, number: 3, kind: 'issue', attempts: 2 }]);
  const result = await r.poller.pollOnce();
  assert.equal(result.threads, 0);
  assert.deepEqual(r.github.calls.filter((c) => !c.startsWith('list')), []);
  assert.deepEqual(r.state.notificationRetries(), []);
  assert.deepEqual(r.events, []);
});

test('a refused opening beside a delivered comment arrives on the next pass, and the comment doesn\'t come twice', async () => {
  const r = rig();
  const fresh: ThreadRef = { repo: REPO, number: 8, kind: 'issue' };
  const row = threadRow(fresh, { createdAt: '2026-10-15T00:09:20Z', updatedAt: '2026-10-15T00:09:40Z', body: 'cc @agent' });
  r.github.threads.set(channelId(fresh), row);
  r.github.comments.set(channelId(fresh), [comment(82, 8, '2026-10-15T00:09:40Z')]);
  r.github.notify(fresh, '2026-10-15T00:09:40Z');
  r.refuse.add(`poll:issue:${row.id}:${row.updatedAt}`);
  await r.poller.pollOnce();
  assert.deepEqual(r.events.map((e) => e.kind), ['comment.created']);

  r.refuse.clear();
  const second = await r.poller.pollOnce();
  assert.equal(second.duplicates, 1);
  assert.deepEqual(r.events.map((e) => e.kind), ['comment.created', 'issue.opened']);
  assert.deepEqual(r.state.notificationRetries(), []);
});

test('GitHub\'s rate limit counts no pass against a thread, ends the pass\'s reads, and the rest are read next pass', async () => {
  const r = rig();
  const a: ThreadRef = { repo: REPO, number: 31, kind: 'issue' };
  const b: ThreadRef = { repo: REPO, number: 32, kind: 'issue' };
  for (const t of [a, b]) {
    r.github.threads.set(channelId(t), threadRow(t));
    r.github.comments.set(channelId(t), [comment(t.number * 10, t.number, '2026-10-15T00:09:20Z')]);
    r.github.notify(t, '2026-10-15T00:09:30Z');
  }
  r.state.setNotificationRetries([{ owner: REPO.owner, name: REPO.name, number: 31, kind: 'issue', attempts: 4 }]);
  r.github.failing.set(channelId(a), new GitHubApiError(403, 'API rate limit exceeded for user ID 1.', 'getPolledThread'));
  const first = await r.poller.pollOnce();
  assert.equal(first.dropped, 0);
  assert.ok(!r.github.calls.includes(`thread ${channelId(b)}`), 'the pass read no further');
  assert.deepEqual(
    r.state.notificationRetries().map((x) => [x.number, x.attempts]),
    [[31, 4], [32, 0]],
  );
  assert.ok(r.logs.some((line) => line.includes('rate-limited') && line.includes('"threads":2')));

  r.github.failing.clear();
  r.github.lastModified = 'Wed, 15 Oct 2026 00:10:00 GMT';
  await r.poller.pollOnce();
  assert.ok(r.github.calls.includes(`comments ${channelId(b)} since=2026-10-15T00:03:59Z`), 'the held thread reads from where its first read would have, a second early');
  assert.deepEqual(r.events.map((e) => e.thread?.number).sort(), [31, 32]);
  assert.deepEqual(r.state.notificationRetries(), []);
});

test('a failing thread keeps its place in the head memory while it waits, so its held rows still come', async () => {
  const r = rig();
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  await r.poller.pollOnce();
  const cursorKey = `notif:${channelId(ISSUE)}`;
  assert.notEqual(r.state.polledHead(cursorKey), null);

  // A comment, then a failure; other threads' writes fill most of the memory around it.
  r.github.comments.set(channelId(ISSUE), [comment(5, 7, '2026-10-15T00:09:45Z')]);
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE, { updatedAt: '2026-10-15T00:09:45Z' }));
  r.github.notify(ISSUE, '2026-10-15T00:09:45Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:09:45 GMT';
  for (let n = 0; n < 150; n++) r.state.setPolledHead(`other#${n}`, 'x');
  r.github.failing.set(channelId(ISSUE), new GitHubApiError(502, 'Bad gateway', 'getPolledThread'));
  await r.poller.pollOnce();
  for (let n = 150; n < 300; n++) r.state.setPolledHead(`other#${n}`, 'x');
  assert.notEqual(r.state.polledHead(cursorKey), null, 'the failure rewrote its place');

  r.github.failing.clear();
  r.github.lastModified = 'Wed, 15 Oct 2026 00:10:00 GMT';
  await r.poller.pollOnce();
  assert.ok(r.github.calls.includes(`comments ${channelId(ISSUE)} since=2026-10-15T00:09:29Z`), 'from its cursor, not from W');
  assert.deepEqual(r.events.map((e) => e.id), ['poll:issue_comment:5:2026-10-15T00:09:45Z']);
});

test('a refused drop notice is logged, and the pass goes on', async () => {
  const r = rig();
  const other: ThreadRef = { repo: REPO, number: 9, kind: 'issue' };
  r.github.threads.set(channelId(other), threadRow(other));
  r.github.comments.set(channelId(other), [comment(90, 9, '2026-10-15T00:09:20Z')]);
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  r.github.notify(other, '2026-10-15T00:09:30Z');
  r.github.failing.set(channelId(ISSUE), new GitHubApiError(404, 'Not Found', 'getPolledThread'));
  r.refuse.add(`poll:read_failed:${channelId(ISSUE)}:${START}`);
  const result = await r.poller.pollOnce();
  assert.equal(result.dropped, 1);
  assert.deepEqual(r.events.map((e) => e.id), ['poll:issue_comment:90:2026-10-15T00:09:20Z']);
  assert.ok(r.logs.some((line) => line.includes('the event announcing a dropped thread was refused')));
  assert.equal(r.state.notificationsWatermark().since, '2026-10-15T00:09:39Z');
});

test('a thread with more new activity than one read takes is read from its current update on, and its notice says the backlog was skipped', async () => {
  const r = rig();
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE, { updatedAt: '2026-10-15T00:09:30Z' }));
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  r.github.listCommentsSince = async (thread, since) => {
    r.github.calls.push(`comments ${channelId(thread)} since=${since}`);
    throw new ReadCapError('listCommentsSince');
  };
  const first = await r.poller.pollOnce();
  assert.equal(first.dropped, 1);
  assert.deepEqual(r.state.notificationRetries().filter((retry) => !retry.stopped), [], 'not read again five times: the same read would meet the same cap');
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, 'thread.read_failed');
  assert.match(r.events[0].body ?? '', /skipped this thread's backlog: it had more than 2,000 comments or reviews to read at once/);
  assert.match(r.events[0].body ?? '', /It reads the thread from its latest update on, so its new activity arrives as usual/);
  assert.ok(r.logs.some((line) => line.startsWith('warn') && line.includes('skipped a thread\'s backlog')));
  assert.ok(!r.logs.some((line) => line.includes('stopped reading a thread until it next moves')));

  // It moves; its read starts from the update it had, and the new comment arrives.
  delete (r.github as Partial<FakeGitHub>).listCommentsSince;
  r.github.comments.set(channelId(ISSUE), [comment(70, 7, '2026-10-15T00:10:30Z')]);
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE, { updatedAt: '2026-10-15T00:10:30Z' }));
  r.github.notify(ISSUE, '2026-10-15T00:10:30Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:10:30 GMT';
  await r.poller.pollOnce();
  assert.ok(r.github.calls.includes(`comments ${channelId(ISSUE)} since=2026-10-15T00:09:29Z`));
  assert.deepEqual(r.events.slice(1).map((e) => e.id), ['poll:issue_comment:70:2026-10-15T00:10:30Z']);
});

test('a waiting thread\'s retry entry keeps its cursor, so its held rows come even when the head memory lost it', async () => {
  const r = rig();
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  await r.poller.pollOnce();
  r.github.comments.set(channelId(ISSUE), [comment(6, 7, '2026-10-15T00:09:50Z')]);
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE, { updatedAt: '2026-10-15T00:09:50Z' }));
  r.github.notify(ISSUE, '2026-10-15T00:09:50Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:09:50 GMT';
  r.github.failing.set(channelId(ISSUE), new GitHubApiError(502, 'Bad gateway', 'getPolledThread'));
  await r.poller.pollOnce();
  const [entry] = r.state.notificationRetries();
  assert.ok(entry?.cursor, 'the entry carries the cursor');
  for (let n = 0; n < 200; n++) r.state.setPolledHead(`other#${n}`, 'x');
  assert.equal(r.state.polledHead(`notif:${channelId(ISSUE)}`), null, 'the head memory lost it');

  r.github.failing.clear();
  r.github.lastModified = 'Wed, 15 Oct 2026 00:20:00 GMT';
  r.setNow('2026-10-15T00:30:00.000Z');
  await r.poller.pollOnce();
  assert.ok(r.github.calls.includes(`comments ${channelId(ISSUE)} since=2026-10-15T00:09:29Z`), 'from its kept cursor, not the reach-back');
  assert.deepEqual(r.events.map((e) => e.id), ['poll:issue_comment:6:2026-10-15T00:09:50Z']);
});

test('threads on the retry list are read before the listed ones, and the one that met a rate limit goes to the back', async () => {
  const r = rig();
  const a: ThreadRef = { repo: REPO, number: 41, kind: 'issue' };
  const b: ThreadRef = { repo: REPO, number: 42, kind: 'issue' };
  const listed: ThreadRef = { repo: REPO, number: 43, kind: 'issue' };
  for (const t of [a, b, listed]) r.github.threads.set(channelId(t), threadRow(t));
  r.github.notify(listed, '2026-10-15T00:09:30Z');
  r.state.setNotificationRetries([
    { owner: REPO.owner, name: REPO.name, number: 41, kind: 'issue', attempts: 1 },
    { owner: REPO.owner, name: REPO.name, number: 42, kind: 'issue', attempts: 1 },
  ]);
  r.github.failing.set(channelId(a), new GitHubApiError(429, 'Too Many Requests', 'getPolledThread'));
  await r.poller.pollOnce();
  assert.deepEqual(r.github.calls.filter((c) => c.startsWith('thread')), [`thread ${channelId(a)}`], 'a retry first, and the limit ended the reads');
  assert.deepEqual(r.state.notificationRetries().map((x) => x.number), [42, 41, 43], 'the one that met the limit is behind the other retry');

  r.github.failing.clear();
  r.github.lastModified = 'Wed, 15 Oct 2026 00:10:00 GMT';
  const before = r.github.calls.length;
  await r.poller.pollOnce();
  assert.deepEqual(
    r.github.calls.slice(before).filter((c) => c.startsWith('thread')),
    [`thread ${channelId(b)}`, `thread ${channelId(a)}`, `thread ${channelId(listed)}`],
  );
});

test('a retry entry outside GITHUB_REPOS is counted with the out-of-scope threads, and logged', async () => {
  const r = rig();
  r.state.setNotificationRetries([{ owner: ELSEWHERE.owner, name: ELSEWHERE.name, number: 3, kind: 'issue', attempts: 2 }]);
  const result = await r.poller.pollOnce();
  assert.equal(result.outOfScope, 1);
  assert.ok(r.logs.some((line) => line.includes('outside GITHUB_REPOS now') && line.includes('"threads":1')));
});

test('a never-read thread whose first read fails keeps where that read started, though GitHub answers again later', async () => {
  const r = rig();
  await r.poller.pollOnce();
  const fresh: ThreadRef = { repo: REPO, number: 51, kind: 'issue' };
  r.github.threads.set(channelId(fresh), threadRow(fresh, { createdAt: '2026-10-15T00:10:05Z', updatedAt: '2026-10-15T00:10:05Z' }));
  r.github.comments.set(channelId(fresh), [comment(510, 51, '2026-10-15T00:10:05Z')]);
  r.github.notify(fresh, '2026-10-15T00:10:25Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:10:25 GMT';
  r.github.failing.set(channelId(fresh), new GitHubApiError(502, 'Bad gateway', 'getPolledThread'));
  r.setNow('2026-10-15T00:11:00.000Z');
  await r.poller.pollOnce();
  const [entry] = r.state.notificationRetries();
  assert.ok(entry?.cursor?.startsWith('2026-10-15T00:05:00Z'), 'five minutes before the answer the first read reached from');

  // Twenty minutes of answers later, the read gets through from where the first one started.
  r.github.failing.clear();
  r.setNow('2026-10-15T00:31:00.000Z');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:30:00 GMT';
  await r.poller.pollOnce();
  assert.ok(r.github.calls.includes(`comments ${channelId(fresh)} since=2026-10-15T00:04:59Z`));
  assert.deepEqual(r.events.map((e) => e.kind).sort(), ['comment.created', 'issue.opened']);
});

test('a listing without Last-Modified moves W to the newest stamp it listed, less a second', async () => {
  const r = rig();
  r.github.listNotifications = async () => ({
    notifications: [
      { id: 'n1', updatedAt: '2026-10-15T00:09:45Z', reason: 'mention', unread: true, repo: REPO, kind: 'issue', number: 61, title: 't' },
      { id: 'n2', updatedAt: '2026-10-15T00:09:50Z', reason: 'mention', unread: true, repo: ELSEWHERE, kind: 'issue', number: 62, title: 't' },
    ],
    notModified: false,
    lastModified: null,
    date: 'Wed, 15 Oct 2026 00:10:30 GMT',
    pollIntervalSeconds: null,
    truncated: false,
  });
  r.github.threads.set(channelId({ repo: REPO, number: 61, kind: 'issue' }), threadRow({ repo: REPO, number: 61, kind: 'issue' }));
  await r.poller.pollOnce();
  assert.equal(r.state.notificationsWatermark().since, '2026-10-15T00:09:49Z', 'not the answer\'s Date');
});

test('a stored cursor of another shape is logged as it is set aside', async () => {
  const r = rig();
  r.state.setPolledHead(`notif:${channelId(ISSUE)}`, 'not a cursor');
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  await r.poller.pollOnce();
  assert.ok(r.logs.some((line) => line.startsWith('warn') && line.includes('read as never seen')));
});

// ─────────────────────────────────────────────────────────────────────────────
// Restarts

test('state is flushed as a pass goes, so a process restarted after a pass repeats nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-notif-'));
  const file = join(dir, 'state.json');
  const r = rig({ stateFile: file });
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.comments.set(channelId(ISSUE), [comment(1, 7, '2026-10-15T00:09:30Z')]);
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  r.github.conditional = false;
  r.github.lastModified = 'Wed, 15 Oct 2026 00:09:30 GMT';
  await r.poller.pollOnce();
  assert.equal(r.events.length, 1);

  // No flush by hand: a new process loads the file as the pass left it, and
  // the thread the overlap second lists again brings nothing twice.
  const restarted = rig({ stateFile: file, github: r.github });
  assert.deepEqual(restarted.state.notificationsWatermark(), {
    since: '2026-10-15T00:09:29Z',
    lastModified: 'Wed, 15 Oct 2026 00:09:30 GMT',
    answeredAt: '2026-10-15T00:10:00Z',
  });
  const result = await restarted.poller.pollOnce();
  assert.equal(result.threads, 1);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(restarted.events, []);
});

test('each thread\'s state is on disk before the next thread is read', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'gh-notif-')), 'state.json');
  const r = rig({ stateFile: file });
  const other: ThreadRef = { repo: REPO, number: 9, kind: 'issue' };
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.threads.set(channelId(other), threadRow(other));
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  r.github.notify(other, '2026-10-15T00:09:30Z');
  let onDisk: string | null | undefined;
  const readThread = r.github.getPolledThread.bind(r.github);
  r.github.getPolledThread = async (thread) => {
    if (channelId(thread) === channelId(other)) onDisk = GithubState.load(file).polledHead(`notif:${channelId(ISSUE)}`);
    return readThread(thread);
  };
  await r.poller.pollOnce();
  assert.ok(onDisk, 'the first thread\'s cursor was in the state file when the second thread was read');
});

// ─────────────────────────────────────────────────────────────────────────────
// Review requests and the checks on the token user's own pull requests

test('a review_requested notification on a pull request arrives as pull.review_requested, once per notification update', async () => {
  const r = rig();
  r.github.threads.set(channelId(PULL), threadRow(PULL));
  r.github.notify(PULL, '2026-10-15T00:09:40Z', REPO, 'review_requested');
  await r.poller.pollOnce();
  assert.deepEqual(r.events.map((e) => e.id), ['poll:review_requested:n-rayforce-12:2026-10-15T00:09:40Z']);
  const request = r.events[0];
  assert.equal(request.kind, 'pull.review_requested');
  assert.deepEqual(request.thread, PULL);
  assert.deepEqual(request.actor, HUMAN, 'the pull request\'s author, who usually asks');
  const tagged = tagsFor(request, { botLogin: 'a-human', maintainers: [] });
  assert.ok(tagged.tags.includes('github:pr=review_requested'));
  assert.equal(tagged.metadata.isReviewRequested, true);
  assert.ok(r.state.snapshot().pollKeys.includes('review_requested:n-rayforce-12:2026-10-15T00:09:40Z'));

  // Listed again with the same update, in the second W takes again: nothing new.
  r.github.lastModified = 'Wed, 15 Oct 2026 00:09:41 GMT';
  const again = await r.poller.pollOnce();
  assert.equal(again.duplicates, 1);
  assert.equal(r.events.length, 1);

  // A later update with the same reason is delivered again, keyed by the new update.
  r.github.notify(PULL, '2026-10-15T00:12:00Z', REPO, 'review_requested');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:12:00 GMT';
  await r.poller.pollOnce();
  assert.deepEqual(r.events.map((e) => e.id).slice(1), ['poll:review_requested:n-rayforce-12:2026-10-15T00:12:00Z']);

  // Another reason, or an issue, is no review request.
  r.github.notify(PULL, '2026-10-15T00:13:00Z', REPO, 'comment');
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.notify(ISSUE, '2026-10-15T00:13:00Z', REPO, 'review_requested');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:13:00 GMT';
  await r.poller.pollOnce();
  assert.equal(r.events.filter((e) => e.kind === 'pull.review_requested').length, 2);
});

test('a refused review request waits on the retry entry, across a restart, and arrives though no listing shows it again', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'gh-notif-')), 'state.json');
  const r = rig({ stateFile: file });
  r.github.threads.set(channelId(PULL), threadRow(PULL));
  r.github.comments.set(channelId(PULL), [comment(1, 12, '2026-10-15T00:09:20Z')]);
  r.github.notify(PULL, '2026-10-15T00:09:30Z', REPO, 'review_requested');
  r.refuse.add('poll:review_requested:n-rayforce-12:2026-10-15T00:09:30Z');
  const first = await r.poller.pollOnce();
  assert.equal(first.failed, 1);
  assert.deepEqual(r.events.map((e) => e.kind), ['comment.created']);
  assert.deepEqual(r.state.notificationRetries().map((x) => x.reviewRequest), [{ id: 'n-rayforce-12', updatedAt: '2026-10-15T00:09:30Z' }]);

  const restarted = rig({ stateFile: file, github: r.github });
  r.github.inbox = [];
  r.github.lastModified = 'Wed, 15 Oct 2026 00:11:00 GMT';
  await restarted.poller.pollOnce();
  assert.deepEqual(restarted.events.map((e) => e.id), ['poll:review_requested:n-rayforce-12:2026-10-15T00:09:30Z'], 'and the comment doesn\'t come twice');
  assert.deepEqual(restarted.state.notificationRetries(), []);
});

test('a review request on a thread whose read fails waits with it, and arrives when the read gets through', async () => {
  const r = rig();
  r.github.threads.set(channelId(PULL), threadRow(PULL));
  r.github.notify(PULL, '2026-10-15T00:09:30Z', REPO, 'review_requested');
  r.github.failing.set(channelId(PULL), new GitHubApiError(502, 'Bad gateway', 'getPolledThread'));
  await r.poller.pollOnce();
  assert.equal(r.events.length, 0);
  assert.deepEqual(r.state.notificationRetries().map((x) => x.reviewRequest?.id), ['n-rayforce-12']);

  r.github.failing.clear();
  r.github.inbox = [];
  r.github.lastModified = 'Wed, 15 Oct 2026 00:11:00 GMT';
  await r.poller.pollOnce();
  assert.deepEqual(r.events.map((e) => e.kind), ['pull.review_requested']);
});

test('a review request on a thread whose backlog is skipped still arrives, before the notice', async () => {
  const r = rig();
  r.github.threads.set(channelId(PULL), threadRow(PULL));
  r.github.notify(PULL, '2026-10-15T00:09:30Z', REPO, 'review_requested');
  r.github.listReviewsSince = async () => {
    throw new ReadCapError('listReviewsSince');
  };
  const result = await r.poller.pollOnce();
  assert.equal(result.dropped, 1);
  assert.deepEqual(r.events.map((e) => e.kind), ['pull.review_requested', 'thread.read_failed']);
});

test('a review request refused beside a skipped backlog waits on a retry entry, and arrives after a 304 and a restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'gh-notif-')), 'state.json');
  const r = rig({ stateFile: file });
  r.github.threads.set(channelId(PULL), threadRow(PULL));
  r.github.notify(PULL, '2026-10-15T00:09:30Z', REPO, 'review_requested');
  const readReviews = r.github.listReviewsSince.bind(r.github);
  r.github.listReviewsSince = async () => {
    throw new ReadCapError('listReviewsSince');
  };
  r.refuse.add('poll:review_requested:n-rayforce-12:2026-10-15T00:09:30Z');
  const first = await r.poller.pollOnce();
  assert.equal(first.dropped, 1);
  assert.deepEqual(r.events.map((e) => e.kind), ['thread.read_failed']);
  assert.deepEqual(r.state.notificationRetries().map((x) => x.reviewRequest?.updatedAt), ['2026-10-15T00:09:30Z']);

  r.github.listReviewsSince = readReviews;
  const restarted = rig({ stateFile: file, github: r.github });
  const second = await restarted.poller.pollOnce();
  assert.equal(second.notModified, true);
  assert.deepEqual(restarted.events.map((e) => e.id), ['poll:review_requested:n-rayforce-12:2026-10-15T00:09:30Z']);
  assert.ok(r.github.calls.includes(`reviews ${channelId(PULL)} since=2026-10-15T00:09:29Z`), 'read from its current update on, as the skip left it');
  assert.deepEqual(restarted.state.notificationRetries().filter((retry) => !retry.stopped), []);
  assert.equal(restarted.state.notificationRetries()[0].dropAnnounced, true);
});

test('a review request refused beside a backlog skipped on every pass is dropped after five passes, as any thread is', async () => {
  const r = rig();
  r.github.threads.set(channelId(PULL), threadRow(PULL));
  r.github.notify(PULL, '2026-10-15T00:09:30Z', REPO, 'review_requested');
  r.github.listReviewsSince = async () => {
    throw new ReadCapError('listReviewsSince');
  };
  r.refuse.add('poll:review_requested:n-rayforce-12:2026-10-15T00:09:30Z');
  const attempts: number[] = [];
  for (let pass = 0; pass < 5; pass++) {
    await r.poller.pollOnce();
    attempts.push(...r.state.notificationRetries().map((x) => x.attempts));
  }
  assert.deepEqual(attempts, [1, 2, 3, 4, 5], 'terminal count is retained after the fifth');
  assert.equal(r.state.notificationRetries()[0].stopped, true);
  assert.equal(r.events.filter((event) => event.kind === 'thread.read_failed').length, 1);
});

test('a review request listed beside a thread read that meets GitHub\'s rate limit waits on its retry entry, and arrives next pass', async () => {
  const r = rig();
  r.github.threads.set(channelId(PULL), threadRow(PULL));
  r.github.notify(PULL, '2026-10-15T00:09:30Z', REPO, 'review_requested');
  r.github.failing.set(channelId(PULL), new GitHubApiError(429, 'Too Many Requests', 'getPolledThread'));
  await r.poller.pollOnce();
  assert.equal(r.events.length, 0);
  assert.deepEqual(r.state.notificationRetries().map((x) => x.reviewRequest?.updatedAt), ['2026-10-15T00:09:30Z']);
  r.github.failing.clear();
  await r.poller.pollOnce();
  assert.deepEqual(r.events.map((e) => e.id), ['poll:review_requested:n-rayforce-12:2026-10-15T00:09:30Z']);
});

test('a newer update of a thread\'s review_requested notification supersedes a request still waiting: one request arrives, the newest', async () => {
  const r = rig();
  r.github.threads.set(channelId(PULL), threadRow(PULL));
  r.github.notify(PULL, '2026-10-15T00:09:30Z', REPO, 'review_requested');
  r.refuse.add('poll:review_requested:n-rayforce-12:2026-10-15T00:09:30Z');
  await r.poller.pollOnce();
  assert.equal(r.events.length, 0);

  r.github.notify(PULL, '2026-10-15T00:11:00Z', REPO, 'review_requested');
  r.github.lastModified = 'Wed, 15 Oct 2026 00:11:00 GMT';
  await r.poller.pollOnce();
  assert.deepEqual(r.events.map((e) => e.id), ['poll:review_requested:n-rayforce-12:2026-10-15T00:11:00Z']);
  assert.deepEqual(r.state.notificationRetries(), []);
});

/** One of the token user's open pull requests, as the search answers it. */
const own = (updatedAt: string, pull: ThreadRef = PULL): OwnPull => ({
  repo: pull.repo,
  number: pull.number,
  updatedAt,
  html_url: `https://github.com/anima-research/rayforce/pull/${pull.number}`,
});

test('without the token\'s login, a pass looks up no checks', async () => {
  const r = rig();
  r.github.ownPulls = [own('2026-10-15T00:09:00Z')];
  const result = await r.poller.pollOnce();
  assert.equal(result.checkLookups, 0);
  assert.ok(!r.github.calls.some((c) => c.startsWith('list own pulls')));
});

test('a settled failure on the head of the token user\'s own open pull request arrives as App mode\'s checks.completed, once per result, on 304 passes too', async () => {
  const r = rig({ login: 'a-human' });
  r.github.ownPulls = [own('2026-10-15T00:09:00Z')];
  r.github.heads.set(channelId(PULL), 'sha-one');
  r.github.checks.set('sha-one', { sha: 'sha-one', conclusion: 'failure', total: 2, failed: [{ name: 'test', url: 'https://ci/1' }] });
  const first = await r.poller.pollOnce();
  assert.equal(first.checkLookups, 1);
  assert.ok(r.github.calls.includes('list own pulls a-human'));
  assert.equal(r.events.length, 1);
  const ci = r.events[0];
  assert.equal(ci.kind, 'checks.completed');
  assert.match(ci.id, /^poll:checks:sha-one:failure:1:[0-9a-f]{12}$/);
  assert.deepEqual(ci.thread, PULL);
  assert.equal(ci.sha, 'sha-one');
  assert.deepEqual(ci.checks, { conclusion: 'failure', failed: [{ name: 'test', url: 'https://ci/1' }] });
  assert.ok(tagsFor(ci, { botLogin: 'a-human', maintainers: [] }).tags.includes('github:ci=failure'));

  // The next pass, a 304, doesn't look again while the pull request's update stands: its result was delivered.
  const second = await r.poller.pollOnce();
  assert.equal(second.notModified, true);
  assert.equal(second.checkLookups, 0);
  assert.equal(r.github.calls.filter((c) => c.startsWith('head ')).length, 1);
  assert.equal(r.events.length, 1);

  // A push moves its update: the new head is read, waits while its runs go, and arrives once they settle.
  r.github.ownPulls = [own('2026-10-15T00:12:00Z')];
  r.github.heads.set(channelId(PULL), 'sha-two');
  r.github.checks.set('sha-two', { sha: 'sha-two', conclusion: null, total: 2, failed: [] });
  await r.poller.pollOnce();
  assert.equal(r.github.calls.filter((c) => c.startsWith('head ')).length, 2);
  assert.equal(r.events.length, 1, 'nothing while its runs go');
  r.github.checks.set('sha-two', { sha: 'sha-two', conclusion: 'success', total: 2, failed: [] });
  await r.poller.pollOnce();
  assert.deepEqual(r.events.slice(1).map((e) => [e.kind, e.sha, e.checks?.conclusion]), [['checks.completed', 'sha-two', 'success']]);
});

test('a delivered result isn\'t looked up again until ten minutes pass, so a re-run on an unmoved head arrives then', async () => {
  const r = rig({ login: 'a-human' });
  r.github.ownPulls = [own('2026-10-15T00:09:00Z')];
  r.github.heads.set(channelId(PULL), 'sha-one');
  r.github.checks.set('sha-one', { sha: 'sha-one', conclusion: 'failure', total: 2, failed: [{ name: 'test', url: 'https://ci/1' }] });
  await r.poller.pollOnce();
  r.github.checks.set('sha-one', { sha: 'sha-one', conclusion: 'success', total: 2, failed: [] });
  r.setNow('2026-10-15T00:19:59.000Z');
  assert.equal((await r.poller.pollOnce()).checkLookups, 0);
  r.setNow('2026-10-15T00:20:00.000Z');
  assert.equal((await r.poller.pollOnce()).checkLookups, 1);
  assert.deepEqual(r.events.map((e) => e.checks?.conclusion), ['failure', 'success'], 'the re-run\'s result, on the same head');
  assert.equal(r.github.calls.filter((c) => c.startsWith('head ')).length, 2, 'its head read again with it');
  // A known result once the head is read again counts as delivered too: not looked up again within ten minutes.
  r.setNow('2026-10-15T00:30:00.000Z');
  const known = await r.poller.pollOnce();
  assert.equal(known.checkLookups, 1);
  assert.equal(known.duplicates, 1);
  r.setNow('2026-10-15T00:35:00.000Z');
  const before = r.github.calls.length;
  await r.poller.pollOnce();
  assert.deepEqual(r.github.calls.slice(before).filter((c) => c.startsWith('checks ') || c.startsWith('head ')), [], 'no request for it');
});

test('a failure while other runs go is delivered, and looked up again each pass until they finish', async () => {
  const r = rig({ login: 'a-human' });
  r.github.ownPulls = [own('2026-10-15T00:09:00Z')];
  r.github.heads.set(channelId(PULL), 'sha-one');
  r.github.checks.set('sha-one', { sha: 'sha-one', conclusion: 'failure', total: 3, failed: [{ name: 'lint', url: 'https://ci/1' }], unfinished: true });
  await r.poller.pollOnce();
  // The same failure while the runs still go: a duplicate, still looked up.
  await r.poller.pollOnce();
  r.github.checks.set('sha-one', { sha: 'sha-one', conclusion: 'failure', total: 3, failed: [{ name: 'lint', url: 'https://ci/1' }, { name: 'test', url: 'https://ci/2' }] });
  await r.poller.pollOnce();
  assert.deepEqual(r.events.map((e) => e.checks?.failed.length), [1, 2], 'the later failure arrives on the next pass after the repeat');
  const before = r.github.calls.length;
  await r.poller.pollOnce();
  assert.deepEqual(r.github.calls.slice(before).filter((c) => c.startsWith('checks ')), [], 'settled once every run finished');
});

test('a head with no check runs is looked up each pass for two minutes after its head is read, then left until it moves or ten minutes pass', async () => {
  const r = rig({ login: 'a-human' });
  r.github.ownPulls = [own('2026-10-15T00:09:00Z')];
  r.github.heads.set(channelId(PULL), 'sha-one');
  const lookups = () => r.github.calls.filter((c) => c.startsWith('checks ')).length;
  await r.poller.pollOnce();
  r.setNow('2026-10-15T00:11:59.000Z');
  await r.poller.pollOnce();
  assert.equal(lookups(), 2, 'still looked up inside two minutes, when a push\'s runs may not exist yet');
  r.setNow('2026-10-15T00:12:00.000Z');
  await r.poller.pollOnce();
  r.setNow('2026-10-15T00:15:00.000Z');
  await r.poller.pollOnce();
  assert.equal(lookups(), 3, 'none once it had no runs two minutes on');
  r.setNow('2026-10-15T00:20:00.000Z');
  await r.poller.pollOnce();
  assert.equal(lookups(), 4, 'looked up with its head ten minutes on');
});

test('a head whose runs still go is looked up each pass past two minutes', async () => {
  const r = rig({ login: 'a-human' });
  r.github.ownPulls = [own('2026-10-15T00:09:00Z')];
  r.github.heads.set(channelId(PULL), 'sha-one');
  r.github.checks.set('sha-one', { sha: 'sha-one', conclusion: null, total: 2, failed: [] });
  await r.poller.pollOnce();
  r.setNow('2026-10-15T00:12:00.000Z');
  await r.poller.pollOnce();
  r.setNow('2026-10-15T00:13:00.000Z');
  await r.poller.pollOnce();
  assert.equal(r.github.calls.filter((c) => c.startsWith('checks ')).length, 3);
});

test('heads whose results stand still move the turn, so the rest of more than one pass\'s worth are reached', async () => {
  const r = rig({ login: 'a-human' });
  const pulls: ThreadRef[] = Array.from({ length: 25 }, (_, i) => ({ repo: REPO, number: 100 + i, kind: 'pull' }));
  r.github.ownPulls = pulls.map((p) => own('2026-10-15T00:09:00Z', p));
  for (const p of pulls) {
    r.github.heads.set(channelId(p), `sha-${p.number}`);
    // The first 20 settle; the last five have no runs yet, looked up each pass for two minutes.
    if (p.number < 120) r.github.checks.set(`sha-${p.number}`, { sha: `sha-${p.number}`, conclusion: 'success', total: 1, failed: [] });
  }
  const looked = () => r.github.calls.filter((c) => c.startsWith('checks ')).map((c) => Number(c.slice('checks sha-'.length)));
  await r.poller.pollOnce();
  await r.poller.pollOnce();
  const before = looked().length;
  await r.poller.pollOnce();
  assert.deepEqual(looked().slice(before), [120, 121, 122, 123, 124], 'the running five are reached past the settled ones');
});

test('a failed search for the token user\'s open pull requests looks up no checks, and the pass still moves the watermark', async () => {
  const r = rig({ login: 'a-human' });
  r.github.ownPulls = [own('2026-10-15T00:09:00Z')];
  r.github.listOwnOpenPulls = async () => {
    throw new GitHubApiError(502, 'Bad Gateway', 'listOwnOpenPulls');
  };
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  const result = await r.poller.pollOnce();
  assert.equal(result.checkLookups, 0);
  assert.ok(r.logs.some((line) => line.includes('listing the token user\'s open pull requests failed')), 'the search was made and failed');
  // The same pass with a search that works stores the same watermark.
  const control = rig({ login: 'a-human' });
  control.github.ownPulls = [own('2026-10-15T00:09:00Z')];
  control.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  control.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  await control.poller.pollOnce();
  assert.notEqual(control.state.notificationsWatermark().lastModified, null, 'the listing\'s answer was stored');
  assert.deepEqual(r.state.notificationsWatermark(), control.state.notificationsWatermark());
});

test('more own open pull requests than one pass looks up are taken in turns', async () => {
  const r = rig({ login: 'a-human' });
  const pulls: ThreadRef[] = Array.from({ length: 25 }, (_, i) => ({ repo: REPO, number: 100 + i, kind: 'pull' }));
  r.github.ownPulls = pulls.map((p) => own('2026-10-15T00:09:00Z', p));
  for (const p of pulls) r.github.heads.set(channelId(p), `sha-${p.number}`);
  const looked = () => r.github.calls.filter((c) => c.startsWith('checks ')).map((c) => Number(c.slice('checks sha-'.length)));
  assert.equal((await r.poller.pollOnce()).checkLookups, 20);
  assert.equal((await r.poller.pollOnce()).checkLookups, 20);
  assert.deepEqual(new Set(looked()), new Set(pulls.map((p) => p.number)), 'every pull request was looked up within two passes');
  assert.deepEqual(looked().slice(20, 25), [120, 121, 122, 123, 124], 'the second pass starts where the first stopped');
});

test('a rate limit that stops a pass\'s lookups leaves the next pass to start where it stopped', async () => {
  const r = rig({ login: 'a-human' });
  const pulls: ThreadRef[] = Array.from({ length: 4 }, (_, i) => ({ repo: REPO, number: 100 + i, kind: 'pull' }));
  r.github.ownPulls = pulls.map((p) => own('2026-10-15T00:09:00Z', p));
  for (const p of pulls) r.github.heads.set(channelId(p), `sha-${p.number}`);
  r.github.checks.set('sha-102', new GitHubApiError(403, 'API rate limit exceeded for user ID 1.', 'getCheckRuns'));
  await r.poller.pollOnce();
  r.github.checks.delete('sha-102');
  await r.poller.pollOnce();
  assert.deepEqual(
    r.github.calls.filter((c) => c.startsWith('checks ')),
    ['checks sha-100', 'checks sha-101', 'checks sha-102', 'checks sha-102', 'checks sha-103', 'checks sha-100', 'checks sha-101'],
  );
});

test('a head read stands while its pull request\'s update does, for ten minutes at most', async () => {
  const r = rig({ login: 'a-human' });
  r.github.ownPulls = [own('2026-10-15T00:09:00Z')];
  r.github.heads.set(channelId(PULL), 'sha-one');
  await r.poller.pollOnce();
  r.github.heads.set(channelId(PULL), 'sha-two');
  r.setNow('2026-10-15T00:19:59.000Z');
  await r.poller.pollOnce();
  assert.deepEqual(r.github.calls.filter((c) => c.startsWith('checks ')), ['checks sha-one', 'checks sha-one']);
  r.setNow('2026-10-15T00:20:00.000Z');
  await r.poller.pollOnce();
  assert.deepEqual(r.github.calls.filter((c) => c.startsWith('checks ')).slice(2), ['checks sha-two'], 'the head is read again, though its update stood');
});

test('a refused checks event arrives when its pull request is next looked at; GitHub\'s rate limit ends a pass\'s lookups, and other failures skip one pull request', async () => {
  const r = rig({ login: 'a-human' });
  const second: ThreadRef = { repo: REPO, number: 13, kind: 'pull' };
  const third: ThreadRef = { repo: REPO, number: 14, kind: 'pull' };
  r.github.ownPulls = [own('2026-10-15T00:09:00Z'), own('2026-10-15T00:08:00Z', second), own('2026-10-15T00:07:00Z', third)];
  r.github.heads.set(channelId(PULL), 'sha-a');
  r.github.heads.set(channelId(second), 'sha-b');
  r.github.heads.set(channelId(third), 'sha-c');
  r.github.checks.set('sha-a', new GitHubApiError(502, 'Bad gateway', 'getCheckRuns'));
  r.github.checks.set('sha-b', { sha: 'sha-b', conclusion: 'failure', total: 1, failed: [{ name: 'lint', url: 'https://ci/b' }] });
  r.github.checks.set('sha-c', { sha: 'sha-c', conclusion: 'timed_out', total: 1, failed: [] });
  const once = await r.poller.pollOnce();
  assert.equal(once.checkLookups, 3, 'a failed lookup skips its pull request alone');
  assert.deepEqual(r.events.map((e) => e.sha), ['sha-b', 'sha-c']);

  // A refusal isn't recorded, so the next look delivers it.
  const settled = { sha: 'sha-a', conclusion: 'failure' as const, total: 1, failed: [] };
  r.github.checks.set('sha-a', settled);
  r.refuse.add(`poll:${checksPollKey(settled)}`);
  await r.poller.pollOnce();
  assert.equal(r.events.length, 2);
  r.refuse.clear();
  await r.poller.pollOnce();
  assert.deepEqual(r.events.slice(2).map((e) => e.sha), ['sha-a']);

  // A rate limit stops the lookups at once. A push moves the first pull request's update, so it's looked up again; the others' results stand.
  r.github.ownPulls = [own('2026-10-15T00:10:00Z'), own('2026-10-15T00:08:00Z', second), own('2026-10-15T00:07:00Z', third)];
  r.github.checks.set('sha-a', new GitHubApiError(403, 'API rate limit exceeded for user ID 1.', 'getCheckRuns'));
  const before = r.github.calls.length;
  const limited = await r.poller.pollOnce();
  assert.equal(limited.checkLookups, 1);
  assert.deepEqual(r.github.calls.slice(before).filter((c) => c.startsWith('checks ')), ['checks sha-a']);
  assert.ok(r.logs.some((line) => line.includes('rate-limited a check lookup')));
});

test('a pass whose thread reads met GitHub\'s rate limit looks up no checks', async () => {
  const r = rig({ login: 'a-human' });
  r.github.ownPulls = [own('2026-10-15T00:09:00Z')];
  r.github.heads.set(channelId(PULL), 'sha-one');
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  r.github.failing.set(channelId(ISSUE), new GitHubApiError(403, 'API rate limit exceeded for user ID 1.', 'getPolledThread'));
  const result = await r.poller.pollOnce();
  assert.equal(result.checkLookups, 0);
  assert.ok(!r.github.calls.some((c) => c.startsWith('list own pulls')));
});


for (const unavailable of ['disconnected', 'plain-mcp', 'ungranted', 'channel-error', 'channel-refused', 'push-refused'] as const) {
  test(`delivery receipt: ${unavailable} retains thread progress until a host accepts`, async (t) => {
    const r = rig();
    r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
    r.github.comments.set(channelId(ISSUE), [comment(1, 7, '2026-10-15T00:09:30Z')]);
    r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
    r.state.setNotificationsWatermark({ since: FIRST_W, lastModified: null, answeredAt: null });
    const cursor = [FIRST_READ, '', '', ''].join('\u0000');
    r.state.setPolledHead(`notif:${channelId(ISSUE)}`, cursor);
    const api = new FakeGitHubApi();
    api.seedIssue({ number: 7 });
    const h = harness({ api, pushAccepted: unavailable !== 'push-refused' });
    t.after(() => h.close());
    let server = unavailable === 'disconnected'
      ? new GitHubMcplServer(api, { botLogin: 'agent', repos: [REPO] })
      : h.server;
    if (unavailable !== 'disconnected') await initialize(h, unavailable !== 'plain-mcp');
    if (unavailable.startsWith('channel-') || unavailable === 'push-refused') {
      await grant(h, unavailable === 'push-refused' ? ['pushEvents'] : ['channels.register', 'channels.incoming']);
      if (unavailable.startsWith('channel-')) {
        h.host.removeAllListeners('request');
        h.host.on('request', (req) => {
          if (req.method === method.CHANNELS_REGISTER || req.method === method.CHANNELS_CHANGED) {
            const p = req.params as { channels?: { id: string }[]; updated?: { id: string }[] };
            h.host.sendResponse(req.id, { results: (p.channels ?? p.updated ?? []).map((c) => ({ id: c.id, accepted: true })) });
          } else if (req.method === method.CHANNELS_INCOMING) {
            if (unavailable === 'channel-error') h.host.sendError(req.id, -32603, 'synthetic delivery failure');
            else {
              const p = req.params as { messages: { messageId: string }[] };
              h.host.sendResponse(req.id, { results: p.messages.map((m) => ({ messageId: m.messageId, accepted: false })) });
            }
          } else h.host.sendResponse(req.id, { accepted: true });
        });
      }
    }
    const poller = new NotificationsPoller({ api: r.github, state: r.state, intervalMs: 60000, repos: [REPO], onEvent: (event) => server.onEvent(event), canPoll: () => server.canReceiveEvents(), now: () => new Date(START) });
    const first = await poller.pollOnce();
    assert.equal(first.delivered.length, 0);
    const paused = ['disconnected', 'plain-mcp', 'ungranted'].includes(unavailable);
    assert.equal(first.failed, paused ? 0 : 1);
    assert.deepEqual(r.state.snapshot().pollKeys, []);
    assert.equal(r.state.polledHead(`notif:${channelId(ISSUE)}`), cursor);
    assert.equal(r.state.notificationsWatermark().since, paused ? FIRST_W : '2026-10-15T00:09:39Z');
    assert.equal(r.state.notificationsWatermark().answeredAt, paused ? null : '2026-10-15T00:10:00Z');
    assert.equal(r.state.notificationRetries().length, paused ? 0 : 1);

    const ready = harness({ api });
    t.after(() => ready.close());
    await initialize(ready, true);
    await grant(ready);
    server = ready.server;
    const second = await poller.pollOnce();
    assert.equal(second.failed, 0);
    assert.equal(second.delivered.length, 1);
    assert.ok(r.state.snapshot().pollKeys.includes('issue_comment:1:2026-10-15T00:09:30Z'));
    assert.equal(r.state.notificationRetries().length, 0);
    assert.notEqual(r.state.polledHead(`notif:${channelId(ISSUE)}`), cursor);
    assert.ok(ready.hostSaw.some((req) => req.method === method.CHANNELS_INCOMING));
  });
}

test('delivery receipt: a false checks delivery is not deduplicated or settled', async () => {
  const r = rig();
  r.github.ownPulls = [{ repo: REPO, number: 12, updatedAt: FIRST_W, html_url: 'https://example.invalid/pull/12' }];
  r.github.heads.set(channelId(PULL), 'synthetic-head');
  r.github.checks.set('synthetic-head', { sha: 'synthetic-head', conclusion: 'success', total: 1, failed: [] });
  let accepted = false;
  const poller = new NotificationsPoller({ api: r.github, state: r.state, intervalMs: 60000, repos: [REPO], login: 'agent', onEvent: () => accepted, now: () => new Date(START) });
  assert.deepEqual((await poller.pollOnce()).delivered, []);
  assert.deepEqual(r.state.snapshot().pollKeys, []);
  accepted = true;
  assert.equal((await poller.pollOnce()).delivered.length, 1);
});


test('delivery receipt: App repository polling retains its legacy handoff behavior', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7, createdAt: '2026-10-15T00:09:30Z', updatedAt: '2026-10-15T00:09:30Z' });
  const server = new GitHubMcplServer(api, { botLogin: 'agent', repos: [REPO] });
  const state = GithubState.empty();
  state.setLastPollAt(FIRST_W);
  const poller = new Poller({ api, state, repos: [REPO], intervalMs: 60000, onEvent: server.onEvent, now: () => new Date(START) });
  await poller.pollOnce();
  // App ingress still ignores the receipt, as before this contributor-only fix.
  assert.ok(state.snapshot().pollKeys.length > 0);
});


test('truncated listing: restart re-reads the original window without a conditional 304 or duplicate delivery', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'gh-notif-truncated-')), 'state.json');
  const r = rig({ stateFile: file });
  const older: ThreadRef = { repo: REPO, number: 8, kind: 'issue' };
  for (const [thread, stamp] of [[ISSUE, '2026-10-15T00:09:30Z'], [older, '2026-10-15T00:09:10Z']] as const) {
    r.github.threads.set(channelId(thread), threadRow(thread, { updatedAt: stamp }));
    r.github.comments.set(channelId(thread), [comment(thread.number, thread.number, stamp)]);
  }
  // The capped response contains a newer thread, not necessarily the oldest
  // one in the window. Never infer a safe cutoff from the returned prefix.
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  r.github.truncated = true;
  assert.equal((await r.poller.pollOnce()).delivered.length, 1);
  assert.equal(r.state.notificationsWatermark().since, FIRST_W);
  assert.equal(r.state.notificationsWatermark().lastModified, null);

  r.github.notify(older, '2026-10-15T00:09:10Z');
  r.github.truncated = false;
  // Last-Modified did not change: retaining it would yield 304 here.
  const restarted = rig({ stateFile: file, github: r.github });
  const second = await restarted.poller.pollOnce();
  assert.equal(second.notModified, false);
  assert.deepEqual(second.delivered.map((e) => e.thread?.number), [8]);
  assert.equal(second.duplicates, 1);
  assert.ok(r.github.calls.filter((call) => call.startsWith('list ')).every((call) => call === `list since=${FIRST_W} ims=null`));
  assert.equal(restarted.state.notificationsWatermark().since, '2026-10-15T00:09:39Z');
});

for (const accepted of ['channel', 'push'] as const) {
  test(`partial egress receipt: ${accepted} acceptance is delivered once despite the other refusal`, async (t) => {
    const r = rig();
    r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
    r.github.comments.set(channelId(ISSUE), [comment(1, 7, '2026-10-15T00:09:30Z')]);
    r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
    r.github.conditional = false;
    r.github.lastModified = 'Wed, 15 Oct 2026 00:09:30 GMT';
    const api = new FakeGitHubApi();
    api.seedIssue({ number: 7 });
    const warnings: string[] = [];
    const h = harness({ api, logger: { debug() {}, info() {}, error() {}, warn(message) { warnings.push(message); } } });
    t.after(() => h.close());
    await initialize(h, true);
    await grant(h);
    let incoming = 0;
    h.host.removeAllListeners('request');
    h.host.on('request', (req) => {
      if (req.method === method.CHANNELS_REGISTER || req.method === method.CHANNELS_CHANGED) {
        const p = req.params as { channels?: { id: string }[]; updated?: { id: string }[] };
        h.host.sendResponse(req.id, { results: (p.channels ?? p.updated ?? []).map((c) => ({ id: c.id, accepted: true })) });
      } else if (req.method === method.CHANNELS_INCOMING) {
        incoming += 1;
        const p = req.params as { messages: { messageId: string }[] };
        h.host.sendResponse(req.id, { results: p.messages.map((m) => ({ messageId: m.messageId, accepted: accepted === 'channel' })) });
      } else h.host.sendResponse(req.id, { accepted: accepted === 'push' });
    });
    const poller = new NotificationsPoller({ api: r.github, state: r.state, intervalMs: 60000, repos: [REPO], onEvent: h.server.onEvent, now: () => new Date(START) });
    assert.equal((await poller.pollOnce()).delivered.length, 1);
    assert.ok(r.state.snapshot().pollKeys.includes('issue_comment:1:2026-10-15T00:09:30Z'));
    assert.equal((await poller.pollOnce()).delivered.length, 0);
    assert.equal(incoming, 1, 'an accepted egress is not resent because the other declined');
    assert.ok(warnings.some((message) => message.includes('declined')));
  });
}

for (const unavailable of ['disconnected', 'plain-mcp', 'ungranted'] as const) {
  test(`host readiness: ${unavailable} skips twelve passes, resumes once, and pauses on disconnect`, async (t) => {
    const r = rig();
    r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
    r.github.comments.set(channelId(ISSUE), [comment(1, 7, '2026-10-15T00:09:30Z')]);
    r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
    const api = new FakeGitHubApi();
    api.seedIssue({ number: 7 });
    const h = harness({ api });
    t.after(() => h.close());
    let server = unavailable === 'disconnected' ? new GitHubMcplServer(api) : h.server;
    if (unavailable !== 'disconnected') await initialize(h, unavailable !== 'plain-mcp');
    const transitions: string[] = [];
    const record = (message: string) => { transitions.push(message); };
    const poller = new NotificationsPoller({ api: r.github, state: r.state, intervalMs: 60000, repos: [REPO],
      onEvent: (event) => server.onEvent(event), canPoll: () => server.canReceiveEvents(), now: () => new Date(START),
      logger: { debug: record, info: record, warn() {}, error() {} } });
    const before = r.state.snapshot();
    poller.start();
    poller.stop();
    for (let pass = 0; pass < 12; pass++) await poller.pollOnce();
    assert.deepEqual(r.github.calls, [], 'no inbox, thread, or check reads while no host is eligible');
    assert.deepEqual(r.state.snapshot(), before, 'not even initial watermark/retry state changes');
    assert.equal(transitions.filter((s) => s.includes('paused')).length, 1);

    const ready = harness({ api });
    await initialize(ready, true);
    await grant(ready);
    server = ready.server;
    assert.equal((await poller.pollOnce()).delivered.length, 1);
    assert.equal((await poller.pollOnce()).delivered.length, 0);
    assert.equal(ready.hostSaw.filter((req) => req.method === method.CHANNELS_INCOMING).length, 1);
    assert.equal(transitions.filter((s) => s.includes('resumed')).length, 1);
    await ready.close();
    const calls = r.github.calls.length;
    const after = r.state.snapshot();
    for (let pass = 0; pass < 12; pass++) await poller.pollOnce();
    assert.equal(r.github.calls.length, calls);
    assert.deepEqual(r.state.snapshot(), after);
    assert.equal(transitions.filter((s) => s.includes('paused')).length, 2);
  });
}

for (const egress of ['channel', 'push'] as const) for (const acceptDrop of [true, false]) {
  test(`bounded refusal: ${egress} stops after five attempts and announces one drop across twelve passes and restart (drop accepted: ${acceptDrop})`, async (t) => {
    const file = join(mkdtempSync(join(tmpdir(), 'gh-notif-bounded-')), 'state.json');
    const r = rig({ stateFile: file });
    r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
    r.github.comments.set(channelId(ISSUE), [comment(1, 7, '2026-10-15T00:09:30Z')]);
    r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
    // Keep re-listing exactly the same notification, including after restart.
    r.github.conditional = false;
    r.github.lastModified = 'Wed, 15 Oct 2026 00:09:30 GMT';
    const api = new FakeGitHubApi();
    api.seedIssue({ number: 7 });
    const h = harness({ api });
    t.after(() => h.close());
    await initialize(h, true);
    await grant(h, egress === 'push' ? ['pushEvents'] : ['channels.register', 'channels.incoming']);
    let attempts = 0;
    let drops = 0;
    let recover = false;
    h.host.removeAllListeners('request');
    h.host.on('request', (req) => {
      if (req.method === method.CHANNELS_REGISTER || req.method === method.CHANNELS_CHANGED) {
        const p = req.params as { channels?: { id: string }[]; updated?: { id: string }[] };
        h.host.sendResponse(req.id, { results: (p.channels ?? p.updated ?? []).map((c) => ({ id: c.id, accepted: true })) });
        return;
      }
      const p = req.params as { eventId?: string; messages?: { messageId: string }[] };
      const id = p.eventId ?? p.messages![0].messageId;
      const drop = id.startsWith('poll:read_failed:');
      if (drop) drops += 1; else attempts += 1;
      const accepted = drop ? acceptDrop : recover;
      h.host.sendResponse(req.id, p.messages ? { results: p.messages.map((m) => ({ messageId: m.messageId, accepted })) } : { accepted });
    });
    let state = r.state;
    const create = () => new NotificationsPoller({ api: r.github, state, intervalMs: 60000, repos: [REPO],
      onEvent: h.server.onEvent, canPoll: h.server.canReceiveEvents, now: () => new Date(START) });
    let poller = create();
    for (let pass = 1; pass <= 12; pass++) {
      await poller.pollOnce();
      if (pass === 3 || pass === 7) { state = GithubState.load(file); poller = create(); }
    }
    assert.equal(attempts, 5, 'same notification cannot reset its retry count after a drop');
    assert.equal(drops, 1, 'one announcement for this thread/notification update, even across restart');
    assert.equal(state.notificationRetries()[0]?.attempts, 5);
    assert.equal(state.notificationRetries()[0]?.stopped, true);
    assert.deepEqual(state.snapshot().pollKeys, [], 'a refused event is not falsely deduplicated');
    assert.equal(state.notificationsWatermark().lastModified, r.github.lastModified, 'failed handoff does not force unconditional listings');
    assert.equal(state.notificationsWatermark().since, '2026-10-15T00:09:29Z');
    assert.equal(r.github.calls.filter((call) => call.startsWith('thread ')).length, 5);

    recover = true;
    r.github.notify(ISSUE, '2026-10-15T00:12:00Z');
    r.github.threads.set(channelId(ISSUE), threadRow(ISSUE, { updatedAt: '2026-10-15T00:12:00Z' }));
    r.github.lastModified = 'Wed, 15 Oct 2026 00:12:00 GMT';
    assert.equal((await poller.pollOnce()).delivered.length, 1, 'a genuinely newer notification resumes from the held cursor');
    assert.equal(drops, 1);
    assert.deepEqual(state.notificationRetries(), []);
  });
}

test('host readiness: revoking egress pauses an outstanding retry without consuming its budget', async (t) => {
  const r = rig();
  r.github.threads.set(channelId(ISSUE), threadRow(ISSUE));
  r.github.comments.set(channelId(ISSUE), [comment(1, 7, '2026-10-15T00:09:30Z')]);
  r.github.notify(ISSUE, '2026-10-15T00:09:30Z');
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7 });
  const h = harness({ api, pushAccepted: false });
  t.after(() => h.close());
  await initialize(h, true);
  await grant(h, ['pushEvents']);
  const poller = new NotificationsPoller({ api: r.github, state: r.state, intervalMs: 60000, repos: [REPO],
    canPoll: h.server.canReceiveEvents, onEvent: h.server.onEvent, now: () => new Date(START) });
  assert.equal((await poller.pollOnce()).failed, 1);
  const pending = r.state.snapshot();
  const calls = r.github.calls.length;
  await grant(h, []);
  for (let pass = 0; pass < 12; pass++) await poller.pollOnce();
  assert.deepEqual(r.state.snapshot(), pending);
  assert.equal(r.github.calls.length, calls);
  await grant(h, ['channels.register', 'channels.incoming']);
  assert.equal((await poller.pollOnce()).delivered.length, 1);
  assert.deepEqual(r.state.notificationRetries(), []);
});
