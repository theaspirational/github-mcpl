import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ToolArgumentError } from '../src/tool-support.js';
import { parseReviewComments, reviewToolModule } from '../src/tools-review.js';
import {
  REVIEW_FEATURE_SET,
  silentLogger,
  type CreateReviewInput,
  type RepoRef,
  type StateStore,
  type SubmittedReview,
  type ThreadRef,
  type ToolContext,
  type ToolResult,
} from '../src/types.js';
import { FakeGitHubApi, TEST_BOT, TEST_REPO } from './harness.js';

const NO_CHECKPOINT_STORE = undefined as unknown as StateStore;

function ctx(api: FakeGitHubApi, over: Partial<ToolContext> = {}): ToolContext {
  return {
    api,
    // A submitted GitHub review can't be withdrawn, so github.review keeps no
    // checkpoints.
    state: NO_CHECKPOINT_STORE,
    botLogin: TEST_BOT.login,
    repos: [TEST_REPO],
    prBaseAllow: ['dev'],
    logger: silentLogger(),
    ...over,
  };
}

function text(result: ToolResult): string {
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.equal(block.type, 'text');
  return (block as { type: 'text'; text: string }).text;
}

function ok(result: ToolResult): string {
  assert.equal(result.isError, undefined, `expected success, got: ${text(result)}`);
  return text(result);
}

function failure(result: ToolResult): string {
  assert.equal(result.isError, true, `expected an error result, got: ${text(result)}`);
  return text(result);
}

const PULL: ThreadRef = { repo: TEST_REPO, number: 8, kind: 'pull' };
const OTHER_REPO: RepoRef = { owner: 'someone-else', name: 'not-ours' };
const HUMAN = { login: 'human-one', isBot: false };

test('the module declares github.review and its three tools', () => {
  assert.equal(reviewToolModule.featureSet, REVIEW_FEATURE_SET);
  assert.deepEqual(reviewToolModule.tools.map((t) => t.name), [
    'create_review',
    'resolve_thread',
    'unresolve_thread',
  ]);
});

test('create_review submits the inline comments with the exact positions', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: HUMAN });

  const comments = [
    { path: 'src/lib.rs', line: 42, side: 'RIGHT', body: 'this allocates in the loop' },
    { path: 'src/old.rs', line: 3, side: 'LEFT', body: 'why was this removed?' },
  ];
  const out = ok(
    await reviewToolModule.call('create_review', { number: 8, event: 'COMMENT', body: 'two notes', comments }, ctx(api)),
  );

  const call = api.callsTo('createReview');
  assert.equal(call.length, 1);
  assert.deepEqual(call[0].args[0], PULL);
  assert.deepEqual(call[0].args[1], {
    event: 'COMMENT',
    body: 'two notes',
    comments: [
      { path: 'src/lib.rs', line: 42, side: 'RIGHT', body: 'this allocates in the loop' },
      { path: 'src/old.rs', line: 3, side: 'LEFT', body: 'why was this removed?' },
    ],
  } satisfies CreateReviewInput);
  assert.match(out, /submitted commented review \d+ on anima-research\/rayforce#8 with 2 inline comments/);

  const threads = await api.listReviewThreads(PULL);
  assert.deepEqual(
    threads.map((t) => `${t.path}:${t.line}:${t.side}`),
    ['src/lib.rs:42:RIGHT', 'src/old.rs:3:LEFT'],
  );
});

test('side defaults to RIGHT, the post-image', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: HUMAN });

  ok(
    await reviewToolModule.call(
      'create_review',
      { number: 8, event: 'COMMENT', body: 'one note', comments: [{ path: 'src/lib.rs', line: 7, body: 'here' }] },
      ctx(api),
    ),
  );
  assert.deepEqual((api.callsTo('createReview')[0].args[1] as CreateReviewInput).comments, [
    { path: 'src/lib.rs', line: 7, side: 'RIGHT', body: 'here' },
  ]);
});

test('a review without inline comments sends none, and says so', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: HUMAN });

  const out = ok(await reviewToolModule.call('create_review', { number: 8, event: 'COMMENT', body: 'looks fine' }, ctx(api)));
  const input = api.callsTo('createReview')[0].args[1] as CreateReviewInput;
  assert.equal(input.event, 'COMMENT');
  assert.equal(input.body, 'looks fine');
  assert.equal((input.comments ?? []).length, 0);
  assert.match(out, /with 0 inline comments/);
});

test('APPROVE and REQUEST_CHANGES on someone else’s pull request go through', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: HUMAN });

  assert.match(
    ok(await reviewToolModule.call('create_review', { number: 8, event: 'APPROVE' }, ctx(api))),
    /submitted approved review/,
  );
  assert.match(
    ok(
      await reviewToolModule.call(
        'create_review',
        { number: 8, event: 'REQUEST_CHANGES', body: 'see the inline notes' },
        ctx(api),
      ),
    ),
    /submitted changes_requested review/,
  );
  assert.equal(api.submittedReviews().length, 2);
});

test('APPROVE on the bot’s own pull request is refused by name, nothing submitted', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: { login: TEST_BOT.login, isBot: true } });

  const out = failure(await reviewToolModule.call('create_review', { number: 8, event: 'APPROVE' }, ctx(api)));
  assert.match(out, /create_review refused: APPROVE on anima-research\/rayforce#8 is this bot's own pull request/);
  assert.match(out, /author rayforce-clone\[bot\]/);
  assert.deepEqual(api.callLog(), ['getPullRequest'], 'the review was never created');
  assert.equal(api.submittedReviews().length, 0);
});

test('REQUEST_CHANGES on the bot’s own pull request is refused too', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: { login: TEST_BOT.login, isBot: true } });

  const out = failure(
    await reviewToolModule.call('create_review', { number: 8, event: 'REQUEST_CHANGES', body: 'no' }, ctx(api)),
  );
  assert.match(out, /refused: REQUEST_CHANGES on anima-research\/rayforce#8 is this bot's own pull request/);
  assert.equal(api.submittedReviews().length, 0);
});

test('the own-pull-request check is case-insensitive, as GitHub logins are', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: { login: 'RayForce-Clone[Bot]', isBot: true } });

  const out = failure(await reviewToolModule.call('create_review', { number: 8, event: 'APPROVE' }, ctx(api)));
  assert.match(out, /refused: APPROVE on/);
});

test('a COMMENT review on the bot’s own pull request is allowed and costs no extra read', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: { login: TEST_BOT.login, isBot: true } });

  ok(await reviewToolModule.call('create_review', { number: 8, event: 'COMMENT', body: 'note to self' }, ctx(api)));
  assert.deepEqual(api.callLog(), ['createReview']);
});

test('create_review needs an event from the contract’s three', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: HUMAN });
  assert.match(
    failure(await reviewToolModule.call('create_review', { number: 8 }, ctx(api))),
    /"event" must be one of COMMENT \| APPROVE \| REQUEST_CHANGES/,
  );
  assert.match(
    failure(await reviewToolModule.call('create_review', { number: 8, event: 'DISMISS' }, ctx(api))),
    /got "DISMISS"/,
  );
  assert.equal(api.calls.length, 0);
});

test('a COMMENT or REQUEST_CHANGES review needs a body, an APPROVE does not', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: HUMAN });

  assert.match(
    failure(await reviewToolModule.call('create_review', { number: 8, event: 'COMMENT' }, ctx(api))),
    /"body" is required for a COMMENT review/,
  );
  assert.match(
    failure(await reviewToolModule.call('create_review', { number: 8, event: 'REQUEST_CHANGES' }, ctx(api))),
    /"body" is required for a REQUEST_CHANGES review/,
  );
  assert.equal(api.calls.length, 0);
  ok(await reviewToolModule.call('create_review', { number: 8, event: 'APPROVE' }, ctx(api)));
});

test('a review on a repository outside GITHUB_REPOS is refused by name', async () => {
  const api = new FakeGitHubApi();
  const out = failure(
    await reviewToolModule.call(
      'create_review',
      { repo: 'someone-else/not-ours', number: 8, event: 'COMMENT', body: 'hi' },
      ctx(api),
    ),
  );
  assert.match(out, /create_review refused: repository someone-else\/not-ours is not in GITHUB_REPOS/);
  assert.equal(api.calls.length, 0);
});

test('an inline comment position is validated, never guessed', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: HUMAN });
  const review = (comments: unknown) =>
    reviewToolModule.call('create_review', { number: 8, event: 'COMMENT', body: 'b', comments }, ctx(api));

  assert.match(failure(await review('src/lib.rs:42')), /"comments" must be an array of inline comments/);
  assert.match(failure(await review([['src/lib.rs', 42]])), /"comments\[0\]" must be an object/);
  assert.match(failure(await review([{ line: 42, body: 'x' }])), /"comments\[0\]\.path" must be a non-empty file path/);
  assert.match(failure(await review([{ path: '  ', line: 42, body: 'x' }])), /"comments\[0\]\.path"/);
  assert.match(
    failure(await review([{ path: 'a.rs', body: 'x' }])),
    /"comments\[0\]\.line" must be a positive integer line number in the diff, got undefined/,
  );
  assert.match(failure(await review([{ path: 'a.rs', line: 0, body: 'x' }])), /\.line" must be a positive integer/);
  assert.match(failure(await review([{ path: 'a.rs', line: -3, body: 'x' }])), /\.line" must be a positive integer/);
  assert.match(failure(await review([{ path: 'a.rs', line: 2.5, body: 'x' }])), /\.line" must be a positive integer/);
  // GitHub answers a line given as a string with a 422.
  assert.match(failure(await review([{ path: 'a.rs', line: '42', body: 'x' }])), /got "42"/);
  assert.match(
    failure(await review([{ path: 'a.rs', line: 42, side: 'BOTH', body: 'x' }])),
    /"comments\[0\]\.side" must be one of LEFT \| RIGHT, got "BOTH"/,
  );
  assert.match(failure(await review([{ path: 'a.rs', line: 42 }])), /"comments\[0\]\.body" must be a non-empty string/);
  assert.match(
    failure(await review([{ path: 'a.rs', line: 42, body: 'ok' }, { path: 'b.rs', line: 0, body: 'x' }])),
    /"comments\[1\]\.line"/,
  );
  assert.equal(api.calls.length, 0, 'no review was submitted on any malformed position');
});

test('parseReviewComments is exact and total', () => {
  assert.deepEqual(parseReviewComments(undefined), []);
  assert.deepEqual(parseReviewComments(null), []);
  assert.deepEqual(parseReviewComments([]), []);
  assert.deepEqual(parseReviewComments([{ path: 'a.rs', line: 1, side: 'LEFT', body: 'b' }]), [
    { path: 'a.rs', line: 1, side: 'LEFT', body: 'b' },
  ]);
  assert.throws(() => parseReviewComments([{ path: 'a.rs', line: 1, body: '' }]), ToolArgumentError);
});

test('resolve_thread and unresolve_thread move a thread of the named pull request', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: HUMAN });
  api.seedReviewThread(PULL, { id: 'RT_kwDO', isResolved: false });

  const resolved = ok(await reviewToolModule.call('resolve_thread', { number: 8, threadId: 'RT_kwDO' }, ctx(api)));
  assert.equal(resolved, 'resolved review thread RT_kwDO on anima-research/rayforce#8');
  assert.deepEqual(api.callLog(), ['listReviewThreads', 'resolveReviewThread']);
  assert.deepEqual(api.callsTo('listReviewThreads')[0].args, [PULL]);
  assert.deepEqual(api.callsTo('resolveReviewThread')[0].args, ['RT_kwDO']);
  assert.equal((await api.listReviewThreads(PULL))[0].isResolved, true);

  const unresolved = ok(await reviewToolModule.call('unresolve_thread', { number: 8, threadId: 'RT_kwDO' }, ctx(api)));
  assert.equal(unresolved, 'unresolved review thread RT_kwDO on anima-research/rayforce#8');
  assert.deepEqual(api.callsTo('unresolveReviewThread')[0].args, ['RT_kwDO']);
  assert.equal((await api.listReviewThreads(PULL))[0].isResolved, false);
});

test('resolve_thread accepts the allowed repository named explicitly', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: HUMAN });
  api.seedReviewThread(PULL, { id: 'RT_kwDO', isResolved: false });

  const out = ok(
    await reviewToolModule.call(
      'resolve_thread',
      { repo: 'anima-research/rayforce', number: 8, threadId: 'RT_kwDO' },
      ctx(api),
    ),
  );
  assert.equal(out, 'resolved review thread RT_kwDO on anima-research/rayforce#8');
  assert.equal((await api.listReviewThreads(PULL))[0].isResolved, true);
});

test('resolve_thread refuses a node id that is not on the pull request', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: HUMAN });
  api.seedReviewThread(PULL, { id: 'RT_ours', isResolved: false });
  // A review thread's GraphQL node id names no repository, so only the pull
  // request's own thread list can refuse a foreign thread.
  const foreignPull: ThreadRef = { repo: OTHER_REPO, number: 8, kind: 'pull' };
  api.seedPullRequest({ repo: OTHER_REPO, number: 8 });
  api.seedReviewThread(foreignPull, { id: 'RT_foreign', isResolved: false });

  const out = failure(await reviewToolModule.call('resolve_thread', { number: 8, threadId: 'RT_foreign' }, ctx(api)));
  assert.match(
    out,
    /resolve_thread refused: review thread "RT_foreign" is not one of the 1 review thread on anima-research\/rayforce#8/,
  );
  assert.deepEqual(api.callLog(), ['listReviewThreads']);
  assert.equal(api.callsTo('resolveReviewThread').length, 0);
  assert.equal((await api.listReviewThreads(foreignPull))[0].isResolved, false);
  assert.equal((await api.listReviewThreads(PULL))[0].isResolved, false);
});

test('unresolve_thread establishes membership too', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: HUMAN });
  const foreignPull: ThreadRef = { repo: OTHER_REPO, number: 8, kind: 'pull' };
  api.seedPullRequest({ repo: OTHER_REPO, number: 8 });
  api.seedReviewThread(foreignPull, { id: 'RT_foreign', isResolved: true });

  const out = failure(await reviewToolModule.call('unresolve_thread', { number: 8, threadId: 'RT_foreign' }, ctx(api)));
  assert.match(out, /unresolve_thread refused: review thread "RT_foreign" is not one of the 0 review threads on/);
  assert.equal(api.callsTo('unresolveReviewThread').length, 0);
  assert.equal((await api.listReviewThreads(foreignPull))[0].isResolved, true);
});

test('a thread id on another pull request of the allowed repository is refused', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: HUMAN });
  api.seedPullRequest({ number: 9, author: HUMAN });
  api.seedReviewThread({ repo: TEST_REPO, number: 9, kind: 'pull' }, { id: 'RT_nine', isResolved: false });

  const out = failure(await reviewToolModule.call('resolve_thread', { number: 8, threadId: 'RT_nine' }, ctx(api)));
  assert.match(out, /refused: review thread "RT_nine" is not one of the 0 review threads on anima-research\/rayforce#8/);
  assert.equal(api.callsTo('resolveReviewThread').length, 0);
});

test('resolve_thread needs the pull request, a thread id, and rejects the channel thread id', async () => {
  const api = new FakeGitHubApi();
  assert.match(
    failure(await reviewToolModule.call('resolve_thread', { threadId: 'RT_x' }, ctx(api))),
    /"number" must be a positive integer, got undefined/,
  );
  assert.match(
    failure(await reviewToolModule.call('resolve_thread', { number: 8 }, ctx(api))),
    /"threadId" is required and must be a non-empty string/,
  );
  assert.match(
    failure(await reviewToolModule.call('resolve_thread', { number: 8, threadId: 'rt:1001' }, ctx(api))),
    /"threadId" is the review thread id from list_review_threads \(a GraphQL node id\), not the channel thread id "rt:1001"/,
  );
  assert.match(
    failure(await reviewToolModule.call('resolve_thread', { number: 8, threadId: 'review:55' }, ctx(api))),
    /not the channel thread id "review:55"/,
  );
  assert.equal(api.calls.length, 0, 'membership is never even looked up for a malformed call');
});

test('resolve_thread refuses a repository outside GITHUB_REPOS', async () => {
  const api = new FakeGitHubApi();
  const out = failure(
    await reviewToolModule.call(
      'resolve_thread',
      { repo: 'someone-else/not-ours', number: 8, threadId: 'RT_x' },
      ctx(api),
    ),
  );
  assert.match(out, /resolve_thread refused: repository someone-else\/not-ours is not in GITHUB_REPOS/);
  assert.equal(api.calls.length, 0);
});

test('an echoed thread id cannot make the message arbitrarily long', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, author: HUMAN });

  const out = failure(
    await reviewToolModule.call('resolve_thread', { number: 8, threadId: 'R'.repeat(100_000) }, ctx(api)),
  );
  assert.ok(out.length < 400, `the refusal stayed bounded (${out.length} chars)`);
  assert.match(out, /truncated \d+ chars/);
});

test('the input schemas advertise what the runtime enforces', () => {
  const byName = new Map(reviewToolModule.tools.map((t) => [t.name, t]));

  const comments = byName.get('create_review')!.inputSchema.properties.comments as {
    items: { properties: Record<string, Record<string, unknown>>; required: string[] };
  };
  assert.equal(comments.items.properties.line.type, 'integer');
  assert.equal(comments.items.properties.line.minimum, 1);
  assert.deepEqual(comments.items.properties.side.enum, ['LEFT', 'RIGHT']);
  assert.deepEqual(comments.items.required, ['path', 'line', 'body']);
  assert.equal((byName.get('create_review')!.inputSchema.properties.number as Record<string, unknown>).type, 'integer');

  for (const name of ['resolve_thread', 'unresolve_thread']) {
    const schema = byName.get(name)!.inputSchema;
    assert.deepEqual(schema.required, ['number', 'threadId']);
    assert.equal((schema.properties.number as Record<string, unknown>).type, 'integer');
    assert.equal((schema.properties.number as Record<string, unknown>).minimum, 1);
  }
});

test('an unknown review tool is reported', async () => {
  const out = failure(await reviewToolModule.call('dismiss_review', {}, ctx(new FakeGitHubApi())));
  assert.match(out, /unknown tool for github\.review: dismiss_review/);
});

test('a GitHub error from createReview carries its status and message', async () => {
  class RejectingApi extends FakeGitHubApi {
    override async createReview(pull: ThreadRef): Promise<SubmittedReview> {
      void pull;
      throw Object.assign(new Error('Unprocessable Entity: line must be part of the diff'), { status: 422 });
    }
  }
  const api = new RejectingApi();
  api.seedPullRequest({ number: 8, author: HUMAN });

  const out = failure(
    await reviewToolModule.call(
      'create_review',
      { number: 8, event: 'COMMENT', body: 'b', comments: [{ path: 'a.rs', line: 9999, body: 'x' }] },
      ctx(api),
    ),
  );
  assert.equal(out, 'create_review failed: GitHub error 422: Unprocessable Entity: line must be part of the diff');
});

test('a successful review result bounds the html_url it echoes', async () => {
  class LongUrlApi extends FakeGitHubApi {
    override async createReview(pull: ThreadRef, input: CreateReviewInput): Promise<SubmittedReview> {
      const review = await super.createReview(pull, input);
      return { ...review, html_url: `https://github.com/${'u'.repeat(100_000)}` };
    }
  }
  const api = new LongUrlApi();
  api.seedPullRequest({ number: 8, author: HUMAN });
  const result = await reviewToolModule.call('create_review', { number: 8, event: 'COMMENT', body: 'b' }, ctx(api));
  const text = JSON.stringify(result);
  assert.ok(text.length < 2_000, `result is ${text.length} chars`);
});
