/**
 * Ingress normalization (TASK-SRHKG.1.3, §Ingress).
 *
 * One place turns a GitHub delivery into a {@link NormalizedEvent}: a raw
 * webhook payload (webhook.ts) or a polled row (poller.ts). Everything here
 * is pure and total — a payload is untrusted input, so a field that is
 * missing or of the wrong type makes the event drop rather than throw — with
 * one exception at the bottom, {@link resolveCheckEvents}, which is the async
 * check-run lookup the contract puts on a `checks.completed` event.
 *
 * `raw` is kept on every event (the contract's field) and is never read by
 * anything downstream: tags.ts and content.ts see only the named fields.
 */

import { createHash } from 'node:crypto';
import {
  parseRepoSlug,
  type CheckConclusion,
  type ChecksSummary,
  type DiffSide,
  type EventActor,
  type FailedCheck,
  type GitHubApi,
  type Logger,
  type NormalizedEvent,
  type NormalizedEventKind,
  type PolledComment,
  type PolledIssue,
  type PolledReview,
  type RepoRef,
  type ReviewState,
  type ThreadKind,
  type ThreadRef,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Deliveries and poll rows (types the contract implies; see the .3 report)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One verified webhook delivery. `id` is `X-GitHub-Delivery` (the event id the
 * contract names), `event` is `X-GitHub-Event`, `payload` is the parsed JSON —
 * parsed only after webhook.ts has checked the signature.
 */
export interface WebhookDelivery {
  id: string;
  event: string;
  payload: unknown;
  /** ISO-8601; webhook.ts stamps it when the body finished arriving. */
  receivedAt: string;
}

/**
 * Which read a poll row came from. Part of the dedup key and of the poll
 * event id (`poll:<kind>:<id>:<updated_at>`, contract amendment 1). Each is a
 * `since` query but two, contributor mode's notifications poller only:
 * `review`, a submitted review, from a list that takes no `since`, which the
 * adapter filters by `submitted_at` itself; and `review_requested`, a
 * notification whose reason is a review request, keyed by the notification's
 * id and `updated_at`. The repository poll never fetches either.
 */
export type PollRowKind = 'issue' | 'issue_comment' | 'review_comment' | 'checks' | 'review' | 'review_requested';

/** `<kind>:<id>:<updated_at>` — what `StateStore.seenPollKey` remembers. */
export function pollKey(kind: PollRowKind, id: number | string, updatedAt: string): string {
  return `${kind}:${id}:${updatedAt}`;
}

/** `poll:<kind>:<id>:<updated_at>` — the `NormalizedEvent.id` of a polled event. */
export function pollEventId(key: string): string {
  return `poll:${key}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Untrusted-JSON accessors
// ─────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function at(value: unknown, ...path: string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    const o = asObject(cursor);
    if (!o) return undefined;
    cursor = o[key];
  }
  return cursor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared field extraction
// ─────────────────────────────────────────────────────────────────────────────

/** `login` ending in `[bot]`, or GitHub's own `type: 'Bot'`. */
export function actorFrom(user: unknown): EventActor | undefined {
  const login = asString(at(user, 'login'));
  if (!login) return undefined;
  const type = asString(at(user, 'type'));
  return { login, isBot: type === 'Bot' || login.endsWith('[bot]') };
}

/** The repository a delivery is about, from `repository.full_name`. */
export function repoFrom(payload: unknown): RepoRef | undefined {
  const full = asString(at(payload, 'repository', 'full_name'));
  if (full) {
    const parsed = parseRepoSlug(full);
    if (parsed) return parsed;
  }
  const owner = asString(at(payload, 'repository', 'owner', 'login'));
  const name = asString(at(payload, 'repository', 'name'));
  return owner && name ? { owner, name } : undefined;
}

const CHECK_CONCLUSIONS: readonly CheckConclusion[] = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'timed_out',
  'action_required',
  'skipped',
  'stale',
];

function conclusionFrom(value: unknown): CheckConclusion | null {
  const raw = asString(value);
  return raw && (CHECK_CONCLUSIONS as readonly string[]).includes(raw) ? (raw as CheckConclusion) : null;
}

function reviewStateFrom(value: unknown): ReviewState {
  switch (asString(value)?.toLowerCase()) {
    case 'approved':
      return 'approved';
    case 'changes_requested':
      return 'changes_requested';
    default:
      // `commented`, and `dismissed`/anything else a future action adds: a
      // review that is neither an approval nor a block is a comment.
      return 'commented';
  }
}

function sideFrom(value: unknown): DiffSide {
  return asString(value)?.toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
}

/**
 * An issue and a pull request share one number space, and a comment row names
 * only the number — but its `html_url` says which: `/pull/7` or `/issues/7`.
 */
export function threadKindFromUrl(url: string | undefined): ThreadKind {
  return url !== undefined && /\/pull\/\d+/.test(url) ? 'pull' : 'issue';
}

function thread(repo: RepoRef, number: number | undefined, kind: ThreadKind): ThreadRef | undefined {
  return number === undefined ? undefined : { repo, number, kind };
}

/** A delivery that fans out gets `<delivery id>#<n>`; a single event keeps the id. */
function eventId(deliveryId: string, index: number, total: number): string {
  return total > 1 ? `${deliveryId}#${index}` : deliveryId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook payloads
// ─────────────────────────────────────────────────────────────────────────────

const ISSUE_ACTIONS: Record<string, NormalizedEventKind> = {
  opened: 'issue.opened',
  edited: 'issue.edited',
  closed: 'issue.closed',
  reopened: 'issue.reopened',
};

const COMMENT_ACTIONS: Record<string, NormalizedEventKind> = {
  created: 'comment.created',
  edited: 'comment.edited',
  deleted: 'comment.deleted',
};

const PULL_ACTIONS: Record<string, NormalizedEventKind> = {
  opened: 'pull.opened',
  synchronize: 'pull.synchronize',
  ready_for_review: 'pull.ready_for_review',
  review_requested: 'pull.review_requested',
  closed: 'pull.closed',
};

const REVIEW_COMMENT_ACTIONS: Record<string, NormalizedEventKind> = {
  created: 'review_comment.created',
  edited: 'review_comment.edited',
  // The contract names no `review_comment.deleted`; a deleted review comment
  // is a deleted comment that happens to carry `reviewComment`.
  deleted: 'comment.deleted',
};

/** The webhook event names this ingress maps. Anything else is dropped. */
export const HANDLED_WEBHOOK_EVENTS: readonly string[] = [
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_suite',
  'check_run',
  'push',
];

/**
 * A verified delivery, normalized. Returns `[]` for an event or an action the
 * contract names no kind for (`issues.labeled`, `pull_request.reopened`,
 * `ping`, `installation`, …) and for a payload too malformed to place —
 * dropping is the only safe answer, and webhook.ts logs the drop.
 *
 * Only `check_suite`/`check_run` can return more than one event, one per head
 * sha (§Ingress); the ids are then `<delivery>#<n>`.
 */
export function normalizeWebhook(delivery: WebhookDelivery): NormalizedEvent[] {
  const { payload } = delivery;
  const repo = repoFrom(payload);
  if (!repo) return [];
  const action = asString(at(payload, 'action')) ?? '';
  const actor = actorFrom(at(payload, 'sender'));
  const base = { id: delivery.id, receivedAt: delivery.receivedAt, repo, raw: payload };

  switch (delivery.event) {
    case 'issues': {
      const kind = ISSUE_ACTIONS[action];
      const issue = asObject(at(payload, 'issue'));
      if (!kind || !issue || !actor) return [];
      const html_url = asString(issue.html_url);
      if (!html_url) return [];
      return [
        {
          ...base,
          kind,
          thread: thread(repo, asNumber(issue.number), 'issue'),
          actor,
          title: asString(issue.title),
          body: asString(issue.body),
          html_url,
        },
      ];
    }

    case 'issue_comment': {
      const kind = COMMENT_ACTIONS[action];
      const comment = asObject(at(payload, 'comment'));
      const issue = asObject(at(payload, 'issue'));
      if (!kind || !comment || !issue || !actor) return [];
      const html_url = asString(comment.html_url);
      if (!html_url) return [];
      return [
        {
          ...base,
          kind,
          // `issue.pull_request` is present iff the thread is a pull request.
          thread: thread(repo, asNumber(issue.number), asObject(issue.pull_request) ? 'pull' : 'issue'),
          actor,
          title: asString(issue.title),
          body: asString(comment.body),
          html_url,
          ...(asNumber(comment.id) === undefined ? {} : { comment: { id: asNumber(comment.id) as number } }),
        },
      ];
    }

    case 'pull_request': {
      const kind = PULL_ACTIONS[action];
      const pull = asObject(at(payload, 'pull_request'));
      if (!kind || !pull || !actor) return [];
      const html_url = asString(pull.html_url);
      if (!html_url) return [];
      return [
        {
          ...base,
          kind,
          thread: thread(repo, asNumber(pull.number), 'pull'),
          actor,
          title: asString(pull.title),
          body: asString(pull.body),
          html_url,
          sha: asString(at(pull, 'head', 'sha')),
        },
      ];
    }

    case 'pull_request_review': {
      const review = asObject(at(payload, 'review'));
      const pull = asObject(at(payload, 'pull_request'));
      if (action !== 'submitted' || !review || !pull || !actor) return [];
      const id = asNumber(review.id);
      const html_url = asString(review.html_url);
      if (id === undefined || !html_url) return [];
      return [
        {
          ...base,
          kind: 'review.submitted',
          thread: thread(repo, asNumber(pull.number), 'pull'),
          actor,
          title: asString(pull.title),
          body: asString(review.body),
          html_url,
          // The commit the review was written against, which is not the PR's
          // current head once the branch moved under the reviewer. Only an
          // older payload without `commit_id` falls back to the head.
          sha: asString(review.commit_id) ?? asString(at(pull, 'head', 'sha')),
          review: { id, state: reviewStateFrom(review.state) },
        },
      ];
    }

    case 'pull_request_review_comment': {
      const kind = REVIEW_COMMENT_ACTIONS[action];
      const comment = asObject(at(payload, 'comment'));
      const pull = asObject(at(payload, 'pull_request'));
      if (!kind || !comment || !pull || !actor) return [];
      const id = asNumber(comment.id);
      const path = asString(comment.path);
      const html_url = asString(comment.html_url);
      if (id === undefined || !path || !html_url) return [];
      return [
        {
          ...base,
          kind,
          thread: thread(repo, asNumber(pull.number), 'pull'),
          actor,
          title: asString(pull.title),
          body: asString(comment.body),
          html_url,
          sha: asString(comment.commit_id) ?? asString(at(pull, 'head', 'sha')),
          reviewComment: {
            id,
            path,
            line: asNumber(comment.line) ?? asNumber(comment.original_line) ?? null,
            side: sideFrom(comment.side),
            diffHunk: asString(comment.diff_hunk) ?? '',
            ...(asNumber(comment.in_reply_to_id) === undefined
              ? {}
              : { inReplyTo: asNumber(comment.in_reply_to_id) as number }),
          },
        },
      ];
    }

    case 'check_suite':
      return action === 'completed' ? normalizeCheckSuite(base, payload, actor) : [];

    case 'check_run':
      return action === 'completed' ? normalizeCheckRun(base, payload, actor) : [];

    case 'push': {
      const after = asString(at(payload, 'after'));
      const html_url = asString(at(payload, 'compare'));
      const pusher = actor ?? actorFrom({ login: asString(at(payload, 'pusher', 'name')) });
      if (!after || !html_url || !pusher) return [];
      return [{ ...base, kind: 'push', actor: pusher, html_url, sha: after }];
    }

    default:
      return [];
  }
}

type EventBase = Pick<NormalizedEvent, 'id' | 'receivedAt' | 'repo' | 'raw'>;

/**
 * §Ingress: "one `checks.completed` event per head sha". A suite has one head
 * sha; the thread is the first pull request in `pull_requests` whose head is
 * that sha, so a suite on a branch with no PR still produces one (thread-less)
 * event. `failed` is filled from the payload's own check runs if it carries
 * any and otherwise by {@link resolveCheckEvents}.
 */
function normalizeCheckSuite(base: EventBase, payload: unknown, actor: EventActor | undefined): NormalizedEvent[] {
  const suite = asObject(at(payload, 'check_suite'));
  if (!suite) return [];
  const sha = asString(suite.head_sha);
  if (!sha) return [];
  const pulls = asArray(suite.pull_requests);
  const match = pulls.find((p) => asString(at(p, 'head', 'sha')) === sha) ?? pulls[0];
  const number = asNumber(at(match, 'number'));
  const html_url =
    asString(at(match, 'html_url')) ??
    asString(suite.html_url) ??
    `https://github.com/${base.repo.owner}/${base.repo.name}/commit/${sha}`;
  return [
    {
      ...base,
      kind: 'checks.completed',
      thread: thread(base.repo, number, 'pull'),
      // A check suite's `sender` is the App that produced it; the suite has no
      // human actor, so an absent sender falls back to the App's slug.
      actor: actor ?? { login: asString(at(suite, 'app', 'slug')) ?? 'github', isBot: true },
      html_url,
      sha,
      checks: { conclusion: conclusionFrom(suite.conclusion), failed: [] },
    },
  ];
}

/**
 * A single `check_run.completed`. Same kind as a suite (the contract names no
 * other), keyed on the run's head sha, with the run itself pre-listed in
 * `failed` when it failed — {@link resolveCheckEvents} then replaces that with the
 * whole sha's failures. A deployment subscribed to both events sees two
 * deliveries for one sha; they carry distinct delivery ids, so the dedup ring
 * does not merge them.
 */
function normalizeCheckRun(base: EventBase, payload: unknown, actor: EventActor | undefined): NormalizedEvent[] {
  const run = asObject(at(payload, 'check_run'));
  if (!run) return [];
  const sha = asString(run.head_sha) ?? asString(at(run, 'check_suite', 'head_sha'));
  if (!sha) return [];
  const conclusion = conclusionFrom(run.conclusion);
  const name = asString(run.name);
  const url = asString(run.html_url);
  const failed: FailedCheck[] =
    conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required'
      ? [{ name: name ?? 'check', url: url ?? '' }]
      : [];
  const pulls = asArray(run.pull_requests);
  const match = pulls.find((p) => asString(at(p, 'head', 'sha')) === sha) ?? pulls[0];
  return [
    {
      ...base,
      kind: 'checks.completed',
      thread: thread(base.repo, asNumber(at(match, 'number')), 'pull'),
      actor: actor ?? { login: asString(at(run, 'app', 'slug')) ?? 'github', isBot: true },
      html_url: url ?? `https://github.com/${base.repo.owner}/${base.repo.name}/commit/${sha}`,
      sha,
      checks: { conclusion, failed },
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Poll rows (contract amendments 1 and 2a)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when `at` is at or after `since` — both ISO-8601 instants.
 *
 * Compared as instants and not as strings: GitHub stamps a row
 * `2026-10-14T12:28:38Z` while a cursor is written with milliseconds
 * (`2026-10-14T12:28:38.000Z`, or `.500Z` from an older release), and
 * lexicographically `'Z'` (0x5A) sorts
 * *after* `'.'` (0x2E) — so a string compare calls the earlier instant the
 * later one. An unparseable stamp answers false, which is the fail-safe
 * direction: the row keeps the kind it had before amendment 2a.
 */
export function atOrAfter(at: string, since: string): boolean {
  const a = Date.parse(at);
  const b = Date.parse(since);
  return Number.isFinite(a) && Number.isFinite(b) && a >= b;
}

/**
 * An issue or pull-request row from `listIssuesSince`.
 *
 * A `since` query reports *that* a row changed, never *how* — there is no
 * action — so amendment 2a derives the one from the row's own `created_at`
 * against `since`, the start of the window the poller has not finished
 * reading (`PollCursor.since` in types.ts):
 *
 *   - **opened** when the row was created at or after `since` and the poller
 *     hasn't announced it as new already (`announced`): this pass is the
 *     first that could have seen it, so `issue.opened` / `pull.opened`. A
 *     row is read again inside its window after a stopped read, a refused
 *     delivery, or in the second a pass starts in, and `announced` keeps it
 *     from being opened twice.
 *   - otherwise an **issue** row is `issue.edited` (or `issue.closed`, below)
 *     when its state, title or body differs from what the last pass recorded
 *     for it ({@link polledMarker}), and is **dropped** when they do not. A
 *     comment bumps its issue's `updated_at`, and the comment row of the same
 *     pass already carries the change; re-announcing the issue beside it,
 *     attributed to the issue's author, woke the bot on its own comments
 *     (deviation D1 and the 2026-10-15 rehearsal in docs/e2e-report.md).
 *   - otherwise an open **pull-request** row is `pull.synchronize` when its
 *     head sha moved away from `previousHeadSha` (what the last pass recorded
 *     for it), and is **dropped** — null — when it did not. A pull request's
 *     row is touched by every comment on it, and those comment and
 *     review-comment rows are collected by the same pass and already carry
 *     the change; re-announcing the pull request beside each of them is the
 *     duplicate volume amendment 2a exists to stop. An unknown head (the
 *     adapter fetches at most `POLL_PR_HEAD_LIMIT` per pass) cannot be shown
 *     to have moved, so it drops the same way.
 *
 *     A *first* sighting — no `previousHeadSha`, because this poll state has
 *     never recorded one — counts as moved, so an open pull request older
 *     than the cursor arrives once as `pull.synchronize` rather than not at
 *     all. It is the honest half of a choice with no clean answer: the row
 *     was not opened now (so `pull.opened` would lie about when), and
 *     dropping it would leave a cold start blind to work already in flight.
 *     The cost is bounded and smaller than it sounds: a poller with no stored
 *     cursor queries from one interval back (`Poller.pollOnce`), so a first
 *     pass sees only the rows touched in that interval — one `synchronize` per
 *     pull request *updated in the last poll interval*, not one per pull
 *     request that happens to be open.
 *   - **closed** rows are `issue.closed` / `pull.closed`, whenever they were
 *     created, but only on the pass that sees the close: a closed row whose
 *     marker is unchanged is a comment's bump and is dropped. The actor is
 *     `closed_by` when the list carries it, so the bot's own close is
 *     from-self.
 *
 * A first sighting — no recorded marker — always counts as a change.
 *
 * The dedup key still carries `updated_at`, so a row that does survive this
 * arrives once per change.
 */
export function normalizePolledIssue(
  repo: RepoRef,
  row: PolledIssue,
  receivedAt: string,
  since: string,
  previousMarker?: string,
  announced = false,
): NormalizedEvent | null {
  const key = pollKey('issue', row.id, row.updatedAt);
  const isNew = !announced && atOrAfter(row.createdAt, since);
  const closed = row.state === 'closed';
  const changed = previousMarker === undefined || polledMarker(row) !== previousMarker;
  let kind: NormalizedEventKind;
  if (row.isPullRequest) {
    if (closed) {
      if (!isNew && !changed) return null;
      kind = 'pull.closed';
    } else if (isNew) kind = 'pull.opened';
    else if (row.headSha !== undefined && row.headSha !== '' && row.headSha !== previousMarker) {
      kind = 'pull.synchronize';
    } else return null;
  } else {
    if (!isNew && !changed) return null;
    kind = closed ? 'issue.closed' : isNew ? 'issue.opened' : 'issue.edited';
  }
  return {
    id: pollEventId(key),
    receivedAt,
    repo,
    kind,
    thread: { repo, number: row.number, kind: row.isPullRequest ? 'pull' : 'issue' },
    actor: closed && row.closedBy ? row.closedBy : row.author,
    title: row.title,
    body: row.body,
    html_url: row.html_url,
    ...(row.headSha === undefined ? {} : { sha: row.headSha }),
    raw: row,
  };
}

/**
 * What the poller records per thread to tell a real change from a comment's
 * bump: an open pull request's head sha (undefined when the adapter did not
 * fetch it, which records nothing), `closed` for a closed pull request, and
 * for an issue its state with a hash of its title and body.
 */
export function polledMarker(row: PolledIssue): string | undefined {
  if (row.isPullRequest) return row.state === 'closed' ? 'closed' : row.headSha || undefined;
  const text = createHash('sha256').update(`${row.title}\0${row.body}`).digest('hex').slice(0, 16);
  return `issue:${row.state}:${text}`;
}

/**
 * An issue comment or a review comment from `listIssueCommentsSince` /
 * `listReviewCommentsSince`. Same caveat as above: a poll cannot tell a new
 * comment from an edited one, so both arrive as `*.created` with
 * `updated_at` in the id.
 */
export function normalizePolledComment(
  repo: RepoRef,
  row: PolledComment,
  rowKind: 'issue_comment' | 'review_comment',
  receivedAt: string,
): NormalizedEvent {
  const key = pollKey(rowKind, row.id, row.updatedAt);
  const review = rowKind === 'review_comment';
  return {
    id: pollEventId(key),
    receivedAt,
    repo,
    kind: review ? 'review_comment.created' : 'comment.created',
    thread: { repo, number: row.number, kind: review ? 'pull' : threadKindFromUrl(row.html_url) },
    actor: row.author,
    body: row.body,
    html_url: row.html_url,
    ...(review ? {} : { comment: { id: row.id } }),
    ...(review
      ? {
          reviewComment: {
            id: row.id,
            path: row.path ?? '',
            // A `since` comment row carries no line, side or diff hunk; the
            // thread read (`listReviewThreads`) is where those live.
            line: null,
            side: 'RIGHT' as DiffSide,
            diffHunk: '',
            ...(row.inReplyTo === undefined ? {} : { inReplyTo: row.inReplyTo }),
          },
        }
      : {}),
    raw: row,
  };
}

/**
 * A submitted review from `listReviewsSince` (contributor mode's notifications
 * poller only — the repository poll has no equivalent, since `since` on this
 * endpoint is a client-side filter the adapter applies itself). Same shape as
 * the webhook's `pull_request_review` case in {@link normalizeWebhook}: one
 * `review.submitted` event with the pull request's title, and the commit the
 * review was written against where the row names one. The poller reads no
 * head, so a row without `commit_id` carries no sha, where the webhook would
 * fall back to the head.
 */
export function normalizePolledReview(
  repo: RepoRef,
  pull: ThreadRef,
  row: PolledReview,
  receivedAt: string,
  title: string,
): NormalizedEvent {
  const key = pollKey('review', row.id, row.submittedAt);
  const sha = row.commitId;
  return {
    id: pollEventId(key),
    receivedAt,
    repo,
    kind: 'review.submitted',
    thread: pull,
    actor: row.author,
    title,
    body: row.body,
    html_url: row.html_url,
    ...(sha === undefined ? {} : { sha }),
    review: { id: row.id, state: row.state },
    raw: row,
  };
}

/**
 * A review request, from a `GET /notifications` row whose reason is
 * `review_requested` (contributor mode's notifications poller only), with the
 * pull request's row the poller read. The notification names neither who
 * asked nor whom, so the actor is the pull request's author, who is usually
 * the one asking, and `raw`, naming no reviewer, makes the server take the
 * request as the token user's own, which the reason says it is. Keyed by the
 * notification's id and `updated_at`.
 */
export function normalizeNotifiedReviewRequest(
  repo: RepoRef,
  row: PolledIssue,
  notification: { id: string; updatedAt: string },
  receivedAt: string,
): NormalizedEvent {
  const key = pollKey('review_requested', notification.id, notification.updatedAt);
  return {
    id: pollEventId(key),
    receivedAt,
    repo,
    kind: 'pull.review_requested',
    thread: { repo, number: row.number, kind: 'pull' },
    actor: row.author,
    title: row.title,
    body: row.body,
    html_url: row.html_url,
    raw: { reason: 'review_requested', notification: notification.id, updatedAt: notification.updatedAt },
  };
}

/**
 * The check lifecycle, in one place.
 *
 * A head sha can report its checks many times over — two workflows are two
 * `check_suite.completed` deliveries, a deployment subscribed to `check_run`
 * gets one per job, a poll pass sees whatever `getCheckRuns` says at that
 * moment, and the webhook and the poller can be doing all of that at once —
 * while §Ingress asks for one `checks.completed` per head sha. Four rules,
 * and the thing that makes them hold under concurrency is the third:
 *
 *   1. **A head enters the lifecycle** when a pull-request row or a check
 *      webhook names it.
 *   2. **It leaves when its checks are settled and the event was accepted.**
 *      Settled means every run on the sha has finished
 *      ({@link isCompletedSummary}); a sha with a suite still running is held
 *      back by {@link resolveCheckEvents} rather than reported with a
 *      provisional conclusion. Accepted means the listener took it without
 *      throwing — the poller keeps the head in its backlog until then.
 *   3. **Every emission for one head sha is serialized.** {@link CheckGate}
 *      runs them one after another through a per-sha promise chain, whichever
 *      ingress path they came from. So an emission never has to reason about
 *      another one being in flight: by the time it runs, every earlier
 *      emission for its sha has already either committed a mark or failed.
 *   4. **A mark is committed only after the listener accepted the event**, and
 *      an emission the committed mark already {@link coversMark covers} is
 *      dropped. A refused or thrown delivery commits nothing and leaves no
 *      trace, so the next emission for that sha — the retry, or the other
 *      path — still gets to deliver it.
 *
 * There is deliberately no reservation, no provisional entry and no rollback:
 * the only writes are commits, and a commit means "the listener has this".
 * Two earlier designs tried to make a claim-then-release state machine safe
 * and each left a window where a refusal erased a newer accepted result or a
 * pending claim hid work from the poller.
 */

/** A {@link ChecksSummary} whose runs have all finished. */
export type CompletedChecksSummary = ChecksSummary & { conclusion: CheckConclusion };

/**
 * Is this sha's result decided, so that `checks.completed` is true? Every run
 * finished, or a failure, which is a failure whatever still runs; the latter
 * carries `unfinished`, since more failures may come.
 */
export function isCompletedSummary(summary: ChecksSummary): summary is CompletedChecksSummary {
  return summary.total > 0 && summary.conclusion !== null;
}

/**
 * The dedup key of a polled check result:
 * `checks:<sha>:<conclusion>:<n>:<fingerprint of the failed job names>`.
 *
 * A check result has no `updated_at` to key on, so the third field is what
 * makes the result distinct news instead — its conclusion and *which* jobs
 * failed. A sha can legitimately settle twice: a suite created after the first
 * poll adds its own failures, or replaces them with others of the same count
 * (review round 4), and neither may look like a duplicate of the earlier
 * result. The names are hashed so the key stays bounded.
 */
export function checksPollKey(summary: CompletedChecksSummary): string {
  const names = summary.failed.map((f) => f.name).sort();
  const fingerprint = createHash('sha1').update(names.join('\n')).digest('hex').slice(0, 12);
  return pollKey('checks', summary.sha, `${summary.conclusion}:${summary.failed.length}:${fingerprint}`);
}

/**
 * The check state of a polled pull-request head. The summary has to be
 * *completed*: a head whose runs are still going belongs in the poller's
 * backlog, not in a `checks.completed` event (rule 2).
 */
export function normalizePolledChecks(
  repo: RepoRef,
  pull: ThreadRef,
  summary: CompletedChecksSummary,
  html_url: string,
  receivedAt: string,
): NormalizedEvent {
  const key = checksPollKey(summary);
  return {
    id: pollEventId(key),
    receivedAt,
    repo,
    kind: 'checks.completed',
    thread: pull,
    actor: { login: 'github', isBot: true },
    html_url,
    sha: summary.sha,
    checks: { conclusion: summary.conclusion, failed: summary.failed },
    raw: summary,
  };
}


/**
 * §Ingress: a `checks.completed` event carries "the failed job names and URLs
 * (from check runs through `GitHubApi.getCheckRuns`)". The delivery that
 * triggered it names at most the one suite or job that just finished, so the
 * whole sha is looked up once per event — and that lookup is also what decides
 * whether the event is ready at all (rule 2):
 *
 *   - **settled** (every run finished): the summary replaces `checks`, so the
 *     event carries every failed job on the sha and not just this suite's.
 *   - **still running** (runs exist, no conclusion yet): the event is *held
 *     back*. Another suite is about to finish and GitHub will deliver again;
 *     emitting now would report a conclusion that is about to change and
 *     would spend the sha's one emission on a partial job list.
 *   - **no runs known** (`total === 0`) or **the lookup failed**: the event
 *     goes out as the payload had it. A check event without job names still
 *     wakes a recipe, and there is nothing better to wait for.
 *
 * Non-checks events pass through untouched.
 */
export async function resolveCheckEvents(
  events: readonly NormalizedEvent[],
  api: Pick<GitHubApi, 'getCheckRuns'>,
  logger?: Logger,
): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for (const event of events) {
    if (event.kind !== 'checks.completed' || !event.sha) {
      out.push(event);
      continue;
    }
    let summary: ChecksSummary;
    try {
      summary = await api.getCheckRuns(event.repo, event.sha);
    } catch (err) {
      logger?.warn('check runs lookup failed; forwarding the event without job names', {
        sha: event.sha,
        error: err instanceof Error ? err.message : String(err),
      });
      out.push(event);
      continue;
    }
    if (isCompletedSummary(summary)) {
      out.push({ ...event, checks: { conclusion: summary.conclusion, failed: summary.failed } });
    } else if (summary.total === 0) {
      // The API knows of no runs on this sha, so the payload is all there is.
      out.push(event);
    } else {
      logger?.info('checks event held back: another suite is still running on this head', {
        sha: event.sha,
        runs: summary.total,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// One checks.completed per head sha: serialize, then commit
// ─────────────────────────────────────────────────────────────────────────────

/** How many head shas the committed-mark ring remembers. */
export const CHECK_MARK_RING = 2000;

/**
 * How bad a conclusion is, ascending. `null` (nothing settled yet) ranks
 * below every real conclusion, so the first real one always gets through.
 */
const CONCLUSION_SEVERITY: Record<CheckConclusion, number> = {
  success: 0,
  skipped: 1,
  neutral: 2,
  stale: 3,
  cancelled: 4,
  action_required: 5,
  timed_out: 6,
  failure: 7,
};

function severity(conclusion: CheckConclusion | null): number {
  return conclusion === null ? -1 : CONCLUSION_SEVERITY[conclusion];
}

/**
 * What a head sha has already told the listener — the *committed* record, only
 * ever written after an accepted delivery.
 *
 * It accumulates rather than replaces: `rank` is the worst conclusion seen and
 * `failed` the union of the job names reported. That is what makes an older
 * result unable to undo a newer one, and it bounds how often one sha can be
 * emitted (once per severity level, plus once per job name that appears).
 */
export interface CheckMark {
  /** {@link CONCLUSION_SEVERITY} of the conclusion; `-1` for none yet. */
  rank: number;
  /** Failed job names, sorted and deduplicated. */
  failed: readonly string[];
}

/** The mark of a `checks.completed` event, or null for any other event. */
export function checkMarkOf(event: NormalizedEvent): CheckMark | null {
  if (event.kind !== 'checks.completed' || !event.sha) return null;
  const names = [...new Set((event.checks?.failed ?? []).map((f) => f.name))].sort();
  return { rank: severity(event.checks?.conclusion ?? null), failed: names };
}

/**
 * Does what the listener already has say everything `mark` would say?
 *
 * True when the committed conclusion is at least as bad and names at least the
 * same failed jobs — then `mark` is a duplicate, a weaker re-run, or a shorter
 * view of the same failures, and emitting it would only repeat the sha. False
 * when `mark` is a stronger conclusion or names a job the listener has not
 * heard about, which is the case that must supersede.
 */
export function coversMark(committed: CheckMark, mark: CheckMark): boolean {
  return committed.rank >= mark.rank && mark.failed.every((name) => committed.failed.includes(name));
}

/** The worst conclusion and every failed job name either mark knows. */
function mergeMarks(a: CheckMark, b: CheckMark): CheckMark {
  return {
    rank: Math.max(a.rank, b.rank),
    failed: [...new Set([...a.failed, ...b.failed])].sort(),
  };
}

/**
 * The gate that makes "one `checks.completed` per head sha" true across every
 * ingress path, keyed on `<owner>/<name>@<sha>`.
 *
 * Two pieces, and neither of them is a state machine:
 *
 *   - **a per-sha promise chain**, so all emissions for one head sha run one
 *     after another. A webhook delivery and a poll pass for the same sha do
 *     not race; the second one simply waits its turn.
 *   - **a bounded ring of committed marks**, written only after a delivery was
 *     accepted. Nothing is ever written speculatively, so there is nothing to
 *     release and no window in which a refusal can erase what another
 *     emission already got accepted.
 */
export class CheckGate {
  private readonly committed = new Map<string, CheckMark>();
  /** The tail of each head sha's queue. Absent once the queue has drained. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly capacity: number = CHECK_MARK_RING) {}

  /** `<owner>/<name>@<sha>`. */
  static key(repo: RepoRef, sha: string): string {
    return `${repo.owner}/${repo.name}@${sha}`;
  }

  /** What the listener has already accepted for this head sha, if anything. */
  committedMark(repo: RepoRef, sha: string): CheckMark | undefined {
    return this.committed.get(CheckGate.key(repo, sha));
  }

  /**
   * Deliver one checks event for this head sha, in turn.
   *
   * Waits for every emission already queued for the sha, then compares `mark`
   * against what those emissions committed. Returns false without calling
   * `deliver` when the committed mark already covers it. Otherwise calls
   * `deliver`, commits `mark` once it resolves, and returns true — or lets its
   * rejection through untouched, having committed nothing.
   */
  async emit(repo: RepoRef, sha: string, mark: CheckMark, deliver: () => Promise<void>): Promise<boolean> {
    const key = CheckGate.key(repo, sha);

    const run = async (): Promise<boolean> => {
      // Read inside the chain: every earlier emission for this sha has
      // settled by now, so this sees their commits and none of their attempts.
      const seen = this.committed.get(key);
      if (seen !== undefined && coversMark(seen, mark)) return false;
      await deliver();
      this.commit(key, mark);
      return true;
    };

    const ahead = this.queues.get(key);
    // `then(run, run)` on both outcomes: an emission that was refused must not
    // stall the queue behind it — that refusal is exactly when the next one
    // needs to run.
    const mine: Promise<boolean> = ahead === undefined ? run() : ahead.then(run, run);
    this.queues.set(key, mine);
    try {
      return await mine;
    } finally {
      // Drop the queue when nothing is waiting behind this emission, so a
      // quiet sha costs nothing and the map cannot grow without bound.
      if (this.queues.get(key) === mine) this.queues.delete(key);
    }
  }

  private commit(key: string, mark: CheckMark): void {
    // Re-read rather than trusting the value `run` saw: merging with whatever
    // is committed now means an emission can only ever add to the record,
    // never lower it.
    const current = this.committed.get(key);
    // Re-setting an existing key keeps its insertion position, so a sha that
    // is emitted again does not get a fresh lease on the ring.
    this.committed.set(key, current === undefined ? mark : mergeMarks(current, mark));
    if (this.committed.size > this.capacity) {
      const oldest = this.committed.keys().next();
      if (!oldest.done) this.committed.delete(oldest.value);
    }
  }

  /** Head shas with a committed mark. */
  get size(): number {
    return this.committed.size;
  }

  /** Head shas with an emission in flight or queued. */
  get inFlight(): number {
    return this.queues.size;
  }
}
