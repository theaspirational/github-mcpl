/**
 * Shared test harness.
 *
 * Two pieces, and every other work package tests against both:
 *
 *   `harness()`      — the real GitHubMcplServer over an in-memory stream
 *                      pair, driven the way an MCPL host drives it. Same API
 *                      as slack-mcpl's harness (`host`, `hostSaw`, `served`,
 *                      `close`, plus `initialize` and `until`), so a test
 *                      written against that one reads the same here.
 *   `FakeGitHubApi`  — an in-memory GitHubApi. No network, no octokit: the
 *                      seam is the only thing the package's own tests touch.
 */

import { PassThrough } from 'node:stream';
import {
  McplConnection,
  method,
  type ChannelsIncomingParams,
  type FeatureSetsUpdateParams,
  type JsonRpcRequest,
  type PushEventParams,
} from '@animalabs/mcpl-core';
import { GitHubMcplServer, type GitHubServerOptions } from '../src/server.js';
import { commentsToolModule } from '../src/tools-comments.js';
import { issuesToolModule, prToolModule } from '../src/tools-issues-pr.js';
import { readToolModule } from '../src/tools-read.js';
import { reviewToolModule } from '../src/tools-review.js';
import {
  LIMITS,
  repoSlug,
  type BotIdentity,
  type ChecksSummary,
  type Comment,
  type CreateIssueInput,
  type CreatePullRequestInput,
  type CreateReviewInput,
  type EventActor,
  type GitHubApi,
  type Issue,
  type IssueSearch,
  type IssueSearchHit,
  type PolledComment,
  type PolledIssue,
  type PollRead,
  type PullRequest,
  type PullRequestFile,
  type RepoRef,
  type ReviewThread,
  type SubmittedReview,
  type ThreadRef,
  type ToolResult,
  type UpdateIssueInput,
  type UpdatePullRequestInput,
} from '../src/types.js';
import type { ContentBlock } from '@animalabs/mcpl-core';
import type { DegradationReceipt } from '../src/grant.js';

// ─────────────────────────────────────────────────────────────────────────────
// FakeGitHubApi
// ─────────────────────────────────────────────────────────────────────────────

/** One recorded call. `args` is what the caller passed, in order. */
export interface RecordedCall {
  method: keyof GitHubApi;
  args: unknown[];
}

export const TEST_REPO: RepoRef = { owner: 'anima-research', name: 'rayforce' };
export const TEST_BOT: BotIdentity = { login: 'rayforce-clone[bot]', id: 9001, isBot: true };

function humanActor(login: string): EventActor {
  return { login, isBot: false };
}

function key(repo: RepoRef, number: number): string {
  return `${repoSlug(repo)}#${number}`;
}

const T0 = '2026-10-01T00:00:00.000Z';


/**
 * In-memory GitHub. Every {@link GitHubApi} method is implemented over plain
 * maps, every call is appended to {@link FakeGitHubApi.calls}, and nothing
 * reaches the network. Seed it with the `seed*` methods; reads of unseeded
 * objects throw, the way a 404 would.
 */
export class FakeGitHubApi implements GitHubApi {
  readonly calls: RecordedCall[] = [];
  bot: BotIdentity = { ...TEST_BOT };

  private readonly issues = new Map<string, Issue>();
  /** `closed_by` for the issues list, by issue number (the live list carries it). */
  readonly closedBy = new Map<number, EventActor>();
  private readonly pulls = new Map<string, PullRequest>();
  private readonly comments = new Map<string, Comment[]>();
  private readonly reviewThreads = new Map<string, ReviewThread[]>();
  private readonly files = new Map<string, PullRequestFile[]>();
  private readonly checks = new Map<string, ChecksSummary>();
  private readonly reviews: SubmittedReview[] = [];
  private nextNumber = 1;
  private nextId = 1000;
  private lastStamp = 0;

  /**
   * A comment body's `updated_at`, the way GitHub stamps one: **second**
   * resolution, and never going backwards (round 6).
   *
   * Real GitHub returns whole seconds, so stamping with `Date.now()`'s
   * milliseconds would order two writes that real GitHub cannot tell apart
   * and the clock rule would look stronger here than it is. Strictly
   * increasing rather than merely non-decreasing, so an ordinary
   * create-then-edit gets the distinct stamps any real elapsed time would
   * give it; a same-second tie is then something a test stages on purpose
   * rather than an accident of how fast it ran.
   */
  private stamp(): string {
    const second = Math.floor(Date.now() / 1000) * 1000;
    this.lastStamp = Math.max(second, this.lastStamp + 1000);
    return new Date(this.lastStamp).toISOString();
  }

  // ── Call log ──

  private record(m: keyof GitHubApi, ...args: unknown[]): void {
    this.calls.push({ method: m, args });
  }

  /** Call names in order, e.g. `['getIssue', 'createComment']`. */
  callLog(): (keyof GitHubApi)[] {
    return this.calls.map((c) => c.method);
  }

  /** Every recorded call to one method. */
  callsTo(m: keyof GitHubApi): RecordedCall[] {
    return this.calls.filter((c) => c.method === m);
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  // ── Seeding ──

  seedIssue(partial: Partial<Issue> & { repo?: RepoRef } = {}): Issue {
    const repo = partial.repo ?? TEST_REPO;
    const number = partial.number ?? this.nextNumber++;
    const defaults: Issue = {
      number,
      kind: 'issue',
      repo,
      title: `Issue ${number}`,
      body: '',
      state: 'open',
      stateReason: null,
      author: humanActor('human-one'),
      labels: [],
      createdAt: T0,
      updatedAt: T0,
      html_url: `https://github.com/${repoSlug(repo)}/issues/${number}`,
    };
    const issue: Issue = { ...defaults, ...partial, repo, number, kind: 'issue' };
    this.issues.set(key(repo, number), issue);
    if (number >= this.nextNumber) this.nextNumber = number + 1;
    return issue;
  }

  seedPullRequest(partial: Partial<PullRequest> & { repo?: RepoRef } = {}): PullRequest {
    const repo = partial.repo ?? TEST_REPO;
    const number = partial.number ?? this.nextNumber++;
    const defaults: PullRequest = {
      number,
      kind: 'pull',
      repo,
      title: `Pull ${number}`,
      body: '',
      state: 'open',
      draft: false,
      merged: false,
      mergeable: true,
      head: { ref: `feature-${number}`, sha: `head${number}`.padEnd(40, '0') },
      base: { ref: 'dev', sha: `base${number}`.padEnd(40, '0') },
      author: humanActor('human-one'),
      requestedReviewers: [],
      createdAt: T0,
      updatedAt: T0,
      html_url: `https://github.com/${repoSlug(repo)}/pull/${number}`,
      checksSummary: null,
    };
    const pull: PullRequest = { ...defaults, ...partial, repo, number, kind: 'pull' };
    this.pulls.set(key(repo, number), pull);
    if (number >= this.nextNumber) this.nextNumber = number + 1;
    return pull;
  }

  seedComment(thread: ThreadRef, partial: Partial<Comment> = {}): Comment {
    const id = partial.id ?? this.nextId++;
    const defaults: Comment = {
      id,
      author: humanActor('human-one'),
      body: '',
      createdAt: T0,
      updatedAt: T0,
      html_url: `https://github.com/${repoSlug(thread.repo)}/issues/${thread.number}#issuecomment-${id}`,
    };
    const comment: Comment = { ...defaults, ...partial, id };
    const list = this.comments.get(key(thread.repo, thread.number)) ?? [];
    list.push(comment);
    this.comments.set(key(thread.repo, thread.number), list);
    return comment;
  }

  seedReviewThread(pull: ThreadRef, partial: Partial<ReviewThread> = {}): ReviewThread {
    const rootId = partial.comments?.[0]?.id ?? this.nextId++;
    const thread: ReviewThread = {
      id: `RT_${rootId}`,
      path: 'src/lib.rs',
      line: 42,
      side: 'RIGHT',
      isResolved: false,
      comments: [
        {
          id: rootId,
          author: humanActor('human-one'),
          body: 'this line',
          createdAt: T0,
        },
      ],
      ...partial,
    };
    const list = this.reviewThreads.get(key(pull.repo, pull.number)) ?? [];
    list.push(thread);
    this.reviewThreads.set(key(pull.repo, pull.number), list);
    return thread;
  }

  seedFiles(pull: ThreadRef, files: PullRequestFile[]): void {
    this.files.set(key(pull.repo, pull.number), files);
  }

  seedCheckRuns(repo: RepoRef, summary: ChecksSummary): void {
    this.checks.set(`${repoSlug(repo)}@${summary.sha}`, summary);
  }

  /** The submitted reviews, in order — createReview has no read method. */
  submittedReviews(): SubmittedReview[] {
    return [...this.reviews];
  }

  // ── Reads ──

  async getIssue(ref: ThreadRef): Promise<Issue> {
    this.record('getIssue', ref);
    const issue = this.issues.get(key(ref.repo, ref.number));
    if (!issue) throw new Error(`no such issue: ${key(ref.repo, ref.number)}`);
    return issue;
  }

  async getPullRequest(ref: ThreadRef): Promise<PullRequest> {
    this.record('getPullRequest', ref);
    const pull = this.pulls.get(key(ref.repo, ref.number));
    if (!pull) throw new Error(`no such pull request: ${key(ref.repo, ref.number)}`);
    return pull;
  }

  async listComments(thread: ThreadRef, since?: string): Promise<Comment[]> {
    this.record('listComments', thread, since);
    const list = this.comments.get(key(thread.repo, thread.number)) ?? [];
    return since ? list.filter((c) => c.updatedAt > since) : [...list];
  }

  async listReviewThreads(pull: ThreadRef): Promise<ReviewThread[]> {
    this.record('listReviewThreads', pull);
    return [...(this.reviewThreads.get(key(pull.repo, pull.number)) ?? [])];
  }

  async listPullRequestFiles(pull: ThreadRef): Promise<PullRequestFile[]> {
    this.record('listPullRequestFiles', pull);
    return [...(this.files.get(key(pull.repo, pull.number)) ?? [])];
  }

  async getCheckRuns(repo: RepoRef, sha: string): Promise<ChecksSummary> {
    this.record('getCheckRuns', repo, sha);
    return this.checks.get(`${repoSlug(repo)}@${sha}`) ?? { sha, conclusion: null, total: 0, failed: [] };
  }

  /** Results from other repositories the next search reports as left out. */
  searchOutside = 0;

  async searchIssues(repo: RepoRef, query: string, limit = LIMITS.listEntries): Promise<IssueSearch> {
    this.record('searchIssues', repo, query, limit);
    const needle = query.toLowerCase();
    const hits: IssueSearchHit[] = [];
    for (const item of [...this.issues.values(), ...this.pulls.values()]) {
      if (repoSlug(item.repo) !== repoSlug(repo)) continue;
      if (!`${item.title} ${item.body}`.toLowerCase().includes(needle)) continue;
      hits.push({
        number: item.number,
        kind: item.kind,
        title: item.title,
        state: item.state,
        updatedAt: item.updatedAt,
        html_url: item.html_url,
      });
    }
    return { hits: hits.slice(0, limit), outside: this.searchOutside };
  }

  // ── Comments ──

  async createComment(thread: ThreadRef, body: string): Promise<Comment> {
    this.record('createComment', thread, body);
    const id = this.nextId++;
    const now = this.stamp();
    const comment: Comment = {
      id,
      author: { login: this.bot.login, isBot: true },
      body,
      createdAt: now,
      updatedAt: now,
      html_url: `https://github.com/${repoSlug(thread.repo)}/issues/${thread.number}#issuecomment-${id}`,
    };
    const list = this.comments.get(key(thread.repo, thread.number)) ?? [];
    list.push(comment);
    this.comments.set(key(thread.repo, thread.number), list);
    return comment;
  }

  /**
   * The `review` flag names the endpoint, as the seam says: GitHub edits a
   * review comment through `pulls/comments/{id}` and an issue comment through
   * `issues/comments/{id}`, and the two are numbered separately, so an id can
   * exist in both stores. WP7 reported that this fake searched issue comments
   * first whatever the flag said, which would let a review-comment edit land
   * on an unrelated issue comment with the same id. WP9: `review === true`
   * looks only at the review threads, `false` only at the issue comments, and
   * `undefined` keeps the old "look on both" for the callers that do not know.
   */
  async updateComment(repo: RepoRef, commentId: number, body: string, review?: boolean): Promise<Comment> {
    this.record('updateComment', repo, commentId, body, review);
    if (review !== true) {
      for (const [threadKey, list] of this.comments) {
        if (!threadKey.startsWith(`${repoSlug(repo)}#`)) continue;
        const found = list.find((c) => c.id === commentId);
        if (found) {
          found.body = body;
          found.updatedAt = this.stamp();
          return found;
        }
      }
    }
    if (review !== false) {
      for (const [threadKey, threads] of this.reviewThreads) {
        if (!threadKey.startsWith(`${repoSlug(repo)}#`)) continue;
        for (const thread of threads) {
          const found = thread.comments.find((c) => c.id === commentId);
          if (found) {
            found.body = body;
            found.updatedAt = this.stamp();
            return {
              id: found.id,
              author: found.author,
              body,
              createdAt: found.createdAt,
              updatedAt: found.updatedAt,
              html_url: `https://github.com/${repoSlug(repo)}#discussion_r${found.id}`,
              path: thread.path,
              line: thread.line,
              side: thread.side,
              inReplyTo: found.inReplyTo,
            };
          }
        }
      }
    }
    throw new Error(`no such comment: ${commentId}`);
  }

  /** Same endpoint split as {@link FakeGitHubApi.updateComment}. */
  async deleteComment(repo: RepoRef, commentId: number, review?: boolean): Promise<void> {
    this.record('deleteComment', repo, commentId, review);
    if (review !== true) {
      for (const [threadKey, list] of this.comments) {
        if (!threadKey.startsWith(`${repoSlug(repo)}#`)) continue;
        const idx = list.findIndex((c) => c.id === commentId);
        if (idx >= 0) {
          list.splice(idx, 1);
          return;
        }
      }
    }
    if (review !== false) {
      for (const [threadKey, threads] of this.reviewThreads) {
        if (!threadKey.startsWith(`${repoSlug(repo)}#`)) continue;
        for (const thread of threads) {
          const idx = thread.comments.findIndex((c) => c.id === commentId);
          if (idx >= 0) {
            thread.comments.splice(idx, 1);
            return;
          }
        }
      }
    }
    throw new Error(`no such comment: ${commentId}`);
  }

  async replyToReviewComment(pull: ThreadRef, inReplyTo: number, body: string): Promise<Comment> {
    this.record('replyToReviewComment', pull, inReplyTo, body);
    const threads = this.reviewThreads.get(key(pull.repo, pull.number)) ?? [];
    const thread = threads.find((t) => t.comments.some((c) => c.id === inReplyTo));
    if (!thread) throw new Error(`no review comment ${inReplyTo} on ${key(pull.repo, pull.number)}`);
    const id = this.nextId++;
    const now = new Date().toISOString();
    thread.comments.push({
      id,
      author: { login: this.bot.login, isBot: true },
      body,
      createdAt: now,
      inReplyTo,
    });
    return {
      id,
      author: { login: this.bot.login, isBot: true },
      body,
      createdAt: now,
      updatedAt: now,
      html_url: `https://github.com/${repoSlug(pull.repo)}/pull/${pull.number}#discussion_r${id}`,
      path: thread.path,
      line: thread.line,
      side: thread.side,
      inReplyTo,
    };
  }

  // ── Review ──

  async createReview(pull: ThreadRef, input: CreateReviewInput): Promise<SubmittedReview> {
    this.record('createReview', pull, input);
    const id = this.nextId++;
    const state =
      input.event === 'APPROVE' ? 'approved' : input.event === 'REQUEST_CHANGES' ? 'changes_requested' : 'commented';
    for (const c of input.comments ?? []) {
      const rootId = this.nextId++;
      const list = this.reviewThreads.get(key(pull.repo, pull.number)) ?? [];
      list.push({
        id: `RT_${rootId}`,
        path: c.path,
        line: c.line,
        side: c.side,
        isResolved: false,
        comments: [
          {
            id: rootId,
            author: { login: this.bot.login, isBot: true },
            body: c.body,
            createdAt: new Date().toISOString(),
          },
        ],
      });
      this.reviewThreads.set(key(pull.repo, pull.number), list);
    }
    const review: SubmittedReview = {
      id,
      state,
      html_url: `https://github.com/${repoSlug(pull.repo)}/pull/${pull.number}#pullrequestreview-${id}`,
    };
    this.reviews.push(review);
    return review;
  }

  async resolveReviewThread(reviewThreadId: string): Promise<void> {
    this.record('resolveReviewThread', reviewThreadId);
    this.setResolved(reviewThreadId, true);
  }

  async unresolveReviewThread(reviewThreadId: string): Promise<void> {
    this.record('unresolveReviewThread', reviewThreadId);
    this.setResolved(reviewThreadId, false);
  }

  private setResolved(reviewThreadId: string, resolved: boolean): void {
    for (const threads of this.reviewThreads.values()) {
      const thread = threads.find((t) => t.id === reviewThreadId);
      if (thread) {
        thread.isResolved = resolved;
        return;
      }
    }
    throw new Error(`no such review thread: ${reviewThreadId}`);
  }

  // ── Issues ──

  async createIssue(repo: RepoRef, input: CreateIssueInput): Promise<Issue> {
    this.record('createIssue', repo, input);
    return this.seedIssue({
      repo,
      title: input.title,
      body: input.body ?? '',
      author: { login: this.bot.login, isBot: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async updateIssue(ref: ThreadRef, input: UpdateIssueInput): Promise<Issue> {
    this.record('updateIssue', ref, input);
    const issue = this.issues.get(key(ref.repo, ref.number));
    if (!issue) throw new Error(`no such issue: ${key(ref.repo, ref.number)}`);
    if (input.title !== undefined) issue.title = input.title;
    if (input.body !== undefined) issue.body = input.body;
    if (input.state !== undefined) issue.state = input.state;
    if (input.stateReason !== undefined) issue.stateReason = input.stateReason;
    issue.updatedAt = new Date().toISOString();
    return issue;
  }

  // ── Pull requests ──

  async updatePullRequest(pull: ThreadRef, input: UpdatePullRequestInput): Promise<PullRequest> {
    this.record('updatePullRequest', pull, input);
    const pr = this.pulls.get(key(pull.repo, pull.number));
    if (!pr) throw new Error(`no such pull request: ${key(pull.repo, pull.number)}`);
    if (input.title !== undefined) pr.title = input.title;
    if (input.body !== undefined) pr.body = input.body;
    if (input.base !== undefined) pr.base = { ...pr.base, ref: input.base };
    if (input.draft !== undefined) pr.draft = input.draft;
    pr.updatedAt = new Date().toISOString();
    return pr;
  }

  async requestReviewers(pull: ThreadRef, logins: string[]): Promise<void> {
    this.record('requestReviewers', pull, logins);
    const pr = this.pulls.get(key(pull.repo, pull.number));
    if (!pr) throw new Error(`no such pull request: ${key(pull.repo, pull.number)}`);
    for (const login of logins) {
      if (!pr.requestedReviewers.includes(login)) pr.requestedReviewers.push(login);
    }
  }

  async createPullRequest(repo: RepoRef, input: CreatePullRequestInput): Promise<PullRequest> {
    this.record('createPullRequest', repo, input);
    return this.seedPullRequest({
      repo,
      title: input.title,
      body: input.body ?? '',
      draft: input.draft ?? false,
      head: { ref: input.head, sha: 'head'.padEnd(40, '0') },
      base: { ref: input.base, sha: 'base'.padEnd(40, '0') },
      author: { login: this.bot.login, isBot: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  // ── Polling fallback (amendment 1) and identity ──

  private inRepo(repo: RepoRef, threadKey: string): boolean {
    return threadKey.startsWith(`${repoSlug(repo)}#`);
  }

  async listIssuesSince(repo: RepoRef, since: string): Promise<PollRead<PolledIssue>> {
    this.record('listIssuesSince', repo, since);
    const rows: PolledIssue[] = [];
    for (const [k, i] of this.issues) {
      if (!this.inRepo(repo, k) || i.updatedAt <= since) continue;
      // The fake has no separate issue id: the number stands in for it.
      const closedBy = this.closedBy.get(i.number);
      rows.push({ id: i.number, number: i.number, isPullRequest: false, title: i.title, body: i.body, state: i.state, author: i.author, createdAt: i.createdAt, updatedAt: i.updatedAt, html_url: i.html_url, ...(closedBy ? { closedBy } : {}) });
    }
    for (const [k, p] of this.pulls) {
      if (!this.inRepo(repo, k) || p.updatedAt <= since) continue;
      rows.push({ id: p.number, number: p.number, isPullRequest: true, title: p.title, body: p.body, state: p.state, author: p.author, createdAt: p.createdAt, updatedAt: p.updatedAt, html_url: p.html_url, headSha: p.head.sha });
    }
    return { rows: rows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)) };
  }

  async listIssueCommentsSince(repo: RepoRef, since: string): Promise<PollRead<PolledComment>> {
    this.record('listIssueCommentsSince', repo, since);
    const rows: PolledComment[] = [];
    for (const [k, list] of this.comments) {
      if (!this.inRepo(repo, k)) continue;
      const number = Number(k.slice(k.indexOf('#') + 1));
      for (const c of list) {
        if (c.updatedAt > since) rows.push({ id: c.id, number, author: c.author, body: c.body, updatedAt: c.updatedAt, html_url: c.html_url });
      }
    }
    return { rows: rows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)) };
  }

  async listReviewCommentsSince(repo: RepoRef, since: string): Promise<PollRead<PolledComment>> {
    this.record('listReviewCommentsSince', repo, since);
    const rows: PolledComment[] = [];
    for (const [k, threads] of this.reviewThreads) {
      if (!this.inRepo(repo, k)) continue;
      const number = Number(k.slice(k.indexOf('#') + 1));
      for (const t of threads) {
        for (const c of t.comments) {
          const updatedAt = c.updatedAt ?? c.createdAt;
          if (updatedAt > since) {
            rows.push({ id: c.id, number, author: c.author, body: c.body, updatedAt, html_url: `https://github.com/${repoSlug(repo)}/pull/${number}#discussion_r${c.id}`, path: t.path, inReplyTo: c.inReplyTo });
          }
        }
      }
    }
    return { rows: rows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)) };
  }

  async getAuthenticatedBot(): Promise<BotIdentity> {
    this.record('getAuthenticatedBot');
    return this.bot;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake MCPL host
// ─────────────────────────────────────────────────────────────────────────────

/** The full capability set github-mcpl's manifest declares (§6.2 paths). */
export const FULL_GRANT = [
  'tools',
  'channels.register',
  'channels.lifecycle',
  'channels.publish',
  'channels.incoming',
  'pushEvents',
  'channels.typing',
];

export interface HarnessOptions extends GitHubServerOptions {
  /** A pre-seeded fake, when the test wants to set one up first. */
  api?: FakeGitHubApi;
  /** What the host answers to push/event (default true). */
  pushAccepted?: boolean;
  /**
   * Register the five tool modules, as `src/index.ts` does. Default true; a
   * test that wants the bare server (the .1 smoke test) passes false.
   */
  tools?: boolean;
  /**
   * Hold the *answer* to a request the server sent, so a test can act inside
   * the window the server is awaiting one — which is where a grant that
   * narrows mid-flight has to be seen (WP9 review round 2, finding 1). Return
   * a promise for the requests to hold and undefined for every other; the
   * answer goes out when the promise settles. The request itself is recorded
   * in {@link Harness.hostSaw}, and checked against the grant, the moment it
   * arrives — that is when the server sent it.
   */
  hold?: (req: JsonRpcRequest) => Promise<void> | undefined;
}

export interface Harness {
  server: GitHubMcplServer;
  api: FakeGitHubApi;
  host: McplConnection;
  /** Every request the server sent the host, in order. */
  hostSaw: JsonRpcRequest[];
  /**
   * Every request the server made on a capability the grant did not carry.
   * Empty is the only acceptable value: this host refuses them as a real one
   * would (§5.4), so an entry here is a conformance failure.
   */
  ungranted: { method: string; capability: string }[];
  served: Promise<void>;
  close(): Promise<void>;
}

export function harness(opts: HarnessOptions = {}): Harness {
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const serverConn = McplConnection.fromStreams(toServer, toHost);
  const host = McplConnection.fromStreams(toHost, toServer);

  const api = opts.api ?? new FakeGitHubApi();
  const server = new GitHubMcplServer(api, {
    botLogin: opts.botLogin ?? TEST_BOT.login,
    repos: opts.repos ?? [TEST_REPO],
    maintainers: opts.maintainers,
    prBaseAllow: opts.prBaseAllow,
    state: opts.state,
    logger: opts.logger,
  });
  if (opts.tools !== false) {
    // The same five src/index.ts registers; github.events carries no tools.
    server.register(readToolModule);
    server.register(commentsToolModule);
    server.register(reviewToolModule);
    server.register(issuesToolModule);
    server.register(prToolModule);
  }

  const hostSaw: JsonRpcRequest[] = [];
  const ungranted: { method: string; capability: string }[] = [];

  /**
   * A conforming host rejects a call on a capability it did not grant (§5.4),
   * and this fake used to accept registration blindly — which is what let the
   * `channels/open` path exercise an ungranted `channels.register` without a
   * single test noticing (WP9 review, finding 2). Every inbound method is
   * checked against the grant the server is actually holding: a violation is
   * recorded in {@link Harness.ungranted} *and* answered with -32002, so a
   * regression is visible both as a refused call and as a named entry.
   */
  const CAPABILITY_OF: Record<string, string> = {
    [method.CHANNELS_REGISTER]: 'channels.register',
    [method.CHANNELS_CHANGED]: 'channels.register',
    [method.CHANNELS_INCOMING]: 'channels.incoming',
    [method.PUSH_EVENT]: 'pushEvents',
  };

  host.on('request', (req) => {
    hostSaw.push(req);
    const needs = CAPABILITY_OF[req.method];
    if (needs && !server.grant.has(needs)) {
      ungranted.push({ method: req.method, capability: needs });
      host.sendError(req.id, -32002, `Capability denied: ${needs} was not granted`, { capability: needs });
      return;
    }
    const held = opts.hold?.(req);
    if (held) void held.then(() => answer(req));
    else answer(req);
  });

  function answer(req: JsonRpcRequest): void {
    switch (req.method) {
      case method.CHANNELS_REGISTER:
      case method.CHANNELS_CHANGED: {
        const p = req.params as { channels?: { id: string }[]; updated?: { id: string }[] };
        const channels = p.channels ?? p.updated ?? [];
        host.sendResponse(req.id, { results: channels.map((c) => ({ id: c.id, accepted: true })) });
        break;
      }
      case method.CHANNELS_INCOMING: {
        const p = req.params as { messages: { messageId: string }[] };
        host.sendResponse(req.id, { results: p.messages.map((m) => ({ messageId: m.messageId, accepted: true })) });
        break;
      }
      case method.PUSH_EVENT:
        host.sendResponse(req.id, { accepted: opts.pushAccepted ?? true });
        break;
      default:
        host.sendError(req.id, -32601, `unexpected ${req.method}`);
    }
  }

  const served = server.serve(serverConn);
  return {
    server,
    api,
    host,
    hostSaw,
    ungranted,
    served,
    async close() {
      toServer.end();
      await served;
      host.close();
    },
  };
}

/** Send `initialize`, as a host does; `mcpl` picks MCPL or plain-MCP mode. */
export async function initialize(h: Harness, mcpl: boolean) {
  const result = (await h.host.sendRequest(method.INITIALIZE, {
    protocolVersion: '2024-11-05',
    capabilities: mcpl ? { experimental: { mcpl: { version: '0.5' } } } : {},
    clientInfo: { name: 'test-host', version: '0' },
  })) as { capabilities: Record<string, unknown> };
  h.host.sendNotification('notifications/initialized');
  return result;
}

/**
 * Hand the server a grant, the §6.7 Request form, and return the degradation
 * receipt. `capabilities` absent means {@link FULL_GRANT}; `[]` is the empty
 * allowlist, which denies everything (§5.4).
 */
export async function grant(
  h: Harness,
  capabilities: readonly string[] = FULL_GRANT,
  extra: Omit<FeatureSetsUpdateParams, 'effectiveCapabilities'> = {},
): Promise<DegradationReceipt> {
  return (await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {
    ...extra,
    effectiveCapabilities: [...capabilities],
  })) as DegradationReceipt;
}

/** `tools/call`, as a host makes it. */
export async function callTool(h: Harness, name: string, args: Record<string, unknown> = {}) {
  return (await h.host.sendRequest('tools/call', { name, arguments: args })) as ToolResult;
}

/** The text of a tool result or a channel message, joined. */
export function textOf(result: { content: ContentBlock[] }): string {
  return result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Every `push/event` the host was sent, in order. */
export function pushes(h: Harness): PushEventParams[] {
  return h.hostSaw.filter((r) => r.method === method.PUSH_EVENT).map((r) => r.params as PushEventParams);
}

/** Every `channels/incoming` message the host was sent, in order. */
export function incoming(h: Harness): ChannelsIncomingParams['messages'] {
  return h.hostSaw
    .filter((r) => r.method === method.CHANNELS_INCOMING)
    .flatMap((r) => (r.params as ChannelsIncomingParams).messages);
}

/** Poll until `predicate` holds — registration and delivery are real async work. */
export async function until(predicate: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
