import type { ContentBlock } from '@animalabs/mcpl-core';
import {
  LIMITS,
  bounded,
  repoSlug,
  type ChecksSummary,
  type Comment,
  type EventActor,
  type Issue,
  type IssueSearchHit,
  type NormalizedEvent,
  type PullRequest,
  type PullRequestFile,
  type ReviewThread,
  type ThreadRef,
} from './types.js';

export const CONTENT_LIMITS = {
  diffHunkLines: 40,
} as const;

function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

/**
 * Leading and trailing whitespace is Markdown (four spaces open a code block,
 * two at a line's end are a hard break), so a body is trimmed only to detect
 * an empty one.
 */
function body(text: string | undefined): string {
  const raw = text ?? '';
  if (raw.trim().length === 0) return '(no body)';
  return bounded(raw, LIMITS.commentChars);
}

function title(text: string): string {
  return bounded(text.replace(/\s+/g, ' ').trim(), LIMITS.titleChars);
}

function actor(a: EventActor): string {
  return a.isBot ? `${a.login} (bot)` : a.login;
}

function ref(repo: { owner: string; name: string }, number?: number): string {
  return number === undefined ? repoSlug(repo) : `${repoSlug(repo)}#${number}`;
}

function list<T>(items: readonly T[], render: (item: T) => string): string[] {
  const shown = items.slice(0, LIMITS.listEntries).map(render);
  if (items.length > LIMITS.listEntries) {
    shown.push(
      `… and ${items.length - LIMITS.listEntries} more (showing ${LIMITS.listEntries} of ${items.length})`,
    );
  }
  return shown;
}

export function boundedDiffHunk(hunk: string): string {
  const lines = hunk.split('\n');
  if (lines.length <= CONTENT_LIMITS.diffHunkLines) return hunk;
  const kept = lines.slice(0, CONTENT_LIMITS.diffHunkLines);
  kept.push(`… [diff hunk truncated, ${lines.length - CONTENT_LIMITS.diffHunkLines} lines dropped]`);
  return kept.join('\n');
}

function line(path: string, lineNo: number | null | undefined): string {
  return lineNo === null || lineNo === undefined ? `${path}:?` : `${path}:${lineNo}`;
}

export function renderEvent(event: NormalizedEvent): ContentBlock[] {
  const lines: string[] = [
    `${ref(event.repo, event.thread?.number)} ${event.kind} by ${actor(event.actor)} — ${event.html_url}`,
  ];

  if (event.title !== undefined) lines.push(`title: ${title(event.title)}`);
  if (event.sha !== undefined) lines.push(`sha: ${event.sha}`);

  if (event.review) lines.push(`review ${event.review.state} (id ${event.review.id})`);

  if (event.reviewComment) {
    const rc = event.reviewComment;
    const replyTo = rc.inReplyTo === undefined ? '' : `, in reply to ${rc.inReplyTo}`;
    lines.push(`${line(rc.path, rc.line)} (${rc.side}${replyTo})`);
    if (rc.diffHunk.trim().length > 0) {
      lines.push('```diff', boundedDiffHunk(rc.diffHunk), '```');
    }
  }

  if (event.checks) {
    const c = event.checks;
    lines.push(`checks: ${c.conclusion ?? 'pending'}, ${c.failed.length} failed`);
    lines.push(...list(c.failed, (f) => `- ${f.name} — ${f.url}`));
  }

  if (event.body !== undefined) lines.push('', body(event.body));

  return [textBlock(lines.join('\n'))];
}

export function renderIssue(issue: Issue): ContentBlock[] {
  const state = issue.stateReason ? `${issue.state} (${issue.stateReason})` : issue.state;
  const lines = [
    `${ref(issue.repo, issue.number)} issue ${state} — ${issue.html_url}`,
    `title: ${title(issue.title)}`,
    `author: ${actor(issue.author)}, opened ${issue.createdAt}, updated ${issue.updatedAt}`,
  ];
  if (issue.labels.length > 0) lines.push(`labels: ${list(issue.labels, (l) => l).join(', ')}`);
  lines.push('', body(issue.body));
  return [textBlock(lines.join('\n'))];
}

export function renderPullRequestSummary(pr: PullRequest): ContentBlock[] {
  const state = pr.merged ? 'merged' : pr.draft ? `${pr.state} (draft)` : pr.state;
  const mergeable = pr.mergeable === null ? 'computing' : pr.mergeable ? 'yes' : 'no';
  const lines = [
    `${ref(pr.repo, pr.number)} pull ${state} — ${pr.html_url}`,
    `title: ${title(pr.title)}`,
    `author: ${actor(pr.author)}, opened ${pr.createdAt}, updated ${pr.updatedAt}`,
    `${pr.head.ref} (${pr.head.sha}) → ${pr.base.ref} (${pr.base.sha}), mergeable: ${mergeable}`,
  ];
  if (pr.requestedReviewers.length > 0) {
    lines.push(`requested reviewers: ${list(pr.requestedReviewers, (r) => r).join(', ')}`);
  }
  if (pr.checksSummary) {
    const c = pr.checksSummary;
    lines.push(
      `checks on ${c.sha}: ${c.conclusion ?? 'pending'}, ${c.total} run, ${c.failed.length} failed`,
    );
    lines.push(...list(c.failed, (f) => `- ${f.name} — ${f.url}`));
  }
  lines.push('', body(pr.body));
  return [textBlock(lines.join('\n'))];
}

export function renderThread(thread: ThreadRef, comments: readonly Comment[]): ContentBlock[] {
  const header = `${ref(thread.repo, thread.number)} ${thread.kind}: ${comments.length} comment(s)`;
  if (comments.length === 0) return [textBlock(`${header}\n(no comments)`)];
  const rendered = list(comments, (c) => {
    const where = c.path ? ` on ${line(c.path, c.line)}` : '';
    const replyTo = c.inReplyTo === undefined ? '' : `, in reply to ${c.inReplyTo}`;
    return [
      `#${c.id} by ${actor(c.author)} at ${c.createdAt}${where}${replyTo} — ${c.html_url}`,
      body(c.body),
    ].join('\n');
  });
  return [textBlock([header, '', rendered.join('\n\n')].join('\n'))];
}

export function renderReviewThreads(threads: readonly ReviewThread[]): ContentBlock[] {
  if (threads.length === 0) return [textBlock('(no review threads)')];
  const rendered = list(threads, (t) => {
    const state = t.isResolved ? 'resolved' : 'unresolved';
    const head = `${line(t.path, t.line)} (${t.side}) ${state} — thread ${t.id} (reply id rt:${t.comments[0]?.id ?? '?'})`;
    const comments = list(t.comments, (c) =>
      // Not indented: an indent is Markdown.
      [`  #${c.id} by ${actor(c.author)} at ${c.updatedAt ?? c.createdAt}`, body(c.body)].join('\n'),
    );
    return [head, ...comments].join('\n');
  });
  return [
    textBlock([`${threads.length} review thread(s)`, '', rendered.join('\n\n')].join('\n')),
  ];
}

export function renderChecks(checkRuns: ChecksSummary): ContentBlock[] {
  const lines = [
    `checks on ${checkRuns.sha}: ${checkRuns.conclusion ?? 'pending'}, ${checkRuns.total} run, ${checkRuns.failed.length} failed`,
  ];
  if (checkRuns.failed.length === 0) lines.push('(nothing failed)');
  else lines.push(...list(checkRuns.failed, (f) => `- ${f.name} — ${f.url}`));
  return [textBlock(lines.join('\n'))];
}

export function renderSearch(results: readonly IssueSearchHit[]): ContentBlock[] {
  if (results.length === 0) return [textBlock('(no matches)')];
  const lines = [
    `${results.length} match(es)`,
    ...list(
      results,
      (r) =>
        `- #${r.number} ${r.kind} ${r.state}, updated ${r.updatedAt}: ${title(r.title)} — ${r.html_url}`,
    ),
  ];
  return [textBlock(lines.join('\n'))];
}

export function renderPullRequestFiles(files: readonly PullRequestFile[]): ContentBlock[] {
  if (files.length === 0) return [textBlock('(no files)')];
  const lines = [
    `${files.length} file(s) changed`,
    ...list(files, (f) => `- ${f.status} ${f.filename} (+${f.additions} −${f.deletions})`),
  ];
  return [textBlock(lines.join('\n'))];
}
