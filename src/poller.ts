/**
 * Polling ingress (TASK-SRHKG.1.3, §Ingress, as amended by contract
 * amendment 1).
 *
 * The contract's first draft polled `GET /notifications`; an App installation
 * token cannot read that endpoint, so the fallback asks the repository what
 * changed since its cursor instead — `listIssuesSince`,
 * `listIssueCommentsSince`, `listReviewCommentsSince` — and derives the check
 * state of the open pull-request heads it saw from `getCheckRuns`.
 *
 * Two properties the acceptance criteria name, and where they live:
 *
 *   - **The interval floor.** `effectiveIntervalMs` is never below
 *     `MIN_POLL_INTERVAL_MS` (60 s) and never below GITHUB_POLL_INTERVAL_MS;
 *     a server-sent `X-Poll-Interval` can only raise it, through
 *     {@link Poller.observePollInterval}.
 *   - **Record only after delivery.** The dedup ring is read once per pass
 *     and a key is written back only once its event has been handed to the
 *     listener without throwing, so a failed delivery is re-attempted on the
 *     next pass instead of being silently consumed. The cursors advance for
 *     the same reason: only when the whole pass delivered.
 *
 * Each repository's three lists keep a cursor of their own
 * ({@link PollCursor}), so a list whose read the page bound stopped reads on
 * from where it stopped, while the rest move to the start of the pass.
 */

import {
  shouldEmitChecks,
  atOrAfter,
  CheckGate,
  checkMarkOf,
  checksPollKey,
  isCompletedSummary,
  normalizePolledChecks,
  normalizePolledComment,
  normalizePolledIssue,
  polledMarker,
  pollKey,
  type PollRowKind,
} from './normalize.js';
import {
  channelId,
  MIN_POLL_INTERVAL_MS,
  repoSlug,
  silentLogger,
  type GitHubApi,
  type Logger,
  type ChecksSummary,
  type ChecksEmit,
  type NormalizedEvent,
  type PolledComment,
  type PolledIssue,
  type PollCursor,
  type PollRead,
  type RepoRef,
  type ThreadRef,
} from './types.js';
import type { EventListener } from './webhook.js';

/** Amendment 1: "at most 20 PRs per poll" get their check runs fetched. */
export const MAX_CHECKED_PULLS_PER_POLL = 20;

/**
 * How many pull-request heads may wait for a check lookup at once.
 *
 * The backlog exists because the issue cursor is not a work queue: it moves
 * forward whether or not the check lookups it implied succeeded, so a head
 * whose lookup failed, or that the {@link MAX_CHECKED_PULLS_PER_POLL} cap cut
 * off, or whose runs had not finished yet, would otherwise be dropped and
 * never asked about again. At the 60 s floor and 20 lookups a pass, this many
 * heads drain in ten minutes; past it the oldest head is forgotten, which
 * bounds the backlog against a repository that updates pull requests faster
 * than the poller can check them.
 */
export const MAX_HEAD_BACKLOG = 200;

/**
 * How many passes a head may report nothing — a failing lookup, or a sha with
 * no check runs at all — before the poller gives up on it. A head whose runs
 * are merely still going does not spend an attempt: that is progress, and CI
 * is allowed to take longer than ten minutes.
 */
export const MAX_HEAD_ATTEMPTS = 10;

/** The part of {@link GitHubApi} the poller uses. */
export type PollerApi = Pick<
  GitHubApi,
  'listIssuesSince' | 'listIssueCommentsSince' | 'listReviewCommentsSince' | 'getCheckRuns'
>;

/**
 * The durable state the poller needs: the cursors, the dedup ring and the last
 * polled head of each open pull request (amendment 2a). A structural subset of
 * `StateStore` (types.ts), which .7 implements over GITHUB_STATE_FILE —
 * `snapshot()` is in the interface so that the ring can be *read* without
 * being written to, which is what lets a key be recorded only after its event
 * was delivered.
 */
export interface IngressState {
  lastPollAt(): string | null;
  setLastPollAt(when: string): void;
  /** Each list's own cursor, keyed by {@link pollCursorKey}. */
  pollCursors(): Readonly<Record<string, PollCursor>>;
  /** Replace them all: a list left out starts from `lastPollAt` next time. */
  setPollCursors(cursors: Record<string, PollCursor>): void;
  /** Per list, the rows announced as new in its window, id → created_at. */
  polledNew(): Readonly<Record<string, Record<string, string>>>;
  setPolledNew(rows: Record<string, Record<string, string>>): void;
  /** Records `key` in the ring and reports whether it was already there. */
  seenPollKey(key: string): boolean;
  /** The head sha the last pass recorded for this pull request, or null. */
  polledHead(channel: string): string | null;
  setPolledHead(channel: string, sha: string): void;
  /** Read-only view; the poller reads `pollKeys` once per pass. */
  snapshot(): { pollKeys: string[] };
}

export interface PollerOptions {
  /** GITHUB_CHECKS_EMIT; omitted preserves all legacy events. */
  checksEmit?: ChecksEmit;
  api: PollerApi;
  /** GITHUB_REPOS. The poller only ever asks these repositories. */
  repos: readonly RepoRef[];
  state: IngressState;
  /** GITHUB_POLL_INTERVAL_MS. 0 means polling is off and `start()` is a no-op. */
  intervalMs: number;
  onEvent: EventListener;
  logger?: Logger;
  /** Overridable in tests. */
  now?: () => Date;
  maxCheckedPulls?: number;
  maxHeadBacklog?: number;
  maxHeadAttempts?: number;
  /**
   * The "one `checks.completed` per head sha" gate. Pass the webhook
   * listener's own gate when both ingress paths are live, so an emission from
   * one path is serialized against the other instead of racing it.
   */
  checkGate?: CheckGate;
}

/** The three lists the poller reads from each repository. */
export type PollList = 'issues' | 'issue_comments' | 'review_comments';

/** `<owner>/<name>:<list>`, the key of a list's cursor in the state. */
export function pollCursorKey(repo: RepoRef, list: PollList): string {
  return `${repoSlug(repo)}:${list}`;
}

/** What one pass did, for the caller's diagnostics and for the tests. */
export interface PollResult {
  /**
   * The start of a list with no cursor of its own: the stored `lastPollAt`
   * as kept, or one interval back in whole seconds. The list asks GitHub from
   * its whole second.
   */
  since: string;
  /** Events handed to the listener, in order. */
  delivered: NormalizedEvent[];
  /** Candidates whose key was already in the ring. */
  duplicates: number;
  /** Events whose listener threw; their keys were not recorded. */
  failed: number;
  /**
   * Whether the cursors moved: each list's to the start of this pass, or, for
   * a read the page bound stopped, to where it stopped.
   */
  cursorAdvanced: boolean;
  /** `getCheckRuns` calls this pass made; never above the cap. */
  checkLookups: number;
  /** Heads still waiting for a conclusion when the pass ended. */
  checksBacklog: number;
}

/**
 * A pull-request head waiting for its check runs to settle. Held across
 * passes, keyed `<owner>/<name>@<sha>`, independent of the issue cursor.
 */
/**
 * What became of one hand-off: the listener took it, or another accepted
 * emission for the same head sha already covered it, or the emission policy
 * suppressed it. A refusal throws.
 */
type HandOff = 'delivered' | 'covered' | 'suppressed';

interface PendingHead {
  repo: RepoRef;
  sha: string;
  number: number;
  html_url: string;
  /** The row's `updated_at`, kept so a check candidate sorts chronologically. */
  at: string;
  /** Passes that reported nothing; {@link MAX_HEAD_ATTEMPTS} gives up. */
  attempts: number;
}

interface Candidate {
  key: string;
  event: NormalizedEvent;
  /** Sort key: the row's `updated_at`, so a pass delivers chronologically. */
  at: string;
  /**
   * The backlog entry this candidate settles, if any. The head is retired
   * only once the listener has accepted the event (or the ring confirms it was
   * already delivered): a head removed at lookup time would be unrecoverable
   * once the cursor had moved past the pull-request row that queued it.
   */
  retires?: string;
  /**
   * The pull-request head this candidate's event announces, committed to
   * `pollHeads` on exactly the same terms as {@link Candidate.retires}:
   * **only once the listener has accepted the event.**
   *
   * Writing it at collection time lost a refused `pull.synchronize` for good
   * (review round 2, finding 1). The cursor is held back by the refusal, so
   * the row is queried again — but the next pass compared it against the head
   * already saved, found no change, dropped the row, and let the cursor move
   * on. The commits were never announced and nothing retried them, which is
   * exactly the guarantee {@link Poller.pollOnce} documents. A row that
   * produced *no* event is different: its head did not move, so recording it
   * at collection time loses nothing.
   */
  head?: { channel: string; sha: string };
  /**
   * An issue row announced as new, remembered in `pollNew` on the same terms
   * as {@link Candidate.head}, so a refused pass's accepted openings stay
   * remembered when the retry reads them again.
   */
  fresh?: { list: string; id: string; createdAt: string };
}

/**
 * An instant as a whole second, in the cursor's form. GitHub stamps rows to
 * the second, and a `since` part way through a second leaves out the rows
 * stamped in it.
 */
function wholeSecond(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

/** A stored position as a whole second, whatever spelling or precision it was kept in. */
function atSecond(iso: string): string {
  return wholeSecond(Date.parse(iso));
}

export class Poller {
  private readonly api: PollerApi;
  private readonly repos: readonly RepoRef[];
  private readonly state: IngressState;
  private readonly configuredIntervalMs: number;
  private readonly onEvent: EventListener;
  private readonly checksEmit: ChecksEmit;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly maxCheckedPulls: number;
  private readonly maxHeadBacklog: number;
  private readonly maxHeadAttempts: number;
  private readonly checkGate: CheckGate;
  /**
   * Heads waiting for a conclusion, oldest first. Insertion order is the
   * drain order, and a head the pass could not settle is moved to the back,
   * so a backlog longer than the per-pass cap still drains round-robin.
   */
  private readonly backlog = new Map<string, PendingHead>();
  /** The last `X-Poll-Interval` the API reported, in ms. Can only raise. */
  private serverIntervalMs = 0;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private pass: Promise<unknown> = Promise.resolve();

  constructor(opts: PollerOptions) {
    this.checksEmit = opts.checksEmit ?? 'all';
    this.api = opts.api;
    this.repos = opts.repos;
    this.state = opts.state;
    this.configuredIntervalMs = opts.intervalMs;
    this.onEvent = opts.onEvent;
    this.logger = opts.logger ?? silentLogger();
    this.now = opts.now ?? (() => new Date());
    this.maxCheckedPulls = opts.maxCheckedPulls ?? MAX_CHECKED_PULLS_PER_POLL;
    this.maxHeadBacklog = opts.maxHeadBacklog ?? MAX_HEAD_BACKLOG;
    this.maxHeadAttempts = opts.maxHeadAttempts ?? MAX_HEAD_ATTEMPTS;
    this.checkGate = opts.checkGate ?? new CheckGate();
  }

  /** Heads still waiting for their check runs to settle. */
  get checkBacklogSize(): number {
    return this.backlog.size;
  }

  /** GITHUB_POLL_INTERVAL_MS = 0: polling off. */
  get enabled(): boolean {
    return this.configuredIntervalMs > 0;
  }

  /**
   * The delay the next pass waits. The 60 s floor and GITHUB_POLL_INTERVAL_MS
   * are both floors, and a server-sent interval can only push it up.
   */
  get effectiveIntervalMs(): number {
    return Math.max(MIN_POLL_INTERVAL_MS, this.configuredIntervalMs, this.serverIntervalMs);
  }

  /**
   * Honour an `X-Poll-Interval` response header (seconds). Returns the
   * interval now in force. A value that would poll faster than the floor is
   * recorded but cannot lower it.
   */
  observePollInterval(value: string | number | null | undefined): number {
    const seconds = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) return this.effectiveIntervalMs;
    const asMs = Math.round(seconds * 1000);
    if (asMs !== this.serverIntervalMs) {
      this.serverIntervalMs = asMs;
      this.logger.info('poll interval reported by the API', {
        headerSeconds: seconds,
        effectiveMs: this.effectiveIntervalMs,
      });
    }
    return this.effectiveIntervalMs;
  }

  /** Start the loop. The first pass runs after one interval, not immediately. */
  start(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Resolve once the in-flight pass, if any, has finished. */
  async whenIdle(): Promise<void> {
    await this.pass;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      const pass = this.pollOnce()
        .catch((err: unknown) => {
          this.logger.error('poll pass failed', { error: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => this.schedule());
      this.pass = pass;
    }, this.effectiveIntervalMs);
    // A poll timer must never be the reason the process stays alive.
    this.timer.unref?.();
  }

  /**
   * One pass: query every allow-listed repository's lists since their cursors, drain as
   * much of the check backlog as the per-pass cap allows, drop what the dedup
   * ring already holds, deliver the rest oldest-first, record each key after
   * its delivery, and advance the cursors if no delivery failed.
   *
   * A failed *lookup* does not hold the cursors back: the head stays in the
   * backlog instead, which is the thing that gets retried. A failed
   * *delivery* does hold it back, so its row is queried again.
   *
   * For that retry to mean anything, nothing a refused event would be
   * recognised by on the next pass may be written before it is accepted.
   * Three things are therefore committed inside the delivery loop and nowhere
   * else: the dedup key, the pull-request head a `pull.synchronize` announces
   * ({@link Candidate.head}), and a row announced as new ({@link Candidate.fresh}).
   */
  async pollOnce(): Promise<PollResult> {
    const startedAt = this.now();
    const stored = this.state.lastPollAt();
    const since = stored ?? wholeSecond(startedAt.getTime() - this.effectiveIntervalMs);
    // A first pass keeps the window it reads before it reads, so however the
    // pass ends, refused or thrown, the next asks from the same start rather
    // than one the clock has moved on.
    if (stored === null) this.state.setLastPollAt(since);
    const receivedAt = startedAt.toISOString();
    // Where a list read to the end starts next: this pass's start, so a row
    // changed after its read is asked for, in whole seconds, so its second is too.
    const startSecond = wholeSecond(startedAt.getTime());

    const candidates: Candidate[] = [];
    // Where each list reads from next, written only if the pass delivers. A
    // repository no longer in GITHUB_REPOS drops out of it.
    const cursors: Record<string, PollCursor> = {};
    for (const repo of this.repos) {
      candidates.push(...(await this.collectRows(repo, since, startSecond, receivedAt, cursors)));
    }
    // One drain for every repository together, so the cap is a cap on the
    // pass and not on each repository in turn.
    const checks = await this.drainHeadBacklog(receivedAt);
    candidates.push(...checks.candidates);
    candidates.sort((a, b) => (a.at === b.at ? a.key.localeCompare(b.key) : a.at.localeCompare(b.at)));

    // One read of the ring per pass: the write happens after delivery.
    const alreadySeen = new Set(this.state.snapshot().pollKeys);
    const result: PollResult = {
      since,
      delivered: [],
      duplicates: 0,
      failed: 0,
      cursorAdvanced: false,
      checkLookups: checks.lookups,
      // Filled in after the delivery loop: a head is only retired once its
      // event has been accepted, so the size before the loop means nothing.
      checksBacklog: 0,
    };
    const deliveredThisPass = new Set<string>();

    for (const candidate of candidates) {
      // A head leaves the backlog once this event is known to be delivered —
      // by this pass, or by an earlier one, or by the webhook path.
      const retire = (): void => {
        if (candidate.retires !== undefined) this.backlog.delete(candidate.retires);
      };
      // Committed on exactly the terms `retire` is: the listener took the
      // event, or the ring says an earlier pass already got it through.
      const commitHead = (): void => {
        if (candidate.head) this.state.setPolledHead(candidate.head.channel, candidate.head.sha);
        if (candidate.fresh) {
          const { list, id, createdAt } = candidate.fresh;
          const all = { ...this.state.polledNew() };
          all[list] = { ...all[list], [id]: createdAt };
          this.state.setPolledNew(all);
        }
      };

      if (alreadySeen.has(candidate.key) || deliveredThisPass.has(candidate.key)) {
        result.duplicates += 1;
        retire();
        commitHead();
        continue;
      }

      let outcome: HandOff;
      try {
        outcome = await this.hand(candidate.event);
      } catch (err) {
        // Nothing is recorded and nothing is retired: the key stays out of
        // the dedup ring, the head stays in the backlog, and the cursors are
        // held back below, so the next pass tries again.
        result.failed += 1;
        this.logger.warn('poll event delivery failed; its key stays unrecorded for the next pass', {
          key: candidate.key,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (outcome === 'covered') {
        // Another emission for this head sha was accepted and said everything
        // this one would have, so the head is done — not waiting on anybody.
        result.duplicates += 1;
        retire();
        this.logger.info('poll checks result dropped: this head sha already reported this result or a stronger one', {
          sha: candidate.event.sha,
          conclusion: candidate.event.checks?.conclusion ?? null,
        });
        continue;
      }

      // Record accepted or deliberately suppressed results, never refused ones.
      this.state.seenPollKey(candidate.key);
      deliveredThisPass.add(candidate.key);
      if (outcome !== 'suppressed') result.delivered.push(candidate.event);
      retire();
      commitHead();
    }

    result.checksBacklog = this.backlog.size;

    if (result.failed === 0) {
      this.state.setPollCursors(cursors);
      // Every list has delivered what changed before this pass's start, or
      // before where a stopped read stopped, whichever is earlier.
      const stops = Object.values(cursors).flatMap((cursor) => cursor.resumeAt ?? []);
      this.state.setLastPollAt([startSecond, ...stops].reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)));
      // A row stays remembered as announced new while it is created inside its
      // list's window, the only rows the window's start would call new again.
      const remembered: Record<string, Record<string, string>> = {};
      for (const [list, rows] of Object.entries(this.state.polledNew())) {
        const window = cursors[list]?.since;
        const kept = Object.entries(rows).filter(([, createdAt]) => window !== undefined && atOrAfter(createdAt, window));
        if (kept.length > 0) remembered[list] = Object.fromEntries(kept);
      }
      this.state.setPolledNew(remembered);
      result.cursorAdvanced = true;
    } else {
      this.logger.warn('poll cursors held back: a delivery failed in this pass, so every list reads it again', {
        failed: result.failed,
      });
    }
    this.logger.debug('poll pass done', {
      // Where a list with no cursor of its own started; the others started at their own.
      fallbackSince: since,
      delivered: result.delivered.length,
      duplicates: result.duplicates,
      failed: result.failed,
      checkLookups: result.checkLookups,
      checksBacklog: result.checksBacklog,
    });
    return result;
  }

  // ── One repository's rows ──

  /**
   * The issue, comment and review-comment rows one repository changed since
   * each list's cursor. Every open pull-request head it saw is *enqueued* for
   * a check lookup rather than looked up here, so the cap and the retries
   * belong to the backlog and not to one repository's turn.
   *
   * Each list's next cursor goes into `next`: the start of this pass when
   * the read reached the end of the list, and otherwise where it stopped,
   * with the window's start kept, since the rows past the stop are still
   * to be read.
   */
  private async collectRows(
    repo: RepoRef,
    fallback: string,
    startSecond: string,
    receivedAt: string,
    next: Record<string, PollCursor>,
  ): Promise<Candidate[]> {
    const cursors = this.state.pollCursors();
    const read = async <T>(list: PollList, ask: (from: string) => Promise<PollRead<T>>) => {
      const key = pollCursorKey(repo, list);
      // Stored positions are read as whole seconds, so one kept with
      // milliseconds, as by a release before this, starts at its second.
      const since = atSecond(cursors[key]?.since ?? fallback);
      const stop = cursors[key]?.resumeAt;
      const { rows, resumeAt } = await ask(stop === undefined ? since : atSecond(stop));
      next[key] = resumeAt === undefined ? { since: startSecond } : { since, resumeAt };
      return { rows, since, key };
    };
    const out: Candidate[] = [];

    const issues = await read('issues', (from) => this.api.listIssuesSince(repo, from));
    const announced = this.state.polledNew()[issues.key] ?? {};
    for (const row of issues.rows) {
      // What the last pass recorded for this thread (amendment 2a for a pull
      // request's head, a state-and-text fingerprint for an issue) turns a
      // real change into an event and drops the row a comment only bumped.
      const channel = channelId({ repo, number: row.number, kind: row.isPullRequest ? 'pull' : 'issue' });
      const seen = announced[String(row.id)] !== undefined;
      const event = normalizePolledIssue(repo, row, receivedAt, issues.since, this.state.polledHead(channel) ?? undefined, seen);
      const fresh = !seen && atOrAfter(row.createdAt, issues.since);
      const marker = polledMarker(row);
      const openHead = row.isPullRequest && row.state === 'open' && row.headSha ? row.headSha : undefined;
      if (event) {
        // The marker rides with the candidate and is committed on acceptance,
        // so a refusal leaves the poller still believing the old one and the
        // next pass announces the change again (finding 1). Deferring it also
        // means a `listIssueCommentsSince` that throws later in this very
        // method cannot leave a marker advanced for a pass that never delivered.
        out.push({
          key: pollKey('issue', row.id, row.updatedAt),
          event,
          at: row.updatedAt,
          ...(marker === undefined ? {} : { head: { channel, sha: marker } }),
          ...(fresh ? { fresh: { list: issues.key, id: String(row.id), createdAt: row.createdAt } } : {}),
        });
      } else if (marker !== undefined) {
        // No event: this row was dropped *because* the marker is unchanged, so
        // what is written here is the value already stored. It costs nothing
        // and refreshes the entry's place in the eviction order, which is why
        // a long-lived thread is not evicted ahead of ones nobody has looked
        // at since.
        this.state.setPolledHead(channel, marker);
      }
      if (openHead !== undefined) this.enqueueHead(repo, row);
    }

    const comments = await read('issue_comments', (from) => this.api.listIssueCommentsSince(repo, from));
    out.push(...this.commentCandidates(repo, comments.rows, 'issue_comment', receivedAt));
    const reviewComments = await read('review_comments', (from) => this.api.listReviewCommentsSince(repo, from));
    out.push(...this.commentCandidates(repo, reviewComments.rows, 'review_comment', receivedAt));

    return out;
  }

  // ── The check backlog ──

  /** Remember a head to check. An already-queued head keeps its place. */
  private enqueueHead(repo: RepoRef, row: PolledIssue): void {
    const sha = row.headSha as string;
    const key = CheckGate.key(repo, sha);
    const queued = this.backlog.get(key);
    if (queued) {
      // Same head seen again: refresh what the event will say, keep the
      // queue position and the attempt count.
      queued.at = row.updatedAt;
      queued.html_url = row.html_url;
      queued.number = row.number;
      return;
    }
    this.backlog.set(key, {
      repo,
      sha,
      number: row.number,
      html_url: row.html_url,
      at: row.updatedAt,
      attempts: 0,
    });
    if (this.backlog.size > this.maxHeadBacklog) {
      const oldest = this.backlog.keys().next();
      if (!oldest.done) {
        this.backlog.delete(oldest.value);
        this.logger.warn('poll head backlog full; forgot the oldest head waiting for checks', {
          forgot: oldest.value,
          cap: this.maxHeadBacklog,
        });
      }
    }
  }

  /**
   * Ask about as many waiting heads as the per-pass cap allows, oldest first.
   * A head that settled leaves the backlog with a candidate; a head that did
   * not is moved to the back, so the next pass starts with someone else and a
   * long backlog drains round-robin instead of starving behind the same 20.
   */
  private async drainHeadBacklog(receivedAt: string): Promise<{ candidates: Candidate[]; lookups: number }> {
    const due = [...this.backlog.values()].slice(0, this.maxCheckedPulls);
    if (this.backlog.size > due.length) {
      this.logger.info('poll check lookups capped; the rest of the backlog waits for the next pass', {
        cap: this.maxCheckedPulls,
        waiting: this.backlog.size - due.length,
      });
    }

    const candidates: Candidate[] = [];
    let lookups = 0;
    for (const head of due) {
      const key = CheckGate.key(head.repo, head.sha);
      lookups += 1;
      let summary: ChecksSummary;
      try {
        summary = await this.api.getCheckRuns(head.repo, head.sha);
      } catch (err) {
        this.retainHead(key, head, 'the check runs lookup failed', err);
        continue;
      }

      if (!isCompletedSummary(summary)) {
        if (summary.total === 0) {
          // Nothing is running on this sha and nothing has run: it may be a
          // head no workflow matches, so it ages out rather than waiting.
          this.retainHead(key, head, 'the head has no check runs');
        } else {
          // Runs exist and have not finished: `checks.completed` would be a
          // lie, so wait — and do not spend an attempt on real progress.
          this.rotateHead(key, head);
          this.logger.debug('poll head still running its checks', { sha: head.sha, runs: summary.total });
        }
        continue;
      }

      // Settled — but the head stays queued until the delivery loop retires
      // it, so a refused event can be retried even after the cursors have moved
      // past the pull-request row that queued this head (rule 2).
      this.rotateHead(key, head);
      const pull: ThreadRef = { repo: head.repo, number: head.number, kind: 'pull' };
      candidates.push({
        key: checksPollKey(summary),
        event: normalizePolledChecks(head.repo, pull, summary, head.html_url, receivedAt),
        at: head.at,
        retires: key,
      });
    }
    return { candidates, lookups };
  }

  /**
   * Hand one event to the listener. A `checks.completed` event goes through
   * the gate, which serializes it against every other emission for its head
   * sha and reports whether what the listener already accepted covers it; any
   * other event goes straight out. A refusal propagates.
   */
  private async hand(event: NormalizedEvent): Promise<HandOff> {
    const mark = checkMarkOf(event);
    if (mark === null) {
      await this.onEvent(event);
      return 'delivered';
    }
    const emit = shouldEmitChecks(event, this.checksEmit);
    const delivered = await this.checkGate.emit(event.repo, event.sha as string, mark, async () => {
      // Commit suppression through the same serialized gate as delivery.
      if (emit) await this.onEvent(event);
    });
    if (!emit) return 'suppressed';
    return delivered ? 'delivered' : 'covered';
  }

  /** Keep a head that reported nothing, until it has used up its attempts. */
  private retainHead(key: string, head: PendingHead, why: string, err?: unknown): void {
    head.attempts += 1;
    const fields = {
      repo: repoSlug(head.repo),
      sha: head.sha,
      attempts: head.attempts,
      why,
      ...(err === undefined ? {} : { error: err instanceof Error ? err.message : String(err) }),
    };
    if (head.attempts >= this.maxHeadAttempts) {
      this.backlog.delete(key);
      this.logger.warn('poll gave up on a pull-request head after too many empty passes', fields);
      return;
    }
    this.rotateHead(key, head);
    this.logger.debug('poll will ask about this head again next pass', fields);
  }

  /** Move to the back of the queue: a Map keeps insertion order. */
  private rotateHead(key: string, head: PendingHead): void {
    this.backlog.delete(key);
    this.backlog.set(key, head);
  }

  private commentCandidates(
    repo: RepoRef,
    rows: readonly PolledComment[],
    kind: Extract<PollRowKind, 'issue_comment' | 'review_comment'>,
    receivedAt: string,
  ): Candidate[] {
    return rows.map((row) => ({
      key: pollKey(kind, row.id, row.updatedAt),
      event: normalizePolledComment(repo, row, kind, receivedAt),
      at: row.updatedAt,
    }));
  }
}
