/**
 * content.ts — a render test for every `NormalizedEventKind`, the documented
 * bounds (4k body, 40-line diff hunk, 50-entry list, 80-char title), Markdown
 * and sticky-marker passthrough, and the promise that no raw payload field
 * reaches a block.
 *
 * Long bodies are one repeated character (`FILL`), so "no rendered body
 * exceeds 4000 chars" can be asserted directly on the output: the longest run
 * of that character in a block is the longest body the renderer let through.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  LIMITS,
  NORMALIZED_EVENT_KINDS,
  type ChecksSummary,
  type Comment,
  type Issue,
  type IssueSearchHit,
  type NormalizedEvent,
  type PullRequest,
  type PullRequestFile,
  type RepoRef,
  type ReviewThread,
  type ThreadRef,
} from '../src/types.js';
import {
  CONTENT_LIMITS,
  boundedDiffHunk,
  renderChecks,
  renderEvent,
  renderIssue,
  renderPullRequestFiles,
  renderPullRequestSummary,
  renderReviewThreads,
  renderSearch,
  renderThread,
} from '../src/content.js';

const REPO: RepoRef = { owner: 'anima-research', name: 'rayforce' };
const ISSUE: ThreadRef = { repo: REPO, number: 7, kind: 'issue' };
const PULL: ThreadRef = { repo: REPO, number: 12, kind: 'pull' };
const URL = 'https://github.com/anima-research/rayforce/issues/7';

/** One repeated character, so the longest run of it is the longest body shown. */
const FILL = 'z';
const HUGE_BODY = FILL.repeat(10_000);

/** The one text block a renderer returns. */
function only(blocks: ReturnType<typeof renderEvent>): string {
  assert.equal(blocks.length, 1);
  const block = blocks[0];
  assert.equal(block.type, 'text');
  assert.ok(typeof (block as { text: string }).text === 'string');
  return (block as { text: string }).text;
}

/** The longest run of `FILL` in the text — the longest body that got through. */
function longestBody(text: string): number {
  return (text.match(new RegExp(`${FILL}+`, 'g')) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
}

function event(
  kind: NormalizedEvent['kind'],
  over: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  const thread = kind.startsWith('issue.') ? ISSUE : kind === 'push' ? undefined : PULL;
  return {
    id: 'delivery-1',
    receivedAt: '2026-10-14T10:00:00Z',
    repo: REPO,
    kind,
    thread,
    actor: { login: 'alice', isBot: false },
    html_url: URL,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// renderEvent: one row, and one test, per NormalizedEventKind
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The payload each kind carries, the way the ingress (.3) fills it in. Kept
 * here rather than imported from tags.test.ts so neither test file runs the
 * other's cases; the coverage test below is what keeps both tables in step
 * with `NORMALIZED_EVENT_KINDS`.
 */
const RENDER_TABLE: Array<{ kind: NormalizedEvent['kind']; event?: Partial<NormalizedEvent> }> = [
  { kind: 'issue.opened', event: { title: 'Rate limiter drops bursts', body: 'Repro inside.' } },
  { kind: 'issue.edited', event: { title: 'Rate limiter drops bursts', body: 'Clarified.' } },
  { kind: 'issue.closed', event: { title: 'Rate limiter drops bursts' } },
  { kind: 'issue.reopened', event: { title: 'Rate limiter drops bursts' } },
  { kind: 'comment.created', event: { body: 'Looks right to me.' } },
  { kind: 'comment.edited', event: { body: 'Looks right to me (typo).' } },
  { kind: 'comment.deleted' },
  { kind: 'pull.opened', event: { title: 'Fix the limiter', body: 'Closes #7.', sha: 'a'.repeat(40) } },
  { kind: 'pull.synchronize', event: { sha: 'b'.repeat(40) } },
  { kind: 'pull.ready_for_review', event: { title: 'Fix the limiter' } },
  { kind: 'pull.review_requested', event: { title: 'Fix the limiter' } },
  { kind: 'pull.closed', event: { title: 'Fix the limiter' } },
  {
    kind: 'review.submitted',
    event: { body: 'Two notes below.', review: { id: 55, state: 'changes_requested' } },
  },
  {
    kind: 'review_comment.created',
    event: {
      body: 'This branch never runs.',
      reviewComment: {
        id: 901,
        path: 'src/limiter.ts',
        line: 42,
        side: 'RIGHT',
        diffHunk: '@@ -1,3 +1,4 @@\n-old\n+new',
      },
    },
  },
  {
    kind: 'review_comment.edited',
    event: {
      body: 'This branch never runs (edited).',
      reviewComment: {
        id: 901,
        path: 'src/limiter.ts',
        line: 42,
        side: 'RIGHT',
        diffHunk: '@@ -1,3 +1,4 @@\n-old\n+new',
        inReplyTo: 900,
      },
    },
  },
  {
    kind: 'checks.completed',
    event: {
      actor: { login: 'github-actions[bot]', isBot: true },
      sha: 'c'.repeat(40),
      checks: {
        conclusion: 'failure',
        failed: [{ name: 'test', url: 'https://example.invalid/1' }],
      },
    },
  },
  { kind: 'push', event: { sha: 'd'.repeat(40) } },
  { kind: 'thread.read_failed', event: { body: 'github-mcpl stopped reading this thread.' } },
];

test('the render table covers every NormalizedEventKind exactly once', () => {
  const kinds = RENDER_TABLE.map((r) => r.kind);
  assert.deepEqual([...kinds].sort(), [...NORMALIZED_EVENT_KINDS].sort());
  assert.equal(new Set(kinds).size, kinds.length);
});

for (const row of RENDER_TABLE) {
  test(`renderEvent ${row.kind}`, () => {
    const ev = event(row.kind, row.event);
    const text = only(renderEvent(ev));
    const header = text.split('\n')[0];

    // The header line: repo#number (or repo, for a threadless event), kind,
    // actor, link.
    if (ev.thread) assert.ok(header.startsWith(`anima-research/rayforce#${ev.thread.number} `), header);
    else assert.ok(header.startsWith('anima-research/rayforce '), header);
    assert.ok(header.includes(row.kind), header);
    assert.ok(header.includes(ev.actor.login), header);
    assert.ok(header.includes(ev.html_url), header);

    if (ev.title !== undefined) assert.ok(text.includes(ev.title));
    if (ev.body !== undefined) assert.ok(text.includes(ev.body));
    if (ev.sha !== undefined) assert.ok(text.includes(ev.sha));
    if (ev.review) assert.ok(text.includes(ev.review.state));
    if (ev.reviewComment) {
      const rc = ev.reviewComment;
      assert.ok(text.includes(`${rc.path}:${rc.line}`), text);
      assert.ok(text.includes(rc.side));
      assert.ok(text.includes(rc.diffHunk));
      if (rc.inReplyTo !== undefined) assert.ok(text.includes(String(rc.inReplyTo)));
    }
    if (ev.checks) {
      for (const failed of ev.checks.failed) {
        assert.ok(text.includes(failed.name) && text.includes(failed.url));
      }
    }
  });
}

test('a bot actor is marked as one in the header', () => {
  const text = only(renderEvent(event('push', { actor: { login: 'ci[bot]', isBot: true } })));
  assert.ok(text.includes('ci[bot] (bot)'), text);
});

test('an event that carries no body renders no body section', () => {
  const text = only(renderEvent(event('comment.deleted')));
  assert.ok(!text.includes('(no body)'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────────────

test('an event body is bounded to LIMITS.commentChars with a note', () => {
  const text = only(renderEvent(event('issue.opened', { body: HUGE_BODY })));
  assert.ok(longestBody(text) <= LIMITS.commentChars);
  assert.ok(text.includes('truncated'), 'the truncation is named');
  assert.ok(text.includes(`${HUGE_BODY.length - longestBody(text)} chars`), text.slice(-80));
});

test('a title is bounded to LIMITS.titleChars and flattened to one line', () => {
  const text = only(
    renderEvent(event('issue.opened', { title: `${'t'.repeat(500)}\nsecond line` })),
  );
  const titleLine = text.split('\n').find((l) => l.startsWith('title: '));
  assert.ok(titleLine);
  assert.ok(titleLine.length - 'title: '.length <= LIMITS.titleChars, String(titleLine?.length));
  assert.ok(!text.includes('second line'));
});

test('a diff hunk is bounded to 40 lines with a note', () => {
  const hunk = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join('\n');
  const bounded = boundedDiffHunk(hunk);
  const lines = bounded.split('\n');
  // 40 kept lines plus the one-line note.
  assert.equal(lines.length, CONTENT_LIMITS.diffHunkLines + 1);
  assert.ok(lines[lines.length - 1].includes('160 lines dropped'), lines[lines.length - 1]);
  assert.ok(!bounded.includes('+line 40'));

  const text = only(
    renderEvent(
      event('review_comment.created', {
        body: 'see below',
        reviewComment: {
          id: 1,
          path: 'src/limiter.ts',
          line: 7,
          side: 'RIGHT',
          diffHunk: hunk,
        },
      }),
    ),
  );
  const fence = text.split('```diff\n')[1].split('\n```')[0];
  assert.equal(fence.split('\n').length, CONTENT_LIMITS.diffHunkLines + 1);
});

test('a short diff hunk is passed through untouched', () => {
  const hunk = '@@ -1,2 +1,3 @@\n-a\n+b';
  assert.equal(boundedDiffHunk(hunk), hunk);
});

test('a review comment with no line number renders path:?', () => {
  const text = only(
    renderEvent(
      event('review_comment.created', {
        body: 'file-level note',
        reviewComment: { id: 1, path: 'README.md', line: null, side: 'RIGHT', diffHunk: '' },
      }),
    ),
  );
  assert.ok(text.includes('README.md:?'), text);
  assert.ok(!text.includes('```diff'), 'an empty hunk renders no fence');
});

// ─────────────────────────────────────────────────────────────────────────────
// Passthrough and leak guards
// ─────────────────────────────────────────────────────────────────────────────

test('Markdown and HTML comments (sticky markers) pass through verbatim', () => {
  const body = [
    '## Heading',
    '',
    '<!-- sticky:release-notes -->',
    '',
    '- a `code` item with **bold**',
    '```ts',
    'const x = 1;',
    '```',
    '[link](https://example.invalid/x)',
  ].join('\n');
  for (const text of [
    only(renderEvent(event('comment.created', { body }))),
    only(renderThread(ISSUE, [comment({ body })])),
    only(renderIssue(issue({ body }))),
    only(renderPullRequestSummary(pull({ body }))),
  ]) {
    assert.ok(text.includes('<!-- sticky:release-notes -->'), 'sticky marker kept');
    assert.ok(text.includes('## Heading'));
    assert.ok(text.includes('const x = 1;'));
    assert.ok(text.includes('[link](https://example.invalid/x)'));
  }
});

test('a body is rendered byte for byte: indentation, tabs and trailing spaces survive', () => {
  // Four leading spaces open an indented code block and two trailing spaces
  // are a hard break: both are Markdown, so trimming either rewrites what the
  // author wrote into something that renders differently.
  const raw = '    const first = 1;\n    const second = 2;\n\nhard break here  \n\ta tabbed line\n';
  const rendered: Array<[string, string]> = [
    ['renderEvent', only(renderEvent(event('comment.created', { body: raw })))],
    ['renderThread', only(renderThread(ISSUE, [comment({ body: raw })]))],
    ['renderIssue', only(renderIssue(issue({ body: raw })))],
    ['renderPullRequestSummary', only(renderPullRequestSummary(pull({ body: raw })))],
    [
      'renderReviewThreads',
      only(renderReviewThreads([reviewThread({ comments: [reviewComment({ body: raw })] })])),
    ],
  ];
  for (const [name, text] of rendered) {
    assert.ok(text.includes(raw), `${name} altered the body`);
    // The body is last in every block, so an exact tail is an exact body: a
    // stripped indent or a swallowed trailing space fails here.
    assert.ok(text.endsWith(raw), `${name} did not end with the body verbatim`);
  }
});

test('only an all-whitespace body counts as empty', () => {
  for (const blank of ['', '   ', '\n\n', ' \t\n ']) {
    const text = only(renderEvent(event('comment.created', { body: blank })));
    assert.ok(text.endsWith('(no body)'), JSON.stringify(blank));
  }
  // Whitespace *around* content is content, and is kept.
  const padded = '  \n  x  ';
  assert.ok(only(renderEvent(event('comment.created', { body: padded }))).endsWith(padded));
});

test('no raw payload field reaches a rendered block', () => {
  const text = only(
    renderEvent(
      event('comment.created', {
        body: 'visible',
        raw: {
          installation: { id: 7 },
          sender: { email: 'leak@example.invalid' },
          token: 'ghs-should-never-appear',
        },
      }),
    ),
  );
  assert.ok(text.includes('visible'));
  for (const secret of ['ghs-should-never-appear', 'leak@example.invalid', 'installation']) {
    assert.ok(!text.includes(secret), secret);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool-result renderers
// ─────────────────────────────────────────────────────────────────────────────

function issue(over: Partial<Issue> = {}): Issue {
  return {
    number: 7,
    kind: 'issue',
    repo: REPO,
    title: 'Rate limiter drops bursts',
    body: 'Repro inside.',
    state: 'open',
    stateReason: null,
    author: { login: 'alice', isBot: false },
    labels: ['bug'],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    html_url: URL,
    ...over,
  };
}

function pull(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 12,
    kind: 'pull',
    repo: REPO,
    title: 'Fix the limiter',
    body: 'Closes #7.',
    state: 'open',
    draft: false,
    merged: false,
    mergeable: true,
    head: { ref: 'fix-limiter', sha: 'a'.repeat(40) },
    base: { ref: 'dev', sha: 'b'.repeat(40) },
    author: { login: 'alice', isBot: false },
    requestedReviewers: ['bob'],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    html_url: URL,
    checksSummary: null,
    ...over,
  };
}

function comment(over: Partial<Comment> = {}): Comment {
  return {
    id: 100,
    author: { login: 'alice', isBot: false },
    body: 'Looks right.',
    createdAt: '2026-10-02T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    html_url: `${URL}#issuecomment-100`,
    ...over,
  };
}

function reviewThread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    // The GraphQL node id resolve_thread/unresolve_thread take — deliberately
    // unlike the `rt:901` reply id, so a test cannot pass on one by accident.
    id: 'PRRT_graphql_node_123',
    path: 'src/limiter.ts',
    line: 42,
    side: 'RIGHT',
    isResolved: false,
    comments: [reviewComment()],
    ...over,
  };
}

function reviewComment(
  over: Partial<ReviewThread['comments'][number]> = {},
): ReviewThread['comments'][number] {
  return {
    id: 901,
    author: { login: 'alice', isBot: false },
    body: 'This branch never runs.',
    createdAt: '2026-10-02T00:00:00Z',
    ...over,
  };
}

test('renderIssue shows state, author, labels and the body', () => {
  const text = only(renderIssue(issue({ state: 'closed', stateReason: 'not_planned' })));
  assert.ok(text.includes('anima-research/rayforce#7 issue closed (not_planned)'), text);
  assert.ok(text.includes('Rate limiter drops bursts'));
  assert.ok(text.includes('author: alice'));
  assert.ok(text.includes('labels: bug'));
  assert.ok(text.includes('Repro inside.'));
  assert.ok(text.includes(URL));
});

test('renderPullRequestSummary shows refs, mergeability, reviewers and checks', () => {
  const text = only(
    renderPullRequestSummary(
      pull({
        mergeable: null,
        draft: true,
        checksSummary: {
          sha: 'a'.repeat(40),
          conclusion: 'failure',
          total: 3,
          failed: [{ name: 'test', url: 'https://example.invalid/1' }],
        },
      }),
    ),
  );
  assert.ok(text.includes('pull open (draft)'), text);
  assert.ok(text.includes('fix-limiter'), text);
  assert.ok(text.includes('→ dev'), text);
  assert.ok(text.includes('mergeable: computing'));
  assert.ok(text.includes('requested reviewers: bob'));
  assert.ok(text.includes('3 run, 1 failed'));
  assert.ok(text.includes('https://example.invalid/1'));
});

test('a merged pull request says merged', () => {
  const text = only(renderPullRequestSummary(pull({ merged: true, state: 'closed' })));
  assert.ok(text.includes('pull merged'), text);
});

test('renderThread bounds every comment body and caps the list', () => {
  const comments = Array.from({ length: 62 }, (_, i) =>
    comment({ id: 100 + i, body: HUGE_BODY }),
  );
  const text = only(renderThread(ISSUE, comments));
  assert.ok(text.includes('anima-research/rayforce#7 issue: 62 comment(s)'), text.split('\n')[0]);
  assert.ok(longestBody(text) <= LIMITS.commentChars, String(longestBody(text)));
  assert.equal(text.match(/^#1\d\d by /gm)?.length, LIMITS.listEntries);
  assert.ok(text.includes(`and 12 more (showing ${LIMITS.listEntries} of 62)`), text.slice(-120));
});

test('renderThread shows review-comment locus and reply-to when present', () => {
  const text = only(
    renderThread(PULL, [comment({ path: 'src/limiter.ts', line: 42, inReplyTo: 900 })]),
  );
  assert.ok(text.includes('on src/limiter.ts:42'), text);
  assert.ok(text.includes('in reply to 900'), text);
});

test('an empty thread renders a note, not a blank block', () => {
  const text = only(renderThread(ISSUE, []));
  assert.ok(text.includes('(no comments)'));
});

test('renderReviewThreads shows path, side, resolution, both ids and bounds bodies', () => {
  const text = only(renderReviewThreads([reviewThread(), reviewThread({ isResolved: true })]));
  assert.ok(
    text.includes(
      'src/limiter.ts:42 (RIGHT) unresolved — thread PRRT_graphql_node_123 (reply id rt:901)',
    ),
    text,
  );
  assert.ok(text.includes('resolved — thread PRRT_graphql_node_123 (reply id rt:901)'));

  const long = only(
    renderReviewThreads([
      reviewThread({
        comments: Array.from({ length: 62 }, (_, i) => ({
          id: 900 + i,
          author: { login: 'alice', isBot: false },
          body: HUGE_BODY,
          createdAt: '2026-10-02T00:00:00Z',
        })),
      }),
    ]),
  );
  assert.ok(longestBody(long) <= LIMITS.commentChars);
  assert.ok(long.includes(`and 12 more (showing ${LIMITS.listEntries} of 62)`));
});

test('renderReviewThreads carries the GraphQL node id beside the rt: reply id', () => {
  // Two different tools, two different ids: resolve_thread/unresolve_thread
  // take ReviewThread.id (a GraphQL node id), reply_in_thread takes the
  // channel thread id rt:<root comment id>. Dropping either strands the agent.
  const threads: ReviewThread[] = [
    reviewThread({ id: 'PRRT_kwDOAbCdEf4Axxxx', comments: [reviewComment({ id: 901 })] }),
    reviewThread({
      id: 'PRRT_kwDOAbCdEf4Ayyyy',
      path: 'src/poller.ts',
      line: 9,
      isResolved: true,
      comments: [reviewComment({ id: 902 })],
    }),
  ];
  const text = only(renderReviewThreads(threads));
  for (const t of threads) {
    assert.ok(text.includes(t.id), `${t.id} was dropped`);
    assert.ok(text.includes(`rt:${t.comments[0].id}`), `rt:${t.comments[0].id} was dropped`);
    assert.ok(
      text.includes(`thread ${t.id} (reply id rt:${t.comments[0].id})`),
      `${t.id} and its reply id are not rendered together`,
    );
  }
});

test('renderReviewThreads caps the thread list itself', () => {
  const threads = Array.from({ length: 51 }, () => reviewThread());
  const text = only(renderReviewThreads(threads));
  assert.ok(text.includes('51 review thread(s)'));
  assert.ok(text.includes(`and 1 more (showing ${LIMITS.listEntries} of 51)`));
});

test('no review threads renders a note', () => {
  assert.ok(only(renderReviewThreads([])).includes('(no review threads)'));
});

test('renderChecks reports the roll-up and caps the failed list', () => {
  const green: ChecksSummary = { sha: 'c'.repeat(40), conclusion: 'success', total: 4, failed: [] };
  assert.ok(only(renderChecks(green)).includes('(nothing failed)'));
  assert.ok(only(renderChecks(green)).includes('success, 4 run, 0 failed'));

  const pending: ChecksSummary = { sha: 'c'.repeat(40), conclusion: null, total: 2, failed: [] };
  assert.ok(only(renderChecks(pending)).includes('pending'));

  const red: ChecksSummary = {
    sha: 'c'.repeat(40),
    conclusion: 'failure',
    total: 60,
    failed: Array.from({ length: 60 }, (_, i) => ({
      name: `job-${i}`,
      url: `https://example.invalid/${i}`,
    })),
  };
  const text = only(renderChecks(red));
  assert.equal(text.match(/^- job-/gm)?.length, LIMITS.listEntries);
  assert.ok(text.includes(`and 10 more (showing ${LIMITS.listEntries} of 60)`));
});

test('renderSearch caps hits and bounds titles', () => {
  const hits: IssueSearchHit[] = Array.from({ length: 55 }, (_, i) => ({
    number: i + 1,
    kind: i % 2 === 0 ? 'issue' : 'pull',
    title: 't'.repeat(500),
    state: 'open',
    updatedAt: '2026-10-02T00:00:00Z',
    html_url: `${URL}/${i}`,
  }));
  const text = only(renderSearch(hits));
  assert.ok(text.includes('55 match(es)'));
  assert.equal(text.match(/^- #\d+ /gm)?.length, LIMITS.listEntries);
  assert.ok(text.includes(`and 5 more (showing ${LIMITS.listEntries} of 55)`));
  for (const line of text.split('\n')) {
    assert.ok(!/t{200}/.test(line), 'a hit title is bounded');
  }
  assert.ok(only(renderSearch([])).includes('(no matches)'));
});

test('renderPullRequestFiles lists names and stats only, capped', () => {
  const files: PullRequestFile[] = Array.from({ length: 51 }, (_, i) => ({
    filename: `src/file-${i}.ts`,
    status: 'modified',
    additions: 2,
    deletions: 1,
    changes: 3,
  }));
  const text = only(renderPullRequestFiles(files));
  assert.ok(text.includes('51 file(s) changed'));
  assert.equal(text.match(/^- modified /gm)?.length, LIMITS.listEntries);
  assert.ok(text.includes(`and 1 more (showing ${LIMITS.listEntries} of 51)`));
  assert.ok(!text.includes('@@'), 'no patch text');
  assert.ok(only(renderPullRequestFiles([])).includes('(no files)'));
});

// ─────────────────────────────────────────────────────────────────────────────
// The bound holds for every kind, not just the ones with a body in the table
// ─────────────────────────────────────────────────────────────────────────────

test('no rendered event body exceeds LIMITS.commentChars, on any kind', () => {
  for (const kind of NORMALIZED_EVENT_KINDS) {
    const text = only(renderEvent(event(kind, { body: HUGE_BODY, title: HUGE_BODY })));
    assert.ok(longestBody(text) <= LIMITS.commentChars, `${kind}: ${longestBody(text)}`);
  }
});
