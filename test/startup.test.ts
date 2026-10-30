import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { GitHubAdapter } from '../src/github-adapter.js';
import { readConfig, silentLogger } from '../src/types.js';

const repos = Array.from({ length: 114 }, (_, i) => ({ owner: 'owner', name: `repo${i}` }));

function tokenFile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-startup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'token');
  writeFileSync(file, 'synthetic-startup-token', { mode: 0o600 });
  return file;
}

// Hold real Octokit fetches until the test explicitly answers them. No sleeps
// are needed to force completion order or to prove the concurrency ceiling.
function rig(t: TestContext, sleep?: (ms: number) => Promise<void>) {
  const pending = new Map<number, { answer: (response: Response) => void; signal: AbortSignal }>();
  const started: number[] = [];
  const aborted: number[] = [];
  const warnings: string[] = [];
  let active = 0;
  let peak = 0;
  const adapter = new GitHubAdapter(readConfig({
    GITHUB_TOKEN_FILE: tokenFile(t),
    GITHUB_REPOS: 'owner/repo0',
  }), {
    logger: { ...silentLogger(), warn: (message) => warnings.push(message) },
    sleep,
    fetch: async (input, init) => {
      const index = Number(new URL(String(input)).pathname.match(/repo(\d+)$/)![1]);
      const signal = init!.signal!;
      signal.throwIfAborted();
      started.push(index);
      peak = Math.max(peak, ++active);
      try {
        return await new Promise<Response>((resolve, reject) => {
          const abort = () => { aborted.push(index); reject(signal.reason); };
          signal.addEventListener('abort', abort, { once: true });
          pending.set(index, {
            answer: (response) => { signal.removeEventListener('abort', abort); resolve(response); },
            signal,
          });
        });
      } finally {
        active--;
        pending.delete(index);
      }
    },
  });
  return { adapter, pending, started, aborted, warnings, peak: () => peak };
}

function success(index: number): Response {
  return Response.json({ full_name: `owner/repo${index}` });
}

for (const count of [0, 3, 114]) {
  test(`repository verification bounds concurrency at eight for ${count} entries`, { timeout: 5000 }, async (t) => {
    const r = rig(t);
    const result = r.adapter.repoSpellingProblems(repos.slice(0, count));
    await setImmediate();
    assert.equal(r.pending.size, Math.min(count, 8));
    while (r.pending.size) {
      assert.ok(r.pending.size <= 8);
      for (const [index, request] of r.pending) request.answer(success(index));
      await setImmediate();
    }
    assert.deepEqual(await result, []);
    assert.deepEqual(r.started, Array.from({ length: count }, (_, i) => i));
    assert.equal(r.peak(), Math.min(count, 8));
    assert.deepEqual(r.aborted, []);
  });
}

for (const failure of ['404', 'mismatch'] as const) {
  for (const earlierFails of [false, true]) {
    test(`${failure}: stop later checks, await earlier checks, report first failure (earlier fails: ${earlierFails})`, { timeout: 5000 }, async (t) => {
      const r = rig(t);
      let settled = false;
      const result = r.adapter.repoSpellingProblems(repos).then((problems) => { settled = true; return problems; });
      await setImmediate();
      const fail = (index: number) => r.pending.get(index)!.answer(failure === '404'
        ? Response.json({ message: 'Not Found' }, { status: 404 })
        : Response.json({ full_name: `Owner/repo${index}` }));
      fail(4);
      await setImmediate();
      assert.deepEqual(r.aborted, [5, 6, 7]);
      assert.equal(settled, false, 'must not return before earlier entries settle');
      if (earlierFails) {
        fail(1);
        await setImmediate();
        assert.deepEqual(r.aborted, [5, 6, 7, 2, 3]);
      }
      for (const [index, request] of r.pending) request.answer(success(index));
      const index = earlierFails ? 1 : 4;
      assert.deepEqual(await result, [failure === '404'
        ? `GITHUB_REPOS names "owner/repo${index}", which the token in GITHUB_TOKEN_FILE can't see (GitHub answered 404: Not Found)`
        : `GITHUB_REPOS names "owner/repo${index}", but GitHub spells it "Owner/repo${index}": set it to "Owner/repo${index}", spelled exactly so`]);
      assert.deepEqual(r.started, [0, 1, 2, 3, 4, 5, 6, 7], 'no new checks after a fatal result');
      assert.equal(r.pending.size, 0);
      assert.deepEqual(r.warnings, [], 'cancelled checks must not produce transient-failure warnings');
    });
  }
}

test('a later check in rate-limit backoff does not retry after a fatal failure', { timeout: 5000 }, async (t) => {
  let resume!: () => void;
  const delays: number[] = [];
  const r = rig(t, (ms) => {
    delays.push(ms);
    return new Promise<void>((resolve) => { resume = resolve; });
  });
  const result = r.adapter.repoSpellingProblems(repos);
  await setImmediate();
  r.pending.get(7)!.answer(Response.json({ message: 'secondary rate limit' }, {
    status: 403, headers: { 'retry-after': '1' },
  }));
  await setImmediate();
  assert.deepEqual(delays, [1000], 'retain the existing Retry-After backoff');
  r.pending.get(0)!.answer(Response.json({ message: 'Not Found' }, { status: 404 }));
  await setImmediate();
  resume();
  assert.deepEqual(await result, [
    'GITHUB_REPOS names "owner/repo0", which the token in GITHUB_TOKEN_FILE can\'t see (GitHub answered 404: Not Found)',
  ]);
  assert.deepEqual(r.started, [0, 1, 2, 3, 4, 5, 6, 7], 'neither queued requests nor a cancelled retry reach GitHub');
  assert.deepEqual(r.warnings, ['github rate limited; one retry']);
});

async function runCli(t: TestContext, failure?: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  initializeMs: number | null;
  stats: { started: number; completed: number; aborted: number; active: number; peak: number };
}> {
  const started = performance.now();
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--import', fileURLToPath(new URL('./fixtures/startup-fetch.mjs', import.meta.url)),
    fileURLToPath(new URL('../src/index.ts', import.meta.url)), '--stdio',
  ], {
    // Do not inherit any real credentials or GitHub configuration.
    env: {
      PATH: process.env.PATH,
      GITHUB_TOKEN_FILE: tokenFile(t),
      GITHUB_REPOS: repos.map((repo) => `${repo.owner}/${repo.name}`).join(','),
      ...(failure ? { TEST_STARTUP_FAILURE: failure } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  let initializeMs: number | null = null;
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (initializeMs === null && stdout.includes('\n')) {
      initializeMs = performance.now() - started;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.kill('SIGTERM');
    }
  });
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: {} } }, clientInfo: { name: 'startup-test', version: '1' } },
  }) + '\n');
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const stats = JSON.parse(stderr.match(/STARTUP_FETCH (.+)/)![1]);
  return { code, stdout, stderr, initializeMs, stats };
}

test('CLI answers initialize in <10s with 114 repositories at 300ms per request', { timeout: 15000 }, async (t) => {
  const r = await runCli(t);
  assert.equal(r.code, 0, r.stderr);
  const response = JSON.parse(r.stdout.trim());
  assert.equal(response.id, 1);
  assert.ok(response.result.capabilities.experimental.mcpl);
  assert.deepEqual(r.stats, { started: 114, completed: 114, aborted: 0, active: 0, peak: 8 });
  assert.ok(r.initializeMs !== null && r.initializeMs < 10000, `initialize took ${r.initializeMs}ms`);
  t.diagnostic(`Node ${process.version}: initialize ${r.initializeMs!.toFixed(1)}ms, 114 repository requests at 300ms, peak ${r.stats.peak}`);
});

for (const failure of ['404', 'mismatch']) {
  test(`CLI fails closed on ${failure} with other checks in flight; never answers initialize`, { timeout: 5000 }, async (t) => {
    const r = await runCli(t, failure);
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.initializeMs, null);
    assert.match(r.stderr, failure === '404'
      ? /GITHUB_REPOS names "owner\/repo1", which the token in GITHUB_TOKEN_FILE can't see \(GitHub answered 404: Not Found\)/
      : /GITHUB_REPOS names "owner\/repo1", but GitHub spells it "Owner\/repo1"/);
    assert.doesNotMatch(r.stderr, /GITHUB_REPOS names "owner\/repo4"|github-mcpl starting|polling notifications|unchecked/);
    assert.deepEqual(r.stats, { started: 8, completed: 3, aborted: 5, active: 0, peak: 8 });
  });
}
