/**
 * Shared contract for github-mcpl (TASK-SRHKG.1, section Contract).
 *
 * Every other module in the map reads this file and none of them edits it, so
 * the work packages .2 to .8 can be built in parallel against one import
 * surface. The ordering below follows the contract's own bullets:
 *
 *   1. Repository refs and thread refs
 *   2. Normalized events (the ingress → pipeline currency)
 *   3. The GitHubApi seam and its payload types
 *   4. Tool modules, definitions, results, context
 *   5. Feature-set and tool name constants
 *   6. Channel ids, thread ids, bounds
 *   7. Tags and metadata
 *   8. State (checkpoint lineage, rollback bookkeeping)
 *   9. Environment (readConfig) and the stderr Logger
 *
 * Decisions taken where the contract left a type under-specified are recorded
 * in docs/contract-notes.md.
 */

import { readFileSync, statSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/mcpl-core';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Repositories and threads
// ─────────────────────────────────────────────────────────────────────────────

/** A repository in the allow-list, e.g. `{ owner: 'anima-research', name: 'rayforce' }`. */
export interface RepoRef {
  owner: string;
  name: string;
}

/** `owner/name`, the form GITHUB_REPOS uses and the form diagnostics print. */
export function repoSlug(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

/** An ISO 8601 instant in UTC as GitHub and this server write them, `2026-10-15T00:09:30Z`, with or without fractional seconds. */
export function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Parse `owner/name`. Returns null for anything else (no guessing). */
export function parseRepoSlug(slug: string): RepoRef | null {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(slug.trim());
  return m ? { owner: m[1], name: m[2] } : null;
}

export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return a.owner === b.owner && a.name === b.name;
}

/** Is `repo` inside the GITHUB_REPOS allow-list? Every write tool asks this. */
export function repoAllowed(repo: RepoRef, allowList: readonly RepoRef[]): boolean {
  return allowList.some((r) => sameRepo(r, repo));
}

/** An issue or a pull request: the thing a channel maps to. */
export interface ThreadRef {
  repo: RepoRef;
  number: number;
  kind: ThreadKind;
}

export type ThreadKind = 'issue' | 'pull';

// ─────────────────────────────────────────────────────────────────────────────
// 2. Normalized events
// ─────────────────────────────────────────────────────────────────────────────

/** Every event kind the ingress (.3) produces; nothing else reaches the pipeline. */
export type NormalizedEventKind =
  | 'issue.opened'
  | 'issue.edited'
  | 'issue.closed'
  | 'issue.reopened'
  | 'comment.created'
  | 'comment.edited'
  | 'comment.deleted'
  | 'pull.opened'
  | 'pull.synchronize'
  | 'pull.ready_for_review'
  | 'pull.review_requested'
  | 'pull.closed'
  | 'review.submitted'
  | 'review_comment.created'
  | 'review_comment.edited'
  | 'checks.completed'
  | 'push'
  | 'thread.read_failed';

export const NORMALIZED_EVENT_KINDS: readonly NormalizedEventKind[] = [
  'issue.opened',
  'issue.edited',
  'issue.closed',
  'issue.reopened',
  'comment.created',
  'comment.edited',
  'comment.deleted',
  'pull.opened',
  'pull.synchronize',
  'pull.ready_for_review',
  'pull.review_requested',
  'pull.closed',
  'review.submitted',
  'review_comment.created',
  'review_comment.edited',
  'checks.completed',
  'push',
  'thread.read_failed',
] as const;

export type ReviewState = 'approved' | 'changes_requested' | 'commented';

/** Which side of the diff a review comment hangs on. */
export type DiffSide = 'LEFT' | 'RIGHT';

export interface EventActor {
  login: string;
  isBot: boolean;
}

/** One failed check run, as the checks event and `renderChecks` report it. */
export interface FailedCheck {
  name: string;
  url: string;
}

export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'skipped'
  | 'stale';

/**
 * A webhook delivery or a polled row, normalized. `raw` is the original
 * payload and is never forwarded to the model: tags.ts and content.ts read
 * only the named fields.
 */
export interface NormalizedEvent {
  /** Webhook delivery id, or `poll:<kind>:<id>:<updated_at>` for a poll (amendment 1). */
  id: string;
  receivedAt: string;
  repo: RepoRef;
  kind: NormalizedEventKind;
  thread?: ThreadRef;
  actor: EventActor;
  body?: string;
  title?: string;
  html_url: string;
  sha?: string;
  review?: { id: number; state: ReviewState };
  /**
   * A **top-level** issue or pull-request comment's own id (amendment 2b).
   * Absent on everything that is not a comment, and absent on a review
   * comment, whose id lives in {@link NormalizedEvent.reviewComment} — the two
   * endpoints number their comments separately and the ids must not be mixed.
   */
  comment?: { id: number };
  reviewComment?: {
    id: number;
    path: string;
    line: number | null;
    side: DiffSide;
    diffHunk: string;
    inReplyTo?: number;
  };
  checks?: { conclusion: CheckConclusion | null; failed: FailedCheck[] };
  /** Never forwarded to the model, never copied into metadata. */
  raw?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The GitHubApi seam
// ─────────────────────────────────────────────────────────────────────────────

export interface Issue {
  number: number;
  kind: 'issue';
  repo: RepoRef;
  title: string;
  body: string;
  state: IssueState;
  stateReason: IssueStateReason | null;
  author: EventActor;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  html_url: string;
}

export type IssueState = 'open' | 'closed';
export type IssueStateReason = 'completed' | 'not_planned' | 'reopened';

/** A branch end of a pull request. */
export interface GitRef {
  /** Branch name, e.g. `dev`. */
  ref: string;
  sha: string;
}

/** The rolled-up state of the check runs on one sha. */
export interface ChecksSummary {
  sha: string;
  conclusion: CheckConclusion | null;
  total: number;
  failed: FailedCheck[];
  /** Present and true when a run is still going or wasn't read, so a failure isn't yet the sha's last word. */
  unfinished?: boolean;
}

export interface PullRequest {
  number: number;
  kind: 'pull';
  repo: RepoRef;
  title: string;
  body: string;
  state: IssueState;
  draft: boolean;
  merged: boolean;
  /** GitHub reports `null` while it is still computing mergeability. */
  mergeable: boolean | null;
  head: GitRef;
  base: GitRef;
  author: EventActor;
  requestedReviewers: string[];
  createdAt: string;
  updatedAt: string;
  html_url: string;
  checksSummary: ChecksSummary | null;
}

/** An issue comment, a PR comment, or a review comment. */
export interface Comment {
  id: number;
  author: EventActor;
  body: string;
  createdAt: string;
  updatedAt: string;
  html_url: string;
  /** Review comments only: the file they hang on. */
  path?: string;
  line?: number | null;
  side?: DiffSide;
  /** Review comments only: the comment this one replies to. */
  inReplyTo?: number;
}

export interface ReviewThreadComment {
  id: number;
  author: EventActor;
  body: string;
  createdAt: string;
  /** Set once the comment was edited; polling (amendment 1) uses it over createdAt. */
  updatedAt?: string;
  inReplyTo?: number;
}

/**
 * A review conversation on a line of a diff. `id` is the GraphQL node id that
 * resolveReviewThread/unresolveReviewThread take; the channel-facing thread id
 * is `rt:<comments[0].id>` (see {@link reviewThreadId}).
 */
export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  side: DiffSide;
  isResolved: boolean;
  comments: ReviewThreadComment[];
}

/** Names and stats only — no patch text ever reaches the model. */
export interface PullRequestFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
}

/** One hit of `search_issues`, bounded to what the result renders. */
export interface IssueSearchHit {
  number: number;
  kind: ThreadKind;
  title: string;
  state: IssueState;
  updatedAt: string;
  html_url: string;
}

/** A search inside one repository: its hits, and how many results GitHub gave from other repositories, left out. */
export interface IssueSearch {
  hits: IssueSearchHit[];
  outside: number;
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface ReviewCommentInput {
  path: string;
  line: number;
  side: DiffSide;
  body: string;
}

export interface CreateReviewInput {
  event: ReviewEvent;
  body?: string;
  comments?: ReviewCommentInput[];
}

export interface SubmittedReview {
  id: number;
  state: ReviewState;
  html_url: string;
}

export interface CreateIssueInput {
  title: string;
  body?: string;
}

export interface UpdateIssueInput {
  title?: string;
  body?: string;
  state?: IssueState;
  stateReason?: IssueStateReason;
}

export interface UpdatePullRequestInput {
  title?: string;
  body?: string;
  /** Must be in GITHUB_PR_BASE_ALLOW; the tool checks before the call. */
  base?: string;
  draft?: boolean;
}

export interface CreatePullRequestInput {
  head: string;
  /** Must be in GITHUB_PR_BASE_ALLOW; the tool checks before the call. */
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}

/**
 * Polling fallback (contract amendment 1). An App installation token cannot
 * read `GET /notifications`, so the poller asks the repository what changed
 * since its cursor: issues and pull requests, issue comments, review comments.
 * Each row is one `poll:<kind>:<id>:<updated_at>` event candidate.
 */
export interface PolledIssue {
  /** GitHub's issue id (not the number). */
  id: number;
  number: number;
  isPullRequest: boolean;
  title: string;
  body: string;
  state: IssueState;
  author: EventActor;
  /**
   * When the row was opened (amendment 2a). A `since` query says only *that* a
   * row changed; comparing this against the start of its list's window
   * (`PollCursor.since`), for a row not yet announced as new, is what tells
   * an opened issue from an edited one.
   */
  createdAt: string;
  updatedAt: string;
  html_url: string;
  /** Pull requests only: the head sha the poller checks runs for. */
  headSha?: string;
  /**
   * Who closed it, from the issues list's `closed_by`. A closed row's actor is
   * this, not the author: the bot's own close must come back as from-self.
   */
  closedBy?: EventActor;
  /**
   * When it was last closed, from `closed_at`. Contributor mode's
   * notifications poller reads it for a thread it has no marker for: a close
   * before that thread's first read starts (five minutes before GitHub's
   * previous answer to a listing, or, at a first start, five minutes before
   * W) is old news, one after it is an event.
   */
  closedAt?: string;
  /**
   * Pull requests only: whether it was merged, from the row's
   * `pull_request.merged_at`. Absent when the row doesn't say.
   */
  merged?: boolean;
}

/**
 * One submitted review, newer than the cursor it was fetched with (contributor
 * mode's notifications poller: `GET pulls/{n}/reviews`, filtered client-side
 * by `submitted_at` — the endpoint takes no `since`).
 */
export interface PolledReview {
  id: number;
  author: EventActor;
  body: string;
  state: ReviewState;
  submittedAt: string;
  html_url: string;
  /** The commit the review was written against, when GitHub reports one. */
  commitId?: string;
}

/** One issue comment or review comment updated since its list's cursor. */
export interface PolledComment {
  id: number;
  /** The issue or pull request the comment belongs to. */
  number: number;
  author: EventActor;
  body: string;
  updatedAt: string;
  html_url: string;
  /** Review comments only. */
  path?: string;
  inReplyTo?: number;
}

/** One read of a poll list: its rows, and where a read the page bound stopped. */
export interface PollRead<T> {
  rows: T[];
  /**
   * Set when the read stopped before the end of the list: the `updated_at`
   * second it stopped in. The rows of that second and later were left for
   * the next read, which asks from here.
   */
  resumeAt?: string;
}

/**
 * Where one poll list (a repository's issues, its issue comments or its
 * review comments) reads from, keyed `<owner>/<name>:<list>`.
 */
export interface PollCursor {
  /**
   * The start of the window this list has not finished: the start of the
   * last pass that read it to the end with every delivery accepted, in whole
   * seconds. A row created at or after it is new (amendment 2a), unless
   * `pollNew` says it was announced as new already.
   */
  since: string;
  /**
   * Set while a read the page bound stopped is being caught up: the second
   * it stopped in, which the next read asks from instead of `since`.
   */
  resumeAt?: string;
}

export interface BotIdentity {
  login: string;
  id: number;
  /**
   * True for a GitHub App's own identity (`GET /app`). Contributor mode's
   * `getAuthenticatedBot` answers from `GET /user` instead — a human account,
   * even though it is the one the server writes as — so this is `false` there.
   */
  isBot: boolean;
}

/**
 * The seam every test fakes (test/harness.ts `FakeGitHubApi`). .2 implements it
 * over octokit; nothing else in the package touches octokit.
 */
export interface GitHubApi {
  // ── Reads ──
  getIssue(ref: ThreadRef): Promise<Issue>;
  getPullRequest(ref: ThreadRef): Promise<PullRequest>;
  listComments(thread: ThreadRef, since?: string): Promise<Comment[]>;
  listReviewThreads(pull: ThreadRef): Promise<ReviewThread[]>;
  listPullRequestFiles(pull: ThreadRef): Promise<PullRequestFile[]>;
  getCheckRuns(repo: RepoRef, sha: string): Promise<ChecksSummary>;
  searchIssues(repo: RepoRef, query: string, limit?: number): Promise<IssueSearch>;

  // ── Comments ──
  createComment(thread: ThreadRef, body: string): Promise<Comment>;
  /** `review` selects the REST path: `pulls/comments/{id}` instead of `issues/comments/{id}`. */
  updateComment(repo: RepoRef, commentId: number, body: string, review?: boolean): Promise<Comment>;
  deleteComment(repo: RepoRef, commentId: number, review?: boolean): Promise<void>;
  replyToReviewComment(pull: ThreadRef, inReplyTo: number, body: string): Promise<Comment>;

  // ── Review ──
  createReview(pull: ThreadRef, input: CreateReviewInput): Promise<SubmittedReview>;
  resolveReviewThread(reviewThreadId: string): Promise<void>;
  unresolveReviewThread(reviewThreadId: string): Promise<void>;

  // ── Issues ──
  createIssue(repo: RepoRef, input: CreateIssueInput): Promise<Issue>;
  updateIssue(ref: ThreadRef, input: UpdateIssueInput): Promise<Issue>;

  // ── Pull requests ──
  updatePullRequest(pull: ThreadRef, input: UpdatePullRequestInput): Promise<PullRequest>;
  requestReviewers(pull: ThreadRef, logins: string[]): Promise<void>;
  createPullRequest(repo: RepoRef, input: CreatePullRequestInput): Promise<PullRequest>;

  // ── Polling fallback (amendment 1) and identity ──
  /** `GET /repos/{o}/{r}/issues?state=all&sort=updated&since=`: issues and PRs. */
  listIssuesSince(repo: RepoRef, since: string): Promise<PollRead<PolledIssue>>;
  /** `GET /repos/{o}/{r}/issues/comments?sort=updated&since=`. */
  listIssueCommentsSince(repo: RepoRef, since: string): Promise<PollRead<PolledComment>>;
  /** `GET /repos/{o}/{r}/pulls/comments?sort=updated&since=`. */
  listReviewCommentsSince(repo: RepoRef, since: string): Promise<PollRead<PolledComment>>;
  getAuthenticatedBot(): Promise<BotIdentity>;
}

/** Every method name of {@link GitHubApi} — the list the harness checks itself against. */
export const GITHUB_API_METHODS = [
  'getIssue',
  'getPullRequest',
  'listComments',
  'listReviewThreads',
  'listPullRequestFiles',
  'getCheckRuns',
  'searchIssues',
  'createComment',
  'updateComment',
  'deleteComment',
  'replyToReviewComment',
  'createReview',
  'resolveReviewThread',
  'unresolveReviewThread',
  'createIssue',
  'updateIssue',
  'updatePullRequest',
  'requestReviewers',
  'createPullRequest',
  'listIssuesSince',
  'listIssueCommentsSince',
  'listReviewCommentsSince',
  'getAuthenticatedBot',
] as const satisfies readonly (keyof GitHubApi)[];

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tool modules
// ─────────────────────────────────────────────────────────────────────────────

/** An MCP tool, as `tools/list` presents it. Same shape as slack-mcpl's. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** A tool answer: text blocks rendered by content.ts, bounded by {@link LIMITS}. */
export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  /**
   * §8.2's checkpoint lineage, set by the server after a rollback-capable
   * call rather than by the tool: `{ checkpoint, parent }`. A tool module
   * never fills it in — .9 adds it to the result of a `github.comments` call,
   * which is the only rollback-capable feature set.
   */
  state?: { checkpoint: string; parent: string | null };
}

/** What a tool call may reach. Nothing here is global state. */
export interface ToolContext {
  api: GitHubApi;
  state: StateStore;
  /** GITHUB_BOT_LOGIN — from-self and own-comment checks. */
  botLogin: string;
  /** GITHUB_REPOS; a write outside it is refused by name. */
  repos: readonly RepoRef[];
  /** GITHUB_PR_BASE_ALLOW entries, as written; {@link allowedBases} resolves them per repository. */
  prBaseAllow: readonly string[];
  logger: Logger;
}

/** One feature set's tools and their dispatch. .6 and .7 each export these. */
export interface ToolModule {
  featureSet: string;
  tools: ToolDefinition[];
  call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Feature-set and tool names
// ─────────────────────────────────────────────────────────────────────────────

export const EVENTS_FEATURE_SET = 'github.events';
export const READ_FEATURE_SET = 'github.read';
export const COMMENTS_FEATURE_SET = 'github.comments';
export const REVIEW_FEATURE_SET = 'github.review';
export const ISSUES_FEATURE_SET = 'github.issues';
export const PR_FEATURE_SET = 'github.pr';

export const FEATURE_SETS = [
  EVENTS_FEATURE_SET,
  READ_FEATURE_SET,
  COMMENTS_FEATURE_SET,
  REVIEW_FEATURE_SET,
  ISSUES_FEATURE_SET,
  PR_FEATURE_SET,
] as const;

export type FeatureSetName = (typeof FEATURE_SETS)[number];

/** github.read */
export const TOOL_GET_ISSUE = 'get_issue';
export const TOOL_GET_PULL_REQUEST = 'get_pull_request';
export const TOOL_LIST_COMMENTS = 'list_comments';
export const TOOL_LIST_REVIEW_THREADS = 'list_review_threads';
export const TOOL_LIST_PULL_REQUEST_FILES = 'list_pull_request_files';
export const TOOL_GET_CHECK_RUNS = 'get_check_runs';
export const TOOL_SEARCH_ISSUES = 'search_issues';

/** github.comments */
export const TOOL_COMMENT = 'comment';
export const TOOL_REPLY_IN_THREAD = 'reply_in_thread';
export const TOOL_EDIT_OWN_COMMENT = 'edit_own_comment';
export const TOOL_DELETE_OWN_COMMENT = 'delete_own_comment';
export const TOOL_UPSERT_STICKY_COMMENT = 'upsert_sticky_comment';

/** github.review */
export const TOOL_CREATE_REVIEW = 'create_review';
export const TOOL_RESOLVE_THREAD = 'resolve_thread';
export const TOOL_UNRESOLVE_THREAD = 'unresolve_thread';

/** github.issues */
export const TOOL_CREATE_ISSUE = 'create_issue';
export const TOOL_EDIT_ISSUE = 'edit_issue';
export const TOOL_CLOSE_ISSUE = 'close_issue';
export const TOOL_REOPEN_ISSUE = 'reopen_issue';

/** github.pr */
export const TOOL_CREATE_PULL_REQUEST = 'create_pull_request';
export const TOOL_EDIT_PULL_REQUEST = 'edit_pull_request';
export const TOOL_REQUEST_REVIEW = 'request_review';

/**
 * Which feature set owns which tool. The server (.9) routes a `tools/call` by
 * this map and refuses a tool whose feature set is not active.
 */
export const TOOLS_BY_FEATURE_SET: Record<Exclude<FeatureSetName, 'github.events'>, readonly string[]> = {
  [READ_FEATURE_SET]: [
    TOOL_GET_ISSUE,
    TOOL_GET_PULL_REQUEST,
    TOOL_LIST_COMMENTS,
    TOOL_LIST_REVIEW_THREADS,
    TOOL_LIST_PULL_REQUEST_FILES,
    TOOL_GET_CHECK_RUNS,
    TOOL_SEARCH_ISSUES,
  ],
  [COMMENTS_FEATURE_SET]: [
    TOOL_COMMENT,
    TOOL_REPLY_IN_THREAD,
    TOOL_EDIT_OWN_COMMENT,
    TOOL_DELETE_OWN_COMMENT,
    TOOL_UPSERT_STICKY_COMMENT,
  ],
  [REVIEW_FEATURE_SET]: [TOOL_CREATE_REVIEW, TOOL_RESOLVE_THREAD, TOOL_UNRESOLVE_THREAD],
  [ISSUES_FEATURE_SET]: [TOOL_CREATE_ISSUE, TOOL_EDIT_ISSUE, TOOL_CLOSE_ISSUE, TOOL_REOPEN_ISSUE],
  [PR_FEATURE_SET]: [TOOL_CREATE_PULL_REQUEST, TOOL_EDIT_PULL_REQUEST, TOOL_REQUEST_REVIEW],
};

/** Which feature sets can undo what they did since a checkpoint (§8.1). */
export const ROLLBACK_CAPABLE: readonly string[] = [COMMENTS_FEATURE_SET];

/** The feature set that owns `toolName`, or undefined for an unknown tool. */
export function featureSetForTool(toolName: string): string | undefined {
  for (const [featureSet, tools] of Object.entries(TOOLS_BY_FEATURE_SET)) {
    if (tools.includes(toolName)) return featureSet;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Channel ids, thread ids, bounds
// ─────────────────────────────────────────────────────────────────────────────

export const CHANNEL_TYPE = 'github';

/** Bounds the contract puts on everything that reaches the model. */
export const LIMITS = {
  /** A rendered comment body. */
  commentChars: 4000,
  /** Entries in a rendered list (comments, files, search hits, threads). */
  listEntries: 50,
  /** A channel label's title part, and every bounded title field. */
  titleChars: 80,
} as const;

/**
 * Truncate so that the result, notice included, is at most `max` chars, naming
 * what was dropped (never silently).
 */
export function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  // The notice counts against `max` and its length depends on the digit count
  // of the dropped total, so settle it in a few passes; the final `keep` is
  // computed from the suffix actually appended, which keeps the bound exact.
  let suffix = '';
  let keep = max;
  for (let i = 0; i < 3; i++) {
    suffix = `… [truncated ${text.length - keep} chars]`;
    keep = Math.max(0, max - suffix.length);
  }
  return `${text.slice(0, keep)}${suffix}`;
}

/** `github:<owner>/<name>#<number>`. */
export function channelId(thread: ThreadRef): string {
  return `${CHANNEL_TYPE}:${repoSlug(thread.repo)}#${thread.number}`;
}

/**
 * The repo and number of a channel id. `kind` is deliberately absent: the id
 * does not carry it (an issue and a PR share one number space per repo), so
 * the channel registry (.5) holds it. Returns null for a foreign id.
 */
export interface ParsedChannelId {
  repo: RepoRef;
  number: number;
}

export function parseChannelId(id: string): ParsedChannelId | null {
  const m = /^github:([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(id);
  if (!m) return null;
  return { repo: { owner: m[1], name: m[2] }, number: Number(m[3]) };
}

/** `"<owner>/<name>#<number>: <title>"`, the title bounded to 80 chars. */
export function channelLabel(thread: ThreadRef, title: string): string {
  return `${repoSlug(thread.repo)}#${thread.number}: ${bounded(title, LIMITS.titleChars)}`;
}

/** The address of a github channel descriptor. */
export interface ChannelAddress {
  owner: string;
  name: string;
  number: number;
  kind: ThreadKind;
}

export function channelAddress(thread: ThreadRef): ChannelAddress {
  return { owner: thread.repo.owner, name: thread.repo.name, number: thread.number, kind: thread.kind };
}

/** A review conversation: `rt:<root review comment id>`. */
export function reviewThreadId(rootCommentId: number): string {
  return `rt:${rootCommentId}`;
}

/** A review summary: `review:<review id>`. */
export function reviewSummaryThreadId(reviewId: number): string {
  return `review:${reviewId}`;
}

/**
 * What a channel-level `threadId` names. A top-level comment carries no
 * threadId at all, so `undefined` in and `null` out means exactly that.
 */
export type ParsedThreadId =
  | { kind: 'review-thread'; rootCommentId: number }
  | { kind: 'review-summary'; reviewId: number };

export function parseThreadId(threadId: string | undefined): ParsedThreadId | null {
  if (!threadId) return null;
  const rt = /^rt:(\d+)$/.exec(threadId);
  if (rt) return { kind: 'review-thread', rootCommentId: Number(rt[1]) };
  const review = /^review:(\d+)$/.exec(threadId);
  if (review) return { kind: 'review-summary', reviewId: Number(review[1]) };
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Tags and metadata (RFC-001 core plus the `github:` namespace)
// ─────────────────────────────────────────────────────────────────────────────

/** The producer name on every tag set this server emits. */
export const TAG_PRODUCER = 'github';

/** RFC-001 core tags github-mcpl emits. */
export const CORE_TAGS = [
  'chat:mention',
  'chat:reply',
  'chat:ambient',
  'chat:from-human',
  'chat:from-bot',
  'chat:from-self',
  'chat:thread',
  'chat:edited',
  'chat:deleted',
  'chat:has-link',
] as const;

/** The `github:` namespace, every value enumerated. */
export const GITHUB_TAGS = [
  'github:issue=opened',
  'github:issue=edited',
  'github:issue=closed',
  'github:issue=reopened',
  'github:pr=opened',
  'github:pr=synchronize',
  'github:pr=ready_for_review',
  'github:pr=review_requested',
  'github:pr=closed',
  'github:pr=merged',
  'github:review=approved',
  'github:review=changes_requested',
  'github:review=commented',
  'github:review-comment',
  'github:ci=success',
  'github:ci=failure',
  'github:push',
  'github:read-failed',
  'github:actor=maintainer',
] as const;

/**
 * Metadata for the host's `metadataTrue` matchers. Booleans first, then the
 * bounded scalar fields. Raw payloads never reach here.
 */
export interface EventMetadata {
  mentioned: boolean;
  isOwnThread: boolean;
  isReplyToSelf: boolean;
  isReviewRequested: boolean;
  isCiFailure: boolean;
  fromSelf: boolean;
  isMaintainer: boolean;
  /** `owner/name`. */
  repo: string;
  number: number | null;
  kind: ThreadKind | null;
  actor: string;
  sha: string | null;
  htmlUrl: string;
}

/** What `tagsFor(event, ctx)` (.4) returns. */
export interface TagResult {
  tags: string[];
  metadata: EventMetadata;
}

/** What tags.ts needs to know about this deployment to classify an event. */
export interface TagContext {
  botLogin: string;
  maintainers: readonly string[];
  /** True when the bot authored the thread or has commented in it (.5 knows). */
  isOwnThread?: boolean;
  /** True when the event replies to a comment the bot wrote. */
  isReplyToSelf?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. State (checkpoint lineage and rollback bookkeeping)
// ─────────────────────────────────────────────────────────────────────────────

export interface CheckpointRecord {
  id: string;
  parent: string | null;
  createdAt: string;
}

/** A comment this server created after a checkpoint — rollback deletes it. */
export interface CreatedComment {
  repo: string;
  commentId: number;
  /** Review-comment deletes use a different REST path than issue comments. */
  review: boolean;
}

/** A comment this server edited after a checkpoint — rollback restores `previousBody`. */
export interface EditedComment {
  repo: string;
  commentId: number;
  previousBody: string;
  review: boolean;
}

/**
 * A comment this server deleted after a checkpoint. GitHub has no undelete, so
 * rollback can only report it; `previousBody` is kept so the receipt can say
 * what was lost without asking GitHub for a comment that is gone.
 */
export interface DeletedComment {
  repo: string;
  commentId: number;
  previousBody: string;
  review: boolean;
}

/**
 * Whether a checkpoint can still be rolled back to (§8.7).
 *
 *   - `live` — it is `current` or one of its ancestors;
 *   - `abandoned` — an earlier rollback moved `current` off its branch, so its
 *     undo records are spent and the state it named cannot be reconstructed;
 *   - `unknown` — no such checkpoint.
 *
 * Both of the latter are §8.7's "pruned or unknown" and answer `-32005`.
 */
export type CheckpointStatus = 'live' | 'abandoned' | 'unknown';

/** What rollback has to undo, newest first. */
export interface RollbackPlan {
  created: CreatedComment[];
  edited: EditedComment[];
}

/** The durable JSON at GITHUB_STATE_FILE, written atomically by .7. */
export interface StateSnapshot {
  checkpoints: CheckpointRecord[];
  current: string | null;
  created: Record<string, CreatedComment[]>;
  edited: Record<string, EditedComment[]>;
  /**
   * Every list of the repositories polled has delivered what changed before
   * this: the start of the last pass whose every delivery was accepted, or
   * where a read it stopped stopped, if earlier; before any pass has
   * delivered, the window the first pass read. A list with no cursor of its
   * own in `pollCursors` starts here, such as one of a repository newly in
   * GITHUB_REPOS, or every list of a state file written before `pollCursors`
   * existed. Read as a whole second.
   */
  lastPollAt: string | null;
  /**
   * Each poll list's own cursor, for the repositories the last pass read.
   * **Additive**: a state file without it is still a valid version-1 snapshot.
   */
  pollCursors: Record<string, PollCursor>;
  /**
   * Per list, the rows announced as new (id → created_at), so a row read
   * again inside its list's window, after a stopped read, a refused delivery
   * or in the second a pass started in, is not announced as new twice.
   * Written when the row's event is accepted, and pruned to the rows created
   * inside the window when a pass delivers. **Additive**, like `pollCursors`.
   */
  pollNew: Record<string, Record<string, string>>;
  /** Ring of the last {@link POLL_DEDUP_RING} `<kind>:<id>:<updated_at>` keys (amendment 1). */
  pollKeys: string[];
  /**
   * The head sha last polled for each open pull request, keyed
   * `<owner>/<name>#<number>` (amendment 2a). An open pull-request row seen
   * again is `pull.synchronize` only when its head moved away from what is
   * recorded here; bounded by {@link POLL_HEAD_MEMORY}.
   */
  pollHeads: Record<string, string>;
  /**
   * Contributor mode's notifications watermark: `since`, the instant (ISO) the
   * notifications list is read from; `lastModified`, the HTTP-date the last
   * full listing answered, sent back as `If-Modified-Since`; and `answeredAt`,
   * when GitHub last answered a listing (ISO), a 304 included, where a thread
   * read for the first time reaches back from. A field of
   * its own, so a state file kept across a switch of modes never hands App
   * mode's `lastPollAt` an HTTP-date, or this an ISO instant. A state file
   * written before it has none: no watermark yet. `retry` is the threads the
   * poller still owes a read ({@link NotificationRetry}); dropping it would
   * lose what their failed reads held back.
   */
  notifications: NotificationsWatermark & { retry: NotificationRetry[] };
}

/** {@link StateSnapshot.notifications}: where the next listing starts, and what it sends. */
export interface NotificationsWatermark {
  since: string | null;
  lastModified: string | null;
  answeredAt: string | null;
}

/**
 * A notified thread whose last read or delivery failed, or that GitHub's rate
 * limit kept from being read: the notifications poller reads it again on each
 * pass whose listing gets through, listed or not, until it gets through or has
 * failed {@link NOTIFICATION_RETRY_LIMIT} passes in a row. A stopped entry
 * retains that count and cursor until a newer notification reopens it.
 */
export interface NotificationRetry {
  /** Latest notification update seen; a strictly newer update reopens a stopped entry. */
  updatedAt?: string;
  /** Terminal retry record, retained so re-listing the same update cannot reset attempts. */
  stopped?: boolean;
  /** The drop notice for this notification update was attempted, even if the host refused it. */
  dropAnnounced?: boolean;
  owner: string;
  name: string;
  number: number;
  kind: ThreadKind;
  /** Passes it has failed in a row. */
  attempts: number;
  /** Its cursor as the head memory holds it, kept here too so eviction there can't lose its place while it waits. */
  cursor?: string;
  /** A review request listed for it and not yet delivered: the notification's id and `updated_at`, which a later listing won't show again. */
  reviewRequest?: { id: string; updatedAt: string };
}

/** How many passes in a row a notified thread may fail before the poller drops it, naming it and the cause. */
export const NOTIFICATION_RETRY_LIMIT = 5;

/** How many poll keys the dedup ring remembers. */
export const POLL_DEDUP_RING = 2000;

/**
 * How many pull-request heads the poll state remembers (amendment 2a). One
 * entry is a channel id and a sha; the oldest is dropped past this, which at
 * worst makes a `synchronize` look like a first sighting and drop one row that
 * the comment rows of the same pass already describe.
 */
export const POLL_HEAD_MEMORY = 200;

/**
 * The state seam ToolContext carries; .7 implements it over the state file.
 *
 * WP9 widened it with `recordDeletedComment` and `checkpointStatus`, which .7
 * had added to its own `GithubStateStore`: `ToolContext.state` is **one** type,
 * so a tool and the rollback path do not each need a different view of the
 * store and nothing has to cast to reach a delete record or a §8.7 status.
 */
export interface StateStore {
  createCheckpoint(): CheckpointRecord;
  current(): string | null;
  lineage(): CheckpointRecord[];
  recordCreatedComment(comment: CreatedComment): void;
  recordEditedComment(comment: EditedComment): void;
  /** A delete rollback can only report; GitHub cannot undo it. */
  recordDeletedComment(comment: DeletedComment): void;
  /** Null when the checkpoint is unknown or abandoned (§8: -32005). */
  rollback(checkpointId: string): RollbackPlan | null;
  /** Why `rollback` returned null: `unknown`, or `abandoned` by an earlier one. */
  checkpointStatus(checkpointId: string): CheckpointStatus;
  lastPollAt(): string | null;
  setLastPollAt(when: string): void;
  /** Each poll list's own cursor, keyed `<owner>/<name>:<list>`. */
  pollCursors(): Readonly<Record<string, PollCursor>>;
  /** Replace them all: a list left out has no cursor of its own. */
  setPollCursors(cursors: Record<string, PollCursor>): void;
  /** Per list, the rows announced as new in its window (`StateSnapshot.pollNew`). */
  polledNew(): Readonly<Record<string, Record<string, string>>>;
  setPolledNew(rows: Record<string, Record<string, string>>): void;
  /** Contributor mode's notifications watermark ({@link StateSnapshot.notifications}). */
  notificationsWatermark(): NotificationsWatermark;
  setNotificationsWatermark(watermark: { since: string; lastModified: string | null; answeredAt: string | null }): void;
  /** Contributor mode's threads to read again ({@link NotificationRetry}). */
  notificationRetries(): NotificationRetry[];
  setNotificationRetries(retries: NotificationRetry[]): void;
  /** True when the key was already seen; otherwise records it in the ring and returns false. */
  seenPollKey(key: string): boolean;
  /**
   * What the last pass recorded for this thread's row, or null: an open pull
   * request's head sha (amendment 2a), `closed` for a closed one, an issue's
   * state-and-text fingerprint ({@link polledMarker} in normalize.ts).
   */
  polledHead(channel: string): string | null;
  /** Record the marker this pass saw for a thread's row. */
  setPolledHead(channel: string, sha: string): void;
  snapshot(): StateSnapshot;
  /** Atomic write of the snapshot; a no-op without GITHUB_STATE_FILE. */
  flush(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Environment and logging
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_WEBHOOK_PATH = '/github/webhook';
/** §Ingress: the repository poll never runs faster than this. */
export const MIN_POLL_INTERVAL_MS = 60_000;

/**
 * Which of the two auth + ingress modes a `Config` was validated for:
 *
 *   - `app` — the original GitHub App mode: an installation token minted from
 *     GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY_FILE, webhook and/or repository
 *     polling as ingress.
 *   - `token` — contributor mode: a user's personal access token from
 *     GITHUB_TOKEN_FILE authenticates every call directly, and the
 *     notifications poller is the only ingress (no webhook listener).
 *
 * `readConfig` picks the mode from which of GITHUB_APP_ID/
 * GITHUB_APP_PRIVATE_KEY_FILE and GITHUB_TOKEN_FILE are set, and refuses both
 * at once as ambiguous.
 */
export type GithubAuthMode = 'app' | 'token';

/**
 * The validated environment. Secret material (`privateKeyPem`, `userToken`,
 * `webhookSecret`) is held here and never logged, never put in an error, and
 * never sent to the host.
 */
export interface Config {
  authMode: GithubAuthMode;
  /** App mode only; `''` in contributor mode. */
  appId: string;
  /** PEM contents of GITHUB_APP_PRIVATE_KEY_FILE. Secret. App mode only. */
  privateKeyPem: string | null;
  /** Discovered from GITHUB_REPOS when GITHUB_APP_INSTALLATION_ID is absent. App mode only. */
  installationId: number | null;
  /** Contents of GITHUB_TOKEN_FILE. Secret. Contributor mode only. */
  userToken: string | null;
  /** Contents of GITHUB_WEBHOOK_SECRET_FILE; present iff `webhookPort` is set. Secret. */
  webhookSecret: string | null;
  /** Absent = webhook listener off. Always absent in contributor mode. */
  webhookPort: number | null;
  webhookPath: string;
  /**
   * App mode: 0 = repository polling off, never below {@link MIN_POLL_INTERVAL_MS}
   * when on. Contributor mode: the notifications poller's interval, never
   * below {@link MIN_POLL_INTERVAL_MS} and defaulted to it when unset — the
   * poller is always on in this mode.
   */
  pollIntervalMs: number;
  /**
   * GITHUB_REPOS, the write allow-list. In App mode several repositories are
   * accepted as long as they share one owner, which is one App installation
   * and so one token; a second owner is a second server process. In
   * contributor mode several owners are accepted: the one token authenticates
   * everywhere the user can reach, and this list bounds what reaches the
   * agent as well as what it can do: the notifications poller drops threads
   * from any other repository, and the tools refuse them, reads included.
   */
  repos: RepoRef[];
  /**
   * GITHUB_PR_BASE_ALLOW, as written: `branch` applies to every repository,
   * `owner/name:branch` to that one. Empty means no PR may be created or
   * retargeted. {@link allowedBases} answers for one repository.
   */
  prBaseAllow: string[];
  stateFile: string | null;
  /** GITHUB_BOT_LOGIN. `''` only in contributor mode when unset: startup sets it to the token's own login. */
  botLogin: string;
  maintainers: string[];
}

/** Every variable readConfig reads, for the README table and the error paths. */
export const ENV_VARS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY_FILE',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_TOKEN_FILE',
  'GITHUB_WEBHOOK_SECRET_FILE',
  'GITHUB_WEBHOOK_PORT',
  'GITHUB_WEBHOOK_PATH',
  'GITHUB_POLL_INTERVAL_MS',
  'GITHUB_REPOS',
  'GITHUB_PR_BASE_ALLOW',
  'GITHUB_STATE_FILE',
  'GITHUB_BOT_LOGIN',
  'GITHUB_MAINTAINERS',
] as const;

export type EnvVar = (typeof ENV_VARS)[number];

/**
 * A rejected environment. `problems` names every offending variable, one line
 * each, and carries no secret value — only paths, names and bounds.
 */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export type Env = Record<string, string | undefined>;

/**
 * The branches a pull request on `repo` may target: every plain entry of
 * GITHUB_PR_BASE_ALLOW plus the `owner/name:branch` entries scoped to this
 * repository. Order and duplicates as written; the caller only asks `includes`.
 */
export function allowedBases(repo: RepoRef, entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const at = entry.indexOf(':');
    if (at < 0) out.push(entry);
    else {
      const scope = parseRepoSlug(entry.slice(0, at));
      if (scope && repoAllowed(scope, [repo])) out.push(entry.slice(at + 1));
    }
  }
  return out;
}

function csv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read a secret file. Refuses a file readable by group or other: the contract
 * requires mode 600 on the PEM and on the webhook secret. The error names the
 * variable and the path, never a byte of the content.
 */
function readSecretFile(name: EnvVar, path: string, problems: string[]): string | null {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    problems.push(`${name}: cannot stat ${path}`);
    return null;
  }
  if ((mode & 0o077) !== 0) {
    problems.push(
      `${name}: ${path} is mode ${(mode & 0o777).toString(8)}; it holds secret material and must be 600`,
    );
    return null;
  }
  try {
    const text = readFileSync(path, 'utf8');
    if (text.trim() === '') {
      problems.push(`${name}: ${path} is empty`);
      return null;
    }
    // `jq -r`, `echo` and a paste followed by Enter all end the file in "\n".
    // The HMAC key must be the bytes GitHub holds, so trailing whitespace goes.
    return text.replace(/\s+$/, '');
  } catch {
    problems.push(`${name}: cannot read ${path}`);
    return null;
  }
}

function readPort(name: EnvVar, raw: string | undefined, problems: string[]): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    problems.push(`${name}: must be a TCP port between 1 and 65535, got "${raw}"`);
    return null;
  }
  return n;
}

/**
 * Validate the environment into a {@link Config}, or throw {@link ConfigError}
 * listing every problem by variable name.
 */
export function readConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  // ── Which mode: App key, or a contributor's own token ──
  //
  // Both present is refused outright, by name, before either is validated any
  // further: an operator who set both meant one of them and would otherwise
  // get whichever branch happened to run, silently. Neither present falls
  // through to the App-mode checks below, which is the mode this server has
  // always defaulted to and so is what "nothing configured" should keep
  // naming.
  const appIdRaw = env.GITHUB_APP_ID?.trim() ?? '';
  const keyFileRaw = env.GITHUB_APP_PRIVATE_KEY_FILE?.trim() ?? '';
  const tokenFileRaw = env.GITHUB_TOKEN_FILE?.trim() ?? '';
  const hasAppVars = appIdRaw !== '' || keyFileRaw !== '';
  const hasToken = tokenFileRaw !== '';
  const authMode: GithubAuthMode = hasToken && !hasAppVars ? 'token' : 'app';

  if (hasToken && hasAppVars) {
    problems.push(
      'GITHUB_TOKEN_FILE: set together with GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY_FILE; set only one of ' +
        'App mode (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_FILE) or contributor mode (GITHUB_TOKEN_FILE)',
    );
  }

  let appId = '';
  let privateKeyPem: string | null = null;
  let installationId: number | null = null;
  let userToken: string | null = null;

  if (authMode === 'token') {
    // A token holds no whitespace, so whitespace or a byte-order mark an
    // editor left before it goes too. readSecretFile itself keeps leading
    // bytes, since a webhook secret may begin with a space.
    userToken = readSecretFile('GITHUB_TOKEN_FILE', tokenFileRaw, problems)?.replace(/^[\uFEFF\s]+/, '') ?? null;
    if (env.GITHUB_APP_INSTALLATION_ID?.trim()) {
      problems.push('GITHUB_APP_INSTALLATION_ID: App mode only; contributor mode (GITHUB_TOKEN_FILE) has no installation, so unset it');
    }
  } else {
    if (!appIdRaw) problems.push('GITHUB_APP_ID: required (or set GITHUB_TOKEN_FILE for contributor mode)');
    else if (!/^\d+$/.test(appIdRaw)) problems.push(`GITHUB_APP_ID: must be the numeric App id, got "${appIdRaw}"`);
    else appId = appIdRaw;

    if (!keyFileRaw) {
      problems.push('GITHUB_APP_PRIVATE_KEY_FILE: required (or set GITHUB_TOKEN_FILE for contributor mode)');
    } else {
      privateKeyPem = readSecretFile('GITHUB_APP_PRIVATE_KEY_FILE', keyFileRaw, problems);
    }

    const rawInstallation = env.GITHUB_APP_INSTALLATION_ID?.trim();
    if (rawInstallation) {
      const n = Number(rawInstallation);
      if (!Number.isInteger(n) || n <= 0) {
        problems.push(`GITHUB_APP_INSTALLATION_ID: must be a positive integer, got "${rawInstallation}"`);
      } else {
        installationId = n;
      }
    }
  }

  // ── Webhook: App mode only ──
  let webhookPort: number | null = null;
  let webhookSecret: string | null = null;
  if (authMode === 'token') {
    if (env.GITHUB_WEBHOOK_PORT?.trim()) {
      problems.push(
        'GITHUB_WEBHOOK_PORT: not supported in contributor mode (GITHUB_TOKEN_FILE is set); contributor mode ' +
          'has no webhook listener, only the notifications poller (GITHUB_POLL_INTERVAL_MS)',
      );
    }
  } else {
    webhookPort = readPort('GITHUB_WEBHOOK_PORT', env.GITHUB_WEBHOOK_PORT, problems);
    // Read only when the listener is on: a polling install keeps the example's
    // GITHUB_WEBHOOK_SECRET_FILE line, and its empty file must not stop startup.
    const secretFile = env.GITHUB_WEBHOOK_SECRET_FILE?.trim() ?? '';
    if (webhookPort === null) {
      // listener off: no secret is needed, whatever the file holds
    } else if (secretFile) {
      webhookSecret = readSecretFile('GITHUB_WEBHOOK_SECRET_FILE', secretFile, problems);
    } else {
      problems.push(
        'GITHUB_WEBHOOK_SECRET_FILE: required when GITHUB_WEBHOOK_PORT is set (a delivery is only trusted after its signature is checked)',
      );
    }
  }

  const webhookPath = env.GITHUB_WEBHOOK_PATH?.trim() || DEFAULT_WEBHOOK_PATH;
  if (!webhookPath.startsWith('/')) {
    problems.push(`GITHUB_WEBHOOK_PATH: must start with "/", got "${webhookPath}"`);
  }

  // ── Poll interval: off-by-default in App mode (a webhook fallback), always
  // on at the floor in contributor mode (its only ingress) ──
  let pollIntervalMs = 0;
  const rawPoll = env.GITHUB_POLL_INTERVAL_MS?.trim();
  if (authMode === 'token') {
    if (!rawPoll) {
      pollIntervalMs = MIN_POLL_INTERVAL_MS;
    } else {
      const n = Number(rawPoll);
      if (!Number.isInteger(n) || n < MIN_POLL_INTERVAL_MS) {
        problems.push(
          `GITHUB_POLL_INTERVAL_MS: must be at least ${MIN_POLL_INTERVAL_MS} ms in contributor mode (the ` +
            `notifications poller is always on), got "${rawPoll}"`,
        );
      } else {
        pollIntervalMs = n;
      }
    }
  } else if (rawPoll) {
    const n = Number(rawPoll);
    if (!Number.isInteger(n) || n < 0) {
      problems.push(`GITHUB_POLL_INTERVAL_MS: must be 0 (off) or a positive integer, got "${rawPoll}"`);
    } else if (n > 0 && n < MIN_POLL_INTERVAL_MS) {
      problems.push(
        `GITHUB_POLL_INTERVAL_MS: ${n} is below the ${MIN_POLL_INTERVAL_MS} ms floor the contract sets for polling`,
      );
    } else {
      pollIntervalMs = n;
    }
  }

  const repos: RepoRef[] = [];
  const rawRepos = csv(env.GITHUB_REPOS);
  if (env.GITHUB_REPOS === undefined) {
    problems.push('GITHUB_REPOS: required (comma-separated owner/name allow-list)');
  } else if (rawRepos.length === 0) {
    problems.push('GITHUB_REPOS: set but names no repository; it is the write allow-list and must name one');
  } else {
    for (const slug of rawRepos) {
      const repo = parseRepoSlug(slug);
      if (!repo) problems.push(`GITHUB_REPOS: "${slug}" is not owner/name`);
      else repos.push(repo);
    }
    const slugs = repos.map(repoSlug);
    const dup = slugs.find((s, i) => slugs.indexOf(s) !== i);
    if (dup) problems.push(`GITHUB_REPOS: ${dup} is listed twice`);
    // App mode: one App installation is one token, so a second owner needs a
    // second process. Contributor mode's one token already reaches every
    // owner the user can, so it has no such restriction (the task's
    // "GITHUB_REPOS may span several owners").
    if (authMode === 'app') {
      const owners = [...new Set(repos.map((r) => r.owner))];
      if (owners.length > 1) {
        problems.push(
          `GITHUB_REPOS: every repository must share one owner (one App installation, one token); ` +
            `got ${owners.join(', ')}. Run one server per owner.`,
        );
      }
    }
  }

  const prBaseAllow = csv(env.GITHUB_PR_BASE_ALLOW);
  for (const entry of prBaseAllow) {
    const at = entry.indexOf(':');
    if (at < 0) continue;
    const scope = parseRepoSlug(entry.slice(0, at));
    const branch = entry.slice(at + 1);
    if (!scope || !branch) {
      problems.push(`GITHUB_PR_BASE_ALLOW: "${entry}" is neither a branch nor owner/name:branch`);
    } else if (repos.length > 0 && !repoAllowed(scope, repos)) {
      problems.push(`GITHUB_PR_BASE_ALLOW: "${entry}" names a repository outside GITHUB_REPOS`);
    }
  }

  // Contributor mode may leave it unset: startup takes the token's own login
  // from `GET /user`, which it checks a set value against anyway.
  const botLogin = env.GITHUB_BOT_LOGIN?.trim() ?? '';
  if (!botLogin && authMode === 'app') {
    problems.push('GITHUB_BOT_LOGIN: required (from-self and mention detection depend on it)');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    authMode,
    appId,
    privateKeyPem,
    installationId,
    userToken,
    webhookSecret,
    webhookPort,
    webhookPath,
    pollIntervalMs,
    repos,
    prBaseAllow,
    stateFile: env.GITHUB_STATE_FILE?.trim() || null,
    botLogin,
    maintainers: csv(env.GITHUB_MAINTAINERS),
  };
}

/**
 * Diagnostics. Stdout carries only JSON-RPC, so every level writes to stderr
 * and nothing else; a Logger has no stdout path to take by accident.
 */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** A Logger that writes `[github-mcpl] <tag> <level> <message> <fields>` to stderr. */
export function stderrLogger(tag = 'github-mcpl'): Logger {
  const write = (level: string, message: string, fields?: Record<string, unknown>): void => {
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
    process.stderr.write(`[${tag}] ${level} ${message}${suffix}\n`);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

/** A Logger that drops everything — tests that assert on no output. */
export function silentLogger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}
