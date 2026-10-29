/**
 * Tool support — the arguments, refusals, failures and per-field bounds every
 * ToolModule shares (TASK-SRHKG.1.9, moved out of tools-read.ts).
 *
 * .6 put these in `tools-read.ts` because its write scope was those four files
 * and both write modules needed them; .7 then grew its own thread parser in
 * `tools-comments.ts` because the two packages were built in parallel. WP9
 * reconciles both: the helpers live here, and {@link parseThread} is the one
 * parser for every form of "which issue or pull request" — `owner/name#12`,
 * `github:owner/name#12`, `#12`, `12`, and `{ owner, name, number, kind }`.
 *
 * The render* functions stay where they are. `content.ts` renders an *event*
 * for a channel delivery; these tools render a *result* for the model, and
 * only .6's renderers bound the fields the contract's `LIMITS` does not name
 * (a login, a branch, a sha, a node id, a path, a URL, an echoed query). See
 * the WP9 report for that decision.
 */

import {
  LIMITS,
  bounded,
  parseRepoSlug,
  repoAllowed,
  repoSlug,
  type RepoRef,
  type ThreadKind,
  type ThreadRef,
  type ToolContext,
  type ToolResult,
} from './types.js';
// ─────────────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-field bounds for everything that reaches the model.
 *
 * `LIMITS` (types.ts) fixes the three the contract names — a comment body at
 * 4k, a list at 50 entries, a title at 80. Every *other* string on the way out
 * is bounded here, because the contract's three do not cover a label, a login,
 * a branch, a sha, a node id, a path, a URL, or an argument echoed back in a
 * message, and an unbounded field is an unbounded result no matter how well
 * the enumerated ones behave.
 */
export const FIELD = {
  /** A login, a label, a branch, a state, a check name, a timestamp. */
  name: LIMITS.titleChars,
  /** `owner/name`: GitHub allows 39 + 1 + 100 characters. */
  slug: 160,
  /** A commit sha — or whatever was passed as one. */
  sha: 64,
  /** A GraphQL node id (a review thread). */
  nodeId: 128,
  /** A file path in a diff. */
  path: 200,
  /** An echoed search query. */
  query: 200,
  /** A URL: long enough that it stays clickable. */
  url: 300,
} as const;

/**
 * A value quoted for a message, bounded. Every "got …" in an argument error,
 * every name in a refusal and every confirmation line goes through it, so no
 * message can be made arbitrarily long by making an argument arbitrarily long.
 */
export function echo(value: unknown, max: number = FIELD.name): string {
  if (typeof value !== 'string') return bounded(JSON.stringify(value) ?? String(value), max);
  // Bound first, quote second: truncating the quoted form would eat the
  // closing quote and leave the message looking unterminated.
  return JSON.stringify(bounded(value, Math.max(0, max - 2)));
}

/** A string field on the way out, bounded to its kind. */
export function field(value: string, max: number = FIELD.name): string {
  return bounded(value, max);
}

/**
 * The first {@link LIMITS.listEntries} entries, joined on one line, naming
 * what was dropped. For a list that is a field (labels, reviewers, logins)
 * rather than a block.
 */
export function boundedInline(items: readonly string[], max: number = FIELD.name): string {
  const shown = items.slice(0, LIMITS.listEntries).map((item) => field(item, max));
  if (items.length > shown.length) {
    shown.push(`… ${items.length - shown.length} more not shown (list bound ${LIMITS.listEntries})`);
  }
  return shown.join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusals, failures, results
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A policy refusal: the repository is outside GITHUB_REPOS, the base branch is
 * outside GITHUB_PR_BASE_ALLOW, the review would approve the bot's own pull
 * request. Not an error from GitHub and not a malformed call — the tool could
 * have done it and must not, and the reason names what was refused.
 */
export class ToolRefusal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ToolRefusal';
  }
}

export function refuse(reason: string): never {
  throw new ToolRefusal(reason);
}

/** A malformed call: a missing argument, a wrong type, a value out of domain. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

/** A text-block tool result (the contract: tool results are text blocks). */
export function toolResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** An HTTP status carried by an octokit error, when there is one. */
function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * One line for a failed call. A GitHub error is reported with its status and
 * its message, as the contract requires; nothing else about the response is
 * forwarded, so no header and no secret can ride along.
 */
export function describeFailure(toolName: string, err: unknown): string {
  const tool = field(toolName);
  if (err instanceof ToolRefusal) return `${tool} refused: ${err.message}`;
  if (err instanceof ToolArgumentError) return `${tool}: ${err.message}`;
  const uncertain = uncertainWrite(err);
  if (uncertain) return `${tool}: ${uncertain}`;
  const message = err instanceof Error ? err.message : String(err);
  const status = statusOf(err);
  return status === undefined
    ? `${tool} failed: ${bounded(message, LIMITS.commentChars)}`
    : `${tool} failed: GitHub error ${status}: ${bounded(message, LIMITS.commentChars)}`;
}

export function uncertainWrite(err: unknown): string | null {
  const e = err as {
    possiblyDone?: unknown;
    answered?: unknown;
    status?: unknown;
    operation?: unknown;
    githubMessage?: unknown;
  } | null;
  if (e?.possiblyDone !== true) return null;
  const operation = field(String(e.operation));
  const detail = bounded(String(e.githubMessage), LIMITS.commentChars);
  const what =
    e.answered === false
      ? `no answer came back from GitHub for ${operation} (${detail})`
      : `GitHub answered ${operation} with ${String(e.status)} (${detail})`;
  return `${what}, so whether it took effect is unknown. Look on GitHub before trying again: a retry may do it twice.`;
}

/**
 * A refusal, a malformed call or a GitHub error comes back as an error result
 * the model can read, not as a JSON-RPC error.
 */
export async function runTool(
  tool: string,
  ctx: ToolContext,
  body: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    const text = describeFailure(tool, err);
    ctx.logger.warn('tool call failed', { tool: field(tool), detail: text });
    return errorResult(text);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolArgumentError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolArgumentError(`"${key}" must be a string`);
  return value;
}

/** A positive integer, which is what every GitHub number and line is. */
export function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new ToolArgumentError(`"${key}" must be a positive integer, got ${echo(value)}`);
  }
  return n;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  if (args[key] === undefined || args[key] === null) return undefined;
  return requireNumber(args, key);
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ToolArgumentError(`"${key}" must be a boolean`);
  return value;
}

export function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolArgumentError(`"${key}" must be a non-empty array of strings`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ToolArgumentError(`"${key}[${i}]" must be a non-empty string`);
    }
    return entry;
  });
}

/** A value from a closed set; `fallback` applies when the argument is absent. */
export function oneOf<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = args[key];
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ToolArgumentError(`"${key}" must be one of ${allowed.join(' | ')}, got ${echo(value)}`);
  }
  return value as T;
}

/**
 * The repository a call acts on: the `repo` argument when given, otherwise the
 * single repository GITHUB_REPOS names. A repository outside the allow-list is
 * refused by name — for reads as well as writes. An installation token could
 * not reach it anyway, and a user token reaches far past the server's scope,
 * so in either mode a named refusal is the boundary.
 */
export function resolveRepo(args: Record<string, unknown>, ctx: ToolContext): RepoRef {
  const allowed = ctx.repos;
  if (allowed.length === 0) {
    throw new ToolArgumentError('GITHUB_REPOS names no repository, so there is nothing to act on');
  }
  const raw = optionalString(args, 'repo');
  if (raw === undefined || raw.trim() === '') {
    if (allowed.length === 1) return allowed[0];
    throw new ToolArgumentError(
      `"repo" is required: GITHUB_REPOS names several repositories (${boundedInline(allowed.map(repoSlug), FIELD.slug)})`,
    );
  }
  const repo = parseRepoSlug(raw);
  if (!repo) throw new ToolArgumentError(`"repo" must be owner/name, got ${echo(raw, FIELD.slug)}`);
  return requireAllowedRepo(repo, allowed);
}

/**
 * A repository, checked against GITHUB_REPOS. The refusal names the
 * repository asked for and the ones allowed, so the caller can correct it in
 * one step.
 */
export function requireAllowedRepo(repo: RepoRef, allowed: readonly RepoRef[]): RepoRef {
  if (!repoAllowed(repo, allowed)) {
    refuse(
      `repository ${field(repoSlug(repo), FIELD.slug)} is not in GITHUB_REPOS (allowed: ${boundedInline(
        allowed.map(repoSlug),
        FIELD.slug,
      )})`,
    );
  }
  return repo;
}

// ─────────────────────────────────────────────────────────────────────────────
// The thread argument — one parser (WP9)
// ─────────────────────────────────────────────────────────────────────────────

/** Either a parsed value or the refusal message explaining why not. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Which issue or pull request a call acts on, from every form the two tool
 * families accept:
 *
 *   - `12` or `"12"` or `"#12"` — the number, in the one repository
 *     GITHUB_REPOS names; with several, the repository has to be spelled;
 *   - `"owner/name#12"` and `"github:owner/name#12"` — the channel id's own
 *     spelling, so a thread can be named exactly as an event named it;
 *   - `{ owner, name, number, kind }`, or `{ repo: "owner/name", number }`,
 *     or `{ repo: "name", number }`.
 *
 * `kindDefault` applies when the form carries no `kind`; `issue` is also the
 * REST path issue comments take on a pull request. The repository allow-list
 * is **not** checked here — the two callers report a refusal differently (a
 * thrown {@link ToolRefusal} for .6, an error *result* for .7) — so each one
 * calls {@link requireAllowedRepo} itself.
 *
 * Returns the refusal message rather than throwing, because .7's tools answer
 * a malformed `thread` with an error result the model can read.
 */
export function parseThread(
  raw: unknown,
  ctx: Pick<ToolContext, 'repos'>,
  kindDefault: ThreadKind = 'issue',
): Parsed<ThreadRef> {
  const fallback = ctx.repos.length === 1 ? ctx.repos[0] : null;
  let owner: string | undefined;
  let name: string | undefined;
  let number: number | undefined;
  let kind: ThreadKind | undefined;

  if (typeof raw === 'number') {
    number = raw;
  } else if (typeof raw === 'string') {
    const m = /^(?:github:)?(?:([^/\s#]+)\/([^/\s#]+))?#?(\d+)$/.exec(raw.trim());
    if (!m) {
      return { ok: false, error: `thread: expected owner/name#number or a number, got ${echo(raw, FIELD.slug)}` };
    }
    owner = m[1];
    name = m[2];
    number = Number(m[3]);
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    // `repo` accepts either `owner/name` or just the repository name.
    const repoField = typeof obj.repo === 'string' ? obj.repo : undefined;
    if (repoField?.includes('/')) {
      [owner, name] = repoField.split('/', 2);
    } else if (repoField) {
      name = repoField;
    }
    if (typeof obj.owner === 'string') owner = obj.owner;
    if (typeof obj.name === 'string') name = obj.name;
    if (typeof obj.number === 'number') number = obj.number;
    if (typeof obj.number === 'string' && /^\d+$/.test(obj.number)) number = Number(obj.number);
    if (obj.kind === 'issue' || obj.kind === 'pull') kind = obj.kind;
  } else {
    return { ok: false, error: 'thread: required (owner/name#number, a number, or { owner, name, number, kind })' };
  }

  if (!Number.isInteger(number) || (number as number) <= 0) {
    return { ok: false, error: `thread: number must be a positive integer, got ${echo(raw, FIELD.slug)}` };
  }
  owner = owner ?? fallback?.owner;
  name = name ?? fallback?.name;
  if (!owner || !name) {
    return {
      ok: false,
      error: `thread: name the repository as owner/name#${number} (GITHUB_REPOS holds ${
        boundedInline(ctx.repos.map(repoSlug), FIELD.slug) || 'nothing'
      })`,
    };
  }
  return { ok: true, value: { repo: { owner, name }, number: number as number, kind: kind ?? kindDefault } };
}

/**
 * `{ repo, number, kind }` for a .6 tool: the `thread` argument in any of
 * {@link parseThread}'s forms when one is given, otherwise the `repo` and
 * `number` pair those tools declare. `kind` is the calling tool's own, so
 * `get_issue` stays an issue read whatever the argument spelled.
 */
export function resolveThread(args: Record<string, unknown>, ctx: ToolContext, kind: ThreadKind): ThreadRef {
  if (args.thread !== undefined && args.thread !== null) {
    const parsed = parseThread(args.thread, ctx, kind);
    if (!parsed.ok) throw new ToolArgumentError(parsed.error);
    requireAllowedRepo(parsed.value.repo, ctx.repos);
    return { ...parsed.value, kind };
  }
  return { repo: resolveRepo(args, ctx), number: requireNumber(args, 'number'), kind };
}

// ─────────────────────────────────────────────────────────────────────────────
// Input-schema fragments
// ─────────────────────────────────────────────────────────────────────────────

/** Every tool takes it; absent means the single repository in GITHUB_REPOS. */
export const REPO_PROPERTY = {
  type: 'string',
  description:
    'Repository as owner/name. Optional when GITHUB_REPOS names one repository (it is then the default); ' +
    'required when it names several. Any repository outside GITHUB_REPOS is refused by name.',
} as const;

export const NUMBER_PROPERTY = {
  type: 'integer',
  minimum: 1,
  description: 'Issue or pull-request number',
} as const;

/**
 * The `thread` argument {@link parseThread} reads — .7's comment tools declare
 * it, and it lives beside its parser so the declared forms and the accepted
 * forms are one list.
 */
export const THREAD_PROPERTY = {
  description: 'The issue or pull request: "owner/name#12", "#12", 12, or { owner, name, number, kind }.',
  anyOf: [
    { type: 'string' },
    { type: 'integer' },
    {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        name: { type: 'string' },
        number: { type: 'integer' },
        kind: { type: 'string', enum: ['issue', 'pull'] },
      },
      required: ['number'],
    },
  ],
} as const;
