/**
 * github.read — the read tools, plus the argument, refusal, failure and
 * rendering support the write modules share (TASK-SRHKG.1.6).
 *
 * Tools: get_issue, get_pull_request, list_comments, list_review_threads,
 * list_pull_request_files, get_check_runs, search_issues. None of them writes
 * anything, so github.read is not rollback-capable.
 *
 * The shared argument helpers, the allow-list check and the failure formatting
 * (`runTool`, `ToolRefusal`, `resolveRepo`, the one `parseThread`) moved to
 * `tool-support.ts` in WP9; every tool module imports them from there.
 *
 * The bounded renderer below stays. `content.ts` renders an *event* for a
 * channel delivery; these functions render a *result* for the model, and only
 * these bound the fields `LIMITS` does not name — a login, a branch, a sha, a
 * node id, a path, a URL, a query echoed back. Replacing them with
 * `content.ts`'s would drop those bounds, so the two families stay separate
 * and this is the only one a `tools/call` reaches.
 */

import {
  LIMITS,
  bounded,
  parseRepoSlug,
  repoAllowed,
  repoSlug,
  READ_FEATURE_SET,
  TOOL_GET_CHECK_RUNS,
  TOOL_GET_ISSUE,
  TOOL_GET_PULL_REQUEST,
  TOOL_LIST_COMMENTS,
  TOOL_LIST_PULL_REQUEST_FILES,
  TOOL_LIST_REVIEW_THREADS,
  TOOL_SEARCH_ISSUES,
  type ChecksSummary,
  type Comment,
  type Issue,
  type IssueSearch,
  type PullRequest,
  type PullRequestFile,
  type RepoRef,
  type ReviewThread,
  type ThreadKind,
  type ThreadRef,
  type ToolContext,
  type ToolDefinition,
  type ToolModule,
  type ToolResult,
} from './types.js';

import {
  FIELD,
  NUMBER_PROPERTY,
  REPO_PROPERTY,
  ToolArgumentError,
  ToolRefusal,
  boundedInline,
  echo,
  errorResult,
  field,
  oneOf,
  optionalBoolean,
  optionalNumber,
  optionalString,
  refuse,
  requireNumber,
  requireString,
  requireStringArray,
  resolveRepo,
  resolveThread,
  runTool,
  toolResult,
} from './tool-support.js';


// ─────────────────────────────────────────────────────────────────────────────
// The bounded renderer for tool results (see the file header on content.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** `owner/name#number`. */
function ref(repo: RepoRef, number: number): string {
  return `${field(repoSlug(repo), FIELD.slug)}#${number}`;
}

/** Join non-empty lines. */
function lines(...parts: (string | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join('\n');
}

/** A body, bounded to the contract's per-comment limit and never blank. */
function body(text: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? '(no body)' : bounded(trimmed, LIMITS.commentChars);
}

/**
 * The first {@link LIMITS.listEntries} entries, with a line naming what was
 * dropped. A list is never silently short.
 */
function boundedList<T>(items: readonly T[], render: (item: T) => string): string {
  const shown = items.slice(0, LIMITS.listEntries).map(render);
  if (items.length > shown.length) {
    shown.push(`… ${items.length - shown.length} more not shown (list bound ${LIMITS.listEntries})`);
  }
  return shown.join('\n');
}

export function renderIssue(issue: Issue): string {
  const state = issue.stateReason
    ? `${field(issue.state)} (${field(issue.stateReason)})`
    : field(issue.state);
  return lines(
    `issue ${ref(issue.repo, issue.number)} [${state}] ${bounded(issue.title, LIMITS.titleChars)}`,
    `by ${field(issue.author.login)}  updated ${field(issue.updatedAt)}  ${field(issue.html_url, FIELD.url)}`,
    issue.labels.length > 0 && `labels: ${boundedInline(issue.labels)}`,
    body(issue.body),
  );
}

export function renderChecksSummary(checks: ChecksSummary): string {
  return lines(
    `checks for ${field(checks.sha, FIELD.sha)}: ${
      checks.conclusion === null ? 'pending' : field(checks.conclusion)
    } (${checks.total} run${checks.total === 1 ? '' : 's'}, ${checks.failed.length} failed)`,
    checks.failed.length > 0 &&
      boundedList(checks.failed, (f) => `failed: ${field(f.name)} ${field(f.url, FIELD.url)}`),
  );
}

export function renderPullRequest(pull: PullRequest): string {
  const state = pull.merged ? 'merged' : pull.draft ? `${field(pull.state)}, draft` : field(pull.state);
  return lines(
    `pull ${ref(pull.repo, pull.number)} [${state}] ${bounded(pull.title, LIMITS.titleChars)}`,
    `${field(pull.head.ref)} (${field(pull.head.sha, FIELD.sha)}) → ${field(pull.base.ref)}  mergeable: ${
      pull.mergeable === null ? 'unknown' : pull.mergeable
    }`,
    `by ${field(pull.author.login)}  updated ${field(pull.updatedAt)}  ${field(pull.html_url, FIELD.url)}`,
    pull.requestedReviewers.length > 0 && `reviewers requested: ${boundedInline(pull.requestedReviewers)}`,
    pull.checksSummary ? renderChecksSummary(pull.checksSummary) : undefined,
    body(pull.body),
  );
}

export function renderComments(thread: ThreadRef, comments: readonly Comment[]): string {
  if (comments.length === 0) return `no comments on ${ref(thread.repo, thread.number)}`;
  return lines(
    `${comments.length} comment${comments.length === 1 ? '' : 's'} on ${ref(thread.repo, thread.number)}`,
    boundedList(comments, (c) =>
      lines(
        `— id ${c.id} by ${field(c.author.login)} at ${field(c.createdAt)}${
          c.path
            ? ` on ${field(c.path, FIELD.path)}${c.line === null || c.line === undefined ? '' : `:${c.line}`}`
            : ''
        }${c.inReplyTo ? ` (reply to ${c.inReplyTo})` : ''}`,
        body(c.body),
      ),
    ),
  );
}

export function renderReviewThreads(pull: ThreadRef, threads: readonly ReviewThread[]): string {
  if (threads.length === 0) return `no review threads on ${ref(pull.repo, pull.number)}`;
  return lines(
    `${threads.length} review thread${threads.length === 1 ? '' : 's'} on ${ref(pull.repo, pull.number)}`,
    boundedList(threads, (t) =>
      lines(
        `— ${field(t.id, FIELD.nodeId)} ${field(t.path, FIELD.path)}${
          t.line === null ? '' : `:${t.line}`
        } ${field(t.side)} ${t.isResolved ? 'resolved' : 'unresolved'}`,
        boundedList(t.comments, (c) => `  id ${c.id} by ${field(c.author.login)}: ${body(c.body)}`),
      ),
    ),
  );
}

export function renderFiles(pull: ThreadRef, files: readonly PullRequestFile[]): string {
  if (files.length === 0) return `no changed files on ${ref(pull.repo, pull.number)}`;
  return lines(
    `${files.length} changed file${files.length === 1 ? '' : 's'} on ${ref(pull.repo, pull.number)}`,
    boundedList(files, (f) => `${field(f.status)} ${field(f.filename, FIELD.path)} +${f.additions} -${f.deletions}`),
  );
}

export function renderSearchHits(repo: RepoRef, query: string, search: IssueSearch): string {
  const { hits, outside } = search;
  // The query is the caller's own string coming back out: echoed, so bounded.
  const asked = `${field(repoSlug(repo), FIELD.slug)} for ${echo(query, FIELD.query)}`;
  const leftOut =
    outside > 0 &&
    `${outside} result${outside === 1 ? '' : 's'} on this page from other repositories left out: a search stays inside ${field(repoSlug(repo), FIELD.slug)}`;
  if (hits.length === 0) return lines(`no matches in ${asked}`, leftOut);
  return lines(
    `${hits.length} match${hits.length === 1 ? '' : 'es'} in ${asked}`,
    boundedList(
      hits,
      (h) =>
        `${field(h.kind)} #${h.number} [${field(h.state)}] ${bounded(h.title, LIMITS.titleChars)}  ${field(
          h.html_url,
          FIELD.url,
        )}`,
    ),
    leftOut,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// github.read
// ─────────────────────────────────────────────────────────────────────────────

const THREAD_KINDS: readonly ThreadKind[] = ['issue', 'pull'];

export const readTools: ToolDefinition[] = [
  {
    name: TOOL_GET_ISSUE,
    description: 'Read one issue: state, author, labels, body and URL.',
    inputSchema: {
      type: 'object',
      properties: { repo: REPO_PROPERTY, number: { type: 'integer', minimum: 1, description: 'Issue number' } },
      required: ['number'],
    },
  },
  {
    name: TOOL_GET_PULL_REQUEST,
    description:
      'Read one pull request: state, draft and merge status, head and base refs with shas, ' +
      'requested reviewers, the check summary of its head, body and URL.',
    inputSchema: {
      type: 'object',
      properties: { repo: REPO_PROPERTY, number: { type: 'integer', minimum: 1, description: 'Pull-request number' } },
      required: ['number'],
    },
  },
  {
    name: TOOL_LIST_COMMENTS,
    description:
      'List the top-level comments on an issue or pull request, oldest first. Review comments ' +
      'on diff lines are not here — list_review_threads has those.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: NUMBER_PROPERTY,
        kind: {
          type: 'string',
          enum: [...THREAD_KINDS],
          description: 'Whether the number is an issue or a pull request (default issue; GitHub serves both from the same comment list)',
        },
        since: {
          type: 'string',
          description: 'Only comments updated after this ISO-8601 timestamp',
        },
      },
      required: ['number'],
    },
  },
  {
    name: TOOL_LIST_REVIEW_THREADS,
    description:
      'List the review threads on a pull request: path, line, side, whether the thread is ' +
      'resolved, and its comments. The thread id is what resolve_thread takes.',
    inputSchema: {
      type: 'object',
      properties: { repo: REPO_PROPERTY, number: { type: 'integer', minimum: 1, description: 'Pull-request number' } },
      required: ['number'],
    },
  },
  {
    name: TOOL_LIST_PULL_REQUEST_FILES,
    description: 'List the files a pull request changes, with their status and line counts. No patches.',
    inputSchema: {
      type: 'object',
      properties: { repo: REPO_PROPERTY, number: { type: 'integer', minimum: 1, description: 'Pull-request number' } },
      required: ['number'],
    },
  },
  {
    name: TOOL_GET_CHECK_RUNS,
    description: 'The check runs for one commit sha: overall conclusion and the failed jobs with their URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        sha: { type: 'string', description: 'Commit sha (a pull request head, from get_pull_request)' },
      },
      required: ['sha'],
    },
  },
  {
    name: TOOL_SEARCH_ISSUES,
    description:
      'Search issues and pull requests within the allowed repository. Takes GitHub search ' +
      'syntax; repo:, user:, org: and owner: qualifiers are dropped, since the repository is added for you.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        query: { type: 'string', description: 'Search query, e.g. `is:open label:bug flaky test`' },
        limit: {
          type: 'integer',
          minimum: 1,
          description: `Max hits (default and cap ${LIMITS.listEntries}, the rendered list bound)`,
        },
      },
      required: ['query'],
    },
  },
];

async function callRead(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case TOOL_GET_ISSUE: {
      const issue = await ctx.api.getIssue(resolveThread(args, ctx, 'issue'));
      return toolResult(renderIssue(issue));
    }
    case TOOL_GET_PULL_REQUEST: {
      const pull = await ctx.api.getPullRequest(resolveThread(args, ctx, 'pull'));
      return toolResult(renderPullRequest(pull));
    }
    case TOOL_LIST_COMMENTS: {
      const kind = oneOf<ThreadKind>(args, 'kind', THREAD_KINDS, 'issue');
      const thread = resolveThread(args, ctx, kind);
      const since = optionalString(args, 'since');
      const comments = await ctx.api.listComments(thread, since);
      return toolResult(renderComments(thread, comments));
    }
    case TOOL_LIST_REVIEW_THREADS: {
      const pull = resolveThread(args, ctx, 'pull');
      return toolResult(renderReviewThreads(pull, await ctx.api.listReviewThreads(pull)));
    }
    case TOOL_LIST_PULL_REQUEST_FILES: {
      const pull = resolveThread(args, ctx, 'pull');
      return toolResult(renderFiles(pull, await ctx.api.listPullRequestFiles(pull)));
    }
    case TOOL_GET_CHECK_RUNS: {
      const repo = resolveRepo(args, ctx);
      const sha = requireString(args, 'sha');
      return toolResult(renderChecksSummary(await ctx.api.getCheckRuns(repo, sha)));
    }
    case TOOL_SEARCH_ISSUES: {
      const repo = resolveRepo(args, ctx);
      const query = requireString(args, 'query');
      const limit = Math.min(optionalNumber(args, 'limit') ?? LIMITS.listEntries, LIMITS.listEntries);
      return toolResult(renderSearchHits(repo, query, await ctx.api.searchIssues(repo, query, limit)));
    }
    default:
      throw new ToolArgumentError(`unknown tool for ${READ_FEATURE_SET}: ${field(name)}`);
  }
}

/** The github.read ToolModule the server (.9) registers. */
export const readToolModule: ToolModule = {
  featureSet: READ_FEATURE_SET,
  tools: readTools,
  call: (name, args, ctx) => runTool(name, ctx, () => callRead(name, args, ctx)),
};
