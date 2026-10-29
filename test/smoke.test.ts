/**
 * Skeleton smoke test (TASK-SRHKG.1.1).
 *
 * Proves the three things the work packages .2 to .8 start from: the harness
 * builds the server over a stream pair and tears it down, FakeGitHubApi
 * answers a read and records the call, and readConfig rejects a bad
 * environment by variable name without leaking a secret.
 */

import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CORE_TAGS,
  ConfigError,
  FEATURE_SETS,
  GITHUB_API_METHODS,
  GITHUB_TAGS,
  LIMITS,
  TOOLS_BY_FEATURE_SET,
  channelId,
  bounded,
  channelLabel,
  featureSetForTool,
  parseChannelId,
  parseRepoSlug,
  parseThreadId,
  allowedBases,
  readConfig,
  repoAllowed,
  reviewSummaryThreadId,
  reviewThreadId,
  type Env,
  type ThreadRef,
} from '../src/types.js';
import { FakeGitHubApi, TEST_REPO, harness } from './harness.js';

const ISSUE: ThreadRef = { repo: TEST_REPO, number: 7, kind: 'issue' };

test('the harness constructs the server and closes cleanly', async () => {
  // `tools: false` is the bare server of .1: no module registered, so the
  // tool surface is empty and only the grant's deny-by-default is on show.
  const h = harness({ tools: false });
  assert.equal(h.server.api, h.api);
  assert.deepEqual(h.server.toolModules(), []);
  // Deny-by-default: no grant-bearing featureSets/update has arrived (§5.3).
  assert.equal(h.server.grant.isReady(), false);
  assert.equal(h.server.grant.has('tools'), false);
  assert.equal(h.server.grant.toolAllowed('get_issue'), false);
  await h.close();
  await h.served;
});

test('FakeGitHubApi answers a read and records the call', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7, title: 'checks are red on dev', body: 'the nightly build fails' });

  const issue = await api.getIssue(ISSUE);
  assert.equal(issue.number, 7);
  assert.equal(issue.title, 'checks are red on dev');
  assert.deepEqual(api.callLog(), ['getIssue']);
  assert.deepEqual(api.callsTo('getIssue')[0].args, [ISSUE]);
});

test('FakeGitHubApi implements every GitHubApi method', () => {
  const api = new FakeGitHubApi();
  for (const name of GITHUB_API_METHODS) {
    assert.equal(typeof api[name], 'function', `${name} is not implemented`);
  }
});

test('FakeGitHubApi round-trips a write and logs it', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7 });
  const created = await api.createComment(ISSUE, 'hello from the bot');
  const comments = await api.listComments(ISSUE);
  assert.deepEqual(
    comments.map((c) => c.id),
    [created.id],
  );
  assert.equal(comments[0].author.login, api.bot.login);
  assert.deepEqual(api.callLog(), ['createComment', 'listComments']);
});

test('FakeGitHubApi replies in a review thread and resolves it', async () => {
  const api = new FakeGitHubApi();
  const pull = { repo: TEST_REPO, number: 12, kind: 'pull' as const };
  api.seedPullRequest({ number: 12 });
  const thread = api.seedReviewThread(pull, { comments: [{ id: 555, author: { login: 'human-one', isBot: false }, body: 'why?', createdAt: '2026-10-01T00:00:00.000Z' }] });

  await api.replyToReviewComment(pull, 555, 'because of the base ref');
  await api.resolveReviewThread(thread.id);

  const threads = await api.listReviewThreads(pull);
  assert.equal(threads[0].comments.length, 2);
  assert.equal(threads[0].isResolved, true);
  assert.deepEqual(api.callLog(), ['replyToReviewComment', 'resolveReviewThread', 'listReviewThreads']);
});

test('FakeGitHubApi reports check runs and answers since-polls', async () => {
  const api = new FakeGitHubApi();
  api.seedCheckRuns(TEST_REPO, {
    sha: 'abc',
    conclusion: 'failure',
    total: 3,
    failed: [{ name: 'test (ubuntu)', url: 'https://github.com/checks/1' }],
  });
  const checks = await api.getCheckRuns(TEST_REPO, 'abc');
  assert.equal(checks.conclusion, 'failure');
  assert.deepEqual(checks.failed.map((f) => f.name), ['test (ubuntu)']);

  const old = api.seedIssue({ updatedAt: '2026-10-01T00:00:00.000Z' });
  const fresh = api.seedPullRequest({ updatedAt: '2026-10-02T00:00:00.000Z' });
  const comment = await api.createComment({ repo: TEST_REPO, number: old.number, kind: 'issue' }, 'late comment');
  const since = '2026-10-01T12:00:00.000Z';
  const { rows: issues } = await api.listIssuesSince(TEST_REPO, since);
  assert.deepEqual(issues.map((i) => [i.number, i.isPullRequest]), [[fresh.number, true]]);
  assert.equal(issues[0].headSha, fresh.head.sha);
  const { rows: comments } = await api.listIssueCommentsSince(TEST_REPO, since);
  assert.deepEqual(comments.map((c) => [c.id, c.number]), [[comment.id, old.number]]);
  assert.deepEqual((await api.listReviewCommentsSince(TEST_REPO, since)).rows, []);
  assert.deepEqual((await api.listIssuesSince({ owner: 'other', name: 'repo' }, since)).rows, []);

  // An old review comment edited after the cursor is polled (reviewer finding).
  api.seedReviewThread({ repo: TEST_REPO, number: fresh.number, kind: 'pull' }, {
    comments: [{ id: 555, author: { login: 'human', isBot: false }, body: 'before', createdAt: '2026-10-01T00:00:00.000Z' }],
  });
  assert.deepEqual((await api.listReviewCommentsSince(TEST_REPO, since)).rows, []);
  await api.updateComment(TEST_REPO, 555, 'after', true);
  const { rows: polledReview } = await api.listReviewCommentsSince(TEST_REPO, since);
  assert.deepEqual(polledReview.map((c) => [c.id, c.number, c.body]), [[555, fresh.number, 'after']]);
});

test('readConfig rejects a missing GITHUB_REPOS by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-'));
  const pem = join(dir, 'app.pem');
  // Obviously fake placeholder; no key material anywhere in this repo.
  writeFileSync(pem, 'NOT-A-REAL-KEY placeholder for tests\n', { mode: 0o600 });

  const env: Env = {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY_FILE: pem,
    GITHUB_BOT_LOGIN: 'rayforce-clone[bot]',
  };

  assert.throws(
    () => readConfig(env),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.problems.length, 1);
      assert.match(err.problems[0], /^GITHUB_REPOS: required/);
      // No secret value, ever — not even the placeholder's contents.
      assert.ok(!err.message.includes('NOT-A-REAL-KEY'));
      return true;
    },
  );
});

test('readConfig validates a whole environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-'));
  const pem = join(dir, 'app.pem');
  const secret = join(dir, 'webhook.secret');
  writeFileSync(pem, 'NOT-A-REAL-KEY placeholder for tests\n', { mode: 0o600 });
  writeFileSync(secret, 'not-a-real-webhook-secret\n', { mode: 0o600 });

  const config = readConfig({
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY_FILE: pem,
    GITHUB_WEBHOOK_SECRET_FILE: secret,
    GITHUB_WEBHOOK_PORT: '8443',
    GITHUB_POLL_INTERVAL_MS: '60000',
    GITHUB_REPOS: 'anima-research/rayforce',
    GITHUB_PR_BASE_ALLOW: 'dev',
    GITHUB_BOT_LOGIN: 'rayforce-clone[bot]',
    GITHUB_MAINTAINERS: 'human-one, human-two',
  });

  assert.deepEqual(config.repos, [TEST_REPO]);
  assert.equal(config.webhookPath, '/github/webhook');
  assert.equal(config.webhookPort, 8443);
  assert.equal(config.pollIntervalMs, 60000);
  assert.deepEqual(config.prBaseAllow, ['dev']);
  assert.deepEqual(config.maintainers, ['human-one', 'human-two']);
  assert.equal(config.installationId, null);
  // Both files were written with a trailing "\n", as `jq -r` writes them.
  assert.equal(config.webhookSecret, 'not-a-real-webhook-secret');
  assert.equal(config.privateKeyPem, 'NOT-A-REAL-KEY placeholder for tests');
  assert.equal(config.stateFile, null);
  assert.ok(config.privateKeyPem.includes('placeholder'));
});

test('readConfig ignores the webhook secret file while the listener is off', () => {
  // The env example names the secret file; a polling install leaves it empty
  // (the Linux rehearsal of 2026-10-15 stopped here).
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-'));
  const pem = join(dir, 'app.pem');
  const secret = join(dir, 'webhook.secret');
  writeFileSync(pem, 'NOT-A-REAL-KEY placeholder for tests\n', { mode: 0o600 });
  writeFileSync(secret, '', { mode: 0o600 });

  const config = readConfig({
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY_FILE: pem,
    GITHUB_WEBHOOK_SECRET_FILE: secret,
    GITHUB_POLL_INTERVAL_MS: '60000',
    GITHUB_REPOS: 'anima-research/rayforce',
    GITHUB_BOT_LOGIN: 'rayforce-clone[bot]',
  });
  assert.equal(config.webhookPort, null);
  assert.equal(config.webhookSecret, null);

  // With the listener on, the same empty file is still a startup failure.
  assert.throws(
    () => readConfig({
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY_FILE: pem,
      GITHUB_WEBHOOK_SECRET_FILE: secret,
      GITHUB_WEBHOOK_PORT: '8443',
      GITHUB_REPOS: 'anima-research/rayforce',
      GITHUB_BOT_LOGIN: 'rayforce-clone[bot]',
    }),
    (err: unknown) => err instanceof ConfigError && /GITHUB_WEBHOOK_SECRET_FILE: .* is empty/.test(err.message),
  );
});

test('readConfig accepts several repositories of one owner, and a per-repository base allow-list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-'));
  const pem = join(dir, 'app.pem');
  writeFileSync(pem, 'NOT-A-REAL-KEY placeholder for tests\n', { mode: 0o600 });
  const base = {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY_FILE: pem,
    GITHUB_BOT_LOGIN: 'rayforce-clone[bot]',
  };

  const config = readConfig({
    ...base,
    GITHUB_REPOS: 'anima-research/rayforce, anima-research/chronicle',
    GITHUB_PR_BASE_ALLOW: 'anima-research/rayforce:dev,main',
  });
  assert.deepEqual(config.repos, [TEST_REPO, { owner: 'anima-research', name: 'chronicle' }]);
  assert.deepEqual(allowedBases(TEST_REPO, config.prBaseAllow), ['dev', 'main']);
  assert.deepEqual(allowedBases({ owner: 'anima-research', name: 'chronicle' }, config.prBaseAllow), ['main']);

  const problems = (env: Record<string, string>): string[] => {
    try {
      readConfig({ ...base, ...env });
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      return err.problems;
    }
    assert.fail('expected a ConfigError');
  };
  // One owner is one App installation and one token; a second owner is a second process.
  assert.match(problems({ GITHUB_REPOS: 'anima-research/rayforce,other-org/thing' })[0], /must share one owner/);
  assert.match(problems({ GITHUB_REPOS: 'anima-research/rayforce,anima-research/rayforce' })[0], /listed twice/);
  // A scoped entry has to name a repository the server serves, so a typo is a startup error.
  assert.match(
    problems({ GITHUB_REPOS: 'anima-research/rayforce', GITHUB_PR_BASE_ALLOW: 'anima-research/chronicle:main' })[0],
    /names a repository outside GITHUB_REPOS/,
  );
  assert.match(problems({ GITHUB_REPOS: 'anima-research/rayforce', GITHUB_PR_BASE_ALLOW: 'rayforce:' })[0], /neither a branch nor/);
});

test('readConfig names every problem at once', () => {
  assert.throws(
    () => readConfig({ GITHUB_REPOS: 'rayforce', GITHUB_WEBHOOK_PORT: '0' }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      const named = err.problems.map((p) => p.split(':')[0]).sort();
      assert.deepEqual(named, [
        'GITHUB_APP_ID',
        'GITHUB_APP_PRIVATE_KEY_FILE',
        'GITHUB_BOT_LOGIN',
        'GITHUB_REPOS',
        'GITHUB_WEBHOOK_PORT',
      ]);
      return true;
    },
  );
});

test('readConfig refuses a secret file readable by anyone else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-'));
  const pem = join(dir, 'app.pem');
  writeFileSync(pem, 'NOT-A-REAL-KEY placeholder for tests\n', { mode: 0o644 });
  // The umask narrows a mode given at creation (a 077 umask makes this 600); chmod sets it as asked.
  chmodSync(pem, 0o644);

  assert.throws(
    () =>
      readConfig({
        GITHUB_APP_ID: '12345',
        GITHUB_APP_PRIVATE_KEY_FILE: pem,
        GITHUB_REPOS: 'anima-research/rayforce',
        GITHUB_BOT_LOGIN: 'rayforce-clone[bot]',
      }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.problems[0], /GITHUB_APP_PRIVATE_KEY_FILE: .* mode 644/);
      return true;
    },
  );
});

test('channel and thread ids round-trip', () => {
  assert.equal(channelId(ISSUE), 'github:anima-research/rayforce#7');
  assert.deepEqual(parseChannelId('github:anima-research/rayforce#7'), { repo: TEST_REPO, number: 7 });
  assert.equal(parseChannelId('slack:C1'), null);
  assert.equal(parseChannelId('github:rayforce#7'), null);

  assert.equal(channelLabel(ISSUE, 'a short title'), 'anima-research/rayforce#7: a short title');
  const long = 'x'.repeat(200);
  const prefix = 'anima-research/rayforce#7: ';
  const label = channelLabel(ISSUE, long);
  assert.ok(label.startsWith(`${prefix}xxxx`));
  assert.ok(label.includes('[truncated'));
  assert.equal(label.length, prefix.length + LIMITS.titleChars);
  for (const n of [81, 99, 1000, 123456]) assert.ok(bounded('y'.repeat(n), 80).length <= 80, `bounded(${n})`);
  assert.equal(bounded('short', 80), 'short');

  assert.equal(reviewThreadId(555), 'rt:555');
  assert.equal(reviewSummaryThreadId(42), 'review:42');
  assert.deepEqual(parseThreadId('rt:555'), { kind: 'review-thread', rootCommentId: 555 });
  assert.deepEqual(parseThreadId('review:42'), { kind: 'review-summary', reviewId: 42 });
  assert.equal(parseThreadId(undefined), null);
  assert.equal(parseThreadId('nonsense'), null);
});

test('the repo allow-list and its parsing', () => {
  assert.deepEqual(parseRepoSlug('anima-research/rayforce'), TEST_REPO);
  assert.equal(parseRepoSlug('rayforce'), null);
  assert.equal(repoAllowed(TEST_REPO, [TEST_REPO]), true);
  assert.equal(repoAllowed({ owner: 'other', name: 'repo' }, [TEST_REPO]), false);
});

test('every tool belongs to exactly one feature set', () => {
  const seen = new Set<string>();
  for (const [featureSet, tools] of Object.entries(TOOLS_BY_FEATURE_SET)) {
    assert.ok(FEATURE_SETS.includes(featureSet as (typeof FEATURE_SETS)[number]));
    for (const tool of tools) {
      assert.equal(seen.has(tool), false, `${tool} is claimed twice`);
      seen.add(tool);
      assert.equal(featureSetForTool(tool), featureSet);
    }
  }
  assert.equal(seen.size, 22);
  assert.equal(featureSetForTool('merge_pull_request'), undefined);
});

test('the tag vocabulary is the contract\'s', () => {
  assert.ok(CORE_TAGS.includes('chat:from-self'));
  assert.ok(GITHUB_TAGS.includes('github:ci=failure'));
  assert.equal(new Set(GITHUB_TAGS).size, GITHUB_TAGS.length);
  for (const tag of GITHUB_TAGS) assert.match(tag, /^github:[a-z-]+(=[a-z_]+)?$/);
});
