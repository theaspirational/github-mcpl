import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { issuesToolModule, prToolModule, requireAllowedBase } from '../src/tools-issues-pr.js';
import { ToolRefusal } from '../src/tool-support.js';
import {
  ISSUES_FEATURE_SET,
  LIMITS,
  PR_FEATURE_SET,
  silentLogger,
  type PullRequest,
  type StateStore,
  type ThreadRef,
  type ToolContext,
  type ToolResult,
  type UpdatePullRequestInput,
} from '../src/types.js';
import { FakeGitHubApi, TEST_BOT, TEST_REPO } from './harness.js';

const NO_CHECKPOINT_STORE = undefined as unknown as StateStore;

function ctx(api: FakeGitHubApi, over: Partial<ToolContext> = {}): ToolContext {
  return {
    api,
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

const ISSUE: ThreadRef = { repo: TEST_REPO, number: 7, kind: 'issue' };
const PULL: ThreadRef = { repo: TEST_REPO, number: 8, kind: 'pull' };

test('the two modules declare their feature sets and no merge tool exists', () => {
  assert.equal(issuesToolModule.featureSet, ISSUES_FEATURE_SET);
  assert.equal(prToolModule.featureSet, PR_FEATURE_SET);
  const names = [...issuesToolModule.tools, ...prToolModule.tools].map((t) => t.name);
  assert.deepEqual(names, [
    'create_issue',
    'edit_issue',
    'close_issue',
    'reopen_issue',
    'create_pull_request',
    'edit_pull_request',
    'request_review',
  ]);
  assert.ok(!names.some((n) => /merge|delete_branch/.test(n)));
});

test('create_issue opens an issue in the default repository', async () => {
  const api = new FakeGitHubApi();
  const out = ok(
    await issuesToolModule.call('create_issue', { title: 'Flake in CI', body: 'reproduces on dev' }, ctx(api)),
  );
  assert.match(out, /issue anima-research\/rayforce#\d+ \[open\] Flake in CI/);
  assert.match(out, /reproduces on dev/);
  assert.deepEqual(api.callsTo('createIssue')[0].args, [TEST_REPO, { title: 'Flake in CI', body: 'reproduces on dev' }]);
});

test('create_issue needs a title', async () => {
  const api = new FakeGitHubApi();
  const out = failure(await issuesToolModule.call('create_issue', { body: 'no title' }, ctx(api)));
  assert.match(out, /create_issue: "title" is required/);
  assert.equal(api.calls.length, 0);
});

test('edit_issue changes the fields it was given and nothing else', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7, title: 'old', body: 'keep me' });

  const out = ok(await issuesToolModule.call('edit_issue', { number: 7, title: 'new' }, ctx(api)));
  assert.match(out, /\[open\] new/);
  assert.match(out, /keep me/);
  assert.deepEqual(api.callsTo('updateIssue')[0].args, [ISSUE, { title: 'new', body: undefined }]);
});

test('edit_issue refuses an edit that changes nothing', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7 });
  const out = failure(await issuesToolModule.call('edit_issue', { number: 7 }, ctx(api)));
  assert.match(out, /one of "title" or "body" is required/);
  assert.equal(api.calls.length, 0);
});

test('close_issue closes with a reason', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7 });

  const out = ok(await issuesToolModule.call('close_issue', { number: 7, reason: 'not_planned' }, ctx(api)));
  assert.match(out, /issue anima-research\/rayforce#7 \[closed \(not_planned\)\]/);
  assert.deepEqual(api.callLog(), ['updateIssue']);
  assert.deepEqual(api.callsTo('updateIssue')[0].args, [ISSUE, { state: 'closed', stateReason: 'not_planned' }]);
});

test('close_issue posts its optional comment before closing', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7 });

  ok(
    await issuesToolModule.call(
      'close_issue',
      { number: 7, reason: 'completed', comment: 'fixed in #8' },
      ctx(api),
    ),
  );
  assert.deepEqual(api.callLog(), ['createComment', 'updateIssue']);
  assert.deepEqual(api.callsTo('createComment')[0].args, [ISSUE, 'fixed in #8']);
});

test('close_issue needs a reason from the contract’s two', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7 });
  assert.match(
    failure(await issuesToolModule.call('close_issue', { number: 7 }, ctx(api))),
    /"reason" must be one of completed \| not_planned/,
  );
  assert.match(
    failure(await issuesToolModule.call('close_issue', { number: 7, reason: 'duplicate' }, ctx(api))),
    /"reason" must be one of completed \| not_planned, got "duplicate"/,
  );
  assert.equal(api.calls.length, 0);
});

test('reopen_issue reopens with the reopened state reason', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7, state: 'closed', stateReason: 'completed' });

  const out = ok(await issuesToolModule.call('reopen_issue', { number: 7 }, ctx(api)));
  assert.match(out, /\[open \(reopened\)\]/);
  assert.deepEqual(api.callsTo('updateIssue')[0].args, [ISSUE, { state: 'open', stateReason: 'reopened' }]);
});

test('an issue write outside GITHUB_REPOS is refused by name, before any call', async () => {
  const api = new FakeGitHubApi();
  const out = failure(
    await issuesToolModule.call('create_issue', { repo: 'someone-else/not-ours', title: 'hi' }, ctx(api)),
  );
  assert.match(out, /create_issue refused: repository someone-else\/not-ours is not in GITHUB_REPOS/);
  assert.match(out, /allowed: anima-research\/rayforce/);
  assert.equal(api.calls.length, 0);
});

test('a GitHub error from an issue write carries its status', async () => {
  class LockedApi extends FakeGitHubApi {
    override async updateIssue(ref: ThreadRef): Promise<never> {
      void ref;
      throw Object.assign(new Error('Issue is locked'), { status: 403 });
    }
  }
  const api = new LockedApi();
  api.seedIssue({ number: 7 });
  const out = failure(await issuesToolModule.call('reopen_issue', { number: 7 }, ctx(api)));
  assert.equal(out, 'reopen_issue failed: GitHub error 403: Issue is locked');
});

test('create_pull_request opens a pull request against an allowed base', async () => {
  const api = new FakeGitHubApi();
  const out = ok(
    await prToolModule.call(
      'create_pull_request',
      { head: 'fix-flake', base: 'dev', title: 'Fix the flake', body: 'why', draft: true },
      ctx(api),
    ),
  );
  assert.match(out, /pull anima-research\/rayforce#\d+ \[open, draft\] Fix the flake/);
  assert.deepEqual(api.callsTo('createPullRequest')[0].args, [
    TEST_REPO,
    { head: 'fix-flake', base: 'dev', title: 'Fix the flake', body: 'why', draft: true },
  ]);
});

test('create_pull_request refuses a base outside GITHUB_PR_BASE_ALLOW', async () => {
  const api = new FakeGitHubApi();
  const out = failure(
    await prToolModule.call(
      'create_pull_request',
      { head: 'fix-flake', base: 'main', title: 'Fix the flake' },
      ctx(api),
    ),
  );
  assert.match(out, /create_pull_request refused: base branch "main" is not in GITHUB_PR_BASE_ALLOW/);
  assert.match(out, /allowed on anima-research\/rayforce: dev/);
  assert.equal(api.calls.length, 0, 'nothing reached the API');
});

test('an empty GITHUB_PR_BASE_ALLOW means no pull request may be opened', async () => {
  const api = new FakeGitHubApi();
  const out = failure(
    await prToolModule.call(
      'create_pull_request',
      { head: 'fix-flake', base: 'dev', title: 'Fix the flake' },
      ctx(api, { prBaseAllow: [] }),
    ),
  );
  assert.match(out, /GITHUB_PR_BASE_ALLOW allows no branch on anima-research\/rayforce, so none may be targeted/);
  assert.equal(api.calls.length, 0);
});

test('edit_pull_request refuses a retarget outside GITHUB_PR_BASE_ALLOW', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, base: { ref: 'dev', sha: 'b'.repeat(40) } });

  const out = failure(await prToolModule.call('edit_pull_request', { number: 8, base: 'main' }, ctx(api)));
  assert.match(out, /edit_pull_request refused: base branch "main" is not in GITHUB_PR_BASE_ALLOW/);
  assert.equal(api.calls.length, 0);
  assert.equal((await api.getPullRequest({ repo: TEST_REPO, number: 8, kind: 'pull' })).base.ref, 'dev');
});

test('edit_pull_request accepts an allowed base and the other fields', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, base: { ref: 'other', sha: 'b'.repeat(40) } });

  const out = ok(
    await prToolModule.call(
      'edit_pull_request',
      { number: 8, title: 'retitled', body: 'rewritten', base: 'dev', draft: false },
      ctx(api),
    ),
  );
  assert.match(out, /\[open\] retitled/);
  assert.match(out, /→ dev/);
  const input = api.callsTo('updatePullRequest')[0].args[1] as UpdatePullRequestInput;
  assert.deepEqual(input, { title: 'retitled', body: 'rewritten', base: 'dev', draft: false });
});

test('edit_pull_request refuses an edit that changes nothing', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8 });
  const out = failure(await prToolModule.call('edit_pull_request', { number: 8 }, ctx(api)));
  assert.match(out, /one of "title", "body", "base" or "draft" is required/);
  assert.equal(api.calls.length, 0);
});

test('a pull-request write outside GITHUB_REPOS is refused before the base check', async () => {
  const api = new FakeGitHubApi();
  const out = failure(
    await prToolModule.call(
      'create_pull_request',
      { repo: 'someone-else/not-ours', head: 'h', base: 'dev', title: 't' },
      ctx(api),
    ),
  );
  assert.match(out, /refused: repository someone-else\/not-ours is not in GITHUB_REPOS/);
  assert.equal(api.calls.length, 0);
});

test('request_review requests exactly the logins given', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8 });

  const out = ok(
    await prToolModule.call('request_review', { number: 8, logins: ['human-one', 'human-two'] }, ctx(api)),
  );
  assert.equal(out, 'requested a review from human-one, human-two on anima-research/rayforce#8');
  assert.deepEqual(api.callsTo('requestReviewers')[0].args, [PULL, ['human-one', 'human-two']]);
});

test('request_review rejects an empty or non-string login list', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8 });
  assert.match(
    failure(await prToolModule.call('request_review', { number: 8, logins: [] }, ctx(api))),
    /"logins" must be a non-empty array of strings/,
  );
  assert.match(
    failure(await prToolModule.call('request_review', { number: 8, logins: ['ok', 7] }, ctx(api))),
    /"logins\[1\]" must be a non-empty string/,
  );
  assert.equal(api.calls.length, 0);
});

test('with several repositories, the base allow-list is read per repository', async () => {
  const api = new FakeGitHubApi();
  const second = { owner: TEST_REPO.owner, name: 'chronicle' };
  const two = ctx(api, {
    repos: [TEST_REPO, second],
    prBaseAllow: ['anima-research/rayforce:dev', 'main'],
  });
  const create = (repo: string, base: string) =>
    prToolModule.call('create_pull_request', { repo, head: 'fix', base, title: 'Fix' }, two);

  ok(await create('anima-research/rayforce', 'dev'));
  ok(await create('anima-research/rayforce', 'main'));
  ok(await create('anima-research/chronicle', 'main'));
  const refused = failure(await create('anima-research/chronicle', 'dev'));
  assert.match(refused, /base branch "dev" is not in GITHUB_PR_BASE_ALLOW \(allowed on anima-research\/chronicle: main\)/);
  assert.equal(api.callsTo('createPullRequest').length, 3);

  const missing = failure(
    await prToolModule.call('create_pull_request', { head: 'fix', base: 'main', title: 'Fix' }, two),
  );
  assert.match(missing, /"repo" is required: GITHUB_REPOS names several repositories/);
  assert.equal(api.callsTo('createPullRequest').length, 3);
});

test('requireAllowedBase is the single gate, and it throws a refusal', () => {
  const api = new FakeGitHubApi();
  assert.equal(requireAllowedBase('dev', TEST_REPO, ctx(api)), 'dev');
  assert.throws(() => requireAllowedBase('main', TEST_REPO, ctx(api)), (err: unknown) => {
    assert.ok(err instanceof ToolRefusal);
    assert.match((err as Error).message, /not in GITHUB_PR_BASE_ALLOW/);
    return true;
  });
});

test('a GitHub error from a pull-request write carries its status', async () => {
  class ValidationApi extends FakeGitHubApi {
    override async updatePullRequest(pull: ThreadRef): Promise<PullRequest> {
      void pull;
      throw Object.assign(new Error('Validation Failed'), { status: 422 });
    }
  }
  const api = new ValidationApi();
  api.seedPullRequest({ number: 8 });
  const out = failure(await prToolModule.call('edit_pull_request', { number: 8, title: 'x' }, ctx(api)));
  assert.equal(out, 'edit_pull_request failed: GitHub error 422: Validation Failed');
});


test('a refused base branch is echoed bounded', async () => {
  const api = new FakeGitHubApi();
  const out = failure(
    await prToolModule.call(
      'create_pull_request',
      { head: 'h', base: 'b'.repeat(100_000), title: 't' },
      ctx(api),
    ),
  );
  assert.match(out, /refused: base branch "b+… \[truncated \d+ chars\]" is not in GITHUB_PR_BASE_ALLOW/);
  assert.ok(out.length < 400, `the refusal stayed bounded (${out.length} chars)`);
  assert.equal(api.calls.length, 0);
});

test('request_review bounds the logins it confirms, in count and in length', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8 });
  const logins = Array.from({ length: LIMITS.listEntries + 4 }, (_, i) => `reviewer-${i}${'z'.repeat(500)}`);

  const out = ok(await prToolModule.call('request_review', { number: 8, logins }, ctx(api)));
  assert.match(out, new RegExp(`… 4 more not shown \\(list bound ${LIMITS.listEntries}\\)`));
  assert.ok(!out.includes('reviewer-50'), 'the 51st login is not echoed');
  assert.ok(out.length < LIMITS.listEntries * (LIMITS.titleChars + 2) + 200, `confirmation is ${out.length} chars`);
  assert.deepEqual(api.callsTo('requestReviewers')[0].args, [PULL, logins]);
});

test('every number argument is advertised as a positive integer', () => {
  for (const tool of [...issuesToolModule.tools, ...prToolModule.tools]) {
    const number = tool.inputSchema.properties.number as Record<string, unknown> | undefined;
    if (!number) continue;
    assert.equal(number.type, 'integer', `${tool.name}.number`);
    assert.equal(number.minimum, 1, `${tool.name}.number`);
  }
});
