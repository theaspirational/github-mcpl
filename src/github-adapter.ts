/**
 * GitHubAdapter — the only module in the package that touches octokit
 * (TASK-SRHKG.1 Contract, module map; work package .2).
 *
 * Three concerns live here and nothing else does:
 *
 *   1. **Auth.** In App mode an RS256 JWT is minted from GITHUB_APP_ID and the
 *      PEM of GITHUB_APP_PRIVATE_KEY_FILE, the installation id comes from
 *      GITHUB_APP_INSTALLATION_ID or is discovered for the GITHUB_REPOS entry,
 *      and the installation token is cached and re-minted before it expires.
 *      In contributor mode every call carries the user token read from
 *      GITHUB_TOKEN_FILE, which nothing re-mints, so a 401 there is final.
 *   2. **Calls.** Every {@link GitHubApi} method, REST where GitHub has REST
 *      and GraphQL where it does not (review threads, resolve/unresolve, the
 *      draft flag), mapped onto the contract's types.
 *   3. **Failure.** `x-ratelimit-remaining` and `retry-after` are honoured,
 *      one bounded retry is spent on a secondary-rate-limit answer and one on
 *      a stale token, and every error that leaves this module carries the
 *      status and GitHub's own message — never a token, never a URL.
 *
 * Secrets never reach a log line or an error. The private key is turned into a
 * KeyObject once and the installation token, or the user token, only ever
 * appears in the `authorization` header built inside
 * {@link GitHubAdapter.authedFetch} — and
 * because GitHub, undici and octokit can all quote back something we sent,
 * every message and every log line is scrubbed on the way out by
 * {@link GitHubAdapter.redact}. The guarantee there is structural, not
 * statistical: every logical call holds the credentials it actually sent until
 * it settles, so its own error can never quote back a token that rotation has
 * meanwhile aged out. A bounded ring of settled credentials and a pass over
 * everything that merely looks like a credential ({@link redactSecrets}) sit
 * behind that as backstops.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { Octokit } from 'octokit';
import {
  LIMITS,
  repoSlug,
  stderrLogger,
  type BotIdentity,
  type CheckConclusion,
  type ChecksSummary,
  type Comment,
  type Config,
  type CreateIssueInput,
  type CreatePullRequestInput,
  type CreateReviewInput,
  type DiffSide,
  type EventActor,
  type FailedCheck,
  type GitHubApi,
  type Issue,
  type IssueSearch,
  type IssueState,
  type IssueStateReason,
  type Logger,
  type PolledComment,
  type PolledIssue,
  type PollRead,
  type PolledReview,
  type PullRequest,
  type PullRequestFile,
  type RepoRef,
  type ReviewState,
  type ReviewThread,
  type ReviewThreadComment,
  type SubmittedReview,
  type ThreadKind,
  type ThreadRef,
  type UpdateIssueInput,
  type UpdatePullRequestInput,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bounds (the contract's "lists capped at 50 unless a method documents
// otherwise"; the three that document otherwise say so on the method)
// ─────────────────────────────────────────────────────────────────────────────

/** A JWT GitHub accepts lives at most 10 minutes; 9 leaves room for clock skew. */
const JWT_TTL_SEC = 9 * 60;
/** The JWT's `iat` is backdated this far, GitHub's own advice against skew. */
const JWT_BACKDATE_SEC = 60;
/** A cached JWT or installation token is re-minted this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** A `retry-after` (or rate-limit reset) further out than this is not slept on. */
const MAX_RETRY_DELAY_MS = 60_000;
/**
 * A secondary-rate-limit answer with no `retry-after` waits this long.
 *
 * GitHub's own guidance for a secondary limit that names no `Retry-After` is
 * to wait at least a minute; retrying sooner is what earns the next one. It is
 * exactly {@link MAX_RETRY_DELAY_MS}, so the single retry is still bounded.
 */
const DEFAULT_SECONDARY_BACKOFF_MS = 60_000;
/** Below this many calls left on the hour the adapter says so on stderr. */
const RATE_LIMIT_WARN_REMAINING = 20;
/**
 * Hard ceiling on the credential-retention set, as an anti-OOM guard only.
 *
 * Retention is governed by validity, not by count (see
 * {@link GitHubAdapter.remember}): a credential is kept redactable until it
 * can no longer authenticate. Both GitHub credentials are strictly
 * time-bounded — an installation token lasts an hour, an App JWT nine minutes,
 * and neither can be refreshed — so the live set is naturally small and this
 * ceiling does not bind in any realistic run. If it ever does, the credentials
 * closest to expiry go first and the adapter says so on stderr.
 */
const SECRET_RETENTION_MAX = 256;
/** Check runs read per page for one sha. GitHub's own page cap is 100. */
const CHECK_RUN_PAGE = 100;
/**
 * Pages of check runs read for one sha. A commit with more than
 * `CHECK_RUN_PAGE * CHECK_RUN_MAX_PAGES` runs comes back marked incomplete
 * rather than summarized from a prefix.
 */
const CHECK_RUN_MAX_PAGES = 5;
/**
 * Requests one `…Since` poll makes before it stops, past which it goes on
 * only to finish a second it is part way through, and leaves the rest for a
 * later pass, which reads on from where it stopped. A documented exception to
 * the 50-entry cap: these lists feed the event pipeline, not a rendered list,
 * so they read 100 rows a request.
 */
export const POLL_MAX_PAGES = 3;
/**
 * Amendment 1: "at most 20 PRs per poll". `listIssuesSince` fills `headSha`
 * for at most this many open pull requests; the rest come back without one.
 */
export const POLL_PR_HEAD_LIMIT = 20;
/** `GET /notifications` serves at most 50 threads a page. */
const NOTIFICATIONS_PAGE_SIZE = 50;
/**
 * Pages one of contributor mode's reads takes. A thread's read (its comments,
 * review comments or reviews since its cursor) fails past them rather than
 * return part of its rows, since its cursor couldn't safely move over a part,
 * and the poller then reads that thread from its current update on. The
 * notifications list delivers what its pages held, and says it was cut short.
 */
const THREAD_MAX_PAGES = 20;
/** A rate limit's message, primary or secondary: a 403 that says this will pass. */
const RATE_LIMITED = /rate limit|abuse detection/i;

// ─────────────────────────────────────────────────────────────────────────────
// Errors and rate-limit state
// ─────────────────────────────────────────────────────────────────────────────

/** What every redaction puts in a secret's place. */
export const REDACTED = '[redacted]';

/**
 * Patterns that are a credential wherever they appear.
 *
 * GitHub's own error text, a transport error from undici, and anything octokit
 * logs can all quote back something we sent. Nothing downstream is trusted to
 * notice, so a message is scrubbed on the way out whether or not we believe it
 * could carry a secret:
 *
 *   - `ghs_…` and the other GitHub token prefixes, wherever they sit;
 *   - an `authorization`-style `Bearer …` / `token …` pair;
 *   - the userinfo of a URL, which is where undici puts a password when it
 *     refuses a credential-bearing URL.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // GitHub's documented token prefixes (ghs_ installation, ghp_ personal,
  // gho_ OAuth, ghu_ user-to-server, ghr_ refresh) and the App JWT shape.
  /\bgh[spour]_[A-Za-z0-9_]+/g,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // `Authorization: Bearer x` / `token x`, however it was quoted back.
  /\b(?:Bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** `scheme://user:password@host` → `scheme://[redacted]@host`. */
const URL_USERINFO = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g;

/**
 * Scrub anything that looks like a credential out of `text`.
 *
 * Pattern-based and therefore never complete on its own — the adapter also
 * substitutes the literal secrets it holds (see `GitHubAdapter.redact`) — but
 * it runs on every error and every log line, including the ones built in code
 * paths that have no adapter instance to ask.
 */
export function redactSecrets(text: string): string {
  let out = text.replace(URL_USERINFO, `$1${REDACTED}@`);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * A failed GitHub call, as the rest of the package sees it.
 *
 * Carries the HTTP status and GitHub's own message and nothing else: no
 * request URL (which identifies the installation), no header, and above all no
 * token. A GraphQL answer that is HTTP 200 with an `errors` array reports
 * status 200 and the first message.
 *
 * The message is redacted in the constructor, so there is no way to build one
 * that carries a credential — not through `githubMessage`, not through
 * `message`, and not through the stack, whose first line is `message`.
 */
export class GitHubApiError extends Error {
  /** GitHub's `message` field, with any credential redacted. */
  readonly githubMessage: string;

  constructor(
    readonly status: number,
    githubMessage: string,
    /** The GitHubApi method that failed, e.g. `getIssue`. Never a URL. */
    readonly operation: string,
    readonly possiblyDone = false,
    /**
     * Whether GitHub answered at all. A request that failed before any HTTP
     * answer (DNS, a refused or reset connection) has none, whatever status
     * octokit gave it, and status 0 is this adapter's own failure.
     */
    readonly answered: boolean = status > 0,
  ) {
    const safe = redactSecrets(githubMessage);
    super(status > 0 ? `GitHub ${status} on ${operation}: ${safe}` : `${operation}: ${safe}`);
    this.name = 'GitHubApiError';
    this.githubMessage = safe;
  }
}

/** What the last answer from GitHub said about the hour's budget. */
export interface RateLimitState {
  /** `x-ratelimit-remaining`, or null before the first answer. */
  remaining: number | null;
  /** `x-ratelimit-reset` as epoch ms, or null. */
  resetAt: number | null;
}

/** Everything the adapter needs that is not the validated environment. */
export interface GitHubAdapterOptions {
  /** Diagnostics. Defaults to the stderr logger; never receives a secret. */
  logger?: Logger;
  /**
   * The transport. Tests point this at a local http server; production leaves
   * it unset and octokit uses the global fetch.
   */
  fetch?: typeof globalThis.fetch;
  /** REST/GraphQL root. Defaults to `https://api.github.com`. */
  baseUrl?: string;
  /** Clock, injectable so token expiry is testable without waiting. */
  now?: () => number;
  /** Backoff, injectable so the rate-limit retry is testable without waiting. */
  sleep?: (ms: number) => Promise<void>;
}

/** What a failed call told us, normalized away from octokit's error shapes. */
interface Failure {
  status: number;
  message: string;
  headers: Record<string, string>;
  read: boolean;
  /** False when the request failed before GitHub answered. */
  answered: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload shapes
//
// Only the fields this module reads are named. Everything arrives off the wire
// and nothing may be assumed present, so each one is optional and each mapper
// supplies the contract's value for "absent".
// ─────────────────────────────────────────────────────────────────────────────

interface ApiActor {
  login?: string | null;
  type?: string | null;
}

interface ApiIssue {
  id?: number;
  number?: number;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  state_reason?: string | null;
  user?: ApiActor | null;
  labels?: Array<string | { name?: string | null }> | null;
  created_at?: string | null;
  updated_at?: string | null;
  html_url?: string | null;
  /** Present on a pull request's row; `merged_at` is null until it's merged. */
  pull_request?: { merged_at?: string | null } | null;
  closed_at?: string | null;
  closed_by?: ApiActor | null;
}

interface ApiPull {
  number?: number;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  draft?: boolean | null;
  merged?: boolean | null;
  merged_at?: string | null;
  mergeable?: boolean | null;
  node_id?: string;
  head?: { ref?: string | null; sha?: string | null } | null;
  base?: { ref?: string | null; sha?: string | null } | null;
  user?: ApiActor | null;
  requested_reviewers?: Array<ApiActor | null> | null;
  created_at?: string | null;
  updated_at?: string | null;
  html_url?: string | null;
}

interface ApiComment {
  id?: number;
  user?: ApiActor | null;
  body?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  html_url?: string | null;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  side?: string | null;
  in_reply_to_id?: number | null;
  issue_url?: string | null;
  pull_request_url?: string | null;
}

/** One row of `GET /repos/{o}/{r}/pulls/{n}/reviews`. */
interface ApiReview {
  id?: number;
  user?: ApiActor | null;
  body?: string | null;
  state?: string | null;
  submitted_at?: string | null;
  html_url?: string | null;
  commit_id?: string | null;
}

/** One row of `GET /notifications`. */
interface ApiNotification {
  id?: string;
  updated_at?: string | null;
  reason?: string | null;
  unread?: boolean;
  subject?: { type?: string | null; url?: string | null; title?: string | null } | null;
  repository?: { full_name?: string | null; owner?: { login?: string | null } | null; name?: string | null } | null;
}

/** One row of `GET /notifications`, mapped: the ingress-only shape the poller reads. */
export interface NotificationRow {
  id: string;
  updatedAt: string;
  reason: string;
  unread: boolean;
  repo: RepoRef;
  /** `issue` or `pull`: a row with any other subject (a discussion, a commit, a release) isn't listed. */
  kind: ThreadKind;
  number: number;
  title: string;
}

/** An open pull request the token's user authored, as `GitHubAdapter.listOwnOpenPulls` found it. */
export interface OwnPull {
  /** The GITHUB_REPOS entry it is in, as configured. */
  repo: RepoRef;
  number: number;
  /** Its `updated_at`, which a push moves. The search's may lag a push, so an unchanged one is taken to say its head hasn't moved only for a while. */
  updatedAt: string;
  html_url: string;
}

/** What `GitHubAdapter.listNotifications` read: every page's threads, and the first page's headers. */
export interface NotificationsPage {
  notifications: NotificationRow[];
  /** True on a 304: `notifications` is empty and nothing changed since `ifModifiedSince`. */
  notModified: boolean;
  /** `Last-Modified` (an HTTP-date), to pass back as the next call's `ifModifiedSince`. */
  lastModified: string | null;
  /** The answer's `Date` (an HTTP-date): GitHub's clock when it answered. */
  date: string | null;
  /** `X-Poll-Interval`, in seconds, when GitHub sent one. */
  pollIntervalSeconds: number | null;
  /** True when the listing stopped at its page cap with threads left unlisted. */
  truncated: boolean;
}

/** One row of `GET /repos/{o}/{r}/commits/{sha}/check-runs`. */
export interface CheckRunRow {
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string | null;
}

interface GqlActor {
  login?: string | null;
  __typename?: string | null;
}

interface GqlReviewThreadsResponse {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        nodes?: Array<{
          id?: string;
          path?: string | null;
          line?: number | null;
          originalLine?: number | null;
          diffSide?: string | null;
          isResolved?: boolean | null;
          comments?: {
            nodes?: Array<{
              databaseId?: number | null;
              author?: GqlActor | null;
              body?: string | null;
              createdAt?: string | null;
              lastEditedAt?: string | null;
              replyTo?: { databaseId?: number | null } | null;
            } | null> | null;
          } | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers (pure; every one of them is total over a payload full of nulls)
// ─────────────────────────────────────────────────────────────────────────────

/** GitHub deletes users; a comment by a deleted account has `user: null`. */
function actorOf(user: ApiActor | null | undefined): EventActor {
  const login = user?.login ?? 'ghost';
  return { login, isBot: user?.type === 'Bot' || login.endsWith('[bot]') };
}

function gqlActorOf(author: GqlActor | null | undefined): EventActor {
  const login = author?.login ?? 'ghost';
  return { login, isBot: author?.__typename === 'Bot' || login.endsWith('[bot]') };
}

function issueStateOf(state: string | null | undefined): IssueState {
  return state === 'closed' ? 'closed' : 'open';
}

function stateReasonOf(reason: string | null | undefined): IssueStateReason | null {
  return reason === 'completed' || reason === 'not_planned' || reason === 'reopened' ? reason : null;
}

function sideOf(side: string | null | undefined): DiffSide {
  return side === 'LEFT' ? 'LEFT' : 'RIGHT';
}

function reviewStateOf(state: string | null | undefined): ReviewState {
  const upper = (state ?? '').toUpperCase();
  if (upper === 'APPROVED') return 'approved';
  if (upper === 'CHANGES_REQUESTED') return 'changes_requested';
  return 'commented';
}

function mapIssue(repo: RepoRef, data: ApiIssue): Issue {
  return {
    number: data.number ?? 0,
    kind: 'issue',
    repo,
    title: data.title ?? '',
    body: data.body ?? '',
    state: issueStateOf(data.state),
    stateReason: stateReasonOf(data.state_reason),
    author: actorOf(data.user),
    labels: (data.labels ?? []).map((l) => (typeof l === 'string' ? l : (l?.name ?? ''))).filter(Boolean),
    createdAt: data.created_at ?? '',
    updatedAt: data.updated_at ?? '',
    html_url: data.html_url ?? '',
  };
}

function mapComment(data: ApiComment): Comment {
  const comment: Comment = {
    id: data.id ?? 0,
    author: actorOf(data.user),
    body: data.body ?? '',
    createdAt: data.created_at ?? '',
    updatedAt: data.updated_at ?? '',
    html_url: data.html_url ?? '',
  };
  // Review-comment-only fields; an issue comment carries none of them and the
  // contract's `Comment` leaves them absent rather than null.
  if (data.path != null) {
    comment.path = data.path;
    comment.line = data.line ?? data.original_line ?? null;
    comment.side = sideOf(data.side);
  }
  if (data.in_reply_to_id != null) comment.inReplyTo = data.in_reply_to_id;
  return comment;
}

/** `…/repos/o/r/issues/12` or `…/repos/o/r/pulls/12` → 12. */
function numberFromUrl(url: string | null | undefined): number {
  const m = /\/(?:issues|pulls)\/(\d+)(?:$|[?#])/.exec(url ?? '');
  return m ? Number(m[1]) : 0;
}

/**
 * Whether a response's `Link` header names a next page, which is GitHub's
 * signal that more follow. A page's length is not: a page shorter than
 * `per_page` is no proof of the end.
 */
function hasNextPage(link: string | undefined): boolean {
  return /(?:^|,)\s*<[^>]*>\s*;\s*rel="next"/.test(link ?? '');
}

/**
 * Roll a sha's check runs up to one conclusion. A run that has not completed
 * makes the whole sha undecided (`null`); otherwise the worst conclusion wins,
 * and `neutral`/`skipped`/`stale` are not failures — GitHub's own required-check
 * semantics treat them as passing.
 */
const FAILING_CONCLUSIONS: readonly CheckConclusion[] = [
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
];

// ─────────────────────────────────────────────────────────────────────────────
// The adapter
// ─────────────────────────────────────────────────────────────────────────────

export class GitHubAdapter implements GitHubApi {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseFetch: typeof globalThis.fetch;
  /** App mode only: null in contributor mode, which mints nothing. */
  private readonly privateKey: KeyObject | null;
  /** Contributor mode only: the static token every call authenticates with. */
  private readonly userToken: string | null;

  /**
   * JWT-authenticated: `/app`, installation discovery, token minting. Null in
   * contributor mode, which has no App identity to JWT-authenticate as.
   */
  private readonly appOctokit: Octokit | null;
  /**
   * App mode: installation-token-authenticated. Contributor mode: the user
   * token directly. Either way, everything the tools and channels do.
   */
  private readonly octokit: Octokit;

  private jwtCache: { token: string; expiresAt: number } | null = null;
  private tokenCache: { token: string; expiresAt: number } | null = null;
/**
   * Every credential this adapter has issued that could still authenticate,
   * each with the moment it stops being able to.
   *
   * Retention is by validity rather than by count: an installation token or an
   * App JWT is dangerous for exactly as long as GitHub would still accept it,
   * and worthless afterwards. Since both expire on a fixed, short schedule and
   * neither can be refreshed, "every credential that still works" is a small
   * set that prunes itself — no ring, no eviction of something still live.
   */
  private readonly issued: { value: string; expiresAt: number }[] = [];
  /**
   * The credentials of every logical call currently in flight — one set per
   * unsettled {@link GitHubAdapter.call}, holding whatever that call actually
   * put on the wire, retries included.
   *
   * This is what makes the credential-lifetime invariant structural rather
   * than statistical. A call's entry appears the moment it sends a credential
   * and is removed only when the call settles, so no amount of rotation
   * underneath an unresolved request can age its token out of the redaction
   * set — which a bounded ring, on its own, allows.
   */
  private readonly liveCredentials = new Set<Set<string>>();
  /** Which live set the code currently running belongs to. */
  private readonly callScope = new AsyncLocalStorage<Set<string>>();
  private installationIdCache: number | null;
  /** In flight mints are shared so a burst of calls mints one token, not ten. */
  private tokenInFlight: Promise<string> | null = null;
  private botCache: BotIdentity | null = null;

  private rateLimit: RateLimitState = { remaining: null, resetAt: null };

  constructor(
    private readonly config: Config,
    options: GitHubAdapterOptions = {},
  ) {
    this.logger = options.logger ?? stderrLogger();
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const base = options.fetch ?? globalThis.fetch;
    this.baseFetch = (input, init) => base(input, init);
    this.installationIdCache = config.installationId;

    const octokitLog = this.octokitLog();
    const common = {
      baseUrl: assertNoUserinfo(options.baseUrl ?? 'https://api.github.com'),
      // octokit bundles retry and throttling plugins. Backoff is this module's
      // own job (one bounded retry, a honoured `retry-after`), and two layers
      // of it would turn a 403 into minutes of hidden sleeping.
      retry: { enabled: false },
      throttle: { enabled: false },
      // octokit's default logger writes straight to the console, and stdout is
      // reserved for JSON-RPC. Everything it has to say (a `deprecation`
      // header, most often) goes through the same redacted Logger as our own
      // diagnostics instead. It has to be set twice: `log` is what the core
      // and its plugins use, `request.log` is what @octokit/request's own
      // warnings use, and that one defaults to `console`.
      log: octokitLog,
    };

    if (config.authMode === 'token') {
      // Contributor mode: one static token, straight from GITHUB_TOKEN_FILE.
      // No JWT, no installation, nothing to mint or refresh — so there is no
      // App octokit and no private key to parse.
      this.privateKey = null;
      this.userToken = config.userToken as string;
      this.appOctokit = null;
      this.octokit = new Octokit({
        ...common,
        request: { fetch: this.authedFetch(async () => `token ${this.userToken as string}`), log: octokitLog },
      });
      // The token does not expire on a schedule the way a minted one does, so
      // it is remembered for the life of the process rather than pruned by
      // validity — `redact` still has to find it in every log line and error.
      this.remember(this.userToken, Number.POSITIVE_INFINITY);
    } else {
      this.userToken = null;
      // Throws on a malformed PEM before any call is made, and the KeyObject
      // is the only form of the key that is kept.
      this.privateKey = createPrivateKey(config.privateKeyPem as string);
      this.appOctokit = new Octokit({
        ...common,
        request: { fetch: this.authedFetch(async () => `Bearer ${await this.appJwt()}`), log: octokitLog },
      });
      this.octokit = new Octokit({
        ...common,
        request: {
          fetch: this.authedFetch(async () => `token ${await this.installationToken()}`),
          log: octokitLog,
        },
      });
    }
  }

  /**
   * octokit's `log` seam, pointed at the injected Logger.
   *
   * octokit's messages quote the request URL, so they are redacted exactly
   * like ours; `debug` and `info` keep their levels so a host that silences
   * them silences octokit too.
   */
  private octokitLog(): { debug: (m: string) => void; info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } {
    const at = (level: keyof Logger) => (message: string) => {
      this.log(level, `octokit: ${String(message)}`);
    };
    return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  }

  /**
   * Every diagnostic this module emits, redacted on the way out.
   *
   * Both the message and every string in `fields` go through
   * {@link GitHubAdapter.redact}, so a log line cannot carry a credential even
   * when the thing being logged came back from GitHub or from octokit.
   */
  private log(level: keyof Logger, message: string, fields?: Record<string, unknown>): void {
    let safeFields: Record<string, unknown> | undefined;
    if (fields) {
      safeFields = {};
      for (const [k, v] of Object.entries(fields)) {
        safeFields[k] = typeof v === 'string' ? this.redact(v) : v;
      }
    }
    this.logger[level](this.redact(message), safeFields);
  }

  /**
   * Scrub `text` of every credential that could possibly be in it, then of
   * everything that merely looks like one.
   *
   * Three passes, in order of how much they can be trusted:
   *
   *   1. **Every credential that could still authenticate**, settled call or
   *      not — the set is pruned by expiry, never by count.
   *   2. **Every unsettled call's credentials**, which closes the one gap the
   *      first pass leaves: a request still in flight under a credential that
   *      has nominally expired. Together these two make the invariant
   *      structural — no amount of rotation can age a credential out from
   *      under a request that is still carrying it.
   *   3. **The shape patterns** ({@link redactSecrets}), which catch what no
   *      value list could — but not GitHub's older `v1.<hex>` tokens, which
   *      match nothing, which is why the value passes come first.
   */
  private redact(text: string): string {
    const values = new Set<string>();
    for (const held of this.issued) values.add(held.value);
    for (const live of this.liveCredentials) {
      for (const secret of live) values.add(secret);
    }
    let out = text;
    // Longest first, so a secret that is a prefix of a longer one cannot chop
    // it in half and leave the tail standing.
    for (const secret of [...values].sort((a, b) => b.length - a.length)) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return redactSecrets(out);
  }

  /**
   * Record that `secret` has gone out on the wire for the call now running.
   *
   * Called from the transport, which is the only place a credential is ever
   * written, so nothing can be sent without being registered. If the call
   * scope is somehow lost the secret is registered with *every* live call
   * rather than none: over-redacting a diagnostic costs nothing, missing a
   * credential costs everything.
   */
  private holdCredential(secret: string): void {
    if (secret.length < 8) return;
    const scope = this.callScope.getStore();
    if (scope) scope.add(secret);
    else for (const live of this.liveCredentials) live.add(secret);
  }

/**
   * Keep `secret` redactable until `expiresAt`, when GitHub stops accepting it
   * and it stops being a secret.
   *
   * Pruning happens here, on the one path that can grow the set, so retention
   * costs nothing to maintain and the set never outgrows the credentials that
   * actually work.
   */
  private remember(secret: string, expiresAt: number): void {
    // Too short to be a credential, and substituting it would shred the text.
    if (secret.length < 8) return;
    const known = this.issued.find((held) => held.value === secret);
    if (known) {
      known.expiresAt = Math.max(known.expiresAt, expiresAt);
      return;
    }
    this.issued.push({ value: secret, expiresAt });

    const now = this.now();
    let kept = this.issued.filter((held) => held.expiresAt > now);
    let overflowed = 0;
    if (kept.length > SECRET_RETENTION_MAX) {
      // Only reachable by minting hundreds of credentials inside one validity
      // window. Whatever expires soonest is the least dangerous to forget.
      kept.sort((a, b) => a.expiresAt - b.expiresAt);
      overflowed = kept.length - SECRET_RETENTION_MAX;
      kept = kept.slice(overflowed);
    }
    this.issued.length = 0;
    this.issued.push(...kept);
    // Logged after the set is settled: `log` redacts, and redacting reads it.
    if (overflowed > 0) {
      this.log('warn', 'more unexpired credentials than the redaction set holds; the oldest were dropped', {
        dropped: overflowed,
        kept: this.issued.length,
      });
    }
  }

  /** What the last answer said about the hour's budget (diagnostics, tests). */
  rateLimitState(): RateLimitState {
    return { ...this.rateLimit };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Transport: the one place a credential is ever written
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Wrap the transport so that the `authorization` header is built per request
   * and is the only place a credential appears. The header is set on a fresh
   * Headers object, so nothing octokit keeps (its `request` copy on an error,
   * for instance) is the object we put the token into.
   */
  private authedFetch(authorization: () => Promise<string>): typeof globalThis.fetch {
    return async (input, init) => {
      const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
      const credential = await authorization();
      // Registered before it is sent and held until this call settles, so the
      // answer to this very request can never quote back a token that has
      // meanwhile aged out of the ring.
      this.holdCredential(credential.replace(/^(?:Bearer|token)\s+/i, ''));
      headers.set('authorization', credential);
      const response = await this.baseFetch(input, { ...init, headers });
      this.recordRateLimit(response.headers);
      return response;
    };
  }

  private recordRateLimit(headers: Headers): void {
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    if (remaining === null) return;
    const left = Number(remaining);
    if (!Number.isFinite(left)) return;
    this.rateLimit = {
      remaining: left,
      resetAt: reset !== null && Number.isFinite(Number(reset)) ? Number(reset) * 1000 : null,
    };
    if (left <= RATE_LIMIT_WARN_REMAINING) {
      this.log('warn', 'github rate limit low', { remaining: left, resetAt: this.rateLimit.resetAt });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // App auth
  // ───────────────────────────────────────────────────────────────────────────

  /** An RS256 App JWT, cached until a minute before it expires. */
  private async appJwt(): Promise<string> {
    const cached = this.jwtCache;
    if (cached && cached.expiresAt - this.now() > TOKEN_REFRESH_MARGIN_MS) return cached.token;

    const issuedAt = Math.floor(this.now() / 1000) - JWT_BACKDATE_SEC;
    const expiresAtSec = issuedAt + JWT_BACKDATE_SEC + JWT_TTL_SEC;
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ iat: issuedAt, exp: expiresAtSec, iss: this.config.appId }));
    const signingInput = `${header}.${payload}`;
    const signature = createSign('RSA-SHA256').update(signingInput).sign(this.privateKey as KeyObject);
    const token = `${signingInput}.${b64url(signature)}`;
    this.jwtCache = { token, expiresAt: expiresAtSec * 1000 };
    this.remember(token, expiresAtSec * 1000);
    return token;
  }

  /**
   * GITHUB_APP_INSTALLATION_ID, or the installation the App has on the first
   * GITHUB_REPOS entry. Every entry shares that owner (readConfig refuses a
   * second one), and an App is installed on an owner once, so the first
   * repository's installation is every repository's. The lookup is the
   * repository's own installation endpoint; discovering it once is enough, an
   * installation id is stable.
   */
  private async resolveInstallationId(): Promise<number> {
    if (this.installationIdCache !== null) return this.installationIdCache;
    const repo = this.config.repos[0];
    if (!repo) {
      throw new GitHubApiError(
        0,
        'no repository in GITHUB_REPOS to discover the installation from, and GITHUB_APP_INSTALLATION_ID is unset',
        'resolveInstallationId',
      );
    }
    const id = await this.call(
      'resolveInstallationId',
      async () => {
        const res = await (this.appOctokit as Octokit).request('GET /repos/{owner}/{repo}/installation', {
          owner: repo.owner,
          repo: repo.name,
        });
        return (res.data as { id?: number }).id ?? 0;
      },
      { refreshAuth: false },
    );
    if (!id) {
      throw new GitHubApiError(0, `the App has no installation on ${repoSlug(repo)}`, 'resolveInstallationId');
    }
    this.log('info', 'github installation discovered', { repo: repoSlug(repo), installationId: id });
    this.installationIdCache = id;
    return id;
  }

  /** The installation token, minted on first use and re-minted before expiry. */
  private async installationToken(): Promise<string> {
    const cached = this.tokenCache;
    if (cached && cached.expiresAt - this.now() > TOKEN_REFRESH_MARGIN_MS) return cached.token;
    // A single mint serves every caller that noticed the same expiry.
    this.tokenInFlight ??= this.mintInstallationToken().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async mintInstallationToken(): Promise<string> {
    const installationId = await this.resolveInstallationId();
    const minted = await this.call(
      'mintInstallationToken',
      async () => {
        const res = await (this.appOctokit as Octokit).request('POST /app/installations/{installation_id}/access_tokens', {
          installation_id: installationId,
        });
        const data = res.data as { token?: string; expires_at?: string };
        return { token: data.token ?? '', expiresAt: Date.parse(data.expires_at ?? '') };
      },
      { refreshAuth: false },
    );
    if (!minted.token) {
      throw new GitHubApiError(0, 'installation token response carried no token', 'mintInstallationToken');
    }
    const expiresAt = Number.isFinite(minted.expiresAt) ? minted.expiresAt : this.now() + 3_600_000;
    this.tokenCache = { token: minted.token, expiresAt };
    // Remembered before it is used and kept until GitHub would refuse it: a
    // request still in flight under it can fail at any point.
    this.remember(minted.token, expiresAt);
    // The token itself is never a field here, only when it expires.
    this.log('debug', 'github installation token minted', { installationId, expiresAt });
    return minted.token;
  }

  /** Drop the cached token so the next call mints a fresh one. */
  private invalidateToken(): void {
    this.tokenCache = null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Failure handling: one bounded auth retry, one bounded rate-limit retry
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Run one logical call — a public {@link GitHubApi} method's trip to GitHub,
   * retries included — with its credentials held redactable for its whole
   * lifetime.
   *
   * The scope opens before the first request and closes only once the call has
   * settled, which is what makes the credential-lifetime invariant structural:
   * the error this call throws is built while its own scope is still open, so
   * whatever credential it sent is still in {@link GitHubAdapter.redact}'s set
   * no matter how many rotations happened underneath it.
   */
  private async call<T>(
    operation: string,
    fn: () => Promise<T>,
    opts: { refreshAuth?: boolean } = {},
  ): Promise<T> {
    const live = new Set<string>();
    this.liveCredentials.add(live);
    try {
      return await this.callScope.run(live, () => this.attempt(operation, fn, opts));
    } finally {
      this.liveCredentials.delete(live);
    }
  }

  /** {@link GitHubAdapter.call}'s retry loop, inside the credential scope. */
  private async attempt<T>(
    operation: string,
    fn: () => Promise<T>,
    opts: { refreshAuth?: boolean } = {},
  ): Promise<T> {
    const refreshAuth = opts.refreshAuth !== false;
    let authRetried = false;
    let rateRetried = false;

    for (;;) {
      try {
        return await fn();
      } catch (raw) {
        // Auth runs inside the transport, before the request is sent, so a
        // failure to mint a token or to find the installation surfaces here
        // wrapped in octokit's generic "the fetch threw" error. Unwrap it and
        // let the real status and the real operation out instead of a 500
        // from `getIssue`, as a failure of a request that never went out.
        const authFailure = authFailureIn(raw);
        if (authFailure) {
          throw new GitHubApiError(authFailure.status, authFailure.githubMessage, authFailure.operation);
        }

        const failure = normalizeFailure(raw);

        // A token that GitHub no longer accepts: mint once more, try once
        // more. Contributor mode's token cannot be re-minted — it is the one
        // static secret in GITHUB_TOKEN_FILE — so a 401 there is terminal.
        if (failure.status === 401 && refreshAuth && !authRetried && this.config.authMode === 'app') {
          authRetried = true;
          this.invalidateToken();
          this.log('warn', 'github rejected the installation token; re-minting', { operation });
          continue;
        }

        const delay = this.retryDelay(failure);
        if (delay !== null && !rateRetried) {
          rateRetried = true;
          this.log('warn', 'github rate limited; one retry', {
            operation,
            status: failure.status,
            delayMs: delay,
          });
          await this.sleep(delay);
          continue;
        }

        throw new GitHubApiError(
          failure.status,
          this.redact(failure.message),
          operation,
          failure.status >= 500 && !failure.read,
          failure.answered,
        );
      }
    }
  }

  /**
   * How long to wait before the single retry, or null if this failure is not a
   * rate limit — or is one whose reset is further out than the adapter is
   * willing to sleep, in which case the caller gets the error now instead of
   * after a pointless nap.
   */
  private retryDelay(failure: Failure): number | null {
    if (failure.status !== 403 && failure.status !== 429) return null;

    const retryAfter = Number(failure.headers['retry-after']);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      const ms = retryAfter * 1000;
      return ms <= MAX_RETRY_DELAY_MS ? ms : null;
    }

    // Primary limit: the hour's budget is spent and `x-ratelimit-reset` says
    // when it comes back.
    if (failure.headers['x-ratelimit-remaining'] === '0') {
      const reset = Number(failure.headers['x-ratelimit-reset']);
      if (!Number.isFinite(reset)) return null;
      const ms = reset * 1000 - this.now();
      if (ms > MAX_RETRY_DELAY_MS) return null;
      return Math.max(0, ms);
    }

    // Secondary limit with no header to go by: a short bounded pause.
    if (/secondary rate limit|abuse detection/i.test(failure.message)) {
      return DEFAULT_SECONDARY_BACKOFF_MS;
    }
    return null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Reads
  // ───────────────────────────────────────────────────────────────────────────

  async getIssue(ref: ThreadRef): Promise<Issue> {
    return this.call('getIssue', async () => {
      const res = await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner: ref.repo.owner,
        repo: ref.repo.name,
        issue_number: ref.number,
      });
      return mapIssue(ref.repo, res.data as ApiIssue);
    });
  }

  async getPullRequest(ref: ThreadRef): Promise<PullRequest> {
    const data = await this.call('getPullRequest', async () => {
      const res = await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: ref.repo.owner,
        repo: ref.repo.name,
        pull_number: ref.number,
      });
      return res.data as ApiPull;
    });
    return this.mapPull(ref.repo, data);
  }

  /**
   * The oldest {@link LIMITS.listEntries} comments at or after `since` (GitHub
   * returns issue comments oldest first, which is the order `since` is meant to
   * be read in). Both an issue and a pull request answer on the issues path:
   * a PR's conversation comments are issue comments.
   */
  async listComments(thread: ThreadRef, since?: string): Promise<Comment[]> {
    return this.call('listComments', async () => {
      const res = await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: thread.repo.owner,
        repo: thread.repo.name,
        issue_number: thread.number,
        per_page: LIMITS.listEntries,
        ...(since ? { since } : {}),
      });
      return (res.data as ApiComment[]).slice(0, LIMITS.listEntries).map(mapComment);
    });
  }

  /**
   * Review threads, which exist only in GraphQL — REST has review comments but
   * no conversation they belong to and no `isResolved`. `id` is the node id
   * that resolve/unresolve take.
   */
  async listReviewThreads(pull: ThreadRef): Promise<ReviewThread[]> {
    const query = `query($owner:String!,$name:String!,$number:Int!,$threads:Int!,$comments:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:$threads){
        nodes{
          id
          path
          line
          originalLine
          diffSide
          isResolved
          comments(first:$comments){
            nodes{
              databaseId
              author{ login __typename }
              body
              createdAt
              lastEditedAt
              replyTo{ databaseId }
            }
          }
        }
      }
    }
  }
}`;
    const data = await this.graphql<GqlReviewThreadsResponse>('listReviewThreads', query, {
      owner: pull.repo.owner,
      name: pull.repo.name,
      number: pull.number,
      threads: LIMITS.listEntries,
      comments: LIMITS.listEntries,
    });

    const nodes = data.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    const threads: ReviewThread[] = [];
    for (const node of nodes) {
      if (!node?.id) continue;
      const comments: ReviewThreadComment[] = [];
      for (const c of node.comments?.nodes ?? []) {
        if (!c) continue;
        const comment: ReviewThreadComment = {
          id: c.databaseId ?? 0,
          author: gqlActorOf(c.author),
          body: c.body ?? '',
          createdAt: c.createdAt ?? '',
        };
        // `lastEditedAt` is null until the comment is edited; the contract's
        // `updatedAt` is "set once the comment was edited".
        if (c.lastEditedAt) comment.updatedAt = c.lastEditedAt;
        if (c.replyTo?.databaseId != null) comment.inReplyTo = c.replyTo.databaseId;
        comments.push(comment);
      }
      threads.push({
        id: node.id,
        path: node.path ?? '',
        // A thread on an outdated diff has `line: null` and keeps the line it
        // was written against in `originalLine`.
        line: node.line ?? node.originalLine ?? null,
        side: sideOf(node.diffSide),
        isResolved: node.isResolved === true,
        comments,
      });
    }
    return threads;
  }

  /** Names and stats only: the `patch` field is never read, so it never leaks. */
  async listPullRequestFiles(pull: ThreadRef): Promise<PullRequestFile[]> {
    return this.call('listPullRequestFiles', async () => {
      const res = await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
        owner: pull.repo.owner,
        repo: pull.repo.name,
        pull_number: pull.number,
        per_page: LIMITS.listEntries,
      });
      const files = res.data as Array<{
        filename?: string;
        status?: string;
        additions?: number;
        deletions?: number;
        changes?: number;
      }>;
      return files.slice(0, LIMITS.listEntries).map((f) => ({
        filename: f.filename ?? '',
        status: (f.status ?? 'modified') as PullRequestFile['status'],
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        changes: f.changes ?? 0,
      }));
    });
  }

  /**
   * The rolled-up state of a sha's check runs.
   *
   * The endpoint is paginated, and a busy commit can carry hundreds of runs:
   * reading one page and calling it `success` is how a failure on page two
   * becomes a green light. So pages are followed past a short one until
   * `total_count` runs are read, up to {@link CHECK_RUN_MAX_PAGES} pages, or
   * until a page comes back empty; `total` is GitHub's own `total_count`
   * rather than what we managed to read, and a sha whose runs were not all
   * read is never reported as a definite success — unless a run that was
   * read failed, its conclusion is `null`, the same "not decided" the
   * contract already uses for runs still in flight.
   */
  async getCheckRuns(repo: RepoRef, sha: string): Promise<ChecksSummary> {
    const runs: CheckRunRow[] = [];
    let totalCount = 0;
    // Whether runs were left unread when the loop ended: then the sha can't be a success.
    let more = false;
    // Whether an empty page ended the read before `total_count` was reached.
    let endedShort = false;

    for (let page = 1; page <= CHECK_RUN_MAX_PAGES; page++) {
      const batch = await this.call('getCheckRuns', async () => {
        const res = await this.octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
          owner: repo.owner,
          repo: repo.name,
          ref: sha,
          per_page: CHECK_RUN_PAGE,
          page,
        });
        const data = res.data as { total_count?: number; check_runs?: CheckRunRow[] };
        return { total: data.total_count ?? 0, rows: data.check_runs ?? [] };
      });
      if (page === 1) totalCount = batch.total;
      runs.push(...batch.rows);
      // `total_count` says how many there are, so a short page is no end;
      // a response without one leaves a full page as the sign of more.
      more = totalCount > 0 ? runs.length < totalCount : batch.rows.length === CHECK_RUN_PAGE;
      if (!more) break;
      // An empty page is past the last one: what `total_count` still counts
      // can't be read, such as a run deleted between pages.
      if (batch.rows.length === 0) {
        endedShort = true;
        break;
      }
    }

    const truncated = more;
    if (truncated) {
      this.log(
        'warn',
        endedShort
          ? 'check runs ended before total_count; the sha is reported undecided unless a run read failed'
          : 'check runs did not fit in the page bound; the sha is reported undecided unless a run read failed',
        { sha, read: runs.length, total: totalCount },
      );
    }
    return summarizeChecks(sha, runs, { total: Math.max(totalCount, runs.length), truncated });
  }

  /**
   * Search inside the one repository. Any `repo:`, `user:`, `org:` or
   * `owner:` qualifier in `query` is dropped before the adapter's own `repo:`
   * is prefixed: GitHub ORs those together, so leaving a caller's in would
   * widen the search past the allow-list, which a user token reaches far
   * beyond. Whatever GitHub still returns from another repository on the
   * page is left out, and counted, so no title or link from outside the one
   * repository reaches the answer.
   */
  async searchIssues(repo: RepoRef, query: string, limit: number = LIMITS.listEntries): Promise<IssueSearch> {
    // A qualifier counts wherever no letter, digit, underscore or hyphen comes
    // right before it, which takes in GitHub's own reading of
    // `"x"user:octocat` (a live search, October 2026); dropping it leaves the
    // rest as written.
    const scrubbed = query.replace(/(?<![\w-])-?(?:repo|user|org|owner):[^\s()]+/gi, ' ').replace(/\s+/g, ' ').trim();
    if (scrubbed !== query.trim()) {
      this.log('debug', 'dropped a repo:, user:, org: or owner: qualifier from a search; searches stay inside the allow-list', {
        repo: repoSlug(repo),
      });
    }
    const perPage = Math.min(Math.max(1, Math.trunc(limit)), LIMITS.listEntries);
    return this.call('searchIssues', async () => {
      const res = await this.octokit.request('GET /search/issues', {
        q: `repo:${repoSlug(repo)} ${scrubbed}`.trim(),
        per_page: perPage,
      });
      const items = ((res.data as { items?: (ApiIssue & { repository_url?: string })[] }).items ?? []).slice(0, perPage);
      const inside = items.filter((item) => sameRepoAsGitHub(repoOfUrl(item.repository_url), repo));
      const hits = inside.map((item) => ({
        number: item.number ?? 0,
        kind: item.pull_request ? ('pull' as const) : ('issue' as const),
        title: item.title ?? '',
        state: issueStateOf(item.state),
        updatedAt: item.updated_at ?? '',
        html_url: item.html_url ?? '',
      }));
      return { hits, outside: items.length - inside.length };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Comments
  // ───────────────────────────────────────────────────────────────────────────

  async createComment(thread: ThreadRef, body: string): Promise<Comment> {
    return this.call('createComment', async () => {
      const res = await this.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: thread.repo.owner,
        repo: thread.repo.name,
        issue_number: thread.number,
        body,
      });
      return mapComment(res.data as ApiComment);
    });
  }

  async updateComment(repo: RepoRef, commentId: number, body: string, review = false): Promise<Comment> {
    return this.call('updateComment', async () => {
      const res = review
        ? await this.octokit.request('PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}', {
            owner: repo.owner,
            repo: repo.name,
            comment_id: commentId,
            body,
          })
        : await this.octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: repo.owner,
            repo: repo.name,
            comment_id: commentId,
            body,
          });
      return mapComment(res.data as ApiComment);
    });
  }

  async deleteComment(repo: RepoRef, commentId: number, review = false): Promise<void> {
    await this.call('deleteComment', async () => {
      if (review) {
        await this.octokit.request('DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}', {
          owner: repo.owner,
          repo: repo.name,
          comment_id: commentId,
        });
      } else {
        await this.octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
          owner: repo.owner,
          repo: repo.name,
          comment_id: commentId,
        });
      }
    });
  }

  async replyToReviewComment(pull: ThreadRef, inReplyTo: number, body: string): Promise<Comment> {
    return this.call('replyToReviewComment', async () => {
      const res = await this.octokit.request(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
        {
          owner: pull.repo.owner,
          repo: pull.repo.name,
          pull_number: pull.number,
          comment_id: inReplyTo,
          body,
        },
      );
      return mapComment(res.data as ApiComment);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Review
  // ───────────────────────────────────────────────────────────────────────────

  async createReview(pull: ThreadRef, input: CreateReviewInput): Promise<SubmittedReview> {
    return this.call('createReview', async () => {
      const res = await this.octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
        owner: pull.repo.owner,
        repo: pull.repo.name,
        pull_number: pull.number,
        event: input.event,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.comments && input.comments.length > 0
          ? {
              comments: input.comments.map((c) => ({
                path: c.path,
                line: c.line,
                side: c.side,
                body: c.body,
              })),
            }
          : {}),
      });
      const data = res.data as { id?: number; state?: string; html_url?: string };
      return { id: data.id ?? 0, state: reviewStateOf(data.state), html_url: data.html_url ?? '' };
    });
  }

  async resolveReviewThread(reviewThreadId: string): Promise<void> {
    await this.graphql(
      'resolveReviewThread',
      `mutation($threadId:ID!){ resolveReviewThread(input:{threadId:$threadId}){ thread{ id isResolved } } }`,
      { threadId: reviewThreadId },
    );
  }

  async unresolveReviewThread(reviewThreadId: string): Promise<void> {
    await this.graphql(
      'unresolveReviewThread',
      `mutation($threadId:ID!){ unresolveReviewThread(input:{threadId:$threadId}){ thread{ id isResolved } } }`,
      { threadId: reviewThreadId },
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Issues
  // ───────────────────────────────────────────────────────────────────────────

  async createIssue(repo: RepoRef, input: CreateIssueInput): Promise<Issue> {
    return this.call('createIssue', async () => {
      const res = await this.octokit.request('POST /repos/{owner}/{repo}/issues', {
        owner: repo.owner,
        repo: repo.name,
        title: input.title,
        ...(input.body !== undefined ? { body: input.body } : {}),
      });
      return mapIssue(repo, res.data as ApiIssue);
    });
  }

  /** Close with a reason, reopen, retitle, re-body: one PATCH covers all four. */
  async updateIssue(ref: ThreadRef, input: UpdateIssueInput): Promise<Issue> {
    return this.call('updateIssue', async () => {
      const res = await this.octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
        owner: ref.repo.owner,
        repo: ref.repo.name,
        issue_number: ref.number,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.stateReason !== undefined ? { state_reason: input.stateReason } : {}),
      });
      return mapIssue(ref.repo, res.data as ApiIssue);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Pull requests
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Title, body and base go through REST. The draft flag does not: GitHub only
   * converts a pull request to or from draft through GraphQL
   * (`convertPullRequestToDraft` / `markPullRequestReadyForReview`), so that
   * part of the contract's `updatePullRequest` is one extra mutation on the
   * PR's node id.
   */
  async updatePullRequest(pull: ThreadRef, input: UpdatePullRequestInput): Promise<PullRequest> {
    const restFields = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.base !== undefined ? { base: input.base } : {}),
    };

    let current: ApiPull | null = null;
    if (Object.keys(restFields).length > 0) {
      current = await this.call('updatePullRequest', async () => {
        const res = await this.octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner: pull.repo.owner,
          repo: pull.repo.name,
          pull_number: pull.number,
          ...restFields,
        });
        return res.data as ApiPull;
      });
    }

    if (input.draft !== undefined) {
      current ??= await this.call('updatePullRequest', async () => {
        const res = await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner: pull.repo.owner,
          repo: pull.repo.name,
          pull_number: pull.number,
        });
        return res.data as ApiPull;
      });
      if ((current.draft ?? false) !== input.draft) {
        const nodeId = current.node_id;
        if (!nodeId) {
          throw new GitHubApiError(
            0,
            'the pull request payload carried no node id, so its draft flag cannot be changed',
            'updatePullRequest',
          );
        }
        const mutation = input.draft
          ? `mutation($id:ID!){ convertPullRequestToDraft(input:{pullRequestId:$id}){ pullRequest{ number isDraft } } }`
          : `mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ pullRequest{ number isDraft } } }`;
        await this.graphql('updatePullRequest', mutation, { id: nodeId });
        // The REST payload in hand predates the mutation; re-read so the
        // caller sees the pull request as it now is.
        current = null;
      }
    }

    if (current === null) return this.getPullRequest(pull);
    return this.mapPull(pull.repo, current);
  }

  async requestReviewers(pull: ThreadRef, logins: string[]): Promise<void> {
    await this.call('requestReviewers', async () => {
      await this.octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers', {
        owner: pull.repo.owner,
        repo: pull.repo.name,
        pull_number: pull.number,
        reviewers: logins,
      });
    });
  }

  async createPullRequest(repo: RepoRef, input: CreatePullRequestInput): Promise<PullRequest> {
    const data = await this.call('createPullRequest', async () => {
      const res = await this.octokit.request('POST /repos/{owner}/{repo}/pulls', {
        owner: repo.owner,
        repo: repo.name,
        head: input.head,
        base: input.base,
        title: input.title,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
      });
      return res.data as ApiPull;
    });
    return this.mapPull(repo, data);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Polling fallback (contract amendment 1) and identity
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Issues and pull requests touched at or after `since`, in the order read:
   * oldest change first, except that a row changed while the list is read
   * keeps the place it was first read at (the poller sorts what it
   * delivers). Bounded by {@link POLL_MAX_PAGES} requests rather than by the
   * 50-entry list cap: these rows become events, so a read the bound stops
   * says where it stopped (`resumeAt`) and the next one reads on from there.
   *
   * `headSha` is filled for at most {@link POLL_PR_HEAD_LIMIT} open pull
   * requests (amendment 1's "at most 20 PRs per poll"); the issues endpoint
   * does not carry it, so each one costs a read.
   */
  async listIssuesSince(repo: RepoRef, since: string): Promise<PollRead<PolledIssue>> {
    const { rows, resumeAt } = await this.pollSince<ApiIssue>('listIssuesSince', since, (from, page) =>
      this.octokit.request('GET /repos/{owner}/{repo}/issues', {
        owner: repo.owner,
        repo: repo.name,
        state: 'all',
        sort: 'updated',
        direction: 'asc',
        since: from,
        per_page: 100,
        page,
      }),
    );

    const polled: PolledIssue[] = rows.map(polledIssueOf);

    const openPulls = polled.filter((p) => p.isPullRequest && p.state === 'open').slice(0, POLL_PR_HEAD_LIMIT);
    for (const pull of openPulls) {
      const head = await this.call('listIssuesSince', async () => {
        const res = await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner: repo.owner,
          repo: repo.name,
          pull_number: pull.number,
        });
        return (res.data as ApiPull).head?.sha ?? '';
      });
      if (head) pull.headSha = head;
    }
    return resumeAt === undefined ? { rows: polled } : { rows: polled, resumeAt };
  }

  /** Issue comments updated at or after `since`. Bounded like the issues poll. */
  async listIssueCommentsSince(repo: RepoRef, since: string): Promise<PollRead<PolledComment>> {
    const { rows, resumeAt } = await this.pollSince<ApiComment>('listIssueCommentsSince', since, (from, page) =>
      this.octokit.request('GET /repos/{owner}/{repo}/issues/comments', {
        owner: repo.owner,
        repo: repo.name,
        sort: 'updated',
        direction: 'asc',
        since: from,
        per_page: 100,
        page,
      }),
    );
    const polled = rows.map((row) => mapPolledComment(row, numberFromUrl(row.issue_url)));
    return resumeAt === undefined ? { rows: polled } : { rows: polled, resumeAt };
  }

  /** Review comments updated at or after `since`. Bounded like the issues poll. */
  async listReviewCommentsSince(repo: RepoRef, since: string): Promise<PollRead<PolledComment>> {
    const { rows, resumeAt } = await this.pollSince<ApiComment>('listReviewCommentsSince', since, (from, page) =>
      this.octokit.request('GET /repos/{owner}/{repo}/pulls/comments', {
        owner: repo.owner,
        repo: repo.name,
        sort: 'updated',
        direction: 'asc',
        since: from,
        per_page: 100,
        page,
      }),
    );
    const polled = rows.map((row) => mapPolledComment(row, numberFromUrl(row.pull_request_url)));
    return resumeAt === undefined ? { rows: polled } : { rows: polled, resumeAt };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Contributor-mode ingress: notifications
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Every page of `GET /notifications?all=true&participating=true&since=…`:
   * the threads the token's user takes part in that GitHub updated after
   * `since`, read or unread, so nothing depends on what anyone has marked
   * read. The first page is conditional on `ifModifiedSince` (a
   * `Last-Modified` this method answered before), and a 304 there answers
   * `notModified` with nothing more read. Each page goes through
   * {@link GitHubAdapter.call}, with its rate-limit retry and redaction.
   *
   * GitHub serves these endpoints to a personal access token (classic) only,
   * so a 403 that isn't a rate limit says so, naming the token type.
   */
  async listNotifications(opts: { since: string; ifModifiedSince: string | null }): Promise<NotificationsPage> {
    const notifications: NotificationRow[] = [];
    let head: Omit<NotificationsPage, 'notifications'> | null = null;
    try {
      for (let page = 1; ; page++) {
        const read = this.call('listNotifications', async () => {
          try {
            const res = await this.octokit.request('GET /notifications', {
              all: true,
              participating: true,
              since: opts.since,
              per_page: NOTIFICATIONS_PAGE_SIZE,
              page,
              headers: page === 1 && opts.ifModifiedSince ? { 'if-modified-since': opts.ifModifiedSince } : {},
            });
            return { notModified: false as const, rows: res.data as ApiNotification[], headers: res.headers as Record<string, string | undefined> };
          } catch (raw) {
            const failure = page === 1 ? normalizeFailure(raw) : null;
            if (failure?.status === 304) return { notModified: true as const, rows: [], headers: failure.headers };
            throw raw;
          }
        });
        if (page > THREAD_MAX_PAGES) {
          // A page past the cap is read only to learn whether there was more
          // to list. Any row there, or a page that can't be read, may mean
          // threads past it: the listing is still what pages 1 to the cap gave.
          const more = await read.then(
            (answer) => answer.rows.length > 0,
            () => true,
          );
          if (more) head!.truncated = true;
          break;
        }
        const answer = await read;
        if (page === 1) {
          head = {
            notModified: answer.notModified,
            lastModified: answer.headers['last-modified'] ?? null,
            date: answer.headers['date'] ?? null,
            pollIntervalSeconds: numberOrNull(answer.headers['x-poll-interval']),
            truncated: false,
          };
          if (answer.notModified) return { ...head, notifications: [] };
        }
        notifications.push(...answer.rows.map(mapNotification).filter((n): n is NotificationRow => n !== null));
        if (answer.rows.length < NOTIFICATIONS_PAGE_SIZE) break;
      }
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 403 && !RATE_LIMITED.test(err.githubMessage)) {
        throw new GitHubApiError(
          403,
          `${err.githubMessage} (GitHub serves the notifications endpoints to a personal access token (classic) only, with the notifications scope; a fine-grained token can't read them)`,
          'listNotifications',
        );
      }
      throw err;
    }
    return { ...head!, notifications };
  }

  /**
   * A thread's row as the issues endpoint gives it, which a pull request has
   * too: its state, when it was opened and closed, and who closed it, which
   * for a merged pull request is whoever merged it. No head sha, so the
   * poller reports no new commits: GitHub lists a pull request's thread when
   * someone pushes to it, and a pass that reads it then finds nothing new.
   * The agent learns of new commits from what comes with them, or by reading
   * the pull request.
   */
  async getPolledThread(thread: ThreadRef): Promise<PolledIssue> {
    return this.call('getPolledThread', async () => {
      const res = await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner: thread.repo.owner,
        repo: thread.repo.name,
        issue_number: thread.number,
      });
      return polledIssueOf(res.data as ApiIssue);
    });
  }

  /** A thread's conversation comments updated at or after `since`, every page, oldest first. */
  async listCommentsSince(thread: ThreadRef, since: string): Promise<PolledComment[]> {
    const rows = await this.everyPage<ApiComment>('listCommentsSince', (page) =>
      this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: thread.repo.owner,
        repo: thread.repo.name,
        issue_number: thread.number,
        since,
        per_page: 100,
        page,
      }),
    );
    return rows.map((row) => mapPolledComment(row, thread.number));
  }

  /** A pull request's review comments updated at or after `since`, every page, oldest update first. */
  async listPullReviewCommentsSince(pull: ThreadRef, since: string): Promise<PolledComment[]> {
    const rows = await this.everyPage<ApiComment>('listPullReviewCommentsSince', (page) =>
      this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
        owner: pull.repo.owner,
        repo: pull.repo.name,
        pull_number: pull.number,
        sort: 'updated',
        direction: 'asc',
        since,
        per_page: 100,
        page,
      }),
    );
    return rows.map((row) => mapPolledComment(row, pull.number));
  }

  /**
   * A pull request's reviews submitted at or after `since`, in the order they
   * were submitted, which is the order `GET pulls/{n}/reviews` lists them in.
   * That list takes no `since`, so this reads its first page, whose `Link`
   * header names the last, then reads back from the last page to the first page
   * that starts before `since`. A read costs page 1 and those pages, whatever
   * the pull request's history. At or after, not after: a review submitted in
   * the second the cursor names comes again, and the poller drops it. More than
   * {@link THREAD_MAX_PAGES} pages holding new reviews fail the read, as the
   * other per-thread reads do ({@link ReadCapError}), and so does a `Link` that
   * names a next page but no last, which this read couldn't walk back from.
   */
  async listReviewsSince(pull: ThreadRef, since: string): Promise<PolledReview[]> {
    const sinceMs = Date.parse(since);
    const submitted = (row: ApiReview): number => Date.parse(row.submitted_at ?? '');
    const read = (page: number) =>
      this.call('listReviewsSince', async () => {
        const res = await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
          owner: pull.repo.owner,
          repo: pull.repo.name,
          pull_number: pull.number,
          per_page: 100,
          page,
        });
        // A plain Error: call() names the operation once.
        if (!Array.isArray(res.data)) throw new Error(`GitHub answered page ${page} with something other than a list`);
        return { rows: res.data as ApiReview[], last: lastPageOf((res.headers as Record<string, string | undefined>).link) };
      });
    const first = await read(1);
    if (first.last === null) {
      throw new GitHubApiError(0, 'its reviews list named a next page but no last page, so it could not be read from the newest back', 'listReviewsSince');
    }
    // Response-supplied page numbers must permit finite, exact decrements;
    // Infinity (or a number above the safe integer range) would never move.
    // Do not cap at the read budget: a long history may have few new reviews.
    const last = Math.max(1, Math.min(first.last, Number.MAX_SAFE_INTEGER));
    let rows: ApiReview[] = [];
    let page = last;
    while (page > 1) {
      const batch = (await read(page)).rows;
      if (batch.length === 0) break;
      const reachedOlder = batch.some((row) => submitted(row) < sinceMs);
      // An older-only boundary page may end the read; new rows beyond the
      // cap may not. Unparseable timestamps cannot buy an unbounded walk.
      if (last - page >= THREAD_MAX_PAGES &&
          (batch.some((row) => submitted(row) >= sinceMs) || !reachedOlder)) throw new ReadCapError('listReviewsSince');
      rows = [...batch, ...rows];
      if (reachedOlder) break;
      page -= 1;
    }
    if (page === 1) {
      // Every page after it was new: page 1 counts against the cap only if it holds a new review too.
      if (last > THREAD_MAX_PAGES && first.rows.some((row) => submitted(row) >= sinceMs)) throw new ReadCapError('listReviewsSince');
      rows = [...first.rows, ...rows];
    }
    const newer = rows.filter((row) => {
      const at = submitted(row);
      return Number.isFinite(at) && (!Number.isFinite(sinceMs) || at >= sinceMs);
    });
    newer.sort((a, b) => submitted(a) - submitted(b));
    return newer.map(mapPolledReview);
  }

  /**
   * Every page of one of the notifications poller's per-thread reads, 100
   * rows a page, until a short page. Past {@link THREAD_MAX_PAGES} the read
   * fails rather than return part of the rows, since a cursor can't safely
   * move over a part ({@link ReadCapError}). The poller then reads the thread
   * from its current update on, and its notice says the backlog was skipped.
   */
  private async everyPage<T>(operation: string, fetchPage: (page: number) => Promise<{ data: unknown }>): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.call(operation, async () => {
        const res = await fetchPage(page);
        // A plain Error: call() names the operation once.
        if (!Array.isArray(res.data)) throw new Error(`GitHub answered page ${page} with something other than a list`);
        return res.data as T[];
      });
      if (page > THREAD_MAX_PAGES) {
        // A page past the cap is read only to learn whether there was more.
        if (batch.length === 0) return rows;
        throw new ReadCapError(operation);
      }
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
  }

  /**
   * Contributor mode: the open pull requests `login` authored in `repos`, most
   * recently updated first, from one search (the search API's own rate limit,
   * not the 5,000 an hour), one page of 100, past which it logs what it left
   * out. A result from any other
   * repository is left out. The search names no head, so
   * {@link GitHubAdapter.getPullHeadSha} reads it.
   */
  async listOwnOpenPulls(login: string, repos: readonly RepoRef[]): Promise<OwnPull[]> {
    if (repos.length === 0) return [];
    return this.call('listOwnOpenPulls', async () => {
      const res = await this.octokit.request('GET /search/issues', {
        q: `is:pr is:open author:${login} ${repos.map((repo) => `repo:${repoSlug(repo)}`).join(' ')}`,
        sort: 'updated',
        order: 'desc',
        per_page: 100,
      });
      const data = res.data as { total_count?: number; items?: (ApiIssue & { repository_url?: string })[] };
      const items = data.items ?? [];
      if ((data.total_count ?? 0) > items.length) {
        this.log('warn', 'more open pull requests by the token\'s user than one search page holds; only the most recently updated have their checks looked up', {
          total: data.total_count,
          read: items.length,
        });
      }
      const pulls: OwnPull[] = [];
      for (const item of items) {
        const repo = repos.find((allowed) => sameRepoAsGitHub(repoOfUrl(item.repository_url), allowed));
        if (!repo || !item.pull_request || !item.number) continue;
        pulls.push({ repo, number: item.number, updatedAt: item.updated_at ?? '', html_url: item.html_url ?? '' });
      }
      return pulls;
    });
  }

  /** A pull request's head sha, and nothing else: one read, with none of {@link GitHubAdapter.getPullRequest}'s check runs. */
  async getPullHeadSha(pull: ThreadRef): Promise<string> {
    return this.call('getPullHeadSha', async () => {
      const res = await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: pull.repo.owner,
        repo: pull.repo.name,
        pull_number: pull.number,
      });
      const sha = (res.data as ApiPull).head?.sha ?? '';
      // A plain Error: call() names the operation once.
      if (!sha) throw new Error('GitHub answered with no head sha');
      return sha;
    });
  }

  /**
   * Contributor mode: the token's login, which from-self and the own-comment
   * checks compare against exactly, or why the start can't go on. A set
   * GITHUB_BOT_LOGIN must be the token's own login as GitHub spells it, since
   * any other value would wake the agent on its own posts; an unset one is
   * the login `GET /user` answers. A token GitHub refuses (401, or a 403 that
   * isn't a rate limit) is a problem either way. When GitHub doesn't answer
   * (unreachable, a server error, a rate limit), a set value is used
   * unchecked, with a warning, and an unset one is a problem: there is no
   * login to use.
   */
  async checkTokenLogin(botLogin: string): Promise<{ login: string; problem: null } | { login: null; problem: string }> {
    let login: string;
    try {
      login = (await this.getAuthenticatedBot()).login;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof GitHubApiError && (err.status === 401 || (err.status === 403 && !isRateLimit(err)))) {
        return {
          login: null,
          problem: botLogin
            ? `GET /user refused the token in GITHUB_TOKEN_FILE, so GITHUB_BOT_LOGIN can't be checked against it: ${message}`
            : `GET /user refused the token in GITHUB_TOKEN_FILE, so its login is unknown: ${message}`,
        };
      }
      if (!botLogin) {
        return {
          login: null,
          problem: `GITHUB_BOT_LOGIN is unset and GET /user failed, so the token's login is unknown: set GITHUB_BOT_LOGIN, or start again once GitHub answers (${message})`,
        };
      }
      this.log('warn', 'GET /user failed, so GITHUB_BOT_LOGIN is unchecked against the token', { error: message });
      return { login: botLogin, problem: null };
    }
    if (!botLogin || login === botLogin) return { login, problem: null };
    return {
      login: null,
      problem: `GITHUB_BOT_LOGIN is "${botLogin}", but the token in GITHUB_TOKEN_FILE belongs to "${login}": set GITHUB_BOT_LOGIN to "${login}", spelled exactly so, or leave it unset`,
    };
  }

  /**
   * Contributor mode: what's wrong with GITHUB_REPOS's spelling, one line per
   * entry. Notifications name a repository as GitHub spells it, and the
   * allow-list compares exactly, so an entry spelled otherwise ("the-glassy/x"
   * for "The-Glassy/x") would drop that repository's notifications silently
   * and refuse its events' tool calls. An entry the token can't see is a
   * problem too. An entry GitHub didn't answer for (unreachable, a server
   * error, a rate limit) is left unchecked, with a warning.
   */
  async repoSpellingProblems(repos: readonly RepoRef[]): Promise<string[]> {
    const problems: string[] = [];
    for (const repo of repos) {
      const slug = repoSlug(repo);
      let fullName: string;
      try {
        fullName = await this.call('getRepository', async () => {
          const res = await this.octokit.request('GET /repos/{owner}/{repo}', { owner: repo.owner, repo: repo.name });
          return String((res.data as { full_name?: unknown }).full_name ?? '');
        });
      } catch (err) {
        if (isLastingFailure(err)) {
          problems.push(`GITHUB_REPOS names "${slug}", which the token in GITHUB_TOKEN_FILE can't see (${describeFailure(err)})`);
        } else {
          this.log('warn', 'GET /repos failed, so a GITHUB_REPOS entry is unchecked against GitHub\'s spelling', {
            repo: slug,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      if (fullName !== '' && fullName !== slug) {
        problems.push(`GITHUB_REPOS names "${slug}", but GitHub spells it "${fullName}": set it to "${fullName}", spelled exactly so`);
      }
    }
    return problems;
  }

  /**
   * App mode: the App's own identity. `GET /app` is JWT-authenticated and
   * answers with the App's slug; the login that appears as a comment author
   * is that slug with `[bot]` appended, which is what GITHUB_BOT_LOGIN holds.
   *
   * Contributor mode: the token's own identity, `GET /user` — a human
   * account, so `isBot` is false even though GITHUB_BOT_LOGIN is set to it for
   * from-self and mention detection.
   *
   * Cached either way: neither identity renames itself mid-session.
   */
  async getAuthenticatedBot(): Promise<BotIdentity> {
    if (this.botCache) return this.botCache;
    if (this.config.authMode === 'token') {
      const identity = await this.call('getAuthenticatedBot', async () => {
        const res = await this.octokit.request('GET /user');
        const data = res.data as { login?: string | null; id?: number } | null;
        return { login: data?.login ?? '', id: data?.id ?? 0, isBot: false };
      });
      if (!identity.login) {
        throw new GitHubApiError(0, 'GET /user answered without a login, so the token identity is unknown', 'getAuthenticatedBot');
      }
      this.botCache = identity;
      return identity;
    }
    const identity = await this.call(
      'getAuthenticatedBot',
      async () => {
        const res = await (this.appOctokit as Octokit).request('GET /app');
        const data = res.data as { slug?: string | null; id?: number; name?: string | null } | null;
        const slug = data?.slug ?? data?.name ?? '';
        return { login: slug ? `${slug}[bot]` : '', id: data?.id ?? 0, isBot: true as const };
      },
      { refreshAuth: false },
    );
    if (!identity.login) {
      throw new GitHubApiError(0, 'GET /app answered without a slug, so the bot login is unknown', 'getAuthenticatedBot');
    }
    this.botCache = identity;
    return identity;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Shared helpers
  // ───────────────────────────────────────────────────────────────────────────

  /** A GraphQL call with the same retry, redaction and auth as a REST one. */
  private async graphql<T>(operation: string, query: string, variables: Record<string, unknown>): Promise<T> {
    return this.call(operation, () => this.octokit.graphql<T>(query, variables));
  }

  /**
   * Read a `…Since` list, which GitHub sorts by `updated_at`, oldest first.
   *
   * Each request after the first asks from the last row's `updated_at`
   * rather than for the next page, so a row updated while the list is being
   * read, which moves to the end, can only move into what is still to be
   * read: an offset would slide an unread row onto a page already read. The
   * rows of that second come back again and are dropped by id, keeping the
   * later copy. When a whole page shares one second, the next request asks
   * that second's next page; that paging is by offset, so it holds while
   * GitHub keeps one second's rows in the same order from page to page,
   * which hasn't been checked, and a row of that second changed meanwhile can
   * move another past a page. Only {@link hasNextPage} says whether more are
   * waiting.
   *
   * After {@link POLL_MAX_PAGES} requests the read stops, but never inside a
   * second: the rows of the second it stopped in are left out, and
   * `resumeAt` names that second for the next read to ask from. GitHub's
   * `since` includes its own second, so nothing between is skipped, and no
   * row this read returns comes back unchanged in the next.
   */
  private async pollSince<T extends { id?: number; updated_at?: string | null }>(
    operation: string,
    since: string,
    fetchPage: (from: string, page: number) => Promise<{ data: unknown; headers: { link?: string } }>,
  ): Promise<{ rows: T[]; resumeAt?: string }> {
    const rows = new Map<number, T>();
    let from = since;
    let page = 1;
    // True while the requests page through one `since`, which a stop must not cut.
    let byPage = false;
    for (let requests = 0; ; requests++) {
      if (requests >= POLL_MAX_PAGES && !byPage) {
        const stop = Date.parse(from);
        for (const [id, row] of rows) {
          if (Date.parse(row.updated_at ?? '') >= stop) rows.delete(id);
        }
        this.log('warn', 'poll page cap reached; a later pass reads the rest from resumeAt', {
          operation,
          kept: rows.size,
          resumeAt: from,
        });
        return { rows: [...rows.values()], resumeAt: from };
      }
      const { batch, more } = await this.call(operation, async () => {
        const res = await fetchPage(from, page);
        return { batch: (Array.isArray(res.data) ? res.data : []) as T[], more: hasNextPage(res.headers.link) };
      });
      // A row read again replaces its earlier copy.
      for (const row of batch) rows.set(row.id ?? 0, row);
      if (!more) return { rows: [...rows.values()] };
      const lastAt = batch.at(-1)?.updated_at ?? '';
      const last = Date.parse(lastAt);
      // One second's rows fill the page, or there is no stamp to read on from: by page.
      byPage = !Number.isFinite(last) || last === Date.parse(from);
      if (byPage) {
        page += 1;
      } else {
        from = lastAt;
        page = 1;
      }
    }
  }

  /** A pull request payload plus the check runs on its head sha. */
  private async mapPull(repo: RepoRef, data: ApiPull): Promise<PullRequest> {
    const headSha = data.head?.sha ?? '';
    let checksSummary: ChecksSummary | null = null;
    if (headSha) {
      const summary = await this.getCheckRuns(repo, headSha);
      // `null` is the contract's "no checks on the head sha"; a summary with
      // `conclusion: null` means "checks are still running".
      checksSummary = summary.total > 0 ? summary : null;
    }
    return {
      number: data.number ?? 0,
      kind: 'pull',
      repo,
      title: data.title ?? '',
      body: data.body ?? '',
      state: issueStateOf(data.state),
      draft: data.draft === true,
      merged: data.merged === true || data.merged_at != null,
      mergeable: data.mergeable ?? null,
      head: { ref: data.head?.ref ?? '', sha: headSha },
      base: { ref: data.base?.ref ?? '', sha: data.base?.sha ?? '' },
      author: actorOf(data.user),
      requestedReviewers: (data.requested_reviewers ?? [])
        .map((r) => r?.login ?? '')
        .filter((login): login is string => login !== ''),
      createdAt: data.created_at ?? '',
      updatedAt: data.updated_at ?? '',
      html_url: data.html_url ?? '',
      checksSummary,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Refuse a `baseUrl` that carries credentials in its userinfo.
 *
 * `https://user:secret@host` is rejected by the platform fetch — with the
 * password quoted in the error it throws, before a single byte goes out. This
 * adapter authenticates through the `authorization` header and has no use for
 * userinfo, so the configuration is refused at construction and the secret
 * never reaches a transport that would echo it.
 */
function assertNoUserinfo(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new GitHubApiError(0, 'baseUrl is not a URL', 'constructor');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    // Naming neither the user nor the password: this error is going to a log.
    throw new GitHubApiError(
      0,
      'baseUrl carries credentials in its userinfo; this adapter authenticates through the authorization header, so remove them',
      'constructor',
    );
  }
  return baseUrl;
}

/**
 * Find a {@link GitHubApiError} octokit buried while wrapping a transport
 * failure.
 *
 * `@octokit/request` catches anything the fetch function throws and re-raises
 * it as its own 500, keeping the original on `cause`. The adapter's auth runs
 * inside that fetch function, so a 403 on the token endpoint would otherwise
 * reach the caller as a 500 with no message. The chain is walked a few links
 * deep and no further; `cause` is not guaranteed acyclic.
 */
function authFailureIn(raw: unknown): GitHubApiError | null {
  let current: unknown = raw;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (current instanceof GitHubApiError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** An issues-endpoint row, a list's or a single issue's, as a {@link PolledIssue}. */
function polledIssueOf(row: ApiIssue): PolledIssue {
  return {
    id: row.id ?? 0,
    number: row.number ?? 0,
    isPullRequest: row.pull_request != null,
    title: row.title ?? '',
    body: row.body ?? '',
    state: issueStateOf(row.state),
    author: actorOf(row.user),
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
    html_url: row.html_url ?? '',
    ...(row.closed_by ? { closedBy: actorOf(row.closed_by) } : {}),
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
    ...(row.pull_request?.merged_at === undefined ? {} : { merged: typeof row.pull_request.merged_at === 'string' }),
  };
}

/**
 * The page a `Link` header names `rel="last"`: 1 when it names no next page
 * either, as on a list's only page, and null when it names a next page but no
 * last, as a list paged by cursor would.
 */
function lastPageOf(link: string | undefined): number | null {
  const m = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link ?? '');
  if (m) return Number(m[1]);
  return /rel="next"/.test(link ?? '') ? null : 1;
}

/**
 * A failure the same read will meet again next pass: the thing is gone (404,
 * 410), or out of the token's reach (a 403 that isn't a rate limit). The
 * notifications poller lets such a thread go until it next moves, rather than
 * read it again each pass.
 */
export function isLastingFailure(err: unknown): boolean {
  if (!(err instanceof GitHubApiError)) return false;
  if (err.status === 404 || err.status === 410) return true;
  return err.status === 403 && !RATE_LIMITED.test(err.githubMessage);
}

/**
 * A per-thread read with more rows than {@link THREAD_MAX_PAGES} pages hold.
 * The notifications poller can't move a cursor over part of them, and the
 * same read will meet the same cap again, so it reads the thread from its
 * current update on and tells the agent.
 */
export class ReadCapError extends GitHubApiError {
  constructor(operation: string) {
    super(0, `more than ${THREAD_MAX_PAGES * 100} comments or reviews to read at once`, operation);
    this.name = 'ReadCapError';
  }
}

/**
 * A failure in its reader's terms, an agent's or an operator's: GitHub's
 * status and words, or what went wrong, without the adapter's method names.
 */
export function describeFailure(err: unknown): string {
  if (err instanceof GitHubApiError) {
    if (err.answered) return `GitHub answered ${err.status}: ${err.githubMessage}`;
    return err.status > 0 ? `the request to GitHub failed: ${err.githubMessage}` : err.githubMessage;
  }
  return `the request to GitHub failed: ${err instanceof Error ? err.message : String(err)}`;
}

/** The repository an API URL such as a search result's `repository_url` names, or null. */
function repoOfUrl(url: string | undefined): RepoRef | null {
  const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(url ?? '');
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

/** The same repository as GitHub counts it, whose owner and repository names ignore case; null is no repository. */
function sameRepoAsGitHub(a: RepoRef | null, b: RepoRef): boolean {
  return a !== null && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
}

/**
 * GitHub's rate limit, primary or secondary: a 429, or a 403 whose message
 * says so. It passes with time and says nothing about the thread read, so the
 * notifications poller counts no pass against a thread for it.
 */
export function isRateLimit(err: unknown): boolean {
  if (!(err instanceof GitHubApiError)) return false;
  return err.status === 429 || (err.status === 403 && RATE_LIMITED.test(err.githubMessage));
}

function mapPolledComment(row: ApiComment, number: number): PolledComment {
  const polled: PolledComment = {
    id: row.id ?? 0,
    number,
    author: actorOf(row.user),
    body: row.body ?? '',
    // A comment that was never edited still carries `updated_at === created_at`.
    updatedAt: row.updated_at ?? row.created_at ?? '',
    html_url: row.html_url ?? '',
  };
  if (row.path != null) polled.path = row.path;
  if (row.in_reply_to_id != null) polled.inReplyTo = row.in_reply_to_id;
  return polled;
}

function mapPolledReview(row: ApiReview): PolledReview {
  const review: PolledReview = {
    id: row.id ?? 0,
    author: actorOf(row.user),
    body: row.body ?? '',
    state: reviewStateOf(row.state),
    submittedAt: row.submitted_at ?? '',
    html_url: row.html_url ?? '',
  };
  if (row.commit_id != null) review.commitId = row.commit_id;
  return review;
}

/**
 * `GET /notifications`'s `subject.type` → the contract's `ThreadKind`, or
 * `null` for a subject this ingress has no event kinds for (`Discussion`,
 * `Commit`, `Release`, `CheckSuite`, …) — dropped rather than guessed.
 */
function notificationKindOf(type: string | null | undefined): ThreadKind | null {
  if (type === 'Issue') return 'issue';
  if (type === 'PullRequest') return 'pull';
  return null;
}

/**
 * A notification row, mapped. `repository.full_name` is split the same way
 * `repoFrom` (normalize.ts) splits a webhook's, and `subject.url` — the API
 * url of the issue or pull request, `…/issues/7` or `…/pulls/7` — is read with
 * the same regex `numberFromUrl` uses on a comment's. A row whose repository
 * is unparseable or whose subject names no kind this ingress maps is dropped
 * (null): there is nothing a poll pass could ask GitHub about.
 */
function mapNotification(row: ApiNotification): NotificationRow | null {
  const full = row.repository?.full_name ?? '';
  const [owner, name] =
    full.includes('/') ? full.split('/', 2) : [row.repository?.owner?.login ?? '', row.repository?.name ?? ''];
  if (!owner || !name) return null;
  const kind = notificationKindOf(row.subject?.type);
  const number = numberFromUrl(row.subject?.url);
  if (!row.id || kind === null || number === 0) return null;
  return {
    id: row.id,
    updatedAt: row.updated_at ?? '',
    reason: row.reason ?? '',
    unread: row.unread === true,
    repo: { owner, name },
    kind,
    number,
    title: row.subject?.title ?? '',
  };
}

/** `X-Poll-Interval` (seconds) → a finite number, or null for anything else. */
function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Summarize the check runs read for a sha.
 *
 * `total` defaults to the number of rows given; pass GitHub's `total_count`
 * when the read was paginated. `truncated` says rows were left unread, and a
 * truncated summary never claims `success` — it cannot know what is on the
 * page it did not fetch.
 */
export function summarizeChecks(
  sha: string,
  runs: CheckRunRow[],
  options: { total?: number; truncated?: boolean } = {},
): ChecksSummary {
  const failed: FailedCheck[] = [];
  let incomplete = options.truncated === true;
  let worst: CheckConclusion | null = null;

  for (const run of runs) {
    if (run.status !== 'completed') {
      incomplete = true;
      continue;
    }
    const conclusion = run.conclusion as CheckConclusion | null | undefined;
    if (conclusion && FAILING_CONCLUSIONS.includes(conclusion)) {
      failed.push({ name: run.name ?? '', url: run.html_url ?? '' });
      const rank = FAILING_CONCLUSIONS.indexOf(conclusion);
      if (worst === null || rank < FAILING_CONCLUSIONS.indexOf(worst)) worst = conclusion;
    }
  }

  let conclusion: CheckConclusion | null;
  // A failure is a failure however much is still unread; otherwise anything
  // unfinished or unread leaves the sha undecided, and only a complete,
  // all-clear set is `success`.
  if (worst !== null) conclusion = worst;
  else if (incomplete || runs.length === 0) conclusion = null;
  else conclusion = 'success';

  return {
    sha,
    conclusion,
    total: options.total ?? runs.length,
    failed: failed.slice(0, LIMITS.listEntries),
    ...(incomplete ? { unfinished: true } : {}),
  };
}

/**
 * Turn whatever octokit threw into a status, GitHub's message, the headers
 * the retry decision needs, whether the request only read, and whether GitHub
 * answered at all. Nothing else of the error is kept: octokit's
 * `RequestError` carries the request it made, including its headers, and that
 * object must not travel any further than this function.
 */
function normalizeFailure(raw: unknown): Failure {
  const err = raw as {
    status?: number;
    message?: string;
    request?: { method?: string; url?: string; body?: unknown };
    response?: { headers?: Record<string, unknown>; data?: unknown; status?: number };
    errors?: Array<{ message?: string }>;
  } | null;

  const read = isReadRequest(err?.request?.method, err?.request?.url, err?.request?.body);
  const answered = err?.response !== undefined;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(err?.response?.headers ?? {})) {
    if (typeof v === 'string' || typeof v === 'number') headers[k.toLowerCase()] = String(v);
  }

  // A GraphQL answer is HTTP 200 with an `errors` array; octokit raises it as
  // a GraphqlResponseError, which has no status of its own.
  if (Array.isArray(err?.errors) && err.errors.length > 0 && err?.status === undefined) {
    const message = err.errors.map((e) => e?.message ?? '').filter(Boolean).join('; ');
    return { status: err.response?.status ?? 200, message: message || 'GraphQL error', headers, read, answered: true };
  }

  const data = err?.response?.data as { message?: string } | undefined;
  const message = data?.message ?? err?.message ?? 'unknown error';
  return { status: err?.status ?? err?.response?.status ?? 0, message, headers, read, answered };
}

function isReadRequest(method: string | undefined, url: string | undefined, body: unknown): boolean {
  const verb = method?.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return true;
  if (verb !== 'POST' || !url?.endsWith('/graphql')) return false;
  let document = body;
  if (typeof document === 'string') {
    try {
      document = JSON.parse(document);
    } catch {
      return false;
    }
  }
  const query = (document as { query?: unknown } | null)?.query;
  return typeof query === 'string' && /^(?:\s|#[^\n]*)*(?:query\b|\{)/.test(query);
}
