/**
 * An App installation token can't read `GET /notifications`, so polling asks
 * each repository what changed since its cursor.
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

export const MAX_CHECKED_PULLS_PER_POLL = 20;
const HEAD_BACKLOG_DRAIN_PASSES = 10;

export const MAX_HEAD_BACKLOG = HEAD_BACKLOG_DRAIN_PASSES * MAX_CHECKED_PULLS_PER_POLL;

export const MAX_HEAD_ATTEMPTS = 10;

export type PollerApi = Pick<
  GitHubApi,
  'listIssuesSince' | 'listIssueCommentsSince' | 'listReviewCommentsSince' | 'getCheckRuns'
>;

export interface IngressState {
  lastPollAt(): string | null;
  setLastPollAt(when: string): void;
  pollCursors(): Readonly<Record<string, PollCursor>>;
  setPollCursors(cursors: Record<string, PollCursor>): void;
  polledNew(): Readonly<Record<string, Record<string, string>>>;
  setPolledNew(rows: Record<string, Record<string, string>>): void;
  seenPollKey(key: string): boolean;
  polledHead(channel: string): string | null;
  setPolledHead(channel: string, sha: string): void;
  snapshot(): { pollKeys: string[] };
}

export interface PollerOptions {
  /** GITHUB_CHECKS_EMIT; omitted preserves all legacy events. */
  checksEmit?: ChecksEmit;
  api: PollerApi;
  repos: readonly RepoRef[];
  state: IngressState;
  intervalMs: number;
  onEvent: EventListener;
  logger?: Logger;
  now?: () => Date;
  maxCheckedPulls?: number;
  maxHeadBacklog?: number;
  maxHeadAttempts?: number;
  checkGate?: CheckGate;
}

export type PollList = 'issues' | 'issue_comments' | 'review_comments';

export function pollCursorKey(repo: RepoRef, list: PollList): string {
  return `${repoSlug(repo)}:${list}`;
}

export interface PollResult {
  since: string;
  delivered: NormalizedEvent[];
  duplicates: number;
  failed: number;
  cursorAdvanced: boolean;
  checkLookups: number;
  checksBacklog: number;
}

type HandOff = 'delivered' | 'covered' | 'suppressed';

interface PendingHead {
  repo: RepoRef;
  sha: string;
  number: number;
  html_url: string;
  at: string;
  attempts: number;
}

interface Candidate {
  key: string;
  event: NormalizedEvent;
  at: string;
  retires?: string;
  head?: { channel: string; sha: string };
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
  private readonly backlog = new Map<string, PendingHead>();
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

  get checkBacklogSize(): number {
    return this.backlog.size;
  }

  get enabled(): boolean {
    return this.configuredIntervalMs > 0;
  }

  get effectiveIntervalMs(): number {
    return Math.max(MIN_POLL_INTERVAL_MS, this.configuredIntervalMs, this.serverIntervalMs);
  }

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
    this.timer.unref?.();
  }

  async pollOnce(): Promise<PollResult> {
    const startedAt = this.now();
    const stored = this.state.lastPollAt();
    const since = stored ?? wholeSecond(startedAt.getTime() - this.effectiveIntervalMs);
    if (stored === null) this.state.setLastPollAt(since);
    const receivedAt = startedAt.toISOString();
    const startSecond = wholeSecond(startedAt.getTime());

    const candidates: Candidate[] = [];
    const cursors: Record<string, PollCursor> = {};
    for (const repo of this.repos) {
      candidates.push(...(await this.collectRows(repo, since, startSecond, receivedAt, cursors)));
    }
    const checks = await this.drainHeadBacklog(receivedAt);
    candidates.push(...checks.candidates);
    candidates.sort((a, b) => (a.at === b.at ? a.key.localeCompare(b.key) : a.at.localeCompare(b.at)));

    const alreadySeen = new Set(this.state.snapshot().pollKeys);
    const result: PollResult = {
      since,
      delivered: [],
      duplicates: 0,
      failed: 0,
      cursorAdvanced: false,
      checkLookups: checks.lookups,
      checksBacklog: 0,
    };
    const deliveredThisPass = new Set<string>();

    for (const candidate of candidates) {
      const retire = (): void => {
        if (candidate.retires !== undefined) this.backlog.delete(candidate.retires);
      };
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
        result.failed += 1;
        this.logger.warn('poll event delivery failed; its key stays unrecorded for the next pass', {
          key: candidate.key,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (outcome === 'covered') {
        result.duplicates += 1;
        retire();
        this.logger.info('poll checks result dropped: this head sha already reported this result or a stronger one', {
          sha: candidate.event.sha,
          conclusion: candidate.event.checks?.conclusion ?? null,
        });
        continue;
      }

      this.state.seenPollKey(candidate.key);
      deliveredThisPass.add(candidate.key);
      if (outcome !== 'suppressed') result.delivered.push(candidate.event);
      retire();
      commitHead();
    }

    result.checksBacklog = this.backlog.size;

    if (result.failed === 0) {
      this.state.setPollCursors(cursors);
      const stops = Object.values(cursors).flatMap((cursor) => cursor.resumeAt ?? []);
      this.state.setLastPollAt([startSecond, ...stops].reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)));
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
      fallbackSince: since,
      delivered: result.delivered.length,
      duplicates: result.duplicates,
      failed: result.failed,
      checkLookups: result.checkLookups,
      checksBacklog: result.checksBacklog,
    });
    return result;
  }

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
      const channel = channelId({ repo, number: row.number, kind: row.isPullRequest ? 'pull' : 'issue' });
      const seen = announced[String(row.id)] !== undefined;
      const event = normalizePolledIssue(repo, row, receivedAt, issues.since, this.state.polledHead(channel) ?? undefined, seen);
      const fresh = !seen && atOrAfter(row.createdAt, issues.since);
      const marker = polledMarker(row);
      const openHead = row.isPullRequest && row.state === 'open' && row.headSha ? row.headSha : undefined;
      if (event) {
        out.push({
          key: pollKey('issue', row.id, row.updatedAt),
          event,
          at: row.updatedAt,
          ...(marker === undefined ? {} : { head: { channel, sha: marker } }),
          ...(fresh ? { fresh: { list: issues.key, id: String(row.id), createdAt: row.createdAt } } : {}),
        });
      } else if (marker !== undefined) {
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

  private enqueueHead(repo: RepoRef, row: PolledIssue): void {
    const sha = row.headSha as string;
    const key = CheckGate.key(repo, sha);
    const queued = this.backlog.get(key);
    if (queued) {
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
          this.retainHead(key, head, 'the head has no check runs');
        } else {
          this.rotateHead(key, head);
          this.logger.debug('poll head still running its checks', { sha: head.sha, runs: summary.total });
        }
        continue;
      }

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
    if (!delivered) return 'covered';
    return emit ? 'delivered' : 'suppressed';
  }

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
