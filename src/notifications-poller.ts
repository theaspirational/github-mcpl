/**
 * Notifications ingress (contributor mode).
 *
 * App mode's two ingress paths — the webhook and the repository poll
 * (poller.ts) — both need an installation token's repository-scoped reads.
 * A user token has no installation and no webhook to receive, but it can read
 * `GET /notifications`: the threads its own user takes part in. That is this
 * module's ingress, and it is the only one contributor mode runs (readConfig
 * refuses GITHUB_WEBHOOK_PORT in this mode).
 *
 * **What a pass lists.** The watermark W is where the last listing got to. A
 * pass lists `GET /notifications?all=true&participating=true&since=W`, every
 * page, conditional on the last listing's `Last-Modified`, so an unchanged
 * inbox's listing is a 304 that costs no rate limit. `all=true` lists read threads too,
 * so nothing depends on what anyone has marked read, and this ingress marks
 * nothing read. Threads in a repository outside GITHUB_REPOS are dropped: no
 * tool and no `channels/publish` would act there, and a user's other threads
 * would only reach the agent's context for nothing. W moves on with every
 * listing that got through, whatever became of the threads it listed.
 *
 * **What it reads of a thread.** Each listed thread, and each thread a past
 * pass failed on, is read since its own cursor, every page: its conversation
 * comments, and for a pull request its review comments and its reviews. Its
 * row from the issues endpoint, read first, says what changed of its state,
 * through the same `normalizePolledIssue` App mode's repository poll uses.
 * Every GitHub event comes from normalize.ts's functions, so it carries the
 * tags, metadata and channel the repository poll's would; the poller's own
 * `thread.read_failed` notice is built here.
 *
 * **Two things a thread's rows don't show.** A listed pull request whose
 * notification gives `review_requested` as its reason is a
 * `pull.review_requested` event too, keyed by the notification's id and
 * `updated_at`; one not yet delivered waits on its thread's retry entry,
 * since a later listing won't show it again. And each pass whose reads met no
 * rate limit, a 304's included, looks up the checks on the head of each open
 * pull request the token's user authored, since no notification says they
 * finished. It leaves a head alone, until its update moves or its head read
 * is ten minutes old, once a result with every run finished was delivered,
 * or once it has had no runs for two minutes since its head read; a failure
 * delivered while other runs go is looked up each pass until they finish
 * ({@link NotificationsPoller.pollOwnChecks}). App mode's repository poll
 * looks up the heads of the pull requests it saw move, until they settle.
 *
 * **A thread with no cursor** reads its rows from {@link NOTIFICATION_DELAY_MS}
 * before GitHub's previous answer to a listing, 304s included (before W, when
 * GitHub hasn't answered yet). A new thread wasn't in that answer, so what's
 * new on it came after it, less the time GitHub takes to write a notification
 * and stamp the thread's `updated_at` in the listing (about 20 s on the
 * house's account in October 2026). A thread whose cursor the bounded head
 * memory evicted, or one only now in GITHUB_REPOS, reads from there too, and
 * can miss what came before. Its opening is an event if it opened since then,
 * and its close if it closed since then. Anything else its state
 * says is taken as known, so an evicted thread can miss a state change other
 * than an opening or a close. It misses none of its rows unless it was dropped
 * (below) with rows held back, and its place was evicted before it moved.
 *
 * **Durable state** (state.ts), flushed after each thread and each listing:
 *   - W and the last `Last-Modified`, in a field of their own
 *     (`notificationsWatermark`), apart from App mode's `lastPollAt`, and the
 *     threads to read again (`notificationRetries`);
 *   - each thread's cursor, in the head memory under `notif:<channel>`: where
 *     its next reads start (the thread's `updated_at` as last read), the
 *     `updated_at` whose state was last delivered, that state's marker, and
 *     the keys of the rows at its edge, which the next read takes again: a
 *     thread can sit quiet while the ring below turns over many times;
 *   - the dedup ring, keyed `<kind>:<id>:<timestamp>` as the repository poll
 *     keys it, so a row a pass reads twice is delivered once.
 *
 * **Failures.** Delivered means handed to `onEvent`, the server's event
 * pipeline, which decides what becomes of an event, as for every ingress: it
 * drops one with no host to send it to, without throwing. A thread's cursor
 * moves past rows only once each was delivered, and past a state change only
 * once it was. A thread whose read failed, or one of whose events `onEvent`
 * threw on, goes on the retry list, which keeps its cursor too, and is
 * read again first on each later pass whose listing gets through, listed or
 * not, until it gets through or has failed {@link NOTIFICATION_RETRY_LIMIT}
 * passes in a row. Then it's dropped, with one `thread.read_failed` event on
 * its channel saying why, and read again when it next moves, from its cursor
 * while that is among the last 200 the head memory keeps. A thread gone or
 * out of the token's reach is dropped at once. GitHub's rate limit counts no
 * pass against a thread: it ends the pass's reads, the threads not yet read
 * wait on the retry list for the next pass, and the thread that met it goes
 * to the back of the list. A thread with more new activity than one read
 * takes is read from its current update on, and its event says so.
 */

import {
  isCompletedSummary,
  normalizeNotifiedReviewRequest,
  normalizePolledChecks,
  normalizePolledComment,
  normalizePolledIssue,
  normalizePolledReview,
  polledMarker,
} from './normalize.js';
import { MAX_CHECKED_PULLS_PER_POLL } from './poller.js';
import {
  MIN_POLL_INTERVAL_MS,
  NOTIFICATION_RETRY_LIMIT,
  channelId,
  isIsoInstant,
  repoAllowed,
  silentLogger,
  type ChecksSummary,
  type EventActor,
  type Logger,
  type NormalizedEvent,
  type NotificationRetry,
  type NotificationsWatermark,
  type PolledComment,
  type PolledIssue,
  type PolledReview,
  type RepoRef,
  type ThreadRef,
} from './types.js';
import type { EventListener } from './webhook.js';
import {
  ReadCapError,
  describeFailure,
  isLastingFailure,
  isRateLimit,
  type NotificationsPage,
  type OwnPull,
} from './github-adapter.js';

/** The adapter surface this ingress uses. A structural subset — `GitHubAdapter` satisfies it with no cast. */
export interface NotificationsPollerApi {
  listNotifications(opts: { since: string; ifModifiedSince: string | null }): Promise<NotificationsPage>;
  getPolledThread(thread: ThreadRef): Promise<PolledIssue>;
  listCommentsSince(thread: ThreadRef, since: string): Promise<PolledComment[]>;
  listPullReviewCommentsSince(pull: ThreadRef, since: string): Promise<PolledComment[]>;
  listReviewsSince(pull: ThreadRef, since: string): Promise<PolledReview[]>;
  listOwnOpenPulls(login: string, repos: readonly RepoRef[]): Promise<OwnPull[]>;
  getPullHeadSha(pull: ThreadRef): Promise<string>;
  getCheckRuns(repo: RepoRef, sha: string): Promise<ChecksSummary>;
}

/** The durable state this ingress needs; `state.ts`'s `GithubState` satisfies it with no adapter. */
export interface NotificationsIngressState {
  notificationsWatermark(): NotificationsWatermark;
  setNotificationsWatermark(watermark: { since: string; lastModified: string | null; answeredAt: string | null }): void;
  notificationRetries(): NotificationRetry[];
  setNotificationRetries(retries: NotificationRetry[]): void;
  seenPollKey(key: string): boolean;
  polledHead(channel: string): string | null;
  setPolledHead(channel: string, value: string): void;
  snapshot(): { pollKeys: string[] };
  flush(): Promise<void>;
}

export interface NotificationsPollerOptions {
  api: NotificationsPollerApi;
  state: NotificationsIngressState;
  /** GITHUB_POLL_INTERVAL_MS. readConfig refuses a value below the floor and defaults an unset one in contributor mode, so it is never 0 in practice. */
  intervalMs: number;
  /** GITHUB_REPOS. A notification from any other repository is dropped. */
  repos: readonly RepoRef[];
  /** The token's login: whose open pull requests have their checks looked up. Without it, none are. */
  login?: string;
  onEvent: EventListener;
  logger?: Logger;
  /** Overridable in tests. */
  now?: () => Date;
}

/** What one pass did, for diagnostics and for the tests. */
export interface NotificationsPollResult {
  /** True on a 304. Threads on the retry list are read all the same. */
  notModified: boolean;
  /** Threads read: those listed in GITHUB_REPOS, and those on the retry list. */
  threads: number;
  /** Issue and pull-request threads listed outside GITHUB_REPOS, dropped. */
  outOfScope: number;
  delivered: NormalizedEvent[];
  duplicates: number;
  /** Threads whose read or deliveries failed this pass. */
  failed: number;
  /** Threads dropped from the retry list this pass. */
  dropped: number;
  /** True when the listing stopped at its page cap, so some threads updated since W weren't listed. */
  truncated: boolean;
  /** `getCheckRuns` calls on the heads of the token user's open pull requests; never above {@link MAX_CHECKED_PULLS_PER_POLL}. */
  checkLookups: number;
}

/**
 * How long before GitHub's previous answer a thread with no cursor starts its reads. GitHub stamps a
 * notification when it writes it: in a read of the house's account on
 * 2026-10-18, the listing's stamp came 20 to 26 s after the thread's own
 * update in 11 of 14 threads, and 0 to 2 s after it in the rest. So the
 * activity behind a thread first listed now can be older than the answer
 * before it. Five minutes leaves room for a slower day; what it reads again
 * is dropped by the dedup ring.
 */
export const NOTIFICATION_DELAY_MS = 5 * 60_000;

/** A thread's cursor, packed into one head-memory value. */
interface ThreadCursor {
  /** Where the thread's next reads start: its `updated_at` when last read whole. */
  since: string | null;
  /** The thread `updated_at` whose state was last delivered: null for a thread never read. */
  seen: string | null;
  /** The state marker last delivered (normalize.ts's `polledMarker`). */
  marker: string | undefined;
  /**
   * The ring keys of the rows delivered at or after `since` less a second,
   * which the next read takes again: that read drops them itself, since a
   * quiet thread's keys can have left the dedup ring by the time it moves.
   */
  edge: readonly string[];
}

const CURSOR_SEP = '\u0000';
const NO_CURSOR: ThreadCursor = { since: null, seen: null, marker: undefined, edge: [] };

function packCursor(cursor: ThreadCursor): string {
  return [cursor.since ?? '', cursor.seen ?? '', cursor.marker ?? '', cursor.edge.join(' ')].join(CURSOR_SEP);
}

/** A cursor this module wrote, or none: a value of another shape, or whose times aren't instants, names nothing here. */
function unpackCursor(value: string | null): ThreadCursor {
  if (value === null) return NO_CURSOR;
  const parts = value.split(CURSOR_SEP);
  if (parts.length !== 4) return NO_CURSOR;
  const [since, seen, marker, edge] = parts as [string, string, string, string];
  const instantOrEmpty = (stamp: string): boolean => stamp === '' || isIsoInstant(stamp);
  if (!instantOrEmpty(since) || !instantOrEmpty(seen)) return NO_CURSOR;
  return { since: since || null, seen: seen || null, marker: marker || undefined, edge: edge ? edge.split(' ') : [] };
}

/** Milliseconds of an ISO or HTTP-date stamp, or NaN. */
const ms = (stamp: string | null | undefined): number => (stamp ? Date.parse(stamp) : Number.NaN);

/** An instant as GitHub writes one: ISO 8601, whole seconds. */
const isoSeconds = (at: number): string => new Date(Math.floor(at / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');

/** True when `a` is a later instant than `b`; an unreadable stamp is never later. */
const later = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = ms(a);
  const y = ms(b);
  return Number.isFinite(x) && Number.isFinite(y) && x > y;
};

/** True when `at` is at or after `since`; an unreadable stamp answers false. */
const atOrAfter = (at: string | undefined, since: string): boolean => {
  const x = ms(at);
  const y = ms(since);
  return Number.isFinite(x) && Number.isFinite(y) && x >= y;
};

/** The ring key of a polled event: its id without `poll:`, as the repository poll records it. */
const ringKey = (event: NormalizedEvent): string => (event.id.startsWith('poll:') ? event.id.slice('poll:'.length) : event.id);

const isClosedMarker = (marker: string): boolean => marker === 'closed' || marker.startsWith('issue:closed:');

/**
 * The marker `normalizePolledIssue` compares a thread's row against, which
 * decides its state event. A thread whose cursor holds a delivered marker
 * compares against it, except that a thread closed then and closed now has
 * news only if it closed again since: an edit to a closed issue isn't a close,
 * and a reopen and a close that no pass saw between them are. Any other
 * thread compares as changed only where something happened at or after
 * `since`: its opening, for a thread never read before, or its close.
 */
function previousMarkerFor(row: PolledIssue, cursor: ThreadCursor, since: string): string | undefined {
  const current = polledMarker(row);
  const known = cursor.seen !== null;
  if (known && cursor.marker !== undefined) {
    if (row.state === 'closed' && isClosedMarker(cursor.marker)) {
      return later(row.closedAt, cursor.seen) ? undefined : current;
    }
    return cursor.marker;
  }
  if (!known && atOrAfter(row.createdAt, since)) return undefined;
  if (row.state === 'closed' && atOrAfter(row.closedAt, since)) return undefined;
  return current;
}

/**
 * The `since` `normalizePolledIssue` tells an opening by (`createdAt` at or
 * after it). Only a thread never read before can have opened since W; for one
 * read before, the instant after its creation says it didn't.
 */
function openedSince(row: PolledIssue, known: boolean, since: string): string {
  const created = ms(row.createdAt);
  return known && Number.isFinite(created) ? new Date(created + 1).toISOString() : since;
}

/** One candidate event, with the time it sorts by. */
interface Candidate {
  event: NormalizedEvent;
  at: string;
}

/** The thread a retry entry names. */
const retryThread = (r: NotificationRetry): ThreadRef => ({ repo: { owner: r.owner, name: r.name }, number: r.number, kind: r.kind });

/**
 * A retry entry for a thread: the passes it has failed in a row, its cursor,
 * so eviction from the head memory can't lose its place, and a review request
 * not yet delivered.
 */
const retryEntry = (
  thread: ThreadRef,
  attempts: number,
  cursor: string | null,
  reviewRequest?: { id: string; updatedAt: string },
): NotificationRetry => ({
  owner: thread.repo.owner,
  name: thread.repo.name,
  number: thread.number,
  kind: thread.kind,
  attempts,
  ...(cursor === null ? {} : { cursor }),
  ...(reviewRequest === undefined ? {} : { reviewRequest }),
});

/** A thread whose new rows are more than one read takes, with its row as read, so its cursor can move to its current update. */
class BacklogTooLarge extends Error {
  constructor(readonly row: PolledIssue) {
    super('more new comments or reviews than one read takes');
  }
}

/**
 * Why a thread's read or delivery failed: `lasting` will fail the same way
 * again (gone, out of reach), `rate-limit` is GitHub's and passes with time,
 * `backlog` is more new rows than one read takes, and `failed` is anything
 * else. `cause` is written for the agent.
 */
interface ThreadFailure {
  kind: 'lasting' | 'rate-limit' | 'failed' | 'backlog';
  cause: string;
}

/**
 * Who a server-made event comes from: neither GitHub nor the agent. No GitHub
 * account can have this login (a login is letters, digits and hyphens), so it
 * is never the token's own, and the event is never from-self.
 */
const SERVER_ACTOR: EventActor = { login: 'github-mcpl[server]', isBot: true };

/**
 * How long a pull request's head, as last read, stands while its `updated_at`
 * does: GitHub's stamps are whole seconds, and the search's can lag a push,
 * so an unchanged one doesn't prove the head unmoved for long.
 */
export const HEAD_READ_TTL_MS = 10 * 60_000;

/**
 * How long after its head was read a pull request with no check runs at all
 * counts as having none to wait for, until its head is read again. A choice,
 * not a measured bound: runs a push's CI creates later than this arrive with
 * the next head read, up to {@link HEAD_READ_TTL_MS} after the last.
 */
export const NO_CHECKS_SETTLE_MS = 2 * 60_000;

/** The longest delay setTimeout keeps; a longer one fires after a millisecond. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export class NotificationsPoller {
  private readonly api: NotificationsPollerApi;
  private readonly state: NotificationsIngressState;
  private readonly configuredIntervalMs: number;
  private readonly repos: readonly RepoRef[];
  private readonly login: string;
  private readonly onEvent: EventListener;
  private readonly logger: Logger;
  private readonly now: () => Date;
  /**
   * Each own open pull request's head as last read, with its `updated_at`
   * then, when it was read, and whether its checks' finished result was
   * delivered, by channel.
   */
  private readonly heads = new Map<string, { updatedAt: string; sha: string; readAt: number; settled: boolean }>();
  /** Where the next pass's check lookups start among the own open pull requests, when there are more than one pass looks up. */
  private checkTurn = 0;
  /** The last `X-Poll-Interval` the API reported, in ms. */
  private serverIntervalMs = 0;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private pass: Promise<unknown> = Promise.resolve();

  constructor(opts: NotificationsPollerOptions) {
    this.api = opts.api;
    this.state = opts.state;
    this.configuredIntervalMs = opts.intervalMs;
    this.repos = opts.repos;
    this.login = opts.login ?? '';
    this.onEvent = opts.onEvent;
    this.logger = opts.logger ?? silentLogger();
    this.now = opts.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.configuredIntervalMs > 0;
  }

  /**
   * Same floor rule as poller.ts's `Poller.effectiveIntervalMs`: never below
   * the floor or the configured interval, and never below the last
   * `X-Poll-Interval` GitHub sent, which can go down again as well as up.
   * Never above what setTimeout keeps, either, so an interval set to mean
   * "hardly ever" doesn't poll every millisecond.
   */
  get effectiveIntervalMs(): number {
    return Math.min(MAX_TIMER_MS, Math.max(MIN_POLL_INTERVAL_MS, this.configuredIntervalMs, this.serverIntervalMs));
  }

  /** Take `X-Poll-Interval` (seconds) as GitHub's latest word; an absent or unreadable header changes nothing. */
  observePollInterval(seconds: number | null): number {
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return this.effectiveIntervalMs;
    const asMs = Math.round(seconds * 1000);
    if (asMs !== this.serverIntervalMs) {
      this.serverIntervalMs = asMs;
      this.logger.info('poll interval reported by the notifications API', {
        headerSeconds: seconds,
        effectiveMs: this.effectiveIntervalMs,
      });
    }
    return this.effectiveIntervalMs;
  }

  start(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    // The first pass runs an interval from now; a first start's W is taken
    // now, so that pass lists from an interval before the start.
    this.watermark();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async whenIdle(): Promise<void> {
    await this.pass;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      const pass = this.pollOnce()
        .catch((err: unknown) => {
          this.logger.error('notifications poll pass failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => this.schedule());
      this.pass = pass;
    }, this.effectiveIntervalMs);
    this.timer.unref?.();
  }

  /**
   * W as stored, or, at a first start, one interval before now, as App mode's
   * repository poll begins. That start is stored at once, so a failed first
   * pass doesn't move it, and logged, so an operator knows where delivery began.
   */
  private watermark(): NotificationsWatermark & { since: string } {
    const stored = this.state.notificationsWatermark();
    if (stored.since !== null) {
      return { since: isoSeconds(ms(stored.since)), lastModified: stored.lastModified, answeredAt: stored.answeredAt };
    }
    const since = isoSeconds(this.now().getTime() - this.effectiveIntervalMs);
    this.state.setNotificationsWatermark({ since, lastModified: null, answeredAt: null });
    this.state.flush().catch((err: unknown) => {
      this.logger.warn('state flush failed', { error: err instanceof Error ? err.message : String(err) });
    });
    this.logger.info('notifications: no usable stored watermark, so delivery begins one interval before this start', { since });
    return { since, lastModified: null, answeredAt: null };
  }

  /**
   * One pass: list the threads GitHub updated since W and read each, with
   * every thread a past pass failed on; deliver what's new; move W on.
   */
  async pollOnce(): Promise<NotificationsPollResult> {
    const receivedAt = this.now().toISOString();
    const { since, lastModified, answeredAt } = this.watermark();
    // A new thread listed now wasn't in GitHub's previous answer, so what's
    // new on it came after that answer, less the notification's delay. Before
    // GitHub has answered, W.
    const reachFrom = answeredAt ?? since;

    const page = await this.api.listNotifications({ since, ifModifiedSince: lastModified });
    this.observePollInterval(page.pollIntervalSeconds);

    const result: NotificationsPollResult = {
      notModified: page.notModified,
      threads: 0,
      outOfScope: 0,
      delivered: [],
      duplicates: 0,
      failed: 0,
      dropped: 0,
      truncated: page.truncated,
      checkLookups: 0,
    };

    // The threads to read: first those a past pass failed on, so a busy
    // listing can't keep them waiting, then those listed in scope. A retry
    // outside GITHUB_REPOS (narrowed since it failed) is dropped unread.
    const retries = new Map<string, NotificationRetry>();
    let retriesOutOfScope = 0;
    for (const retry of this.state.notificationRetries()) {
      if (repoAllowed({ owner: retry.owner, name: retry.name }, this.repos)) retries.set(channelId(retryThread(retry)), retry);
      else retriesOutOfScope += 1;
    }
    if (retriesOutOfScope > 0) {
      result.outOfScope += retriesOutOfScope;
      this.logger.info('notifications: threads on the retry list are outside GITHUB_REPOS now, so they are dropped unread', {
        threads: retriesOutOfScope,
      });
    }
    this.state.setNotificationRetries([...retries.values()]);
    const toRead = new Map<string, ThreadRef>();
    // The review requests to deliver, by channel: those a retry entry kept,
    // since a later listing won't show them again, and those listed now. A
    // thread has one notification, so a newer update of it with the same
    // reason supersedes a request still waiting: it says the same thing.
    const requests = new Map<string, { id: string; updatedAt: string }>();
    for (const [channel, retry] of retries) {
      toRead.set(channel, retryThread(retry));
      if (retry.reviewRequest) requests.set(channel, retry.reviewRequest);
    }
    for (const n of page.notifications) {
      const thread: ThreadRef = { repo: n.repo, number: n.number, kind: n.kind };
      if (!repoAllowed(n.repo, this.repos)) {
        result.outOfScope += 1;
        continue;
      }
      if (!toRead.has(channelId(thread))) toRead.set(channelId(thread), thread);
      if (n.reason === 'review_requested' && n.kind === 'pull') requests.set(channelId(thread), { id: n.id, updatedAt: n.updatedAt });
    }
    result.threads = toRead.size;

    // The dedup ring as it stands, copied once a pass; each delivery adds its key.
    const alreadySeen = new Set(this.state.snapshot().pollKeys);
    let rateLimited = 0;
    for (const [channel, thread] of toRead) {
      const waiting = retries.get(channel);
      const attemptsSoFar = waiting?.attempts ?? 0;
      const request = requests.get(channel);
      if (rateLimited > 0) {
        // GitHub's rate limit ended this pass's reads: the rest wait for the next, uncounted.
        retries.set(channel, retryEntry(thread, attemptsSoFar, this.holdPlace(thread, reachFrom, waiting?.cursor ?? null), request));
        rateLimited += 1;
        continue;
      }
      const outcome = await this.pollThread(thread, reachFrom, receivedAt, alreadySeen, waiting?.cursor ?? null, request);
      result.delivered.push(...outcome.delivered);
      result.duplicates += outcome.duplicates;
      if (outcome.failure === null) {
        retries.delete(channel);
      } else {
        result.failed += 1;
        const place = this.state.polledHead(`notif:${channel}`);
        if (outcome.failure.kind === 'rate-limit') {
          rateLimited = 1;
          // To the back of the list, so the thread that met the limit can't keep the rest waiting.
          retries.delete(channel);
          retries.set(channel, retryEntry(thread, attemptsSoFar, place, outcome.request));
        } else {
          const attempts = attemptsSoFar + 1;
          if (outcome.failure.kind !== 'failed' || attempts >= NOTIFICATION_RETRY_LIMIT) {
            retries.delete(channel);
            result.dropped += 1;
            result.delivered.push(...(await this.announceDrop(thread, outcome.failure, attempts, receivedAt)));
            // A skipped backlog leaves the thread readable from its current
            // update, so a review request refused beside it is read again with it.
            if (outcome.failure.kind === 'backlog' && outcome.request && attempts < NOTIFICATION_RETRY_LIMIT) {
              retries.set(channel, retryEntry(thread, attempts, place, outcome.request));
            }
          } else {
            retries.set(channel, retryEntry(thread, attempts, place, outcome.request));
          }
        }
      }
      this.state.setNotificationRetries([...retries.values()]);
      await this.state.flush();
    }
    if (rateLimited > 0) {
      this.state.setNotificationRetries([...retries.values()]);
      await this.state.flush();
      this.logger.warn('notifications: GitHub rate-limited a read, so this pass read no further; those threads are read next pass', {
        threads: rateLimited,
      });
    } else {
      const checks = await this.pollOwnChecks(receivedAt, alreadySeen);
      result.delivered.push(...checks.delivered);
      result.duplicates += checks.duplicates;
      result.checkLookups = checks.lookups;
    }

    const next = page.notModified ? since : nextWatermark(page, since);
    if (page.truncated) {
      this.logger.error('notifications: the listing stopped at its page cap, so some threads GitHub notified between since and until may not have been listed or read', {
        since,
        until: next,
        listed: page.notifications.length,
      });
    }
    // W moves only on what a listing showed; a 304 leaves it, and records when GitHub answered.
    const answered = ms(page.date);
    this.state.setNotificationsWatermark({
      since: next,
      lastModified: page.notModified ? lastModified : conditional(page),
      answeredAt: isoSeconds(Number.isFinite(answered) ? answered : ms(receivedAt)),
    });
    await this.state.flush();
    return result;
  }

  /**
   * Read one thread and deliver its new activity. The state event moves `seen`
   * and the marker once it was delivered, so a refused comment can't make a
   * delivered close come again. The cursor's `since` moves only once every row
   * and the state event were delivered, so a refused opening is judged again
   * from where it was, and its rows come again to the dedup ring.
   */
  private async pollThread(
    thread: ThreadRef,
    reachFrom: string,
    receivedAt: string,
    alreadySeen: Set<string>,
    held: string | null,
    request: { id: string; updatedAt: string } | undefined,
  ): Promise<{
    delivered: NormalizedEvent[];
    duplicates: number;
    failure: ThreadFailure | null;
    /** The review request still to deliver, when it wasn't. */
    request?: { id: string; updatedAt: string };
  }> {
    const channel = channelId(thread);
    const cursorKey = `notif:${channel}`;
    // The head memory's cursor, or the one its retry entry kept if that was evicted.
    const stored = this.state.polledHead(cursorKey) ?? held;
    const cursor = unpackCursor(stored);
    if (stored !== null && cursor === NO_CURSOR) {
      this.logger.warn('notifications poll: a stored cursor was not one this poller writes, so the thread is read as never seen', { channel });
    }
    // A thread with no cursor starts a notification's delay before GitHub's
    // previous answer. One with a cursor starts a second early: GitHub's stamps
    // are whole seconds, and a row written in the second the cursor names may
    // have come after the read that set it.
    const since = cursor.since === null ? firstReadSince(reachFrom) : isoSeconds(ms(cursor.since) - 1000);

    const delivered: NormalizedEvent[] = [];
    let duplicates = 0;
    const deliver = async (candidates: Candidate[]): Promise<string | null> => {
      let refusal: string | null = null;
      for (const { event } of candidates) {
        const key = ringKey(event);
        if (alreadySeen.has(key) || cursor.edge.includes(key)) {
          duplicates += 1;
          continue;
        }
        try {
          await this.onEvent(event);
        } catch (err) {
          refusal = err instanceof Error ? err.message : String(err);
          this.logger.warn('notifications poll: event delivery failed; its key stays unrecorded for the next pass', { key, error: refusal });
          continue;
        }
        this.state.seenPollKey(key);
        alreadySeen.add(key);
        delivered.push(event);
      }
      return refusal;
    };

    const requestEvent = (row: PolledIssue): Candidate[] =>
      request ? [{ event: normalizeNotifiedReviewRequest(thread.repo, row, request, receivedAt), at: request.updatedAt }] : [];

    let read: { rows: Candidate[]; state: Candidate | null; row: PolledIssue };
    try {
      read = await this.readThread(thread, since, cursor, receivedAt);
    } catch (err) {
      if (err instanceof BacklogTooLarge) {
        // The same read would meet the same cap again: read the thread from its current update on.
        this.state.setPolledHead(cursorKey, packCursor({ ...cursor, since: err.row.updatedAt }));
        this.logger.warn('notifications poll: a thread has more new activity than one read takes; it is read from its current update on', {
          channel,
        });
        // A review request isn't one of the rows skipped: it still arrives,
        // and one refused waits on a retry entry of its own.
        const refused = await deliver(requestEvent(err.row));
        return {
          delivered,
          duplicates,
          failure: { kind: 'backlog', cause: 'it had more than 2,000 comments or reviews to read at once' },
          ...(request && refused !== null ? { request } : {}),
        };
      }
      const kind = isLastingFailure(err) ? 'lasting' : isRateLimit(err) ? 'rate-limit' : 'failed';
      this.logger.warn(
        kind === 'lasting'
          ? 'notifications poll: a thread is gone or out of reach'
          : 'notifications poll: reading a thread failed; it is read again next pass',
        { channel, error: err instanceof Error ? err.message : String(err) },
      );
      this.holdPlace(thread, reachFrom, held);
      return { delivered: [], duplicates: 0, failure: { kind, cause: describeFailure(err) }, ...(request ? { request } : {}) };
    }

    read.rows.sort((a, b) => (a.at === b.at ? a.event.id.localeCompare(b.event.id) : ms(a.at) - ms(b.at)));
    const rowsRefused = await deliver(read.rows);
    const stateRefused = read.state ? await deliver([read.state]) : null;
    // A review request comes with no row of the thread's, so it neither moves
    // nor holds the cursor: one refused waits on the retry entry instead.
    const requestRefused = await deliver(requestEvent(read.row));

    const through = rowsRefused === null && stateRefused === null;
    // The rows the next read takes again, from a second before its since: every
    // one of them was delivered now or before, once this read got through.
    const edgeFrom = ms(read.row.updatedAt) - 1000;
    this.state.setPolledHead(
      cursorKey,
      packCursor({
        since: through ? read.row.updatedAt : (cursor.since ?? since),
        seen: stateRefused === null ? read.row.updatedAt : cursor.seen,
        marker: stateRefused === null ? polledMarker(read.row) : cursor.marker,
        edge: through ? read.rows.filter((row) => ms(row.at) >= edgeFrom).map((row) => ringKey(row.event)) : cursor.edge,
      }),
    );
    const failure = rowsRefused ?? stateRefused ?? requestRefused;
    return {
      delivered,
      duplicates,
      failure: failure === null ? null : { kind: 'failed', cause: `the host refused one of its events (${failure})` },
      ...(request && requestRefused !== null ? { request } : {}),
    };
  }

  /**
   * The checks on the head of each open pull request the token's user
   * authored in GITHUB_REPOS: one search, then for each, up to
   * {@link MAX_CHECKED_PULLS_PER_POLL} a pass in turns, one `getCheckRuns`,
   * with a read of its head first when its `updated_at` moved since the last,
   * or that read is {@link HEAD_READ_TTL_MS} old. A head whose runs
   * have all finished is a `checks.completed` event as App mode's repository
   * poll makes it, keyed by its sha, conclusion and failed jobs, so each
   * result is delivered once and a re-run that changes it is news. Once its
   * result is delivered with every run finished, or it has had no runs for
   * {@link NO_CHECKS_SETTLE_MS} since its head was read, a head isn't looked
   * up again until its pull request's `updated_at` moves or its head read is
   * {@link HEAD_READ_TTL_MS} old, so a re-run on an unmoved head is seen on
   * the first look after that. A refused
   * one isn't recorded, so the pass that next looks at it delivers it.
   * GitHub's rate limit ends the lookups until the next pass; any other
   * failure skips that pull request this pass.
   */
  private async pollOwnChecks(
    receivedAt: string,
    alreadySeen: Set<string>,
  ): Promise<{ delivered: NormalizedEvent[]; duplicates: number; lookups: number }> {
    const out = { delivered: [] as NormalizedEvent[], duplicates: 0, lookups: 0 };
    if (!this.login) return out;
    let pulls: OwnPull[];
    try {
      pulls = await this.api.listOwnOpenPulls(this.login, this.repos);
    } catch (err) {
      this.logger.warn('notifications: listing the token user\'s open pull requests failed; their checks are looked up next pass', {
        error: err instanceof Error ? err.message : String(err),
      });
      return out;
    }
    const open = new Set(pulls.map((pull) => channelId({ repo: pull.repo, number: pull.number, kind: 'pull' })));
    for (const channel of this.heads.keys()) if (!open.has(channel)) this.heads.delete(channel);
    // Taken in turns, each pass starting where the last stopped, so none
    // waits for good behind the cap or a rate limit.
    const start = pulls.length === 0 ? 0 : this.checkTurn % pulls.length;
    const due = [...pulls.slice(start), ...pulls.slice(0, start)].slice(0, MAX_CHECKED_PULLS_PER_POLL);
    let tried = 0;
    if (pulls.length > MAX_CHECKED_PULLS_PER_POLL) {
      this.logger.info('notifications: more open pull requests than one pass looks up checks for; the rest wait their turn', {
        cap: MAX_CHECKED_PULLS_PER_POLL,
        open: pulls.length,
      });
    }
    const now = this.now().getTime();
    for (const pull of due) {
      const thread: ThreadRef = { repo: pull.repo, number: pull.number, kind: 'pull' };
      const channel = channelId(thread);
      let summary: ChecksSummary;
      try {
        const known = this.heads.get(channel);
        const stands = known !== undefined && known.updatedAt === pull.updatedAt && now - known.readAt < HEAD_READ_TTL_MS;
        if (stands && known.settled) {
          // Its result was delivered and nothing moved: looked up again once its update moves or the head read is old.
          tried += 1;
          continue;
        }
        if (!stands) {
          this.heads.set(channel, { updatedAt: pull.updatedAt, sha: await this.api.getPullHeadSha(thread), readAt: now, settled: false });
        }
        const sha = (this.heads.get(channel) as { sha: string }).sha;
        out.lookups += 1;
        summary = await this.api.getCheckRuns(pull.repo, sha);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (isRateLimit(err)) {
          this.logger.warn('notifications: GitHub rate-limited a check lookup, so this pass looked up no more', { channel, error });
          break;
        }
        tried += 1;
        this.logger.warn('notifications: looking up a pull request\'s checks failed; it is looked up again next pass', { channel, error });
        continue;
      }
      tried += 1;
      const head = this.heads.get(channel) as { settled: boolean; readAt: number };
      if (!isCompletedSummary(summary)) {
        // No runs a while after its head was read: nothing to wait for until it's read again.
        if (summary.total === 0 && now - head.readAt >= NO_CHECKS_SETTLE_MS) head.settled = true;
        continue;
      }
      const event = normalizePolledChecks(pull.repo, thread, summary, pull.html_url, receivedAt);
      const key = ringKey(event);
      // A failure while other runs go may yet gain failures of its own: not settled until they finish.
      const settles = summary.unfinished !== true;
      if (alreadySeen.has(key)) {
        out.duplicates += 1;
        head.settled = settles;
        continue;
      }
      try {
        await this.onEvent(event);
      } catch (err) {
        this.logger.warn('notifications: a checks event was refused; it is delivered when its pull request\'s turn comes again', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      this.state.seenPollKey(key);
      alreadySeen.add(key);
      head.settled = settles;
      out.delivered.push(event);
    }
    this.checkTurn = start + tried;
    await this.state.flush();
    return out;
  }

  /**
   * Every new comment, review comment and submitted review on one thread, and
   * its state event if it has one. The thread's row is read first, so its
   * `updated_at` bounds every row the reads after it could have missed.
   */
  private async readThread(
    thread: ThreadRef,
    since: string,
    cursor: ThreadCursor,
    receivedAt: string,
  ): Promise<{ rows: Candidate[]; state: Candidate | null; row: PolledIssue }> {
    const row = await this.api.getPolledThread(thread);
    let rows: Candidate[];
    try {
      rows = await this.readRows(thread, since, row, receivedAt);
    } catch (err) {
      if (err instanceof ReadCapError) throw new BacklogTooLarge(row);
      throw err;
    }

    const known = cursor.seen !== null;
    const stateEvent = normalizePolledIssue(
      thread.repo,
      row,
      receivedAt,
      openedSince(row, known, since),
      previousMarkerFor(row, cursor, since),
    );
    return { rows, state: stateEvent ? { event: stateEvent, at: row.updatedAt } : null, row };
  }

  /** A thread's comments since `since`, and for a pull request its review comments and reviews, as candidate events. */
  private async readRows(thread: ThreadRef, since: string, row: PolledIssue, receivedAt: string): Promise<Candidate[]> {
    const rows: Candidate[] = [];
    for (const comment of await this.api.listCommentsSince(thread, since)) {
      rows.push({ event: normalizePolledComment(thread.repo, comment, 'issue_comment', receivedAt), at: comment.updatedAt });
    }
    if (thread.kind === 'pull') {
      for (const comment of await this.api.listPullReviewCommentsSince(thread, since)) {
        rows.push({ event: normalizePolledComment(thread.repo, comment, 'review_comment', receivedAt), at: comment.updatedAt });
      }
      for (const review of await this.api.listReviewsSince(thread, since)) {
        rows.push({
          event: normalizePolledReview(thread.repo, thread, review, receivedAt, row.title),
          at: review.submittedAt,
        });
      }
    }
    return rows;
  }

  /**
   * Keep a thread's place while it waits on the retry list, and answer it for
   * the list's entry: a thread never read keeps where its first read would
   * have started, so a later read still covers what this one couldn't, and
   * rewriting the cursor keeps it among the newest in the bounded head memory.
   */
  private holdPlace(thread: ThreadRef, reachFrom: string, held: string | null): string {
    const cursorKey = `notif:${channelId(thread)}`;
    const cursor = unpackCursor(this.state.polledHead(cursorKey) ?? held);
    const place = packCursor({ ...cursor, since: cursor.since ?? firstReadSince(reachFrom) });
    this.state.setPolledHead(cursorKey, place);
    return place;
  }

  /**
   * Tell the agent, on the thread's own channel, that the poller stopped
   * reading a thread, and why. The server's own event handler doesn't throw:
   * it drops an event with no host to send it to, and catches its own build
   * and send failures. So a refusal here comes from a listener that throws,
   * and it's logged; nothing else carries it.
   */
  private async announceDrop(thread: ThreadRef, failure: ThreadFailure, attempts: number, receivedAt: string): Promise<NormalizedEvent[]> {
    const channel = channelId(thread);
    const said =
      failure.kind === 'backlog'
        ? `github-mcpl skipped this thread's backlog: ${failure.cause}, more than one read takes. ` +
          'It reads the thread from its latest update on, so its new activity arrives as usual.'
        : `github-mcpl stopped reading this thread's new activity: ${
            failure.kind === 'lasting'
              ? `${failure.cause}, so the thread is gone or out of this token's reach`
              : `its last ${attempts} attempts in a row failed (the last: ${failure.cause})`
          }. It reads the thread again if it moves on GitHub.`;
    const event: NormalizedEvent = {
      id: `poll:read_failed:${channel}:${receivedAt}`,
      receivedAt,
      repo: thread.repo,
      kind: 'thread.read_failed',
      thread,
      actor: SERVER_ACTOR,
      html_url: `https://github.com/${thread.repo.owner}/${thread.repo.name}/${thread.kind === 'pull' ? 'pull' : 'issues'}/${thread.number}`,
      body: said,
    };
    if (failure.kind === 'backlog') this.logger.warn('notifications: skipped a thread\'s backlog; it is read from its latest update on', { channel });
    else this.logger.error('notifications: stopped reading a thread until it next moves', { channel, attempts, error: failure.cause });
    try {
      await this.onEvent(event);
      return [event];
    } catch (err) {
      this.logger.error('notifications: the event announcing a dropped thread was refused', {
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}

/** Where a thread with no cursor starts its reads: {@link NOTIFICATION_DELAY_MS} before GitHub's previous answer (W at a first start). */
function firstReadSince(reachFrom: string): string {
  return isoSeconds(ms(reachFrom) - NOTIFICATION_DELAY_MS);
}

/**
 * W for the next listing: the listing's `Last-Modified`, or failing that the
 * newest stamp it listed, a second early, so a thread GitHub updated in that
 * second is listed again rather than missed. W rests only on stamps a listing
 * showed: it never goes back before `since`, and stays there when a listing
 * without `Last-Modified` listed nothing.
 */
function nextWatermark(page: NotificationsPage, since: string): string {
  const newestListed = page.notifications.reduce((max, n) => Math.max(max, ms(n.updatedAt) || 0), 0);
  const stamp = page.lastModified !== null ? ms(page.lastModified) : newestListed > 0 ? newestListed : Number.NaN;
  if (!Number.isFinite(stamp)) return since;
  return isoSeconds(Math.max(stamp - 1000, ms(since)));
}

/**
 * The `If-Modified-Since` for the next listing: this one's `Last-Modified`,
 * unless the inbox changed in the second GitHub answered, when something
 * written later in that second would get a 304. Then the next listing goes
 * unconditional.
 */
function conditional(page: NotificationsPage): string | null {
  if (page.lastModified === null) return null;
  const changed = ms(page.lastModified);
  const answered = ms(page.date);
  if (Number.isFinite(answered) && Number.isFinite(changed) && answered - changed < 1000) return null;
  return page.lastModified;
}
