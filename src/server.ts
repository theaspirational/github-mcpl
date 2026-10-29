/**
 * GitHubMcplServer — the one server the seven packages make (TASK-SRHKG.1.9).
 *
 * What it joins up, in the order a connection meets it:
 *
 *   - **The handshake.** `initialize` answers with MCP's own `capabilities.tools`
 *     always, and with `experimental.mcpl` — the manifest of `feature-sets.ts`,
 *     through {@link ManifestTracker} — only when the host advertised
 *     `experimental.mcpl` itself (§5.1). A host that did not is in plain-MCP
 *     mode: tools, and nothing else. No push, no channels, no rollback.
 *   - **The grant.** `featureSets/update` goes through `grant.ts` and its
 *     response is the §6.7 degradation receipt. Absence is denial (§5.3/§5.4):
 *     before the first grant-bearing Request every tool call, every channel
 *     method and every push is refused, and it stays that way for any path the
 *     host did not name.
 *   - **Tools.** `tools/list` is the *granted* surface under MCPL and the whole
 *     surface in plain MCP ({@link GitHubMcplServer.listedTools});
 *     `tools/call` finds the module that owns the name, refuses an unknown
 *     name *by name* before consulting the grant (a typo is not a policy
 *     question), then asks `grant.toolAllowed`. A `github.comments` call is
 *     followed by a checkpoint, persisted before it is reported, and answers
 *     `state: { checkpoint, parent }` (§8.2), slack-mcpl's order. A successful
 *     call also registers the channel of the thread it touched and books the
 *     thread as the bot's own when it authored anything there.
 *   - **Channels.** `channels/list`, `channels/open`, `channels/close`,
 *     `channels/publish` (as a Request *or* a Notification, §14.3) and
 *     `channels/typing` over the `ChannelRegistry` of .5, each behind its own
 *     capability, and all of them behind GITHUB_REPOS: a channel is a write
 *     surface, so the allow-list that binds the tools binds it too.
 *   - **State.** `state/rollback` through `rollbackComments` (.7); an unknown
 *     or abandoned checkpoint arrives here as a thrown `McplRpcError` and
 *     leaves as the JSON-RPC error `-32005` (§8.7).
 *   - **The pipeline.** One `onEvent` for both ingress paths (.3):
 *     `tagsFor` (.4) → `renderEvent` (.4) → `channels/incoming` (.5) *and*
 *     `push/event`. The two egress paths are granted separately, so a host
 *     with no channels still wakes and a host with no push still reads its
 *     channels; only an event with a thread can be a channel delivery. Each
 *     path is re-asked immediately before its own send ({@link
 *     GitHubMcplServer.eventEgressAllowed}), so a reduction the host
 *     acknowledged while the event was in flight stops it.
 *
 * Stdout is the JSON-RPC channel: every diagnostic goes through the Logger,
 * which writes to stderr only.
 */

import {
  McplConnection,
  method,
  ManifestTracker,
  type ChannelsCloseParams,
  type ChannelsCloseResult,
  type ChannelsListResult,
  type ChannelsOpenParams,
  type ChannelsOpenResult,
  type ChannelsTypingParams,
  type ContentBlock,
  type FeatureSetsUpdateParams,
  type InitializeCapabilities,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type McplInitializeParams,
  type McplInitializeResult,
  type PushEventParams,
  type StateRollbackParams,
} from '@animalabs/mcpl-core';
import { ChannelRegistry, type GitHubPublishParams, type PublishOutcome } from './channels.js';
import { renderEvent } from './content.js';
import { McplRpcError, capabilityDenied } from './errors.js';
import { buildFeatureSets, buildServerCapabilities } from './feature-sets.js';
import { CapabilityGrant } from './grant.js';
import { GithubState } from './state.js';
import { tagsFor, type GitHubTagContext } from './tags.js';
import { recordCreated, rollbackComments, type RollbackEffect } from './tools-comments.js';
import {
  COMMENTS_FEATURE_SET,
  EVENTS_FEATURE_SET,
  TOOL_COMMENT,
  TOOL_CREATE_REVIEW,
  TOOL_EDIT_OWN_COMMENT,
  TOOL_REPLY_IN_THREAD,
  TOOL_UPSERT_STICKY_COMMENT,
  channelId,
  repoAllowed,
  repoSlug,
  stderrLogger,
  type CreatedComment,
  type EventMetadata,
  type GitHubApi,
  type Logger,
  type NormalizedEvent,
  type RepoRef,
  type StateStore,
  type ThreadKind,
  type ThreadRef,
  type ToolContext,
  type ToolModule,
  type ToolResult,
} from './types.js';

export interface GitHubServerOptions {
  /** GITHUB_BOT_LOGIN. From-self and mention detection depend on it. */
  botLogin?: string;
  /** GITHUB_REPOS, the write allow-list. */
  repos?: readonly RepoRef[];
  /** GITHUB_MAINTAINERS; `github:actor=maintainer` and `isMaintainer`. */
  maintainers?: readonly string[];
  /** GITHUB_PR_BASE_ALLOW; what `github.pr` may target. */
  prBaseAllow?: readonly string[];
  /**
   * The checkpoint store. Absent keeps an in-memory {@link GithubState}, which
   * is what the contract notes say GITHUB_STATE_FILE's absence means.
   */
  state?: StateStore;
  logger?: Logger;
}

/** JSON-RPC: the method is not implemented (App. A). */
const ERR_METHOD_NOT_FOUND = -32601;
/** JSON-RPC: the request's params are not usable (App. A). */
const ERR_INVALID_PARAMS = -32602;
/** JSON-RPC: an internal failure (App. A). */
const ERR_INTERNAL = -32603;

const SERVER_NAME = 'github-mcpl';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

/**
 * How many comments of a thread the own-thread lookup reads. The adapter
 * already bounds a page; this bounds how much of that page is remembered, so
 * a thread with ten thousand comments costs a fixed amount of memory per
 * connection.
 */
const THREAD_MEMORY = 200;

/**
 * What the server knows about one thread — one record per `<repo>#<number>`,
 * and the only place that knowledge lives.
 *
 * Four writers learn about a thread: a tool write, a channel publish, an
 * inbound event, and the bounded history read. They used to each keep their
 * own corner of it, and the three ways they disagreed were three review
 * findings (WP9 review round 3). So the rules are written here, once, and
 * every writer goes through {@link GitHubMcplServer.learn}:
 *
 *  1. **Merge, never replace.** A writer contributes what it learned and
 *     nothing else: `own` only ever goes false → true, `botReviewIds` only
 *     ever gains ids, and `kind` is set only by a writer that *knows*. The
 *     merge is one synchronous function on the live record, so a history read
 *     that completes after a tool write cannot erase what the write learned —
 *     there is no snapshot to install over it.
 *  2. **Kind is resolved before it is registered.** `kind` is authoritative
 *     only from a webhook (which says which API delivered it) or from the API
 *     (a successful `getPullRequest`); never from a tool argument, where
 *     `#58` means `issue` by default and might be a pull request. A tool touch
 *     of an unresolved thread resolves it once ({@link
 *     GitHubMcplServer.resolveKind}) before anything is registered or
 *     remembered, and a webhook that contradicts a registered channel
 *     reconciles it (`ChannelRegistry.touch`).
 *  3. **Partial is not loaded.** `loaded` says the bounded history has been
 *     read since the last invalidation — *not* that something is known. A
 *     record a tool write created knows `own` and knows nothing about the
 *     thread's history, so the next event on it still reads that history.
 *     `create_review` with inline comments invalidates it again: GitHub
 *     answers such a call with the review's id and never the comments' ids.
 *  4. `isOwnThread` is `own`. `isReplyToSelf` is `inReplyTo ∈ botReviewIds`
 *     for a review comment, which GitHub tells us outright; for a top-level
 *     comment, which carries no reply relation at all, it is amendment 2b's
 *     turn-order rule over `recentComments`. Asked only of a loaded record.
 */
interface ThreadKnowledge {
  /**
   * Issue or pull request, or `unknown` until an authoritative source says.
   * The channel id carries no discriminator (an issue and a PR share one
   * number space per repository), and the `rt:` publish route needs one.
   */
  kind: ThreadKind | 'unknown';
  /** The bot opened this thread or has written in it. */
  own: boolean;
  /**
   * Ids of this thread's **review** comments the bot authored, bounded by
   * {@link THREAD_MEMORY}.
   *
   * Review comments alone: `inReplyTo` only ever names one, and GitHub
   * numbers issue comments and review comments separately — so an issue
   * comment id in here could match an unrelated review comment's `inReplyTo`
   * and claim a reply to the bot that never happened. A *review* id is kept
   * out for the same reason: `createReview` answers with the review's id, and
   * a review is not a comment.
   */
  botReviewIds: Set<number>;
  /**
   * This thread's **top-level** comments, oldest first, bounded by {@link
   * THREAD_MEMORY}: each id and whether the bot wrote it (amendment 2b).
   *
   * Ids ascend along the list — GitHub numbers issue comments monotonically —
   * so "the comment immediately before X" is the last entry whose id is below
   * X's, which is what the amendment's first rule asks for. Top-level
   * comments alone, for the reason {@link ThreadKnowledge.botReviewIds} gives:
   * the two endpoints number their comments separately.
   */
  recentComments: { id: number; mine: boolean }[];
  /**
   * Ids of top-level comments this server knows are **gone**, bounded by
   * {@link THREAD_MEMORY} (review round 4, finding 2).
   *
   * A removal has to outlive the read that contradicts it. `listComments`
   * snapshots are taken asynchronously and merged when they land, so one
   * begun before a deletion arrives afterwards still listing the comment —
   * and `learn` merges, so it would seat the id again and the *next* clean
   * read would never expunge it either, because that read only inserts too.
   * An id in here is refused by `learn` however late and from whatever
   * source it arrives. GitHub does not reuse comment ids, so a tombstone can
   * never suppress a real later comment.
   */
  removedComments: Set<number>;
  /** The bounded history has been read since the last invalidation. */
  loaded: boolean;
  /**
   * Bumped by every invalidation (`loaded: false`). A history read that began
   * before a newer invalidation must not mark the record loaded: it read a
   * history that is already stale (review round 4, finding 2).
   */
  generation: number;
}

/**
 * Tools whose success means the bot now has content of its own on the thread,
 * which is exactly what `isOwnThread` reports.
 *
 * The bot's own writes do come back as webhook events, and {@link
 * GitHubMcplServer.handleEvent} books them — but not before GitHub has
 * delivered them, and not at all on a connection whose ingress is off. So a
 * successful call of one of these updates the thread knowledge immediately
 * (WP9 review, finding 7). Every other tool touches a thread without authoring
 * anything and leaves the knowledge as it found it: `delete_own_comment`
 * included, since a removed comment is not evidence the bot was never there.
 */
const AUTHORING_TOOLS: ReadonlySet<string> = new Set([
  TOOL_COMMENT,
  TOOL_REPLY_IN_THREAD,
  TOOL_EDIT_OWN_COMMENT,
  TOOL_UPSERT_STICKY_COMMENT,
  TOOL_CREATE_REVIEW,
]);

/** A thread one tool call named, with the title that call read or wrote. */
interface ToolTouch {
  thread: ThreadRef;
  title?: string;
  /**
   * The id of a review comment this call created on the thread, when it
   * created one — the handle a later `inReplyTo` names (WP9 review round 2,
   * finding 2).
   */
  reviewCommentId?: number;
  /**
   * A **top-level** comment this call created or edited on the thread, with
   * the body GitHub answered with (amendment 2b). Kept apart from
   * {@link ToolTouch.reviewCommentId} because the two endpoints number their
   * comments separately.
   */
  commentId?: number;
  /**
   * The call proved this thread is a pull request: it answered from an
   * endpoint that serves nothing else. The one kind a tool call can establish
   * (rule 2 of {@link ThreadKnowledge}) — `issue` it cannot, because the
   * issues endpoint serves pull requests too and `#58` *defaults* to `issue`.
   */
  provenPull?: true;
  /**
   * The call submitted a review carrying inline comments, whose ids GitHub
   * did not answer with. The thread's review history is stale from here on
   * (rule 3 of {@link ThreadKnowledge}).
   */
  createdInlineComments?: true;
}

/**
 * `GitHubApi` methods whose first argument is the thread the call acts on, so
 * calling one is a tool touch of that thread.
 */
const THREAD_ARGUMENT: ReadonlySet<keyof GitHubApi> = new Set<keyof GitHubApi>([
  'getIssue',
  'getPullRequest',
  'listComments',
  'listReviewThreads',
  'listPullRequestFiles',
  'createComment',
  'replyToReviewComment',
  'createReview',
  'updateIssue',
  'updatePullRequest',
  'requestReviewers',
]);

/**
 * `GitHubApi` methods whose answer *is a review comment this call created* on
 * the thread of their first argument.
 *
 * Exactly one: `replyToReviewComment`. `createComment` creates an issue
 * comment, and GitHub numbers the two endpoints separately — an issue comment
 * id booked as the bot's review comment could match an unrelated review
 * comment's `inReplyTo` and claim a reply to the bot that never happened, so
 * those ids are deliberately kept out (see {@link ThreadKnowledge}).
 * `createReview` does create review comments, but `SubmittedReview` answers
 * only the review's own id, so their ids are learned the way they always were:
 * the thread lookup, or the bot's webhook coming back.
 */
const CREATED_REVIEW_COMMENT: ReadonlySet<keyof GitHubApi> = new Set<keyof GitHubApi>(['replyToReviewComment']);

/**
 * `GitHubApi` methods that answer with a **top-level** comment the bot now
 * owns, created (amendment 2b). It answers with the comment, so the id and
 * the body are read off the answer rather than guessed from the arguments.
 */
const CREATED_COMMENT: ReadonlySet<keyof GitHubApi> = new Set<keyof GitHubApi>(['createComment']);

/**
 * `GitHubApi` methods that answer with a **top-level** comment the bot owns
 * and has just rewritten — `edit_own_comment`, and the second call of
 * `upsert_sticky_comment`.
 *
 * Watched for the comment's **identity alone**: that this id is a comment of
 * the bot's on this thread, which is what the turn-order rule asks. The body
 * is not read and nothing about it is kept.
 *
 * Round 7 removed this set along with the quote rule, on the reasoning that
 * an edit changes only a body. That was wrong about *which* record: a tool
 * touch leaves a record it created unloaded, but it leaves an **already
 * loaded** one loaded, and a loaded record is never re-read. So when the
 * bounded history read had missed the comment — a lagging replica omitted it
 * — editing it taught nothing, and the human comment immediately after the
 * bot's read as `chat:ambient` on a thread whose order was plainly human,
 * bot, human (review round 8). `stateKnowsWrite` does not close this: it
 * carries ownership, not which id the comment has.
 *
 * `updateComment` takes a **repository** and not a thread, so like a delete
 * the change is reported on its own and {@link
 * GitHubMcplServer.afterToolCall} places it on the thread the call resolved
 * — sound because both callers read the thread before rewriting anything.
 */
const EDITED_COMMENT: ReadonlySet<keyof GitHubApi> = new Set<keyof GitHubApi>(['updateComment']);

/**
 * `GitHubApi` methods that **remove** a comment the bot owns, which is
 * `delete_own_comment`'s whole job (review round 3, finding 1). A comment
 * GitHub no longer has must leave the thread's turn order, or the next
 * unrelated human comment reads as a reply to something that is not there.
 *
 * `deleteComment` answers `void`, so unlike an edit there is nothing to read
 * off the answer: the id and the endpoint come from its own arguments and the
 * resolution of the promise is the whole of the success.
 */
const DELETED_COMMENT: ReadonlySet<keyof GitHubApi> = new Set<keyof GitHubApi>(['deleteComment']);

/**
 * One top-level comment a tool call changed: rewrote, or removed. An id and
 * which endpoint it came from — no body, since v1's turn-order rule asks
 * nothing about one (Amendment 2 revision, 2026-10-14).
 *
 * `review` is the endpoint discriminator — `updateComment`'s fourth argument,
 * `deleteComment`'s third. A review comment is reported here too and then
 * **skipped**, rather than being filtered out at the seam, so the
 * discriminator stays visible at the decision: a review comment's identity
 * lives in `botReviewIds` under GitHub's exact `inReplyTo` rule, and feeding
 * one into the top-level turn order would claim a reply that never happened —
 * the mistake {@link ThreadKnowledge.botReviewIds} exists to prevent.
 */
interface CommentChange {
  action: 'edit' | 'delete';
  id: number;
  review: boolean;
}

/**
 * `GitHubApi` methods that live on GitHub's pull-request endpoints and so
 * serve nothing else: one of these *answering* proves the thread of its first
 * argument is a pull request, whatever the argument's own `kind` said.
 *
 * This is the free half of rule 2 of {@link ThreadKnowledge}. The other half
 * is {@link GitHubMcplServer.resolveKind}'s one `getPullRequest`, paid only
 * when a tool touched a thread without proving anything about it.
 *
 * `getIssue` is deliberately absent: `GET /issues/{n}` answers for a pull
 * request too (`mapIssue` then calls it an issue), so its success proves
 * nothing. `createPullRequest` takes a repository rather than a thread, and
 * is covered by its answer instead — see {@link asTitledThread}.
 */
const PULL_ONLY: ReadonlySet<keyof GitHubApi> = new Set<keyof GitHubApi>([
  'getPullRequest',
  'listReviewThreads',
  'listPullRequestFiles',
  'createReview',
  'replyToReviewComment',
  'updatePullRequest',
  'requestReviewers',
]);

/**
 * `GitHubApi` methods that answer with an issue or a pull request, so the call
 * also learns the thread's title. `createIssue` and `createPullRequest` take a
 * repository rather than a thread, and this is the only way the thread they
 * made is known at all.
 */
const TITLED_RESULT: ReadonlySet<keyof GitHubApi> = new Set<keyof GitHubApi>([
  'getIssue',
  'getPullRequest',
  'createIssue',
  'updateIssue',
  'createPullRequest',
  'updatePullRequest',
]);

/**
 * The `GitHubApi` one tool call sees, with the threads and titles it used
 * reported to `touched`.
 *
 * Two things need to know which thread a call acted on: .5 registers a channel
 * on the first event on a thread **or the first tool touch of one**, and the
 * own-thread knowledge has to learn about a write when it happens. Reading
 * either off the rendered result text would be guesswork about prose this
 * server wrote for a model; this reads them off the seam the tool actually
 * used — the `ThreadRef` it passed in, and the title GitHub answered with — so
 * no tool module has to report anything and no renderer is parsed.
 *
 * A method this does not watch is forwarded untouched, and so is every
 * non-function member.
 */
function watchThreads(
  api: GitHubApi,
  touched: (touch: ToolTouch) => void,
  changed: (change: CommentChange) => void,
): GitHubApi {
  return new Proxy(api, {
    get(target, prop) {
      // `target` as the receiver, not the proxy: a getter on the adapter must
      // see its own private fields, and a method is applied to `target` below
      // for the same reason.
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const name = prop as keyof GitHubApi;
      const watchArgument = THREAD_ARGUMENT.has(name);
      const watchResult = TITLED_RESULT.has(name);
      const watchCreated = CREATED_REVIEW_COMMENT.has(name);
      const watchComment = CREATED_COMMENT.has(name);
      const watchEdit = EDITED_COMMENT.has(name);
      const watchDelete = DELETED_COMMENT.has(name);
      const watchPull = PULL_ONLY.has(name);
      const watchInline = name === 'createReview';
      if (
        !watchArgument &&
        !watchResult &&
        !watchCreated &&
        !watchComment &&
        !watchEdit &&
        !watchDelete &&
        !watchPull
      ) {
        return value;
      }
      return (...args: unknown[]): unknown => {
        const argThread = watchArgument || watchCreated || watchComment || watchPull ? asThreadRef(args[0]) : null;
        if (watchArgument && argThread) touched({ thread: argThread });
        // `updateComment(repo, id, body, review?)`: the discriminator is its
        // own fourth argument, and absent means an issue comment.
        const editIsReview = watchEdit && args[3] === true;
        // `deleteComment(repo, id, review?)`: both facts are arguments, because
        // the call answers nothing.
        const deleted = watchDelete
          ? { id: typeof args[1] === 'number' ? args[1] : undefined, review: args[2] === true }
          : null;
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!watchResult && !watchCreated && !watchComment && !watchEdit && !watchDelete && !watchPull) return out;
        // Everything below is reported only once the call has *answered*: a
        // refused or failed call proves nothing about the thread's kind and
        // created no comment.
        return Promise.resolve(out).then((answer) => {
          if (watchResult) {
            const titled = asTitledThread(answer);
            if (titled) touched(titled);
          }
          if (watchPull && argThread) touched({ thread: argThread, provenPull: true });
          if (watchCreated && argThread) {
            const id = commentIdOf(answer);
            if (id !== undefined) touched({ thread: argThread, reviewCommentId: id });
          }
          if (watchComment && argThread) {
            const id = commentIdOf(answer);
            if (id !== undefined) touched({ thread: argThread, commentId: id });
          }
          if (watchEdit) {
            // The id GitHub answered with, which is the one it actually
            // rewrote. Identity only: the body it answers with is not read.
            const id = commentIdOf(answer);
            if (id !== undefined) changed({ action: 'edit', id, review: editIsReview });
          }
          if (deleted && deleted.id !== undefined) {
            // No thread here to attach it to — `deleteComment` takes a
            // repository — so the removal is reported on its own and
            // `afterToolCall` places it on the thread the call resolved,
            // which is sound because the caller read the thread first.
            changed({ action: 'delete', id: deleted.id, review: deleted.review });
          }
          if (watchInline && argThread && hasInlineComments(args[1])) {
            touched({ thread: argThread, createdInlineComments: true });
          }
          return answer;
        });
      };
    },
  }) as GitHubApi;
}

/** `{ repo: { owner, name }, number, kind }`, or null for anything else. */
function asThreadRef(value: unknown): ThreadRef | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const repo = v.repo as Record<string, unknown> | undefined;
  if (!repo || typeof repo.owner !== 'string' || typeof repo.name !== 'string') return null;
  if (typeof v.number !== 'number' || !Number.isInteger(v.number) || v.number <= 0) return null;
  if (v.kind !== 'issue' && v.kind !== 'pull') return null;
  return { repo: { owner: repo.owner, name: repo.name }, number: v.number, kind: v.kind };
}

/** The numeric id of a {@link Comment} answer, or undefined for anything else. */
function commentIdOf(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'number' && Number.isInteger(id) ? id : undefined;
}

/**
 * An {@link Issue} or {@link PullRequest} answer, as a touch with its title.
 *
 * A `PullRequest` answer carries `kind: 'pull'` from the pull-request endpoint
 * that produced it, so it proves the kind — which is the only way the thread
 * `createPullRequest` just made is known to be a pull request at all (it takes
 * a repository, not a thread). An `Issue` answer proves nothing: `mapIssue`
 * writes `kind: 'issue'` for whatever the issues endpoint returned.
 */
function asTitledThread(value: unknown): ToolTouch | null {
  const thread = asThreadRef(value);
  if (!thread) return null;
  const title = (value as Record<string, unknown>).title;
  return {
    thread,
    ...(typeof title === 'string' ? { title } : {}),
    ...(thread.kind === 'pull' ? { provenPull: true as const } : {}),
  };
}

/** Did this `createReview` input carry inline comments of its own? */
function hasInlineComments(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const comments = (input as Record<string, unknown>).comments;
  return Array.isArray(comments) && comments.length > 0;
}

/**
 * What a state record says about where its comment lives. `StateStore.snapshot`
 * is typed to the narrow {@link CreatedComment}; .7 writes the thread alongside
 * it (`CreatedCommentRecord`), which is what makes a record readable back as
 * "the bot has written on this thread".
 */
type RecordedComment = CreatedComment & { thread?: { number: number } };

export class GitHubMcplServer {
  readonly grant = new CapabilityGrant(buildFeatureSets());
  /** §17: the manifest presented at `initialize` and answered to `mcpl/manifest`. */
  readonly manifest = new ManifestTracker(buildServerCapabilities());
  readonly state: StateStore;

  private readonly logger: Logger;
  private readonly modules = new Map<string, ToolModule>();
  /** Tool name → the module that owns it, built as modules register. */
  private readonly owners = new Map<string, ToolModule>();
  private conn: McplConnection | null = null;
  private mcplEnabled = false;
  private channels: ChannelRegistry | null = null;
  private detachManifest: (() => void) | null = null;
  /** Per-connection, keyed by channel id. A new host gets a new memory. */
  private threadMemory = new Map<string, ThreadKnowledge>();
  /** In-flight lookups, so two events on one thread make one API call. */
  private threadLookups = new Map<string, Promise<ThreadKnowledge>>();
  /** In-flight kind resolutions, so two tool touches of one thread ask once. */
  private kindProbes = new Map<string, Promise<ThreadKind | undefined>>();

  constructor(
    readonly api: GitHubApi,
    readonly options: GitHubServerOptions = {},
  ) {
    this.logger = options.logger ?? stderrLogger();
    this.state = options.state ?? GithubState.empty(null, this.logger);
  }

  /** Register a feature set's tools. .6 and .7 hand their modules in here. */
  register(module: ToolModule): void {
    this.modules.set(module.featureSet, module);
    for (const tool of module.tools) this.owners.set(tool.name, module);
  }

  /** The registered tool modules, in registration order. */
  toolModules(): ToolModule[] {
    return [...this.modules.values()];
  }

  /** Every registered tool, in registration order. */
  toolDefinitions(): ToolModule['tools'] {
    return this.toolModules().flatMap((m) => m.tools);
  }

  /**
   * What `tools/list` answers on this connection.
   *
   * Under MCPL it is the granted surface and nothing else: a tool the grant
   * would refuse is not offered, so a model is never shown an affordance it
   * cannot use, and the listing matches what `tools/call` will accept (WP9
   * review, finding 6). Before the initial policy exchange that is the empty
   * list — absence is denial (§5.3/§5.4) — and a host that widens its grant
   * knows the listing moved, because it is the one that widened it.
   *
   * A plain-MCP host sees the whole surface: there is no grant on that
   * connection to narrow it by, and filtering it to nothing would make the
   * server useless to an ordinary MCP client.
   */
  listedTools(): ToolModule['tools'] {
    const all = this.toolDefinitions();
    return this.mcplEnabled ? all.filter((tool) => this.grant.toolAllowed(tool.name)) : all;
  }

  /** True when the host negotiated MCPL on this connection. */
  get isMcpl(): boolean {
    return this.mcplEnabled;
  }

  /** What a tool body is given. One object, built from the options and state. */
  toolContext(): ToolContext {
    return {
      api: this.api,
      state: this.state,
      botLogin: this.options.botLogin ?? '',
      repos: this.options.repos ?? [],
      prBaseAllow: this.options.prBaseAllow ?? [],
      logger: this.logger,
    };
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  /**
   * Serve one connection until the peer closes it.
   *
   * Everything per-connection is rebuilt here and torn down at the end: the
   * grant (§5.3 — a previous peer's policy is not this peer's), the channel
   * registry (registration is per-host, §14.5) and the thread memory.
   */
  async serve(conn: McplConnection): Promise<void> {
    conn.on('error', (err) => this.logger.error('connection error', { error: String(err) }));
    this.conn = conn;
    this.grant.reset();
    this.channels = new ChannelRegistry({
      host: { send: (m, p) => conn.sendRequest(m, p) },
      logger: this.logger,
      // Asked at every announcement, not once here: the grant is the host's
      // and narrows whenever it says so (§5.4). A plain-MCP connection never
      // registers anything — there is no channel surface on it at all.
      canRegister: () => this.mcplEnabled && this.grant.has('channels.register'),
      // And asked again after a queued registration or refresh, immediately
      // before the `channels/incoming` send, for the same reason: see
      // {@link GitHubMcplServer.eventEgressAllowed}.
      canDeliver: () => this.eventEgressAllowed(conn, 'incoming'),
    });
    this.threadMemory = new Map();
    this.threadLookups = new Map();
    this.kindProbes = new Map();

    try {
      if (!(await this.handleInitialize(conn))) return;

      // §17.3: the handshake carried this revision, so the connection is
      // seeded with it and only a later change is announced.
      this.detachManifest = this.mcplEnabled
        ? this.manifest.attach(
            { sendNotification: (m, p) => conn.sendNotification(m, p) },
            { announcedRevision: this.manifest.revision },
          )
        : null;

      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        // Both awaited, so the host's messages take effect in the order it
        // sent them: a publish Notification followed by a `channels/list` has
        // to have happened by the time the list is answered.
        if (msg.type === 'request') await this.handleRequest(msg.request);
        else await this.handleNotification(msg.notification);
      }
    } catch (err) {
      if ((err as Error).name !== 'ConnectionClosedError') {
        this.logger.error('connection error', { error: String(err) });
      }
    } finally {
      this.detachManifest?.();
      this.detachManifest = null;
      this.conn = null;
      this.channels = null;
      this.mcplEnabled = false;
    }
  }

  /**
   * The `initialize` exchange. Returns false when the peer did not open with
   * one, which is a protocol error there is nothing useful to answer.
   *
   * MCPL is on exactly when the host advertised `experimental.mcpl` — the
   * presence of the member, not its contents, is the signal (§5.1), the same
   * test slack-mcpl makes.
   */
  private async handleInitialize(conn: McplConnection): Promise<boolean> {
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') {
      this.logger.error('expected initialize', {
        got: msg.type === 'request' ? msg.request.method : msg.notification.method,
      });
      conn.close();
      return false;
    }

    const params = msg.request.params as McplInitializeParams | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;

    const capabilities: InitializeCapabilities = {
      tools: {},
      ...(this.mcplEnabled ? { experimental: { mcpl: this.manifest.snapshot() } } : {}),
    };
    const result: McplInitializeResult = {
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
    conn.sendResponse(msg.request.id, result);

    // An inaccurate `uses` disables its own feature set (§6.4), which is a bug
    // on this side rather than a policy outcome — said once, at the handshake.
    for (const bad of this.grant.invalidDeclarations()) {
      this.logger.error('feature set declares an invalid uses', bad);
    }

    const inited = await conn.nextMessage();
    if (inited.type === 'notification' && inited.notification.method === 'notifications/initialized') {
      this.logger.info('host initialized', {
        mode: this.mcplEnabled ? 'mcpl' : 'mcp',
        client: params?.clientInfo?.name,
      });
    }

    // No default grant (§5.3): until a grant-bearing featureSets/update
    // Request is answered, nothing capability-dependent is available. Plain
    // MCP tool calls are unaffected — there is no grant to consult.
    return true;
  }

  /** MCPL was not negotiated, so this method does not exist on this connection. */
  private requireMcpl(what: string): void {
    if (!this.mcplEnabled) {
      throw new McplRpcError(ERR_METHOD_NOT_FOUND, `${what} needs MCPL, which is not negotiated on this connection`);
    }
  }

  private require(capability: string): void {
    if (!this.grant.has(capability)) throw capabilityDenied(capability);
  }

  // ── Request dispatch ──────────────────────────────────────────────────────

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    const params = (req.params ?? {}) as Record<string, unknown>;

    try {
      switch (req.method) {
        case 'tools/list':
          conn.sendResponse(req.id, { tools: this.listedTools() });
          break;

        case 'tools/call': {
          const result = await this.handleToolCall(
            params.name,
            (params.arguments ?? {}) as Record<string, unknown>,
          );
          conn.sendResponse(req.id, result);
          break;
        }

        case method.FEATURE_SETS_UPDATE: {
          // §6.7: the Request form carries the effective grant and its
          // response is a degradation receipt — what this server WILL DO
          // under the grant it was given, never a claim of entitlement.
          this.requireMcpl('featureSets/update');
          const receipt = this.grant.apply(params as unknown as FeatureSetsUpdateParams, 'request');
          conn.sendResponse(req.id, receipt);
          break;
        }

        case method.MCPL_MANIFEST:
          this.requireMcpl('mcpl/manifest');
          conn.sendResponse(req.id, this.manifest.handleManifestRequest());
          break;

        case method.CHANNELS_LIST: {
          this.requireMcpl('channels/list');
          this.require('channels.register');
          const result: ChannelsListResult = { channels: this.registry().list() };
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_OPEN: {
          this.requireMcpl('channels/open');
          this.require('channels.lifecycle');
          conn.sendResponse(req.id, await this.handleOpen(params as unknown as ChannelsOpenParams));
          break;
        }

        case method.CHANNELS_CLOSE: {
          this.requireMcpl('channels/close');
          this.require('channels.lifecycle');
          const p = params as unknown as ChannelsCloseParams;
          // Nothing is torn down: a GitHub thread outlives a host's interest
          // in it, and an event on it is still a push. `closed` reports only
          // whether the channel was one this server had registered.
          const result: ChannelsCloseResult = { closed: this.registry().get(p.channelId) !== undefined };
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_PUBLISH: {
          this.requireMcpl('channels/publish');
          conn.sendResponse(req.id, await this.publish(params as unknown as GitHubPublishParams));
          break;
        }

        case method.CHANNELS_TYPING: {
          this.requireMcpl('channels/typing');
          this.require('channels.typing');
          conn.sendResponse(req.id, this.registry().handleTyping(params as unknown as ChannelsTypingParams));
          break;
        }

        case STATE_CHECKPOINT: {
          this.requireMcpl('state/checkpoint');
          conn.sendResponse(req.id, await this.checkpoint(params.featureSet));
          break;
        }

        case method.STATE_ROLLBACK: {
          this.requireMcpl('state/rollback');
          // No capability of its own in §6.2: rollback belongs to the feature
          // set being rolled back, and `rollbackComments` refuses any other.
          const p = params as unknown as StateRollbackParams;
          if (!this.grant.isFeatureSetActive(p.featureSet)) {
            throw new McplRpcError(ERR_METHOD_NOT_FOUND, `Feature set '${p.featureSet}' is not active`, {
              featureSet: p.featureSet,
              missingCapabilities: this.grant.missingFor(p.featureSet),
            });
          }
          // The third argument is what keeps the thread knowledge true across
          // a rollback: see `afterRollback` (review round 3, finding 1).
          conn.sendResponse(
            req.id,
            await rollbackComments(p, this.toolContext(), (effect) => this.afterRollback(effect)),
          );
          break;
        }

        default:
          conn.sendError(req.id, ERR_METHOD_NOT_FOUND, `Method not found: ${req.method}`);
      }
    } catch (err) {
      // An McplRpcError is already the answer, code and data included — which
      // is how a rollback of an unknown checkpoint becomes -32005 (§8.7).
      if (err instanceof McplRpcError) {
        conn.sendError(req.id, err.code, err.message, err.data);
        return;
      }
      const e = err as Error;
      this.logger.error('request failed', {
        method: req.method,
        ...(req.method === 'tools/call' ? { tool: String(params.name) } : {}),
        error: e.message,
      });
      conn.sendError(req.id, ERR_INTERNAL, e.message);
    }
  }

  private async handleNotification(notif: JsonRpcNotification): Promise<void> {
    try {
      switch (notif.method) {
        case method.CHANNELS_PUBLISH: {
          // §14.3: a publish may arrive as a Notification. It takes exactly
          // the same path as the Request form — the same grant, the same
          // repository boundary, the same routing and the same checkpoint
          // bookkeeping — and only the answer differs: there is no id to
          // answer, so a refusal, a skip or a failure is logged (WP9 review,
          // finding 5). Silently dropping it would lose the host's reply.
          if (!this.mcplEnabled) break;
          const params = (notif.params ?? {}) as GitHubPublishParams;
          const outcome = await this.publish(params);
          if (!outcome.delivered) {
            this.logger.info('publish notification delivered nothing', {
              channel: params.channelId,
              reason: outcome.reason ?? 'unknown',
            });
          }
          break;
        }

        case method.FEATURE_SETS_UPDATE:
          // §6.7 Notification form: descriptive only. `grant.apply` applies
          // the `disabled` reductions and discards anything grant-bearing.
          if (this.mcplEnabled) {
            this.grant.apply(notif.params as unknown as FeatureSetsUpdateParams, 'notification');
          }
          break;

        case method.CHANNELS_TYPING:
          if (this.mcplEnabled && this.grant.has('channels.typing')) {
            this.registry().handleTyping((notif.params ?? {}) as ChannelsTypingParams);
          }
          break;

        default:
          // Unknown notifications are ignored; one can never be answered.
          break;
      }
    } catch (err) {
      // Including a capability denial and a repository refusal: a
      // Notification has no id, so the only honest place for either is the
      // log (§6.6 fixes the shape of an *answer*, and there is none here).
      this.logger.warn('notification failed', { method: notif.method, error: (err as Error).message });
    }
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  /**
   * One `tools/call`.
   *
   * The order is deliberate. An unknown *name* is answered first, by name: a
   * host asking for a tool this server does not have has made a mistake no
   * policy can fix, and reporting it as a capability denial would send the
   * operator looking at the grant. Only a tool that exists is then a policy
   * question, and `grant.toolAllowed` is the whole of it — `tools` granted and
   * the owning feature set active. Absence is denial (§5.4), so a thrown
   * protocol error rather than an error result.
   *
   * A plain-MCP host is subject to no grant: there is none to consult.
   */
  private async handleToolCall(name: unknown, args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof name !== 'string' || name === '') {
      throw new McplRpcError(-32602, 'tools/call requires a tool "name"');
    }
    const module = this.owners.get(name);
    if (!module) {
      throw new McplRpcError(ERR_METHOD_NOT_FOUND, `Unknown tool: ${name}`, { tool: name });
    }
    if (this.mcplEnabled && !this.grant.toolAllowed(name)) {
      throw capabilityDenied(this.grant.has('tools') ? module.featureSet : 'tools');
    }

    // What the call touched, read off the API seam rather than the result
    // text; see {@link watchThreads}.
    const touches: ToolTouch[] = [];
    const changes: CommentChange[] = [];
    const ctx: ToolContext = {
      ...this.toolContext(),
      api: watchThreads(
        this.api,
        (touch) => touches.push(touch),
        (change) => changes.push(change),
      ),
    };
    const result = await module.call(name, args, ctx);

    // An error result claims nothing: the call may have read a thread on the
    // way to refusing, or written where GitHub's answer was lost, and neither
    // is a reason to announce a channel or to claim the bot has written
    // anywhere.
    if (result.isError === true) return result;

    await this.afterToolCall(name, touches, changes);

    // §8.2: a rollback-capable feature set checkpoints after the write, and
    // the result names the checkpoint and its parent. A failed call is not
    // checkpointed: nothing it may have done is booked to undo.
    if (module.featureSet !== COMMENTS_FEATURE_SET) return result;
    try {
      return { ...result, state: await this.checkpoint(COMMENTS_FEATURE_SET) };
    } catch (err) {
      // The write happened and the checkpoint naming it did not reach the
      // disk. The result still reports the write — the model has to know it
      // landed — but carries no `state`, because a checkpoint id a restart
      // would not recognise is a rollback handle that does not exist (WP9
      // review, finding 3).
      const detail = err instanceof McplRpcError ? err.message : (err as Error).message;
      this.logger.error('checkpoint not persisted after a write', { tool: name, error: detail });
      return {
        content: [
          ...result.content,
          {
            type: 'text',
            text:
              `WARNING: the write above succeeded, but the checkpoint naming it could not be ` +
              `persisted (${detail}), so this call cannot be rolled back.`,
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * What a successful tool call leaves behind, from the threads it actually
   * touched: the thread knowledge, and the channel .5 registers lazily.
   *
   * For the channel, only the last touch counts, and the one with a title
   * wins: a call reads before it writes, and the thread it finally acted on is
   * the one it named last. A created *review comment*, by contrast, is booked
   * from the touch that created it, against that touch's own thread. Nothing
   * is registered on a plain-MCP connection — it has no channel surface and no
   * event pipeline to feed — but the knowledge is still kept, because it is
   * the pipeline's and not the host's.
   *
   * **Nothing is registered or remembered before the thread's kind is
   * resolved** (rule 2 of {@link ThreadKnowledge}). A `comment({ thread:
   * '#58' })` on pull request 58 names an `issue`, because that is what the
   * shorthand defaults to; registering that guess as the channel's kind made
   * every later review reply on it a `-32602` for the rest of the connection
   * (WP9 review round 3, finding 1).
   */
  private async afterToolCall(
    name: string,
    touches: readonly ToolTouch[],
    changes: readonly CommentChange[],
  ): Promise<void> {
    if (touches.length === 0) return;
    const last = [...touches].reverse().find((t) => t.title !== undefined) ?? touches[touches.length - 1];

    // Every thread this call named, with what the call proved about it. The
    // id is the channel id, which is the knowledge record's key.
    const proven = new Set<string>();
    for (const t of touches) if (t.provenPull) proven.add(channelId(t.thread));
    const resolve = (thread: ThreadRef): Promise<ThreadRef> =>
      this.resolveKind(thread, proven.has(channelId(thread)));

    const thread = await resolve(last.thread);

    // An authoring tool means the bot now has content of its own here.
    if (AUTHORING_TOOLS.has(name)) this.learn(thread, { own: true });

    for (const touch of touches) {
      // A review comment the call created is booked by id, exactly as the
      // channel publish path books its own (WP9 review round 2, finding 2).
      // Without this the id exists only in GitHub's copy of the thread, and a
      // human reply to it reads as `chat:ambient` until the thread is looked
      // up again — which a loaded record means never.
      if (touch.reviewCommentId !== undefined) {
        // `replyToReviewComment` answered, so this thread is a pull request.
        this.learn({ ...touch.thread, kind: 'pull' }, { kind: 'pull', own: true, reviewIds: [touch.reviewCommentId] });
      }
      // Amendment 2b: a top-level comment the call wrote is the bot's new last
      // word on the thread, and the next human comment has to read as a reply
      // to it. A comment write does not invalidate the history (rule 3 keeps
      // that for the review path), so nothing else would record it.
      if (touch.commentId !== undefined) {
        this.learn(touch.thread, { own: true, comments: [{ id: touch.commentId, mine: true }] });
      }
      // And inline review comments the call created, whose ids GitHub did not
      // answer with, make the record's review history stale (rule 3).
      if (touch.createdInlineComments) {
        this.learn({ ...touch.thread, kind: 'pull' }, { kind: 'pull', own: true, loaded: false });
      }
    }

    // A comment the call rewrote or removed, on the thread the call resolved.
    //
    // A **removal** (round-3 finding 1) has to leave the turn order, or the
    // next human comment reads as a reply to something GitHub no longer has.
    //
    // An **edit** (round-8 finding) puts the comment *into* it. The call
    // proves the id is a comment of the bot's on this thread — its own read
    // found it there and refused to touch anything the bot did not write —
    // and on a loaded record nothing else will ever say so, because a loaded
    // record is not read again. Identity alone: `mine` is what turn order
    // asks, and the merge is idempotent when the history already had it.
    for (const change of changes) {
      // A review comment's identity is `botReviewIds`, under GitHub's exact
      // `inReplyTo` rule. Putting one into the top-level turn order would
      // claim a reply that never happened, and neither editing nor deleting
      // one tells that path anything it does not already have.
      if (change.review) continue;
      if (change.action === 'delete') {
        this.forgetComment(thread, change.id);
        continue;
      }
      this.learn(thread, { comments: [{ id: change.id, mine: true }] });
    }

    if (!this.mcplEnabled) return;
    try {
      // `ensureChannel` is the "first tool touch" entry point of .5, and it
      // asks `canRegister` before announcing anything, so an ungranted host
      // gets no outbound registration.
      await this.registry().ensureChannel(thread, last.title);
    } catch (err) {
      this.logger.warn('tool touch did not register its channel', {
        tool: name,
        channel: channelId(thread),
        error: (err as Error).message,
      });
    }
  }

  /**
   * A fresh checkpoint and its parent, the §8.2 `state` object — **persisted
   * before it is reported**.
   *
   * A checkpoint the host holds and a restart does not know is worse than no
   * checkpoint: the host believes it can roll back to a point the state file
   * never heard of. The comment tools flush their own records, so the window
   * was exactly the checkpoint itself (WP9 review, finding 3). A flush failure
   * is therefore an error and not a durable success.
   */
  private async checkpoint(featureSet?: unknown): Promise<{ checkpoint: string; parent: string | null }> {
    if (typeof featureSet === 'string' && featureSet !== COMMENTS_FEATURE_SET) {
      throw new McplRpcError(ERR_INVALID_PARAMS, `Feature set '${featureSet}' is not rollback-capable`, { featureSet });
    }
    const record = this.state.createCheckpoint();
    try {
      await this.state.flush();
    } catch (err) {
      throw new McplRpcError(
        ERR_INTERNAL,
        `checkpoint ${record.id} could not be persisted: ${(err as Error).message}`,
        { checkpoint: record.id },
      );
    }
    return { checkpoint: record.id, parent: record.parent };
  }

  // ── Channels ──────────────────────────────────────────────────────────────

  private registry(): ChannelRegistry {
    const registry = this.channels;
    if (!registry) throw new McplRpcError(ERR_INTERNAL, 'no connection');
    return registry;
  }

  /**
   * The repository boundary on the channel path.
   *
   * GITHUB_REPOS is the write allow-list, and every tool checks it by name
   * (`requireAllowedRepo`, tool-support.ts). A channel is a write surface too
   * — `channels/publish` creates a comment — and the channel path used to
   * check nothing at all, so a host could open `outside/not-allowed#77` and
   * write to it (WP9 review, finding 1). The same list binds it: refused at
   * `channels/open` before any registration, and refused **again** before
   * every channel write, so a descriptor registered under one configuration
   * cannot be written through after the configuration narrowed. The refusal
   * names the repository and the allow-list, and comes before any GitHub call.
   */
  private requireAllowedRepo(repo: RepoRef, what: string): void {
    const allowed = this.options.repos ?? [];
    if (repoAllowed(repo, allowed)) return;
    throw new McplRpcError(
      ERR_INVALID_PARAMS,
      `${what}: repository ${repoSlug(repo)} is not in GITHUB_REPOS (allowed: ${
        allowed.map(repoSlug).join(', ') || 'nothing'
      })`,
      { repo: repoSlug(repo), allowed: allowed.map(repoSlug) },
    );
  }

  /**
   * `channels/open`. The exact `channelId` wins; otherwise the descriptor
   * address (`{ owner, name, number, kind }`) names the thread, and a thread
   * this server has not announced yet is registered now so the host gets a
   * descriptor rather than a refusal.
   *
   * Nothing is "opened": `deliver` sends `channels/incoming` for every event
   * with a thread whatever the host has opened, so open is a lookup. .5's
   * header says the registry does not implement these two; the manifest
   * advertises `channels.lifecycle` all the same, so they are answered here,
   * over the registry's own lookups, and the advertisement stays true.
   *
   * Reading an existing descriptor back announces nothing and so needs nothing
   * but `channels.lifecycle`. Opening one this server has not announced *does*
   * announce it, which is `channels.register` — a capability `channels.lifecycle`
   * does not imply and the open path used to exercise regardless (WP9 review,
   * finding 2).
   */
  private async handleOpen(params: ChannelsOpenParams): Promise<ChannelsOpenResult> {
    const registry = this.registry();
    if (params.channelId) {
      const known = registry.get(params.channelId);
      if (known) return { channel: known };
    }
    const thread = threadFromAddress(params.address);
    if (thread) {
      const known = registry.get(channelId(thread));
      if (known) return { channel: known };
      this.require('channels.register');
      this.requireAllowedRepo(thread.repo, 'channels/open');
      // The address's `kind` is the host's claim, and the host is guessing as
      // often as a tool argument is: resolved against the API before the
      // channel is announced under it (rule 2 of {@link ThreadKnowledge}).
      const descriptor = await registry.ensureChannel(await this.resolveKind(thread, false));
      if (descriptor) return { channel: descriptor };
    }
    throw new McplRpcError(ERR_INVALID_PARAMS, 'channels/open needs a registered channelId or an { owner, name, number, kind } address', {
      channelId: params.channelId,
    });
  }

  /**
   * `channels/publish`. The route is `threadId`'s, exactly as the contract
   * says and .5 implements it: `rt:<id>` replies inside that review
   * conversation, and **absent means a top-level comment** — never the latest
   * thread on the channel, which is the one guess that would put an answer
   * somewhere nobody asked for. mcpl-core 0.3's `ChannelsPublishParams` has no
   * `threadId`; .5's `GitHubPublishParams` adds it, and a host that sends it
   * (§14.4 already hands one out on `context/beforeInference`) is routed by
   * it.
   *
   * A delivered comment is booked under the current checkpoint, so a rollback
   * undoes a publish exactly as it undoes a `comment` tool call.
   *
   * One body for both carriers §14.3 allows: the Request case answers it, the
   * Notification case logs what it would have answered, and neither gets a
   * different grant, a different boundary or different bookkeeping.
   */
  private async publish(params: GitHubPublishParams): Promise<PublishOutcome> {
    this.require('channels.publish');
    // The declaration puts `channels.publish` on github.comments: a publish is
    // a comment, so a host that disabled the comment tools must not get a
    // write through the channel either.
    if (!this.grant.isFeatureSetActive(COMMENTS_FEATURE_SET)) {
      throw new McplRpcError(
        ERR_METHOD_NOT_FOUND,
        `channels/publish writes a comment, and ${COMMENTS_FEATURE_SET} is not active`,
        { featureSet: COMMENTS_FEATURE_SET, missingCapabilities: this.grant.missingFor(COMMENTS_FEATURE_SET) },
      );
    }
    // Before any GitHub call. An unknown channel has no thread to check and
    // the registry refuses it by id a line later (-32023).
    const registered = this.registry().threadFor(params.channelId);
    if (registered) this.requireAllowedRepo(registered.repo, 'channels/publish');

    const outcome = await this.registry().handlePublish(params, this.api);
    if (outcome.delivered && outcome.commentId !== undefined && outcome.thread) {
      const isReviewComment = outcome.isReviewComment === true;
      await recordCreated({ id: outcome.commentId }, outcome.thread, isReviewComment, this.toolContext());
      // Only a review comment id is remembered: `inReplyTo` only ever names
      // one, and the two endpoints number their comments separately.
      this.learn(outcome.thread, {
        own: true,
        ...(isReviewComment ? { reviewIds: [outcome.commentId] } : {}),
        // Amendment 2b: a top-level publish takes its place in the thread's
        // turn order, so the next human comment reads as a reply to it. A
        // publish does not invalidate the history, so without this the
        // comment would be missing from the order until something else read
        // the thread.
        ...(isReviewComment ? {} : { comments: [{ id: outcome.commentId, mine: true }] }),
      });
    }
    return outcome;
  }

  // ── The event pipeline ────────────────────────────────────────────────────

  /**
   * Every ingress path hands its events here: App mode's webhook listener and
   * repository poller, and contributor mode's notifications poller, take this
   * as their `onEvent`, so one pipeline tags, renders and forwards whatever
   * arrived, however it arrived.
   */
  readonly onEvent = (event: NormalizedEvent): Promise<void> => this.handleEvent(event);

  private async handleEvent(event: NormalizedEvent): Promise<void> {
    const conn = this.conn;
    // Plain MCP has no push and no channels: an event has nowhere to go.
    if (!conn || !this.mcplEnabled) return;
    // Nothing to do at all. Each egress is asked again at its own send, so
    // this is only the cheap way out of an event no path wants: see
    // {@link GitHubMcplServer.eventEgressAllowed} for why the answer here is
    // never the one the sends rely on.
    if (!this.eventEgressAllowed(conn, 'push') && !this.eventEgressAllowed(conn, 'incoming')) return;

    let tags: string[];
    let metadata: EventMetadata;
    let content: ContentBlock[];
    try {
      const ctx = await this.tagContext(event);
      const result = tagsFor(event, ctx);
      tags = result.tags;
      metadata = result.metadata;
      content = renderEvent(event);
    } catch (err) {
      this.logger.error('event pipeline failed', { event: event.id, error: (err as Error).message });
      return;
    }

    // A top-level comment that is *gone* is a removal, whoever removed it and
    // whichever ingress said so (review round 4, finding 1).
    //
    // `comment.deleted` used to fall through the two branches below, which
    // only ever insert, so an `issue_comment.deleted` delivery re-seated the
    // id in the turn order. The event that should have confirmed a removal
    // undid it instead — a rollback-delete followed by its own deletion
    // webhook left the next unrelated human comment reading as a reply to a
    // comment GitHub no longer had. It is the same for a direct
    // `delete_own_comment` and for a human deleting their own comment.
    //
    // `own` is still learned for the bot's own deletion: the bot wrote there
    // and then unwrote it, and `isOwnThread` is history. `botReviewIds` is
    // untouched here, as everywhere in this path.
    const deletedTopLevel = event.kind === 'comment.deleted' && event.comment !== undefined;
    if (event.thread && deletedTopLevel) {
      if (event.actor.login === this.options.botLogin) this.learn(event.thread, { own: true });
      this.forgetComment(event.thread, (event.comment as { id: number }).id);
    } else {
      // The bot's own write becomes its own thread: no second lookup needed.
      if (event.thread && event.actor.login === this.options.botLogin) {
        this.learn(event.thread, {
          own: true,
          ...(event.reviewComment ? { reviewIds: [event.reviewComment.id] } : {}),
          // Amendment 2b: the bot's own top-level comment, whichever ingress
          // brought it back — the webhook route never saw the write itself.
          // Amendment 2b: the bot's own top-level comment takes its place in
          // the turn order, whichever ingress brought it back — the webhook
          // route never saw the write itself.
          ...(event.comment ? { comments: [{ id: event.comment.id, mine: true }] } : {}),
        });
      }
      // Amendment 2b: and a *human's* comment takes its place in the turn order
      // too, so the comment after it is not read as following the bot.
      if (event.thread && event.comment && event.actor.login !== this.options.botLogin) {
        this.learn(event.thread, { comments: [{ id: event.comment.id, mine: false }] });
      }
    }

    // A thread's channel first, so a host that has the channel sees the
    // message there before the push that also describes it. Asked here *and*
    // inside the registry, which is where the send finally happens.
    if (event.thread && this.eventEgressAllowed(conn, 'incoming')) {
      try {
        await this.registry().deliver(event, tags, metadata, content);
      } catch (err) {
        this.logger.warn('channel delivery failed', { event: event.id, error: (err as Error).message });
      }
    }

    // push/event for *every* event — including the ones with no thread (a
    // push, a repository-level change), which belong to no channel at all.
    // Re-asked after the channel delivery, which awaited the host.
    if (!this.eventEgressAllowed(conn, 'push')) return;
    const params: PushEventParams = {
      featureSet: EVENTS_FEATURE_SET,
      eventId: event.id,
      timestamp: event.receivedAt,
      // `origin` is open (`unknown` in mcpl-core), and the wake metadata rides
      // there rather than in `payload`: PushEventPayload is exactly
      // `{ content }`, and a host's `metadataTrue` matchers read the origin.
      origin: {
        source: 'github',
        repo: metadata.repo,
        kind: event.kind,
        ...(event.thread
          ? { number: event.thread.number, threadKind: event.thread.kind, channelId: channelId(event.thread) }
          : {}),
        actor: metadata.actor,
        htmlUrl: metadata.htmlUrl,
        ...(event.sha ? { sha: event.sha } : {}),
        sender: { login: event.actor.login, isBot: event.actor.isBot },
        metadata,
      },
      tags,
      payload: { content },
    };
    try {
      await conn.sendRequest(method.PUSH_EVENT, params);
    } catch (err) {
      this.logger.warn('push/event failed', { event: event.id, error: (err as Error).message });
    }
  }

  /**
   * May one egress path of the event pipeline send, *right now*?
   *
   * Every step of the pipeline awaits something — the thread lookup, the
   * channel registration, the `channels/incoming` round trip — and a
   * `featureSets/update` answered inside any of those windows is a decision
   * the host has already been told was accepted. So the decision is never
   * captured: it is taken again immediately before each outbound send, and the
   * event in flight stops at the first one that says no (WP9 review round 2,
   * finding 1).
   *
   * Four questions, in the order they can go wrong:
   *
   *   - **the connection.** `this.conn` moving on means this event belongs to
   *     a peer that is gone; a new host gets a new grant, and sending it the
   *     previous one's traffic would be sending it on no grant at all.
   *   - **the mode.** Plain MCP has neither surface.
   *   - **the feature set.** §6.7: a host that disabled `github.events` stops
   *     its traffic at once, incoming and push alike. False before the initial
   *     policy exchange too (§5.3), so absence is denial here as everywhere.
   *   - **the capability.** The two egress paths are granted separately, which
   *     is what makes a host with no channels still wake and a host with no
   *     push still read its channels (WP9 review, finding 4). `github.events`
   *     declares `uses: ['pushEvents']`, so §6.4's fail-closed derivation is
   *     what gates the push; the delivery takes `channels.incoming`, and the
   *     registration behind it is the registry's own `canRegister`.
   */
  private eventEgressAllowed(conn: McplConnection, path: 'push' | 'incoming'): boolean {
    if (this.conn !== conn || !this.mcplEnabled) return false;
    if (!this.grant.isFeatureSetSelected(EVENTS_FEATURE_SET)) return false;
    return path === 'push'
      ? this.grant.isFeatureSetActive(EVENTS_FEATURE_SET)
      : this.grant.has('channels.incoming');
  }

  /**
   * What `tagsFor` cannot derive from the event alone.
   *
   * `merged` and `reviewRequestedForSelf` come out of the raw payload the
   * ingress kept: a webhook's `pull_request.merged`, or a polled row's
   * `merged`, is the only thing that tells a close from a merge, and
   * `requested_reviewer.login` the only thing that says
   * whether *this* bot was the one asked. `isOwnThread` and `isReplyToSelf`
   * come from the thread's comment history.
   */
  private async tagContext(event: NormalizedEvent): Promise<GitHubTagContext> {
    const botLogin = this.options.botLogin ?? '';
    // An event says which GitHub API delivered it, so its thread's kind is
    // authoritative — this is where a channel a tool registered under the
    // wrong kind learns the right one (rule 2 of {@link ThreadKnowledge}).
    if (event.thread) this.learn(event.thread, { kind: event.thread.kind });
    const knowledge = event.thread ? await this.knowledgeFor(event.thread) : undefined;
    const replyTo = event.reviewComment?.inReplyTo;
    return {
      botLogin,
      maintainers: this.options.maintainers ?? [],
      isOwnThread: knowledge?.own === true,
      // A review comment names what it answers, so that one is exact. A
      // top-level comment names nothing, and amendment 2b derives it instead.
      isReplyToSelf:
        replyTo !== undefined
          ? knowledge?.botReviewIds.has(replyTo) === true
          : repliesToBotTopLevel(event, knowledge),
      ...(mergedFlag(event) !== undefined ? { merged: mergedFlag(event) } : {}),
      ...(event.kind === 'pull.review_requested'
        ? { reviewRequestedForSelf: requestedReviewerIsBot(event, botLogin) }
        : {}),
    };
  }

  /**
   * The thread's record, with its bounded history read if that has not
   * happened since the last invalidation.
   *
   * Three bounded reads, and only on a pull request the third one:
   *
   *   - **the thread itself**, for its author. A thread the bot *opened* is
   *     its own thread even with no comment on it at all, and reading only
   *     the comments called that one ambient (WP9 review, finding 7). One
   *     `getIssue` or `getPullRequest`, which is the cheapest statement of
   *     authorship GitHub has.
   *   - **the issue comments**, which say whether the bot has spoken on the
   *     thread.
   *   - **the review threads** of a pull request, which say which *review*
   *     comments are the bot's.
   *
   * Everything read is merged into the live record through {@link
   * GitHubMcplServer.learn} (rule 1): a `reply_in_thread` that succeeds while
   * this is awaiting `listReviewThreads` has already booked its `own` and its
   * new comment id, and installing a snapshot taken before it would erase
   * both — which is exactly what made a human answer to that reply read as
   * `chat:ambient` (WP9 review round 3, finding 2).
   *
   * `loaded` is what this method consults, not "is anything known": a record
   * a tool write created knows `own` and nothing about the history, and
   * treating it as loaded left the bot's existing review comments unknown for
   * the rest of the connection (finding 3).
   *
   * A failure is logged, and the record keeps what was gathered before it and
   * is marked loaded all the same: that under-claims (`chat:ambient` rather
   * than `chat:reply`) rather than asking GitHub again for every event on a
   * thread it cannot read.
   */
  private async knowledgeFor(thread: ThreadRef): Promise<ThreadKnowledge> {
    const id = channelId(thread);
    const known = this.threadMemory.get(id);
    if (known?.loaded) return known;
    const inFlight = this.threadLookups.get(id);
    if (inFlight) return inFlight;

    const lookup = (async (): Promise<ThreadKnowledge> => {
      const botLogin = this.options.botLogin ?? '';
      const mine = (login: string): boolean => !!botLogin && login === botLogin;
      // The record as it stands, which may already know the kind from a
      // webhook or a resolved tool touch. The argument's kind is the fallback
      // and is authoritative here anyway: every caller is an event.
      const record = this.learn(thread, { kind: thread.kind });
      // The invalidation generation this read answers for. If a write makes
      // the history stale while the read is in flight, the read's answer is
      // already out of date and must not be marked loaded.
      const generation = record.generation;
      // Free, and true across a restart: a comment this server recorded on
      // this thread is a comment the bot wrote on it.
      if (this.stateKnowsWrite(thread)) this.learn(thread, { own: true });
      const isPull = record.kind === 'pull';
      try {
        const opened = isPull ? await this.api.getPullRequest(thread) : await this.api.getIssue(thread);
        if (mine(opened.author.login)) this.learn(thread, { own: true });
      } catch (err) {
        // A thread this server cannot read is not a thread it can claim.
        this.logger.warn('thread author lookup failed', { channel: id, error: (err as Error).message });
      }
      try {
        const comments = await this.api.listComments(thread);
        const tail = comments.slice(-THREAD_MEMORY);
        if (tail.some((comment) => mine(comment.author.login))) {
          this.learn(thread, { own: true });
        }
        // Amendment 2b: the thread's turn order, and the bot's last word in
        // it. `listComments` is already oldest-first and already bounded, so
        // this costs the read nothing extra — it keeps what it had thrown away.
        //
        // The turn order, as GitHub answered it. Ids a later write removed
        // are refused by `removedComments`; the rest are other people's
        // turns, which nothing that happened since makes untrue.
        this.learn(thread, { comments: tail.map((c) => ({ id: c.id, mine: mine(c.author.login) })) });
        if (isPull) {
          const threads = await this.api.listReviewThreads(thread);
          for (const reviewThread of threads) {
            for (const comment of reviewThread.comments) {
              if (!mine(comment.author.login)) continue;
              this.learn(thread, { own: true, reviewIds: [comment.id] });
            }
          }
        }
      } catch (err) {
        this.logger.warn('thread history lookup failed', { channel: id, error: (err as Error).message });
      }
      this.threadLookups.delete(id);
      const live = this.threadMemory.get(id);
      if (live && live.generation !== generation) {
        // Invalidated while this read ran: what it learned is merged, but the
        // history is stale and the next event reads it again.
        return live;
      }
      return this.learn(thread, { loaded: true });
    })();
    this.threadLookups.set(id, lookup);
    return lookup;
  }

  /**
   * The thread, with its `issue | pull` kind resolved — the one thing a tool
   * argument cannot be trusted about (rule 2 of {@link ThreadKnowledge}).
   *
   * In order: what the call itself proved (a pull-request endpoint answered,
   * {@link PULL_ONLY}), then what the record already holds, then one bounded
   * `getPullRequest`. That last one is the whole cost of the rule — one call
   * per thread per connection, on the tool path only, and never on the event
   * path, where the delivery already says which API it came from.
   *
   * `getPullRequest` answering is a pull request; it refusing is an issue,
   * unless GitHub refused it with a status that says nothing about the thread
   * existing (a 403, a 500), in which case the kind stays unresolved and the
   * next touch asks again. A kind resolved wrongly is not permanent either:
   * the first event on the thread is authoritative and reconciles it.
   */
  private async resolveKind(thread: ThreadRef, provenPull: boolean): Promise<ThreadRef> {
    if (provenPull) {
      this.learn(thread, { kind: 'pull' });
      return { ...thread, kind: 'pull' };
    }
    const id = channelId(thread);
    const known = this.threadMemory.get(id)?.kind;
    if (known === 'issue' || known === 'pull') return { ...thread, kind: known };
    const resolved = await (this.kindProbes.get(id) ?? this.probeKind(thread));
    // The record may have learned the kind from an authoritative source (a
    // webhook) while the probe ran; that beats both the probe's answer and
    // the argument's guess (review round 4, finding 1).
    const live = this.threadMemory.get(id)?.kind;
    if (live === 'issue' || live === 'pull') return { ...thread, kind: live };
    return resolved ? { ...thread, kind: resolved } : thread;
  }

  /** The one `getPullRequest` of {@link GitHubMcplServer.resolveKind}. */
  private probeKind(thread: ThreadRef): Promise<ThreadKind | undefined> {
    const id = channelId(thread);
    const probe = (async (): Promise<ThreadKind | undefined> => {
      try {
        const pull = await this.api.getPullRequest(thread);
        const botLogin = this.options.botLogin ?? '';
        // The answer also says who opened it, which is free `own`.
        this.learn(thread, { kind: 'pull', own: !!botLogin && pull.author.login === botLogin });
        return 'pull';
      } catch (err) {
        const status = (err as { status?: unknown }).status;
        if (typeof status === 'number' && status !== 404 && status !== 410) {
          this.logger.warn('thread kind unresolved', { channel: id, status, error: (err as Error).message });
          return undefined;
        }
        this.learn(thread, { kind: 'issue' });
        return 'issue';
      } finally {
        this.kindProbes.delete(id);
      }
    })();
    this.kindProbes.set(id, probe);
    return probe;
  }

  /**
   * Has this server recorded a comment of its own on this thread?
   *
   * The checkpoint bookkeeping is a durable record of every comment the bot
   * created, with the thread it created it on, so it answers "own thread" for
   * free and across a restart — before the bot's own webhook comes back, and
   * on a connection whose ingress never saw it.
   */
  private stateKnowsWrite(thread: ThreadRef): boolean {
    const slug = repoSlug(thread.repo);
    let snapshot;
    try {
      snapshot = this.state.snapshot();
    } catch (err) {
      this.logger.warn('state snapshot failed', { error: (err as Error).message });
      return false;
    }
    for (const bucket of Object.values(snapshot.created)) {
      for (const record of bucket as RecordedComment[]) {
        if (record.repo === slug && record.thread?.number === thread.number) return true;
      }
    }
    return false;
  }

  /**
   * Merge what one writer learned into the thread's record — the only way
   * {@link GitHubMcplServer.threadMemory} is ever written.
   *
   * Synchronous, and on the live record, which is what rule 1 of {@link
   * ThreadKnowledge} amounts to in a single-threaded runtime: a writer cannot
   * be interleaved with another, and nobody holds a snapshot to install over
   * one. So the four writers can learn in any order and in any overlap, and
   * the record ends up holding the union of what they saw.
   *
   * What each field takes:
   *
   *   - `kind` — set only by a caller that *knows* (a webhook, a
   *     pull-request endpoint that answered, a resolved probe). Pass nothing
   *     and the record keeps what it had.
   *   - `own` — false → true only. A deleted comment is not evidence the bot
   *     was never there, and a lookup that found nothing is not evidence
   *     against a write that happened while it ran.
   *   - `reviewIds` — a bounded union; the oldest id is dropped at {@link
   *     THREAD_MEMORY}, so one thread costs a fixed amount of memory.
   *   - `loaded` — true from a completed history read, false from something
   *     that made the history stale (rule 3).
   */
  private learn(
    thread: ThreadRef,
    learned: {
      kind?: ThreadKind;
      own?: boolean;
      reviewIds?: Iterable<number>;
      /** Top-level comments this writer saw, in any order (amendment 2b). */
      comments?: Iterable<{ id: number; mine: boolean }>;
      loaded?: boolean;
    },
  ): ThreadKnowledge {
    const id = channelId(thread);
    let record = this.threadMemory.get(id);
    if (!record) {
      record = {
        kind: 'unknown',
        own: false,
        botReviewIds: new Set<number>(),
        recentComments: [],
        removedComments: new Set<number>(),
        loaded: false,
        generation: 0,
      };
      this.threadMemory.set(id, record);
    }
    if (learned.kind !== undefined) record.kind = learned.kind;
    if (learned.own === true) record.own = true;
    for (const commentId of learned.reviewIds ?? []) {
      if (record.botReviewIds.has(commentId)) continue;
      if (record.botReviewIds.size >= THREAD_MEMORY) {
        record.botReviewIds.delete(record.botReviewIds.values().next().value as number);
      }
      record.botReviewIds.add(commentId);
    }
    for (const seen of learned.comments ?? []) {
      // A comment known to be gone is never seated again, however late or
      // from whichever source its sighting arrives.
      if (record.removedComments.has(seen.id)) continue;
      const at = record.recentComments.findIndex((c) => c.id === seen.id);
      if (at >= 0) {
        // `mine` only ever goes false → true, for `own`'s reason: a reader
        // that could not tell is not evidence against a writer that could.
        if (seen.mine) record.recentComments[at].mine = true;
        continue;
      }
      // Insert by id, so the list is chronological however the writers
      // interleaved — a tool write lands after the history read's tail even
      // when it happened while that read was in flight.
      const before = record.recentComments.findIndex((c) => c.id > seen.id);
      if (before < 0) record.recentComments.push({ ...seen });
      else record.recentComments.splice(before, 0, { ...seen });
      if (record.recentComments.length > THREAD_MEMORY) {
        record.recentComments.splice(0, record.recentComments.length - THREAD_MEMORY);
      }
    }
    if (learned.loaded === false) record.generation += 1;
    if (learned.loaded !== undefined) record.loaded = learned.loaded;
    return record;
  }

  /**
   * Forget a top-level comment that is no longer on the thread — a rollback
   * deleted it, or `delete_own_comment` did.
   *
   * Separate from {@link GitHubMcplServer.learn} because `learn` is a merge
   * and a merge cannot express a removal: it only ever inserts into
   * `recentComments` and only ever accepts a latest id that did not go
   * backwards. Forcing a removal through it would have to weaken both of those
   * for every other writer. Nor is marking the history unloaded enough on its
   * own — the re-read that follows also only inserts, so a comment GitHub no
   * longer has would stay in the turn order for the life of the connection.
   * That is the shape of review round 3, finding 1: a rollback that deleted
   * the bot's comment left the next unrelated human comment reading as a reply
   * to it.
   *
   * `own` is deliberately untouched. The bot *did* write here, and a write it
   * has since undone is not evidence it never spoke: `isOwnThread` is history,
   * not a census of what is currently on the page.
   *
   * `botReviewIds` is untouched too. A review comment's identity answers
   * GitHub's own `inReplyTo`, lives under its own rule, and is numbered by a
   * different endpoint — a top-level removal has nothing to say about it.
   */
  private forgetComment(thread: ThreadRef, commentId: number): void {
    // `learn` with nothing to learn is the get-or-create for the record.
    const record = this.learn(thread, {});
    const at = record.recentComments.findIndex((c) => c.id === commentId);
    if (at >= 0) record.recentComments.splice(at, 1);

    // Remembered as gone, bounded like every other per-thread set. Removing
    // it from the list is not enough on its own: a history snapshot taken
    // before this and landing after it would seat the id again, and so would
    // every later read for as long as GitHub's own list lagged (round 4,
    // finding 2).
    if (!record.removedComments.has(commentId)) {
      if (record.removedComments.size >= THREAD_MEMORY) {
        record.removedComments.delete(record.removedComments.values().next().value as number);
      }
      record.removedComments.add(commentId);
    }
    // No invalidation: the splice and the tombstone are the whole of a
    // removal now that the turn order is all the rule asks about. A re-read
    // would learn nothing they have not already applied, and deletions
    // arrive as webhooks on threads nobody is waiting on — a history read
    // apiece would be a cost for nothing.
  }

  /**
   * Bring the thread's knowledge back in line with GitHub after a rollback
   * undid something (review round 3, finding 1).
   *
   * The rollback runs on the unobserved context — it is not a tool call, so
   * there is no proxy watching the seam and no `afterToolCall` to attach
   * anything to — but its own records carry the thread, which is what lets it
   * report each success here instead. Amendment 2b is about the thread as it
   * *is*, so an undone write has to be undone in the record too.
   */
  private afterRollback(effect: RollbackEffect): void {
    // A review comment answers the exact `inReplyTo` rule and is numbered by
    // another endpoint; neither of this method's two moves applies to it.
    if (effect.review) return;
    if (effect.action === 'delete') {
      this.forgetComment(effect.thread, effect.commentId);
      return;
    }
    // A restore puts a body back on a comment that never left the thread, so
    // the turn order is unchanged; what it still proves is that the comment
    // is the bot's and the thread is one the bot has written in.
    this.learn(effect.thread, { own: true, comments: [{ id: effect.commentId, mine: true }] });
  }
}

/**
 * Amendment 2b: is this top-level comment a reply to the bot?
 *
 * GitHub gives an issue comment no reply relation whatsoever — there is no
 * `in_reply_to_id` on the issues endpoint — so before this amendment every
 * answer to the bot on an issue read as plain `chat:ambient`, which the WP10
 * end-to-end run showed costs the bot every follow-up on its own comment.
 *
 * The rule that stands in for it is **turn order**: the last comment on the
 * thread older than this one is the bot's. That is a conversation turn — the
 * bot spoke and the next person answered.
 *
 * A second rule shipped alongside it for a while and was **withdrawn from v1**
 * (Amendment 2 revision, 2026-10-14): a body quoting a line of the bot's
 * latest comment with `> `. It needed the server to track which *version* of
 * a body was current, and five consecutive review rounds each found another
 * interleaving — a webhook echo, a lagging read, a rollback, an in-flight
 * snapshot, an edit — where it matched text GitHub no longer held and claimed
 * a reply that never happened. Each fix was right and each left another. Turn
 * order needs no body at all, so it has none of them. The quote rule returns
 * in a follow-up with provenance-aware body versioning.
 *
 * Only asked of comment events: an `issue.edited` or a `checks.completed` has
 * no comment to place in the thread. Returns false for an unloaded record,
 * which under-claims (`chat:ambient`) rather than guessing.
 */
function repliesToBotTopLevel(event: NormalizedEvent, knowledge: ThreadKnowledge | undefined): boolean {
  if (!knowledge) return false;
  if (event.kind !== 'comment.created' && event.kind !== 'comment.edited') return false;
  const id = event.comment?.id;
  if (id === undefined) return false;
  // The entries older than this comment, in order; the last of them is the one
  // it follows. An id of its own is required: without it there is no way to
  // say which comments came before, and the newest comment on the thread
  // would stand in for the predecessor of every comment on it.
  const older = knowledge.recentComments.filter((c) => c.id < id);
  return older.length > 0 && older[older.length - 1].mine;
}

/**
 * `state/checkpoint` — not an MCPL 0.5 method. The contract asks the server to
 * answer one, and a host that does not call it loses nothing: a checkpoint is
 * created after every `github.comments` write anyway and reported on the tool
 * result (§8.2). This is the way to take one *without* writing, so a recipe
 * can mark a point it may want to roll back to.
 */
const STATE_CHECKPOINT = 'state/checkpoint';

/** `{ owner, name, number, kind }`, the descriptor address of .5, as a ThreadRef. */
function threadFromAddress(address: unknown): ThreadRef | null {
  if (!address || typeof address !== 'object') return null;
  const a = address as Record<string, unknown>;
  const { owner, name, number, kind } = a;
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
  const threadKind: ThreadKind = kind === 'pull' ? 'pull' : 'issue';
  return { repo: { owner, name }, number, kind: threadKind };
}

/**
 * Whether a closed pull request was merged, out of the raw payload: a
 * webhook's `pull_request.merged`, or a polled row's `merged` (from its
 * `pull_request.merged_at`). It's the only field that tells a merge from a
 * close, and it never reaches `tagsFor` (`raw` stays in the pipeline).
 * Undefined means "not known to be merged".
 */
function mergedFlag(event: NormalizedEvent): boolean | undefined {
  if (event.kind !== 'pull.closed') return undefined;
  const raw = event.raw;
  if (!raw || typeof raw !== 'object') return undefined;
  // A polled row (PolledIssue) says it outright; a webhook payload nests it.
  const polled = (raw as Record<string, unknown>).merged;
  if (typeof polled === 'boolean') return polled;
  const pull = (raw as Record<string, unknown>).pull_request;
  if (!pull || typeof pull !== 'object') return undefined;
  const merged = (pull as Record<string, unknown>).merged;
  return typeof merged === 'boolean' ? merged : undefined;
}

/**
 * Was *this* bot the requested reviewer? `pull.review_requested` carries no
 * reviewer, so the raw payload's `requested_reviewer` (a user) or
 * `requested_team` (a team the bot cannot be) answers it. A payload that names
 * neither is treated as concerning the bot, which is `tagsFor`'s own
 * conservative default for a wake signal.
 */
function requestedReviewerIsBot(event: NormalizedEvent, botLogin: string): boolean {
  const raw = event.raw;
  if (!raw || typeof raw !== 'object') return true;
  const payload = raw as Record<string, unknown>;
  const reviewer = payload.requested_reviewer;
  if (reviewer && typeof reviewer === 'object') {
    const login = (reviewer as Record<string, unknown>).login;
    return typeof login === 'string' && !!botLogin && login === botLogin;
  }
  // A team request is never this bot's.
  if (payload.requested_team && typeof payload.requested_team === 'object') return false;
  return true;
}
