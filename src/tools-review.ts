/**
 * github.review — submitting a review and resolving review threads
 * (TASK-SRHKG.1.6).
 *
 *   create_review     — COMMENT | APPROVE | REQUEST_CHANGES, with inline
 *                       comments on diff lines.
 *   resolve_thread    — mark a review thread resolved.
 *   unresolve_thread  — reopen one.
 *
 * Not rollback-capable: GitHub has no API to withdraw a submitted review, so
 * nothing here can be undone and the declaration says so (ROLLBACK_CAPABLE).
 *
 * The refusal that matters: a clone must not approve or demand changes on its
 * own pull request. A verdict on one's own work is not review, and GitHub's own
 * 422 would arrive too late to be legible, so the author is checked against
 * GITHUB_BOT_LOGIN first and the refusal names the login. A plain COMMENT
 * review on its own pull request is allowed — that is just talking.
 */

import {
  REVIEW_FEATURE_SET,
  TOOL_CREATE_REVIEW,
  TOOL_RESOLVE_THREAD,
  TOOL_UNRESOLVE_THREAD,
  parseThreadId,
  repoSlug,
  type DiffSide,
  type ReviewCommentInput,
  type ReviewEvent,
  type SubmittedReview,
  type ThreadRef,
  type ToolContext,
  type ToolDefinition,
  type ToolModule,
  type ToolResult,
} from './types.js';
import {
  FIELD,
  REPO_PROPERTY,
  ToolArgumentError,
  echo,
  field,
  optionalString,
  oneOf,
  refuse,
  requireString,
  resolveThread,
  runTool,
  toolResult,
} from './tool-support.js';

const REVIEW_EVENTS: readonly ReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
const DIFF_SIDES: readonly DiffSide[] = ['LEFT', 'RIGHT'];

/** A verdict on code is only a verdict when someone else wrote it. */
const VERDICT_EVENTS: readonly ReviewEvent[] = ['APPROVE', 'REQUEST_CHANGES'];

/** GitHub logins are case-insensitive; `rayforce-clone[bot]` is one login. */
function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Validate the inline comments, position by position, and hand them on exactly
 * as given: `createReview` must receive the path, line and side the caller
 * named, because a review comment on the wrong line is worse than none.
 *
 * `side` defaults to RIGHT — the post-image, which is what a comment on a
 * proposed change almost always means; LEFT addresses a removed line.
 */
export function parseReviewComments(value: unknown): ReviewCommentInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolArgumentError('"comments" must be an array of inline comments');
  return value.map((entry, i) => {
    const at = `comments[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ToolArgumentError(`"${at}" must be an object { path, line, side?, body }`);
    }
    const row = entry as Record<string, unknown>;
    const path = row.path;
    if (typeof path !== 'string' || path.trim() === '') {
      throw new ToolArgumentError(`"${at}.path" must be a non-empty file path`);
    }
    const line = row.line;
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
      throw new ToolArgumentError(
        `"${at}.line" must be a positive integer line number in the diff, got ${echo(line)}`,
      );
    }
    const side = row.side ?? 'RIGHT';
    if (typeof side !== 'string' || !(DIFF_SIDES as readonly string[]).includes(side)) {
      throw new ToolArgumentError(
        `"${at}.side" must be one of ${DIFF_SIDES.join(' | ')}, got ${echo(row.side)}`,
      );
    }
    const body = row.body;
    if (typeof body !== 'string' || body.trim() === '') {
      throw new ToolArgumentError(`"${at}.body" must be a non-empty string`);
    }
    return { path, line, side: side as DiffSide, body };
  });
}

/**
 * The review thread id `resolve_thread` takes is the GraphQL node id that
 * `list_review_threads` prints, not the channel-level `rt:<comment id>`. The
 * two name different things (contract notes, "GitHubApi signatures"), so the
 * channel form is refused with the difference spelled out instead of being
 * silently sent to an API that would 404.
 */
export function requireReviewThreadId(args: Record<string, unknown>): string {
  const threadId = requireString(args, 'threadId');
  const channelForm = parseThreadId(threadId);
  if (channelForm) {
    throw new ToolArgumentError(
      `"threadId" is the review thread id from list_review_threads (a GraphQL node id), not the ` +
        `channel thread id ${echo(threadId, FIELD.nodeId)}`,
    );
  }
  return threadId;
}

/**
 * A review thread this server is allowed to touch, established rather than
 * assumed.
 *
 * A GraphQL node id names a thread without naming its repository, so checking
 * the `repo` argument proves nothing about the node the call then mutates: a
 * node id from any repository the token can reach would be resolved —
 * and the confirmation would name the allowed repository, which is worse than
 * failing. So the pull request is named too, and the thread has to be one of
 * *its* threads: the repository allow-list is checked on the pull request
 * (`resolveThread`), and membership on the list GitHub returns for it.
 *
 * The cost is one extra read per resolve, which is the price of the id being
 * unforgeable here.
 */
async function requireThreadOnPull(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ pull: ThreadRef; threadId: string }> {
  const pull = resolveThread(args, ctx, 'pull');
  const threadId = requireReviewThreadId(args);
  const threads = await ctx.api.listReviewThreads(pull);
  if (!threads.some((t) => t.id === threadId)) {
    refuse(
      `review thread ${echo(threadId, FIELD.nodeId)} is not one of the ${threads.length} review ` +
        `thread${threads.length === 1 ? '' : 's'} on ${repoSlug(pull.repo)}#${pull.number}; a thread is ` +
        `only acted on where list_review_threads found it`,
    );
  }
  return { pull, threadId };
}

/**
 * A tool result, not a channel delivery: it stays here rather than moving to
 * `content.ts`. WP9 kept the two renderer families apart on purpose —
 * `content.ts` bounds bodies, titles and list length for an event an agent
 * reads as a message, and these renderers bound each *field* (`field()` on the
 * url here) for a result an agent reads as the outcome of its own call. One
 * family cannot do both without dropping bounds.
 */
function renderSubmittedReview(pull: ThreadRef, review: SubmittedReview, inline: number): string {
  return (
    `submitted ${review.state} review ${review.id} on ${repoSlug(pull.repo)}#${pull.number} with ` +
    `${inline} inline comment${inline === 1 ? '' : 's'}\n${field(review.html_url, FIELD.url)}`
  );
}

export const reviewTools: ToolDefinition[] = [
  {
    name: TOOL_CREATE_REVIEW,
    description:
      'Submit a review on a pull request: COMMENT (remarks only), APPROVE or REQUEST_CHANGES. ' +
      'Inline comments attach to diff lines by path, line and side. APPROVE and REQUEST_CHANGES ' +
      'are refused on this bot’s own pull request. A submitted review cannot be withdrawn.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: { type: 'integer', minimum: 1, description: 'Pull-request number' },
        event: {
          type: 'string',
          enum: [...REVIEW_EVENTS],
          description: 'COMMENT, APPROVE or REQUEST_CHANGES',
        },
        body: {
          type: 'string',
          description: 'Review summary (required for COMMENT and REQUEST_CHANGES, optional for APPROVE)',
        },
        comments: {
          type: 'array',
          description: 'Inline comments on diff lines',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path as the diff names it' },
              line: {
                type: 'integer',
                minimum: 1,
                description: 'Line number in the diff (a positive integer; a string is refused)',
              },
              side: {
                type: 'string',
                enum: [...DIFF_SIDES],
                description: 'RIGHT for the new version (default), LEFT for a removed line',
              },
              body: { type: 'string', description: 'Comment text' },
            },
            required: ['path', 'line', 'body'],
          },
        },
      },
      required: ['number', 'event'],
    },
  },
  {
    name: TOOL_RESOLVE_THREAD,
    description:
      'Mark a review thread resolved. Takes the pull request it is on and the thread id ' +
      'list_review_threads prints for that pull request; a thread id from anywhere else is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: { type: 'integer', minimum: 1, description: 'Pull-request number the thread is on' },
        threadId: { type: 'string', description: 'Review thread id from list_review_threads' },
      },
      required: ['number', 'threadId'],
    },
  },
  {
    name: TOOL_UNRESOLVE_THREAD,
    description:
      'Reopen a resolved review thread. Takes the pull request it is on and the thread id ' +
      'list_review_threads prints for that pull request; a thread id from anywhere else is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: { type: 'integer', minimum: 1, description: 'Pull-request number the thread is on' },
        threadId: { type: 'string', description: 'Review thread id from list_review_threads' },
      },
      required: ['number', 'threadId'],
    },
  },
];

async function callReview(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case TOOL_CREATE_REVIEW: {
      const pull = resolveThread(args, ctx, 'pull');
      const event = oneOf<ReviewEvent>(args, 'event', REVIEW_EVENTS);
      const body = optionalString(args, 'body');
      const comments = parseReviewComments(args.comments);
      if (event !== 'APPROVE' && (body === undefined || body.trim() === '')) {
        throw new ToolArgumentError(`"body" is required for a ${event} review`);
      }
      if (VERDICT_EVENTS.includes(event)) {
        const pr = await ctx.api.getPullRequest(pull);
        if (sameLogin(pr.author.login, ctx.botLogin)) {
          refuse(
            `${event} on ${repoSlug(pull.repo)}#${pull.number} is this bot's own pull request ` +
              `(author ${field(pr.author.login)}); a verdict on one's own work is not a review. Use event ` +
              `COMMENT instead.`,
          );
        }
      }
      const review = await ctx.api.createReview(pull, {
        event,
        body,
        // Exactly the positions the caller gave, unreordered and unrounded.
        comments: comments.length > 0 ? comments : undefined,
      });
      return toolResult(renderSubmittedReview(pull, review, comments.length));
    }
    case TOOL_RESOLVE_THREAD: {
      const { pull, threadId } = await requireThreadOnPull(args, ctx);
      await ctx.api.resolveReviewThread(threadId);
      return toolResult(
        `resolved review thread ${field(threadId, FIELD.nodeId)} on ${repoSlug(pull.repo)}#${pull.number}`,
      );
    }
    case TOOL_UNRESOLVE_THREAD: {
      const { pull, threadId } = await requireThreadOnPull(args, ctx);
      await ctx.api.unresolveReviewThread(threadId);
      return toolResult(
        `unresolved review thread ${field(threadId, FIELD.nodeId)} on ${repoSlug(pull.repo)}#${pull.number}`,
      );
    }
    default:
      throw new ToolArgumentError(`unknown tool for ${REVIEW_FEATURE_SET}: ${field(name)}`);
  }
}

/** The github.review ToolModule the server (.9) registers. */
export const reviewToolModule: ToolModule = {
  featureSet: REVIEW_FEATURE_SET,
  tools: reviewTools,
  call: (name, args, ctx) => runTool(name, ctx, () => callReview(name, args, ctx)),
};
