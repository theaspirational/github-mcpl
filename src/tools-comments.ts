import {
  ERR_CHECKPOINT_NOT_FOUND,
  textContent,
  type StateRollbackParams,
  type StateRollbackResult,
} from '@animalabs/mcpl-core';
import { McplRpcError } from './errors.js';
import { THREAD_PROPERTY, field, parseThread, uncertainWrite, type Parsed } from './tool-support.js';
import type { GithubStateStore, ThreadLocator } from './state.js';
import {
  COMMENTS_FEATURE_SET,
  LIMITS,
  TOOL_COMMENT,
  TOOL_DELETE_OWN_COMMENT,
  TOOL_EDIT_OWN_COMMENT,
  TOOL_REPLY_IN_THREAD,
  TOOL_UPSERT_STICKY_COMMENT,
  bounded,
  parseRepoSlug,
  parseThreadId,
  repoAllowed,
  repoSlug,
  type Comment,
  type RepoRef,
  type ThreadKind,
  type ThreadRef,
  type ToolContext,
  type ToolDefinition,
  type ToolModule,
  type ToolResult,
} from './types.js';

function refuse(message: string): ToolResult {
  return { content: [textContent(message)], isError: true };
}

function ok(message: string): ToolResult {
  return { content: [textContent(bounded(message, LIMITS.commentChars))] };
}

function parseThreadArg(raw: unknown, ctx: ToolContext, kindDefault: ThreadKind = 'issue'): Parsed<ThreadRef> {
  return parseThread(raw, ctx, kindDefault);
}

function parseBody(raw: unknown, field = 'body'): Parsed<string> {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: `${field}: required, a non-empty string` };
  return { ok: true, value: raw };
}

function parseCommentId(raw: unknown): Parsed<number> {
  const value = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { ok: false, error: 'commentId: required, a positive integer' };
  }
  return { ok: true, value };
}

function parseEndpoint(raw: unknown): Parsed<boolean | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'boolean') {
    return { ok: false, error: 'review: true for a review comment, false for an issue comment, or omit it' };
  }
  return { ok: true, value: raw };
}

function repoRefused(repo: RepoRef, ctx: ToolContext): string | null {
  if (repoAllowed(repo, ctx.repos)) return null;
  return `refused: ${repoSlug(repo)} is not in GITHUB_REPOS (${ctx.repos.map(repoSlug).join(', ') || 'empty'})`;
}

function recordRepo(slug: string, ctx: ToolContext): Parsed<RepoRef> {
  const repo = parseRepoSlug(slug);
  if (!repo) return { ok: false, error: `unparsable repository "${slug}" in the checkpoint record` };
  const denied = repoRefused(repo, ctx);
  return denied ? { ok: false, error: denied } : { ok: true, value: repo };
}

function store(ctx: Pick<ToolContext, 'state'>): GithubStateStore {
  return ctx.state as GithubStateStore;
}

function locator(thread: ThreadRef): ThreadLocator {
  return { number: thread.number, kind: thread.kind };
}

export function stickyMarker(marker: string): string {
  const trimmed = marker.trim();
  return /^<!--[\s\S]*-->$/.test(trimmed) ? trimmed : `<!-- ${trimmed} -->`;
}

export function stickyBody(marker: string, body: string): string {
  const html = stickyMarker(marker);
  return body.includes(html) ? body : `${html}\n${body}`;
}

interface FoundComment {
  comment: Comment;
  review: boolean;
}

/**
 * GitHub numbers issue comments and review comments from separate sequences,
 * so one id can name one of each on the same pull request.
 */
async function findComment(
  thread: ThreadRef,
  commentId: number,
  ctx: ToolContext,
  review?: boolean,
): Promise<Parsed<FoundComment>> {
  const where = `${repoSlug(thread.repo)}#${thread.number}`;
  const asIssue = review === true ? null : await findIssueComment(thread, commentId, ctx);
  let asReview: FoundComment | null = null;
  if (review === true || (review === undefined && thread.kind === 'pull')) {
    const lookup = await findReviewComment(thread, commentId, ctx);
    if ('failed' in lookup) {
      return {
        ok: false,
        error:
          `refused: could not establish whether ${commentId} on ${where} is a review comment ` +
          `(${lookup.failed}); retry, or pass review: false for the issue comment`,
      };
    }
    asReview = lookup.found;
  }

  if (asIssue && asReview) {
    return {
      ok: false,
      error:
        `refused: ${commentId} on ${where} names both an issue comment and a review comment; ` +
        'pass review: true for the review comment or review: false for the issue comment',
    };
  }
  const found = asIssue ?? asReview;
  if (found) return { ok: true, value: found };
  const endpoint = review === true ? ' as a review comment' : review === false ? ' as an issue comment' : '';
  return { ok: false, error: `no comment ${commentId} on ${where}${endpoint}` };
}

async function findIssueComment(thread: ThreadRef, commentId: number, ctx: ToolContext): Promise<FoundComment | null> {
  const comment = (await ctx.api.listComments(thread)).find((c) => c.id === commentId);
  return comment ? { comment, review: false } : null;
}

async function findReviewComment(
  thread: ThreadRef,
  commentId: number,
  ctx: ToolContext,
): Promise<{ found: FoundComment | null } | { failed: string }> {
  let threads;
  try {
    threads = await ctx.api.listReviewThreads({ ...thread, kind: 'pull' });
  } catch (err) {
    return { failed: bounded(err instanceof Error ? err.message : String(err), 200) };
  }
  for (const rt of threads) {
    const found = rt.comments.find((c) => c.id === commentId);
    if (!found) continue;
    return {
      found: {
      review: true,
      comment: {
        id: found.id,
        author: found.author,
        body: found.body,
        createdAt: found.createdAt,
        updatedAt: found.updatedAt ?? found.createdAt,
        html_url: `https://github.com/${repoSlug(thread.repo)}/pull/${thread.number}#discussion_r${found.id}`,
        path: rt.path,
        line: rt.line,
        side: rt.side,
        inReplyTo: found.inReplyTo,
      },
      },
    };
  }
  return { found: null };
}

const THREAD_SCHEMA = THREAD_PROPERTY;

export const COMMENT_TOOLS: ToolDefinition[] = [
  {
    name: TOOL_COMMENT,
    description: 'Post a comment on an issue or pull request.',
    inputSchema: {
      type: 'object',
      properties: { thread: THREAD_SCHEMA, body: { type: 'string', description: 'Markdown body.' } },
      required: ['thread', 'body'],
    },
  },
  {
    name: TOOL_REPLY_IN_THREAD,
    description: 'Reply inside a review conversation on a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: THREAD_SCHEMA,
        threadId: { type: 'string', description: 'The review conversation, "rt:<root review comment id>".' },
        body: { type: 'string', description: 'Markdown body.' },
      },
      required: ['thread', 'threadId', 'body'],
    },
  },
  {
    name: TOOL_EDIT_OWN_COMMENT,
    description: "Edit a comment this bot wrote. Refused for anyone else's comment.",
    inputSchema: {
      type: 'object',
      properties: {
        thread: THREAD_SCHEMA,
        commentId: { type: 'integer', description: 'The comment id.' },
        body: { type: 'string', description: 'The new Markdown body.' },
        review: {
          type: 'boolean',
          description:
            'Which endpoint owns the id: true a review-conversation comment, false a top-level comment. Omit it unless the id names one of each on this thread, which is refused until you say which.',
        },
      },
      required: ['thread', 'commentId', 'body'],
    },
  },
  {
    name: TOOL_DELETE_OWN_COMMENT,
    description: "Delete a comment this bot wrote. Refused for anyone else's comment, and not undoable by rollback.",
    inputSchema: {
      type: 'object',
      properties: {
        thread: THREAD_SCHEMA,
        commentId: { type: 'integer', description: 'The comment id.' },
        review: {
          type: 'boolean',
          description:
            'Which endpoint owns the id: true a review-conversation comment, false a top-level comment. Omit it unless the id names one of each on this thread, which is refused until you say which.',
        },
      },
      required: ['thread', 'commentId'],
    },
  },
  {
    name: TOOL_UPSERT_STICKY_COMMENT,
    description:
      'Create or update one durable comment per marker: edits the bot comment carrying the marker, else posts a new one. The marker stays in the body.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: THREAD_SCHEMA,
        marker: { type: 'string', description: 'A key ("ci-status") or an HTML comment ("<!-- ci-status -->").' },
        body: { type: 'string', description: 'Markdown body; the marker is kept at the top.' },
      },
      required: ['thread', 'marker', 'body'],
    },
  },
];

export const commentsToolModule: ToolModule = {
  featureSet: COMMENTS_FEATURE_SET,
  tools: COMMENT_TOOLS,
  async call(name, args, ctx) {
    try {
      return await callComment(name, args, ctx);
    } catch (err) {
      const uncertain = uncertainWrite(err);
      if (!uncertain) throw err;
      const text = `${field(name)}: ${uncertain} If it did, rollback has no record of it.`;
      ctx.logger.warn('tool call failed', { tool: field(name), detail: text });
      return refuse(text);
    }
  },
};

function callComment(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case TOOL_COMMENT:
      return comment(args, ctx);
    case TOOL_REPLY_IN_THREAD:
      return replyInThread(args, ctx);
    case TOOL_EDIT_OWN_COMMENT:
      return editOwnComment(args, ctx);
    case TOOL_DELETE_OWN_COMMENT:
      return deleteOwnComment(args, ctx);
    case TOOL_UPSERT_STICKY_COMMENT:
      return upsertStickyComment(args, ctx);
    default:
      return Promise.resolve(refuse(`unknown tool: ${name}`));
  }
}

async function comment(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const thread = parseThreadArg(args.thread, ctx);
  if (!thread.ok) return refuse(thread.error);
  const body = parseBody(args.body);
  if (!body.ok) return refuse(body.error);
  const denied = repoRefused(thread.value.repo, ctx);
  if (denied) return refuse(denied);

  const created = await ctx.api.createComment(thread.value, body.value);
  await recordCreated(created, thread.value, false, ctx);
  return ok(`commented on ${repoSlug(thread.value.repo)}#${thread.value.number} (comment ${created.id})\n${created.html_url}`);
}

async function replyInThread(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const thread = parseThreadArg(args.thread, ctx, 'pull');
  if (!thread.ok) return refuse(thread.error);
  const body = parseBody(args.body);
  if (!body.ok) return refuse(body.error);
  const threadId = typeof args.threadId === 'string' ? args.threadId : '';
  const parsed = parseThreadId(threadId);
  if (!parsed || parsed.kind !== 'review-thread') {
    return refuse(`threadId: expected a review conversation "rt:<id>", got ${JSON.stringify(args.threadId ?? null)}`);
  }
  const pull: ThreadRef = { ...thread.value, kind: 'pull' };
  const denied = repoRefused(pull.repo, ctx);
  if (denied) return refuse(denied);

  const created = await ctx.api.replyToReviewComment(pull, parsed.rootCommentId, body.value);
  await recordCreated(created, pull, true, ctx);
  return ok(`replied in ${threadId} on ${repoSlug(pull.repo)}#${pull.number} (comment ${created.id})\n${created.html_url}`);
}

async function editOwnComment(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const thread = parseThreadArg(args.thread, ctx);
  if (!thread.ok) return refuse(thread.error);
  const commentId = parseCommentId(args.commentId);
  if (!commentId.ok) return refuse(commentId.error);
  const body = parseBody(args.body);
  if (!body.ok) return refuse(body.error);
  const endpoint = parseEndpoint(args.review);
  if (!endpoint.ok) return refuse(endpoint.error);
  const denied = repoRefused(thread.value.repo, ctx);
  if (denied) return refuse(denied);

  const found = await findComment(thread.value, commentId.value, ctx, endpoint.value);
  if (!found.ok) return refuse(found.error);
  const target = found.value;
  if (target.comment.author.login !== ctx.botLogin) {
    return refuse(
      `refused: comment ${commentId.value} was written by ${target.comment.author.login}, not ${ctx.botLogin}; this tool only edits its own comments`,
    );
  }

  const previousBody = target.comment.body;
  const updated = await ctx.api.updateComment(thread.value.repo, commentId.value, body.value, target.review);
  await recordEdited(commentId.value, previousBody, thread.value, target.review, ctx);
  return ok(`edited comment ${updated.id} on ${repoSlug(thread.value.repo)}#${thread.value.number}\n${updated.html_url}`);
}

async function deleteOwnComment(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const thread = parseThreadArg(args.thread, ctx);
  if (!thread.ok) return refuse(thread.error);
  const commentId = parseCommentId(args.commentId);
  if (!commentId.ok) return refuse(commentId.error);
  const endpoint = parseEndpoint(args.review);
  if (!endpoint.ok) return refuse(endpoint.error);
  const denied = repoRefused(thread.value.repo, ctx);
  if (denied) return refuse(denied);

  const found = await findComment(thread.value, commentId.value, ctx, endpoint.value);
  if (!found.ok) return refuse(found.error);
  const target = found.value;
  if (target.comment.author.login !== ctx.botLogin) {
    return refuse(
      `refused: comment ${commentId.value} was written by ${target.comment.author.login}, not ${ctx.botLogin}; this tool only deletes its own comments`,
    );
  }

  await ctx.api.deleteComment(thread.value.repo, commentId.value, target.review);
  store(ctx).recordDeletedComment({
    repo: repoSlug(thread.value.repo),
    commentId: commentId.value,
    previousBody: target.comment.body,
    review: target.review,
    thread: locator(thread.value),
  });
  await ctx.state.flush();
  return ok(
    `deleted comment ${commentId.value} on ${repoSlug(thread.value.repo)}#${thread.value.number} (a delete cannot be rolled back)`,
  );
}

async function upsertStickyComment(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const thread = parseThreadArg(args.thread, ctx);
  if (!thread.ok) return refuse(thread.error);
  const marker = parseBody(args.marker, 'marker');
  if (!marker.ok) return refuse(marker.error);
  const body = parseBody(args.body);
  if (!body.ok) return refuse(body.error);
  const denied = repoRefused(thread.value.repo, ctx);
  if (denied) return refuse(denied);

  const html = stickyMarker(marker.value);
  const next = stickyBody(marker.value, body.value);
  const existing = (await ctx.api.listComments(thread.value)).find(
    (c) => c.author.login === ctx.botLogin && c.body.includes(html),
  );

  if (!existing) {
    const created = await ctx.api.createComment(thread.value, next);
    await recordCreated(created, thread.value, false, ctx);
    return ok(
      `created sticky ${html} on ${repoSlug(thread.value.repo)}#${thread.value.number} (comment ${created.id})\n${created.html_url}`,
    );
  }

  const previousBody = existing.body;
  const updated = await ctx.api.updateComment(thread.value.repo, existing.id, next, false);
  await recordEdited(existing.id, previousBody, thread.value, false, ctx);
  return ok(
    `updated sticky ${html} on ${repoSlug(thread.value.repo)}#${thread.value.number} (comment ${updated.id})\n${updated.html_url}`,
  );
}

export async function recordCreated(
  created: Pick<Comment, 'id'>,
  thread: ThreadRef,
  review: boolean,
  ctx: Pick<ToolContext, 'state'>,
): Promise<void> {
  store(ctx).recordCreatedComment({
    repo: repoSlug(thread.repo),
    commentId: created.id,
    review,
    thread: locator(thread),
  });
  await ctx.state.flush();
}

export async function recordEdited(
  commentId: number,
  previousBody: string,
  thread: ThreadRef,
  review: boolean,
  ctx: Pick<ToolContext, 'state'>,
): Promise<void> {
  store(ctx).recordEditedComment({
    repo: repoSlug(thread.repo),
    commentId,
    previousBody,
    review,
    thread: locator(thread),
  });
  await ctx.state.flush();
}

export interface RollbackItem {
  /** `delete` undoes a create, `restore` undoes an edit, `none` is unundoable. */
  action: 'delete' | 'restore' | 'none';
  repo: string;
  commentId: number;
  review: boolean;
  thread?: ThreadLocator;
  reason?: string;
}

export interface RollbackEffect {
  action: 'delete' | 'restore';
  thread: ThreadRef;
  commentId: number;
  review: boolean;
  body?: string;
}

/**
 * MCPL's rollback result, plus a receipt of what was undone and what wasn't.
 * MCPL tolerates extra result fields, so a host that knows only `checkpoint`,
 * `success` and `reason` still reads it.
 */
export interface CommentRollbackResult extends StateRollbackResult {
  undone: RollbackItem[];
  notUndone: RollbackItem[];
}

/**
 * Undo the comment writes made after `params.checkpoint`, best effort: delete
 * what was created, and give each edited comment back the body it had at the
 * checkpoint in one update. The receipt names every action that failed and
 * every delete, which GitHub can't undo. A record naming a repository outside
 * GITHUB_REPOS is reported as not undone and never executed. Whatever wasn't
 * undone, deletes included, stays booked under the checkpoint, so a retry
 * attempts it again and never reports a complete rollback over it.
 *
 * Throws -32005 for a checkpoint that is unknown or that an earlier rollback
 * abandoned, which MCPL's rollback result has no way to say.
 */
export async function rollbackComments(
  params: StateRollbackParams,
  ctx: ToolContext,
  onUndone?: (effect: RollbackEffect) => void,
): Promise<CommentRollbackResult> {
  if (params.featureSet !== COMMENTS_FEATURE_SET) {
    return {
      checkpoint: params.checkpoint,
      success: false,
      reason: `Feature set '${params.featureSet}' does not support rollback`,
      undone: [],
      notUndone: [],
    };
  }

  const state = store(ctx);
  const plan = state.rollback(params.checkpoint);
  if (!plan) {
    const status = state.checkpointStatus(params.checkpoint);
    throw new McplRpcError(ERR_CHECKPOINT_NOT_FOUND, 'Checkpoint not found', {
      checkpoint: params.checkpoint,
      reason:
        status === 'abandoned'
          ? 'an earlier rollback left this checkpoint behind; the state it named can no longer be restored'
          : 'no such checkpoint',
    });
  }

  const undone: RollbackItem[] = [];
  const notUndone: RollbackItem[] = [];
  const deletedKeys = new Set<string>();
  const handledKeys = new Set<string>();
  const keptCreated: typeof plan.created = [];
  const keptEdited: typeof plan.edited = [];

  for (const created of plan.created) {
    const key = idKey(created.repo, created.commentId, created.review);
    if (handledKeys.has(key)) continue;
    handledKeys.add(key);
    const item: RollbackItem = {
      action: 'delete',
      repo: created.repo,
      commentId: created.commentId,
      review: created.review,
      thread: created.thread,
    };
    const repo = recordRepo(created.repo, ctx);
    if (!repo.ok) {
      notUndone.push({ ...item, reason: repo.error });
      keptCreated.push(created);
      continue;
    }
    try {
      await ctx.api.deleteComment(repo.value, created.commentId, created.review);
      deletedKeys.add(key);
      undone.push(item);
      if (created.thread) {
        onUndone?.({
          action: 'delete',
          thread: { repo: repo.value, number: created.thread.number, kind: created.thread.kind },
          commentId: created.commentId,
          review: created.review,
        });
      }
    } catch (err) {
      notUndone.push({ ...item, reason: message(err) });
      keptCreated.push(created);
    }
  }

  // A `Map` keeps a key's first position and its last value, and the plan is
  // newest first, so each comment collapses to its oldest body in place.
  const targetEdit = new Map<string, (typeof plan.edited)[number]>();
  for (const edited of plan.edited) {
    targetEdit.set(idKey(edited.repo, edited.commentId, edited.review), edited);
  }

  for (const [key, edited] of targetEdit) {
    if (deletedKeys.has(key)) continue;
    const item: RollbackItem = {
      action: 'restore',
      repo: edited.repo,
      commentId: edited.commentId,
      review: edited.review,
      thread: edited.thread,
    };
    const repo = recordRepo(edited.repo, ctx);
    if (!repo.ok) {
      notUndone.push({ ...item, reason: repo.error });
      keptEdited.push(edited);
      continue;
    }
    try {
      await ctx.api.updateComment(repo.value, edited.commentId, edited.previousBody, edited.review);
      undone.push(item);
      if (edited.thread) {
        onUndone?.({
          action: 'restore',
          thread: { repo: repo.value, number: edited.thread.number, kind: edited.thread.kind },
          commentId: edited.commentId,
          review: edited.review,
          body: edited.previousBody,
        });
      }
    } catch (err) {
      notUndone.push({ ...item, reason: message(err) });
      keptEdited.push(edited);
    }
  }

  for (const deleted of plan.deleted ?? []) {
    notUndone.push({
      action: 'none',
      repo: deleted.repo,
      commentId: deleted.commentId,
      review: deleted.review,
      thread: deleted.thread,
      reason: 'the comment was deleted; GitHub cannot restore a deleted comment',
    });
  }

  for (const record of keptCreated.reverse()) state.recordCreatedComment(record);
  for (const record of keptEdited.reverse()) state.recordEditedComment(record);
  for (const record of [...(plan.deleted ?? [])].reverse()) state.recordDeletedComment(record);

  await ctx.state.flush();
  const result: CommentRollbackResult = {
    checkpoint: params.checkpoint,
    success: notUndone.length === 0,
    undone,
    notUndone,
  };
  if (notUndone.length > 0) {
    result.reason = bounded(
      `undid ${undone.length} of ${undone.length + notUndone.length} actions; could not undo ${notUndone
        .map((i) => `${i.repo} comment ${i.commentId} (${i.reason})`)
        .join('; ')}`,
      LIMITS.commentChars,
    );
    ctx.logger.warn(`rollback ${params.checkpoint}: ${result.reason}`);
  }
  return result;
}

function idKey(repo: string, commentId: number, review: boolean): string {
  return `${repo}#${review ? 'pulls' : 'issues'}/${commentId}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
