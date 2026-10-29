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
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
