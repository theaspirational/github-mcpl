/**
 * Contributor mode: config validation and the multi-owner write allow-list
 * (anima-research/github-mcpl#5).
 *
 * The auth-header and notifications-ingress behaviour are covered where the
 * rest of the adapter and the poller already are: githubAdapter.test.ts and
 * notifications-poller.test.ts. This file is `readConfig`'s two modes and
 * the one tool-level consequence of "GITHUB_REPOS may span several owners in
 * this mode" — a write still has to name one of them.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { McplConnection } from '@animalabs/mcpl-core';
import { GitHubAdapter } from '../src/github-adapter.js';
import { GitHubMcplServer } from '../src/server.js';
import { mergeToolModule } from '../src/tools-merge.js';
import { actionsToolModule } from '../src/tools-actions.js';
import { commentsToolModule } from '../src/tools-comments.js';
import {
  ConfigError,
  MIN_POLL_INTERVAL_MS,
  TOOL_COMMENT,
  readConfig,
  silentLogger,
  type Env,
  type Logger,
  type RepoRef,
  type ToolContext,
  type ToolResult,
} from '../src/types.js';
import { FakeGitHubApi, TEST_REPO } from './harness.js';
import { GithubState } from '../src/state.js';

function tmpFile(name: string, contents: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-contrib-'));
  const file = join(dir, name);
  writeFileSync(file, contents, { mode });
  // The umask narrows a mode given at creation; chmod sets it as asked.
  chmodSync(file, mode);
  return file;
}

function problemsOf(env: Env): string[] {
  try {
    readConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
  assert.fail('expected a ConfigError');
}

// ─────────────────────────────────────────────────────────────────────────────
// Mode selection
// ─────────────────────────────────────────────────────────────────────────────

test('GITHUB_TOKEN_FILE alone selects contributor mode', () => {
  const tokenFile = tmpFile('token', 'ghp_fake_token_for_tests\n');
  const config = readConfig({
    GITHUB_TOKEN_FILE: tokenFile,
    GITHUB_REPOS: 'anima-research/rayforce',
    GITHUB_BOT_LOGIN: 'a-human',
  });
  assert.equal(config.authMode, 'token');
  assert.equal(config.userToken, 'ghp_fake_token_for_tests');
  assert.equal(config.appId, '');
  assert.equal(config.privateKeyPem, null);
  assert.equal(config.webhookPort, null);
  // The poller is always on in this mode, at the floor, when unset.
  assert.equal(config.pollIntervalMs, MIN_POLL_INTERVAL_MS);
});

test('contributor mode may leave GITHUB_BOT_LOGIN unset, for startup to take from the token; App mode may not', () => {
  const tokenFile = tmpFile('token', 'ghp_fake_token_for_tests\n');
  const config = readConfig({ GITHUB_TOKEN_FILE: tokenFile, GITHUB_REPOS: 'anima-research/rayforce' });
  assert.equal(config.authMode, 'token');
  assert.equal(config.botLogin, '');
  const keyFile = tmpFile('key.pem', 'not a key');
  assert.ok(
    problemsOf({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY_FILE: keyFile, GITHUB_REPOS: 'anima-research/rayforce' }).some((p) =>
      p.startsWith('GITHUB_BOT_LOGIN: required'),
    ),
  );
});

test('a token file that an editor began with a byte-order mark or a blank line still gives the bare token', () => {
  const tokenFile = tmpFile('token', '\uFEFF\n  ghp_fake_token_for_tests\n');
  const config = readConfig({ GITHUB_TOKEN_FILE: tokenFile, GITHUB_REPOS: 'anima-research/rayforce', GITHUB_BOT_LOGIN: 'a-human' });
  assert.equal(config.userToken, 'ghp_fake_token_for_tests');
});

test('GITHUB_APP_INSTALLATION_ID beside GITHUB_TOKEN_FILE is refused rather than ignored', () => {
  const tokenFile = tmpFile('token', 'ghp_fake_token_for_tests\n');
  const problems = problemsOf({
    GITHUB_TOKEN_FILE: tokenFile,
    GITHUB_APP_INSTALLATION_ID: '42',
    GITHUB_REPOS: 'anima-research/rayforce',
    GITHUB_BOT_LOGIN: 'a-human',
  });
  assert.deepEqual(problems.map((p) => p.split(':')[0]), ['GITHUB_APP_INSTALLATION_ID']);
});

test('neither GITHUB_APP_ID/KEY nor GITHUB_TOKEN_FILE names the same App-mode problems as before', () => {
  assert.deepEqual(
    problemsOf({ GITHUB_REPOS: 'rayforce', GITHUB_WEBHOOK_PORT: '0' })
      .map((p) => p.split(':')[0])
      .sort(),
    ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_BOT_LOGIN', 'GITHUB_REPOS', 'GITHUB_WEBHOOK_PORT'],
  );
});

test('both an App key and a token is refused as ambiguous, by name, and nothing else', () => {
  const pem = tmpFile('app.pem', 'NOT-A-REAL-KEY placeholder for tests\n');
  const tokenFile = tmpFile('token', 'ghp_fake_token_for_tests\n');
  const problems = problemsOf({
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY_FILE: pem,
    GITHUB_TOKEN_FILE: tokenFile,
    GITHUB_REPOS: 'anima-research/rayforce',
    GITHUB_BOT_LOGIN: 'a-human',
  });
  assert.equal(problems.length, 1, `expected exactly one problem, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /^GITHUB_TOKEN_FILE: set together with/);
  // Either App variable alone beside the token is just as ambiguous.
  for (const appVariable of [{ GITHUB_APP_ID: '12345' }, { GITHUB_APP_PRIVATE_KEY_FILE: pem }]) {
    const alone = problemsOf({ ...appVariable, GITHUB_TOKEN_FILE: tokenFile, GITHUB_REPOS: 'anima-research/rayforce', GITHUB_BOT_LOGIN: 'a-human' });
    assert.ok(alone.some((p) => /^GITHUB_TOKEN_FILE: set together with/.test(p)), `${Object.keys(appVariable)[0]}: ${JSON.stringify(alone)}`);
  }
});

test('GITHUB_TOKEN_FILE is read as a secret file: required, mode 600, non-empty', () => {
  assert.match(
    problemsOf({ GITHUB_REPOS: 'anima-research/rayforce', GITHUB_BOT_LOGIN: 'a-human', GITHUB_TOKEN_FILE: '' })
      .filter((p) => p.startsWith('GITHUB_APP_ID'))
      .join(''),
    /required/,
    'an empty GITHUB_TOKEN_FILE falls through to the App-mode checks, same as an unset one',
  );

  const worldReadable = tmpFile('token', 'ghp_fake\n', 0o644);
  assert.match(
    problemsOf({
      GITHUB_TOKEN_FILE: worldReadable,
      GITHUB_REPOS: 'anima-research/rayforce',
      GITHUB_BOT_LOGIN: 'a-human',
    })[0],
    /GITHUB_TOKEN_FILE: .* mode 64\d; it holds secret material and must be 600/,
  );

  const empty = tmpFile('token', '');
  assert.match(
    problemsOf({ GITHUB_TOKEN_FILE: empty, GITHUB_REPOS: 'anima-research/rayforce', GITHUB_BOT_LOGIN: 'a-human' })[0],
    /GITHUB_TOKEN_FILE: .* is empty/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Ingress in contributor mode
// ─────────────────────────────────────────────────────────────────────────────

test('GITHUB_WEBHOOK_PORT is refused in contributor mode, with a clear reason', () => {
  const tokenFile = tmpFile('token', 'ghp_fake\n');
  const problems = problemsOf({
    GITHUB_TOKEN_FILE: tokenFile,
    GITHUB_REPOS: 'anima-research/rayforce',
    GITHUB_BOT_LOGIN: 'a-human',
    GITHUB_WEBHOOK_PORT: '9042',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^GITHUB_WEBHOOK_PORT: not supported in contributor mode/);
});

test('GITHUB_POLL_INTERVAL_MS defaults to the floor in contributor mode and is never allowed below it', () => {
  const tokenFile = tmpFile('token', 'ghp_fake\n');
  const base = { GITHUB_TOKEN_FILE: tokenFile, GITHUB_REPOS: 'anima-research/rayforce', GITHUB_BOT_LOGIN: 'a-human' };

  assert.equal(readConfig(base).pollIntervalMs, MIN_POLL_INTERVAL_MS);
  assert.equal(readConfig({ ...base, GITHUB_POLL_INTERVAL_MS: '120000' }).pollIntervalMs, 120000);
  assert.match(
    problemsOf({ ...base, GITHUB_POLL_INTERVAL_MS: '1000' })[0],
    /GITHUB_POLL_INTERVAL_MS: must be at least 60000 ms in contributor mode/,
  );
  // 0 ("off" in App mode) is not a way to turn the notifications poller off.
  assert.match(problemsOf({ ...base, GITHUB_POLL_INTERVAL_MS: '0' })[0], /must be at least 60000 ms/);
});

// ─────────────────────────────────────────────────────────────────────────────
// GITHUB_REPOS: several owners in contributor mode, one owner still in App mode
// ─────────────────────────────────────────────────────────────────────────────

test('contributor mode accepts GITHUB_REPOS spanning several owners; App mode still refuses it', () => {
  const tokenFile = tmpFile('token', 'ghp_fake\n');
  const config = readConfig({
    GITHUB_TOKEN_FILE: tokenFile,
    GITHUB_REPOS: 'anima-research/rayforce,other-org/thing',
    GITHUB_BOT_LOGIN: 'a-human',
  });
  assert.deepEqual(config.repos, [TEST_REPO, { owner: 'other-org', name: 'thing' }]);

  const pem = tmpFile('app.pem', 'NOT-A-REAL-KEY placeholder for tests\n');
  assert.match(
    problemsOf({
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY_FILE: pem,
      GITHUB_REPOS: 'anima-research/rayforce,other-org/thing',
      GITHUB_BOT_LOGIN: 'rayforce-clone[bot]',
    })[0],
    /must share one owner/,
  );
});

test('a write still has to name one of the several owners GITHUB_REPOS allows in contributor mode', async () => {
  const allowed: RepoRef[] = [TEST_REPO, { owner: 'other-org', name: 'thing' }];
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7 });
  const otherIssue = { repo: allowed[1], number: 3, kind: 'issue' as const };
  // Seed the second owner's repo too, so a permitted write there has something to act on.
  api.seedIssue({ repo: allowed[1], number: 3 });

  const logger: Logger = silentLogger();
  const ctx: ToolContext = { api, state: GithubState.empty(), botLogin: 'a-human', repos: allowed, prBaseAllow: [], logger };

  const text = (r: ToolResult): string => r.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

  const inFirstOwner = await commentsToolModule.call(
    TOOL_COMMENT,
    { thread: { owner: TEST_REPO.owner, name: TEST_REPO.name, number: 7 }, body: 'hi' },
    ctx,
  );
  assert.equal(inFirstOwner.isError, undefined);

  const inSecondOwner = await commentsToolModule.call(
    TOOL_COMMENT,
    { thread: { owner: otherIssue.repo.owner, name: otherIssue.repo.name, number: 3 }, body: 'hi' },
    ctx,
  );
  assert.equal(inSecondOwner.isError, undefined);

  const outsideBoth = await commentsToolModule.call(
    TOOL_COMMENT,
    { thread: { owner: 'someone-else', name: 'not-allowed', number: 1 }, body: 'hi' },
    ctx,
  );
  assert.equal(outsideBoth.isError, true);
  assert.match(text(outsideBoth), /not in GITHUB_REPOS/);
});


test('token-file privacy checks the symlink target mode, not symlink provenance', () => {
  const target = tmpFile('token', 'synthetic-token-only\n');
  const link = join(mkdtempSync(join(tmpdir(), 'github-mcpl-token-link-')), 'link');
  symlinkSync(target, link);
  const env = { GITHUB_TOKEN_FILE: link, GITHUB_REPOS: 'anima-research/rayforce' };
  assert.equal(readConfig(env).userToken, 'synthetic-token-only');
  chmodSync(target, 0o640);
  const problems = problemsOf(env);
  assert.ok(problems.some((problem) => problem.includes('must be 600')));
  assert.ok(problems.every((problem) => !problem.includes('synthetic-token-only')));
});


test('multi-owner contributor allow-lists: unscoped writes reach both repositories; scopes isolate either direction', async () => {
  const repos = [{ owner: 'my-login', name: 'my-fork' }, { owner: 'third-party', name: 'upstream' }];
  const tokenFile = tmpFile('token', 'synthetic-scope-token');
  for (const scope of [undefined, ...repos.map((repo) => `${repo.owner}/${repo.name}`)]) {
    const cfg = readConfig({
      GITHUB_TOKEN_FILE: tokenFile,
      GITHUB_REPOS: repos.map((repo) => `${repo.owner}/${repo.name}`).join(','),
      GITHUB_MERGE_BASE_ALLOW: scope ? `${scope}:main` : 'main',
      GITHUB_WORKFLOW_ALLOW: scope ? `${scope}:review.yml` : 'review.yml',
    }, silentLogger());
    const api = new FakeGitHubApi();
    const ctx: ToolContext = {
      api, state: GithubState.empty(), botLogin: 'my-login', repos: cfg.repos,
      prBaseAllow: [], mergeBaseAllow: cfg.mergeBaseAllow, workflowAllow: cfg.workflowAllow,
      logger: silentLogger(),
    };
    for (const repo of repos) {
      const slug = `${repo.owner}/${repo.name}`;
      const head = 'a'.repeat(40);
      api.seedPullRequest({ repo, number: 12, base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feature', sha: head } });
      api.clearCalls();
      const merge = await mergeToolModule.call('merge_pull_request', { repo: slug, number: 12, sha: head }, ctx);
      const dispatch = await actionsToolModule.call('dispatch_workflow', { repo: slug, workflow: 'review.yml', ref: 'main' }, ctx);
      const allowed = scope === undefined || scope === slug;
      for (const result of [merge, dispatch]) assert.equal(result.isError, allowed ? undefined : true, `${scope ?? 'unscoped'} -> ${slug}`);
      assert.equal(api.callsTo('mergePullRequest').length, allowed ? 1 : 0);
      assert.equal(api.callsTo('dispatchWorkflow').length, allowed ? 1 : 0);
    }
  }
});

test('multi-owner unscoped merge/workflow config warns per variable without refusing or narrowing', () => {
  const base = { GITHUB_TOKEN_FILE: tmpFile('token', 'synthetic-warning-token'), GITHUB_REPOS: 'mine/fork,upstream/project' };
  for (const variable of ['GITHUB_MERGE_BASE_ALLOW', 'GITHUB_WORKFLOW_ALLOW'] as const) {
    const warnings: string[] = [];
    const cfg = readConfig({ ...base, [variable]: variable === 'GITHUB_MERGE_BASE_ALLOW' ? 'main,mine/fork:dev' : 'review.yml,mine/fork:ci.yml' }, {
      ...silentLogger(), warn: (message) => warnings.push(message),
    });
    assert.equal(cfg.authMode, 'token');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(variable));
    assert.match(warnings[0], /every repository in GITHUB_REPOS/);
    assert.match(warnings[0], /third-party upstreams/);
    assert.match(warnings[0], /owner\/name:value/);
    assert.ok(!warnings[0].includes('synthetic-warning-token'));
    assert.deepEqual(variable === 'GITHUB_MERGE_BASE_ALLOW' ? cfg.mergeBaseAllow : cfg.workflowAllow,
      variable === 'GITHUB_MERGE_BASE_ALLOW' ? ['main', 'mine/fork:dev'] : ['review.yml', 'mine/fork:ci.yml']);
  }
  for (const env of [
    base,
    { ...base, GITHUB_MERGE_BASE_ALLOW: 'mine/fork:main', GITHUB_WORKFLOW_ALLOW: 'upstream/project:review.yml' },
    { ...base, GITHUB_REPOS: 'mine/fork,mine/other', GITHUB_MERGE_BASE_ALLOW: 'main', GITHUB_WORKFLOW_ALLOW: 'review.yml' },
    { ...base, GITHUB_REPOS: 'mine/fork,MINE/other', GITHUB_MERGE_BASE_ALLOW: 'main' },
  ]) {
    const warnings: string[] = [];
    readConfig(env, { ...silentLogger(), warn: (message) => warnings.push(message) });
    assert.deepEqual(warnings, [], 'empty/scoped lists and a single owner do not warn');
  }
});

test('readConfig default startup warnings go only to stderr and name both broad write lists', () => {
  const env = {
    GITHUB_TOKEN_FILE: tmpFile('token', 'synthetic-stderr-token'), GITHUB_REPOS: 'mine/fork,upstream/project',
    GITHUB_MERGE_BASE_ALLOW: 'main', GITHUB_WORKFLOW_ALLOW: 'review.yml',
  };
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { readConfig } from './src/types.ts'; readConfig(${JSON.stringify(env)});`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr.trim().split('\n').length, 2);
  assert.match(child.stderr, /warn GITHUB_MERGE_BASE_ALLOW:/);
  assert.match(child.stderr, /warn GITHUB_WORKFLOW_ALLOW:/);
  assert.ok(!child.stderr.includes('synthetic-stderr-token'));
});


test('contributor merge and Actions traverse host grants, server tools/call and user-token transport', async (t) => {
  const token = 'synthetic-server-contributor-token';
  const cfg = readConfig({
    GITHUB_TOKEN_FILE: tmpFile('token', token), GITHUB_BOT_LOGIN: 'a-human',
    GITHUB_REPOS: 'mine/fork', GITHUB_MERGE_BASE_ALLOW: 'mine/fork:main',
    GITHUB_WORKFLOW_ALLOW: 'mine/fork:review.yml',
  });
  assert.equal(cfg.authMode, 'token');
  const head = 'a'.repeat(40);
  const calls: Request[] = [];
  const bodies: unknown[] = [];
  const api = new GitHubAdapter(cfg, {
    baseUrl: 'https://synthetic.invalid', logger: silentLogger(),
    // No global fetch: every request is answered here, and unexpected routes fail.
    fetch: async (input, init) => {
      const req = new Request(input, init);
      calls.push(req);
      assert.equal(req.headers.get('authorization'), `token ${token}`);
      const route = `${req.method} ${new URL(req.url).pathname}`;
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      switch (route) {
        case 'GET /repos/mine/fork':
          return json({ full_name: 'mine/fork', default_branch: 'main' });
        case 'GET /repos/mine/fork/pulls/12':
          return json({ number: 12, state: 'open', draft: false, merged: false,
            head: { ref: 'feature', sha: head, repo: { owner: { login: 'mine' }, name: 'fork' } },
            base: { ref: 'main', sha: 'b'.repeat(40) }, user: { login: 'a-human', type: 'User' } });
        case `GET /repos/mine/fork/commits/${head}/check-runs`:
          return json({ total_count: 0, check_runs: [] });
        case 'PUT /repos/mine/fork/pulls/12/merge':
          bodies.push(await req.json());
          return json({ merged: true, sha: head, message: 'Merged' });
        case 'POST /repos/mine/fork/actions/workflows/review.yml/dispatches':
          bodies.push(await req.json());
          return new Response(null, { status: 204 });
        default:
          assert.fail(`unexpected request (including any App-token path): ${route}`);
      }
    },
  });
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const host = McplConnection.fromStreams(toHost, toServer);
  const server = new GitHubMcplServer(api, {
    botLogin: cfg.botLogin, repos: cfg.repos, prBaseAllow: cfg.prBaseAllow,
    mergeBaseAllow: cfg.mergeBaseAllow, workflowAllow: cfg.workflowAllow, logger: silentLogger(),
  });
  server.register(mergeToolModule);
  server.register(actionsToolModule);
  const served = server.serve(McplConnection.fromStreams(toServer, toHost));
  t.after(async () => { toServer.end(); await served; host.close(); });
  await host.sendRequest('initialize', {
    protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } },
    clientInfo: { name: 'synthetic-contributor-host', version: '0' },
  });
  host.sendNotification('notifications/initialized');
  const invoke = (name: string, args: Record<string, unknown>) =>
    host.sendRequest('tools/call', { name, arguments: args }) as Promise<ToolResult>;
  const operations = [
    ['merge_pull_request', { number: 12, sha: head }],
    ['dispatch_workflow', { workflow: 'review.yml', ref: 'main' }],
  ] as const;
  for (const [name, args] of operations) {
    await assert.rejects(invoke(name, args), (err: { code?: number }) => err.code === -32002);
  }
  assert.equal(calls.length, 0, 'no transport before the host grants tools');
  await host.sendRequest('featureSets/update', { effectiveCapabilities: ['tools'] });
  assert.equal(server.grant.isFeatureSetActive('github.merge'), true);
  assert.equal(server.grant.isFeatureSetActive('github.actions'), true);
  for (const [name, args] of operations) {
    const out = await invoke(name, args);
    assert.equal(out.isError, undefined, JSON.stringify(out));
    assert.ok(!JSON.stringify(out).includes(token));
  }
  assert.deepEqual(bodies, [{ merge_method: 'merge', sha: head }, { ref: 'main', inputs: {} }]);
  assert.ok(calls.every((req) => !new URL(req.url).pathname.includes('/app')));
  const beforeRevocation = calls.length;
  await host.sendRequest('featureSets/update', { effectiveCapabilities: [] });
  for (const [name, args] of operations) {
    await assert.rejects(invoke(name, args), (err: { code?: number }) => err.code === -32002);
  }
  assert.equal(calls.length, beforeRevocation, 'revoked grants stop both tools before transport');
});
