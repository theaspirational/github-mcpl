/**
 * Webhook listener (TASK-SRHKG.1.3): the order of the checks is the test.
 *
 * Every case below but the dedup ring's goes through a real `node:http` server
 * on a loopback port and a real `fetch`, because the properties under test — "rejected before
 * parsing", "2xx returned before the event is processed", "one stderr line" —
 * are properties of the request path and not of a function.
 */

import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { DELIVERY_DEDUP_RING, DeliveryRing, MAX_BODY_BYTES, WebhookListener, webhookListenerFromConfig } from '../src/webhook.js';
import { CheckGate } from '../src/normalize.js';
import { Poller, type IngressState } from '../src/poller.js';
import type { ChecksSummary, Config, Logger, NormalizedEvent, RepoRef } from '../src/types.js';
import { FakeGitHubApi, TEST_REPO, until } from './harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Not a credential: a literal only this test file knows, to sign with. */
const SECRET = 'test-webhook-signing-material-0123456789';
const HEAD = '4d7b2e8c1a93f05627de4b1c8a0f3927e5c6d418';

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** A Logger that keeps every line, so a test can assert on what was logged. */
interface CapturedLogger extends Logger {
  lines: string[];
  text(): string;
}

function capturingLogger(): CapturedLogger {
  const lines: string[] = [];
  const write =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      lines.push(`${level} ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`);
    };
  return {
    lines,
    text: () => lines.join('\n'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}

interface Rig {
  listener: WebhookListener;
  url: string;
  events: NormalizedEvent[];
  log: CapturedLogger;
  post(body: string, headers?: Record<string, string>): Promise<Response>;
  /** Sign `body` with the right secret and POST it as delivery `id`. */
  deliver(event: string, body: string, id?: string): Promise<Response>;
}

interface RigOptions {
  repos?: readonly RepoRef[];
  api?: FakeGitHubApi;
  path?: string;
  maxBodyBytes?: number;
  onEvent?: (event: NormalizedEvent) => void | Promise<void>;
  checkGate?: CheckGate;
  /** A seeded fake is the usual way; this is for scripting call-by-call. */
  getCheckRuns?: (repo: RepoRef, sha: string, call: number) => Promise<ChecksSummary>;
}

async function rig(t: TestContext, opts: RigOptions = {}): Promise<Rig> {
  const events: NormalizedEvent[] = [];
  const log = capturingLogger();
  const path = opts.path ?? '/github/webhook';
  let checkCalls = 0;
  const api = opts.getCheckRuns
    ? { getCheckRuns: (repo: RepoRef, sha: string) => (opts.getCheckRuns as NonNullable<typeof opts.getCheckRuns>)(repo, sha, ++checkCalls) }
    : opts.api;
  const listener = new WebhookListener({
    secret: SECRET,
    path,
    repos: opts.repos ?? [TEST_REPO],
    logger: log,
    api,
    maxBodyBytes: opts.maxBodyBytes,
    checkGate: opts.checkGate,
    onEvent: async (event) => {
      events.push(event);
      await opts.onEvent?.(event);
    },
  });
  const port = await listener.listen(0);
  t.after(() => listener.close());
  const url = `http://127.0.0.1:${port}${path}`;

  const post = (body: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

  let n = 0;
  const deliver = (event: string, body: string, id = `d-${++n}`): Promise<Response> =>
    post(body, {
      'x-github-event': event,
      'x-github-delivery': id,
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    });

  return { listener, url, events, log, post, deliver };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signature
// ─────────────────────────────────────────────────────────────────────────────

test('a correctly signed delivery is accepted and normalized', async (t) => {
  const r = await rig(t);
  const res = await r.deliver('issues', fixture('issues.opened.json'), 'delivery-aaa');
  assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);
  await r.listener.whenIdle();
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, 'issue.opened');
  assert.equal(r.events[0].id, 'delivery-aaa');
  assert.deepEqual(r.events[0].thread, { repo: TEST_REPO, number: 41, kind: 'issue' });
});

test('a forged signature is rejected with 401 before the body is parsed', async (t) => {
  const r = await rig(t);
  const body = fixture('issues.opened.json');

  // Signed with the wrong secret.
  const forged = createHmac('sha256', 'not-the-secret').update(body).digest('hex');
  const res = await r.post(body, {
    'x-github-event': 'issues',
    'x-github-delivery': 'forged-1',
    'x-hub-signature-256': `sha256=${forged}`,
  });
  assert.equal(res.status, 401);

  // A body that is not JSON at all, forged the same way: still 401 and never
  // a parse error, which is what "rejected before parsing" means on the wire.
  const junk = '}{ not json';
  const res2 = await r.post(junk, {
    'x-github-event': 'issues',
    'x-github-delivery': 'forged-2',
    'x-hub-signature-256': `sha256=${createHmac('sha256', 'not-the-secret').update(junk).digest('hex')}`,
  });
  assert.equal(res2.status, 401);

  await r.listener.whenIdle();
  assert.deepEqual(r.events, []);
  // Nothing interpreted the body: no normalization and no parse diagnostic.
  assert.equal(r.log.text().includes('not JSON'), false, r.log.text());
  assert.equal(r.log.lines.filter((l) => l.includes('did not verify')).length, 2);
  // A rejected delivery must not be able to write to the dedup gate.
  assert.equal(r.listener.rememberedDeliveries, 0);
});

test('a missing, misprefixed or short signature header is rejected', async (t) => {
  const r = await rig(t);
  const body = fixture('push.json');
  const good = createHmac('sha256', SECRET).update(body).digest('hex');
  const base = { 'x-github-event': 'push', 'x-github-delivery': 'd' };
  for (const header of [
    undefined,
    'sha1=da39a3ee5e6b4b0d3255bfef95601890afd80709',
    `sha256=${good.slice(0, 32)}`,
    'sha256=',
    `${good}`,
    `sha256=${'z'.repeat(64)}`,
  ]) {
    const res = await r.post(body, header === undefined ? base : { ...base, 'x-hub-signature-256': header });
    assert.equal(res.status, 401, `header ${String(header)} must be refused`);
  }
  await r.listener.whenIdle();
  assert.deepEqual(r.events, []);
});

test('a signed delivery with no delivery id or no event name is a 400', async (t) => {
  const r = await rig(t);
  const body = fixture('push.json');
  const sig = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  assert.equal(
    (await r.post(body, { 'x-hub-signature-256': sig, 'x-github-event': 'push' })).status,
    400,
  );
  assert.equal(
    (await r.post(body, { 'x-hub-signature-256': sig, 'x-github-delivery': 'd' })).status,
    400,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Replay
// ─────────────────────────────────────────────────────────────────────────────

test('a replayed delivery id is dropped and the event is emitted once', async (t) => {
  const r = await rig(t);
  const body = fixture('issue_comment.created.json');
  const first = await r.deliver('issue_comment', body, 'replay-me');
  const second = await r.deliver('issue_comment', body, 'replay-me');
  assert.ok(first.status >= 200 && first.status < 300);
  // A replay is not an error: GitHub must not be told to retry.
  assert.ok(second.status >= 200 && second.status < 300);
  await r.listener.whenIdle();
  assert.equal(r.events.length, 1);
  assert.equal(r.log.lines.filter((l) => l.includes('replay')).length, 1, r.log.text());
  assert.equal(r.listener.rememberedDeliveries, 1);
  assert.equal(r.listener.dedupCapacity, 2000);
});

test('the dedup ring remembers 2000 ids and then forgets the oldest', () => {
  const ring = new DeliveryRing(DELIVERY_DEDUP_RING);
  for (let i = 0; i < 2000; i++) assert.equal(ring.add(`gate-${i}`), false, `gate-${i} is new`);
  assert.equal(ring.size, 2000);
  assert.equal(ring.add('gate-0'), true, 'still remembered at the capacity boundary');

  for (let i = 2000; i < 2002; i++) assert.equal(ring.add(`gate-${i}`), false, `gate-${i} is new`);
  assert.equal(ring.size, 2000);
  assert.equal(ring.add('gate-0'), false, 'two more ids than the ring holds have evicted gate-0, replayed or not');
  assert.equal(ring.add('gate-1'), false, 'and gate-1');
});

// ─────────────────────────────────────────────────────────────────────────────
// Allow-list
// ─────────────────────────────────────────────────────────────────────────────

test('a delivery for a repository outside GITHUB_REPOS is dropped with one line', async (t) => {
  const r = await rig(t);
  const res = await r.deliver('issues', fixture('issues.opened.foreign_repo.json'), 'foreign-1');
  assert.ok(res.status >= 200 && res.status < 300);
  await r.listener.whenIdle();
  assert.deepEqual(r.events, []);
  const dropped = r.log.lines.filter((l) => l.includes('outside GITHUB_REPOS'));
  assert.equal(dropped.length, 1, r.log.text());
  assert.ok(dropped[0].includes('other-org/other-repo'), dropped[0]);
  // The allow-listed repo still goes through on the same listener.
  await r.deliver('issues', fixture('issues.opened.json'), 'local-1');
  await r.listener.whenIdle();
  assert.equal(r.events.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ping, routing, body cap
// ─────────────────────────────────────────────────────────────────────────────

test('ping is answered and emits nothing', async (t) => {
  const r = await rig(t);
  const res = await r.deliver('ping', fixture('ping.json'), 'ping-1');
  assert.equal(res.status, 200);
  assert.equal((await res.text()).trim(), 'pong');
  await r.listener.whenIdle();
  assert.deepEqual(r.events, []);
});

test('a GET, or a POST to another path, is refused without reading a body', async (t) => {
  const r = await rig(t, { path: '/hooks/gh' });
  assert.equal((await fetch(r.url)).status, 405);
  assert.equal((await fetch(`http://${new URL(r.url).host}/elsewhere`, { method: 'POST', body: '{}' })).status, 404);
  // The configured path with a query string still routes.
  assert.equal((await fetch(`${r.url}?x=1`, { method: 'POST', body: '{}' })).status, 401);
});

test('a body over the 1 MiB cap is refused with 413 and never signature-checked', async (t) => {
  const r = await rig(t, { maxBodyBytes: 4096 });
  const big = 'x'.repeat(8192);
  const res = await r.post(big, {
    'x-github-event': 'push',
    'x-github-delivery': 'big-1',
    'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(big).digest('hex')}`,
  });
  assert.equal(res.status, 413);
  await r.listener.whenIdle();
  assert.deepEqual(r.events, []);
  assert.equal(r.listener.rememberedDeliveries, 0);
  assert.ok(r.log.text().includes('over the cap'), r.log.text());
});

test('the production cap is the contract 1 MiB', () => {
  assert.equal(MAX_BODY_BYTES, 1024 * 1024);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ordering and enrichment
// ─────────────────────────────────────────────────────────────────────────────

test('2xx is returned before the listener has finished with the event', async (t) => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let listenerEntered = false;
  let listenerDone = false;
  const r = await rig(t, {
    onEvent: async () => {
      listenerEntered = true;
      await held;
      listenerDone = true;
    },
  });

  const res = await r.deliver('issues', fixture('issues.opened.json'), 'slow-1');
  assert.ok(res.status >= 200 && res.status < 300);
  await until(() => listenerEntered, 'the listener to be entered');
  // The response was already complete while the listener is still working.
  assert.equal(listenerDone, false);
  release?.();
  await r.listener.whenIdle();
  assert.equal(listenerDone, true);
});

test('a listener that throws does not take the server down', async (t) => {
  const r = await rig(t, {
    onEvent: () => {
      throw new Error('recipe blew up');
    },
  });
  assert.ok((await r.deliver('issues', fixture('issues.opened.json'), 'boom-1')).status < 300);
  await r.listener.whenIdle();
  assert.ok(r.log.text().includes('processing failed'), r.log.text());
  // The next delivery is still served.
  assert.ok((await r.deliver('ping', fixture('ping.json'), 'after-boom')).status === 200);
});

test('a check_suite delivery reaches the listener with the failed job names', async (t) => {
  const api = new FakeGitHubApi();
  api.seedCheckRuns(TEST_REPO, {
    sha: HEAD,
    conclusion: 'failure',
    total: 2,
    failed: [{ name: 'clippy', url: 'https://github.com/anima-research/rayforce/runs/2700001235' }],
  });
  const r = await rig(t, { api });
  await r.deliver('check_suite', fixture('check_suite.completed.json'), 'suite-1');
  await r.listener.whenIdle();
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, 'checks.completed');
  assert.equal(r.events[0].sha, HEAD);
  assert.deepEqual(r.events[0].checks?.failed, [
    { name: 'clippy', url: 'https://github.com/anima-research/rayforce/runs/2700001235' },
  ]);
});

test('a signed body that is not JSON is dropped after the signature passed', async (t) => {
  const r = await rig(t);
  const res = await r.deliver('issues', '}{ not json', 'junk-1');
  assert.ok(res.status >= 200 && res.status < 300);
  await r.listener.whenIdle();
  assert.deepEqual(r.events, []);
  assert.ok(r.log.text().includes('not JSON'), r.log.text());
});

// ─────────────────────────────────────────────────────────────────────────────
// No secret anywhere
// ─────────────────────────────────────────────────────────────────────────────

test('neither a log line nor a response body ever carries the webhook secret', async (t) => {
  const r = await rig(t);
  const bodies: string[] = [];
  const body = fixture('issues.opened.json');
  const sig = createHmac('sha256', SECRET).update(body).digest('hex');

  bodies.push(await (await r.deliver('issues', body, 'ok-1')).text());
  bodies.push(await (await r.deliver('issues', body, 'ok-1')).text());
  bodies.push(await (await r.post(body, { 'x-github-event': 'issues', 'x-github-delivery': 'bad-1', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) })).text());
  bodies.push(await (await r.post(body, { 'x-github-event': 'issues', 'x-github-delivery': 'no-sig' })).text());
  bodies.push(await (await r.deliver('issues', fixture('issues.opened.foreign_repo.json'), 'foreign-2')).text());
  bodies.push(await (await r.deliver('ping', fixture('ping.json'), 'ping-2')).text());
  bodies.push(await (await fetch(r.url)).text());
  await r.listener.whenIdle();

  const everything = [r.log.text(), ...bodies].join('\n');
  assert.equal(everything.includes(SECRET), false, 'the secret appeared in output');
  // Nor the valid HMAC of a body, which would let a replay be re-signed.
  assert.equal(everything.includes(sig), false, 'a computed signature appeared in output');
  assert.ok(r.log.lines.length > 0, 'the listener did log something');
});

// ─────────────────────────────────────────────────────────────────────────────
// Config wiring
// ─────────────────────────────────────────────────────────────────────────────

function config(overrides: Partial<Config> = {}): Config {
  return {
    authMode: 'app',
    appId: '12345',
    privateKeyPem: '(not a key)',
    installationId: null,
    userToken: null,
    webhookSecret: SECRET,
    webhookPort: 8081,
    webhookPath: '/github/webhook',
    pollIntervalMs: 0,
    repos: [TEST_REPO],
    prBaseAllow: ['dev'],
    stateFile: null,
    botLogin: 'rayforce-clone[bot]',
    maintainers: [],
    ...overrides,
  };
}

test('webhookListenerFromConfig builds a listener, or null when the port is absent', () => {
  const onEvent = (): void => {};
  assert.ok(webhookListenerFromConfig(config(), { onEvent }) instanceof WebhookListener);
  assert.equal(webhookListenerFromConfig(config({ webhookPort: null }), { onEvent }), null);
  // Defensive: readConfig guarantees a secret with a port, but a null secret
  // must never produce a listener that would accept anything.
  assert.equal(webhookListenerFromConfig(config({ webhookSecret: null }), { onEvent }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// One checks.completed per head sha (§Ingress)
// ─────────────────────────────────────────────────────────────────────────────

test('two completed suites on one head sha produce one checks event', async (t) => {
  const r = await rig(t);
  // Different suite ids, different delivery ids, same PR head. The delivery
  // gate cannot collapse these; the sha gate has to.
  await r.deliver('check_suite', fixture('check_suite.completed.json'), 'suite-a');
  await r.deliver('check_suite', fixture('check_suite.completed.second_suite.json'), 'suite-b');
  await r.listener.whenIdle();

  assert.equal(r.events.length, 1, 'one event per head sha');
  assert.equal(r.events[0].sha, HEAD);
  assert.equal(r.events[0].checks?.conclusion, 'failure');
  assert.ok(r.log.text().includes('already reported this result'), r.log.text());
  // Both deliveries were still accepted on the wire.
  assert.equal(r.listener.rememberedDeliveries, 2);
});

test('a check_run and a check_suite delivery for one sha produce one checks event', async (t) => {
  const api = new FakeGitHubApi();
  // The realistic path: both deliveries look the sha up and get the same
  // settled answer, so the second is not news.
  api.seedCheckRuns(TEST_REPO, {
    sha: HEAD,
    conclusion: 'failure',
    total: 2,
    failed: [{ name: 'test (ubuntu-latest)', url: 'https://github.com/anima-research/rayforce/runs/2700001234' }],
  });
  const r = await rig(t, { api });
  await r.deliver('check_suite', fixture('check_suite.completed.json'), 'suite-c');
  await r.deliver('check_run', fixture('check_run.completed.json'), 'run-c');
  await r.listener.whenIdle();
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].sha, HEAD);
  assert.deepEqual(r.events[0].checks?.failed.map((f) => f.name), ['test (ubuntu-latest)']);
});

test('without an API to ask, a delivery that names a failed job supersedes one that names none', async (t) => {
  // No `api`, so nothing can be enriched: the suite payload reports a failure
  // with no job names and the run payload names the job that failed. The
  // longer list is better information, so it is allowed through — the same
  // rule that lets a second failing suite's jobs reach the listener.
  const r = await rig(t);
  await r.deliver('check_suite', fixture('check_suite.completed.json'), 'suite-d');
  await r.deliver('check_run', fixture('check_run.completed.json'), 'run-d');
  await r.listener.whenIdle();
  assert.deepEqual(
    r.events.map((e) => e.checks?.failed.length),
    [0, 1],
  );
  // And the shorter list afterwards is not news again.
  await r.deliver('check_suite', fixture('check_suite.completed.json'), 'suite-e');
  await r.listener.whenIdle();
  assert.equal(r.events.length, 2);
});

test('a sha that turns red after it was green is reported again, once', async (t) => {
  const r = await rig(t);
  await r.deliver('check_suite', fixture('check_suite.completed.second_suite.json'), 'green-1');
  await r.deliver('check_suite', fixture('check_suite.completed.json'), 'red-1');
  // A third delivery of the same failure is not news.
  await r.deliver('check_suite', fixture('check_suite.completed.json'), 'red-2');
  await r.listener.whenIdle();
  assert.deepEqual(
    r.events.map((e) => e.checks?.conclusion),
    ['success', 'failure'],
  );
});

test('the suite dedup is per sha, so another head still reports', async (t) => {
  const r = await rig(t);
  await r.deliver('check_suite', fixture('check_suite.completed.json'), 'head-1');
  await r.deliver('check_suite', fixture('check_suite.completed.no_pull.json'), 'head-2');
  await r.listener.whenIdle();
  assert.equal(r.events.length, 2);
  assert.deepEqual(new Set(r.events.map((e) => e.sha)).size, 2);
});

test('a shared CheckGate makes two ingress paths agree on a sha', async (t) => {
  const gate = new CheckGate();
  const a = await rig(t, { checkGate: gate });
  const b = await rig(t, { checkGate: gate });
  await a.deliver('check_suite', fixture('check_suite.completed.json'), 'shared-1');
  await b.deliver('check_suite', fixture('check_suite.completed.json'), 'shared-2');
  await a.listener.whenIdle();
  await b.listener.whenIdle();
  assert.equal(a.events.length + b.events.length, 1, 'the sha is reported once across both');
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 2: the checks lifecycle end to end
// ─────────────────────────────────────────────────────────────────────────────

test('two failing suites finishing separately deliver one event naming every failed job', async (t) => {
  // The regression the reviewer reproduced: the first suite's delivery found
  // the sha still pending with [lint], emitted it, and the sha gate then
  // suppressed the final [lint, test] because it ranked the same.
  const LINT = { name: 'lint', url: 'https://github.com/anima-research/rayforce/runs/1' };
  const TEST_JOB = { name: 'test', url: 'https://github.com/anima-research/rayforce/runs/2' };
  const r = await rig(t, {
    getCheckRuns: async (_repo, sha, call) =>
      call === 1
        ? // The `test` suite is still running, so nothing has settled.
          { sha, conclusion: null, total: 4, failed: [LINT] }
        : { sha, conclusion: 'failure', total: 4, failed: [LINT, TEST_JOB] },
  });

  // The `lint` suite finishes first: held back, because reporting now would
  // spend this sha's one emission on half the story.
  await r.deliver('check_suite', fixture('check_suite.completed.json'), 'lint-suite');
  await r.listener.whenIdle();
  assert.equal(r.events.length, 0, 'nothing goes out while a suite is still running');
  assert.ok(r.log.text().includes('held back'), r.log.text());

  // The `test` suite finishes: now the sha has settled and the event names
  // both failed jobs.
  await r.deliver('check_suite', fixture('check_suite.completed.second_suite_failed.json'), 'test-suite');
  await r.listener.whenIdle();
  assert.equal(r.events.length, 1, 'one checks event for the head sha');
  assert.equal(r.events[0].checks?.conclusion, 'failure');
  assert.deepEqual(r.events[0].checks?.failed.map((f) => f.name), ['lint', 'test']);
});

test('a settled sha that later reports more failed jobs supersedes, once', async (t) => {
  // The other order: the first lookup already looks settled because the
  // second suite has not been created yet.
  const LINT = { name: 'lint', url: 'https://github.com/anima-research/rayforce/runs/1' };
  const TEST_JOB = { name: 'test', url: 'https://github.com/anima-research/rayforce/runs/2' };
  const r = await rig(t, {
    getCheckRuns: async (_repo, sha, call) =>
      call === 1
        ? { sha, conclusion: 'failure', total: 2, failed: [LINT] }
        : { sha, conclusion: 'failure', total: 4, failed: [LINT, TEST_JOB] },
  });

  await r.deliver('check_suite', fixture('check_suite.completed.json'), 'settled-1');
  await r.deliver('check_suite', fixture('check_suite.completed.second_suite_failed.json'), 'settled-2');
  await r.deliver('check_suite', fixture('check_suite.completed.second_suite_failed.json'), 'settled-3');
  await r.listener.whenIdle();

  assert.deepEqual(
    r.events.map((e) => e.checks?.failed.map((f) => f.name)),
    [['lint'], ['lint', 'test']],
    'the fuller list supersedes the shorter one, and then nothing more',
  );
});

test('a refused checks delivery commits nothing, so a later delivery reports the sha', async (t) => {
  let refuse = true;
  const api = new FakeGitHubApi();
  api.seedCheckRuns(TEST_REPO, { sha: HEAD, conclusion: 'failure', total: 2, failed: [] });
  const r = await rig(t, {
    api,
    onEvent: () => {
      if (refuse) throw new Error('host refused the event');
    },
  });

  await r.deliver('check_suite', fixture('check_suite.completed.json'), 'refused-1');
  await r.listener.whenIdle();
  assert.ok(r.log.text().includes('processing failed'), r.log.text());

  // The refusal must not have cost the sha its emission.
  refuse = false;
  await r.deliver('check_suite', fixture('check_suite.completed.second_suite_failed.json'), 'retry-1');
  await r.listener.whenIdle();
  assert.equal(r.events.length, 2, 'the listener saw the retry');
  assert.equal(r.events[1].sha, HEAD);
});

/**
 * `IngressState` over two fields, so this file can drive a real Poller
 * against a real listener without importing poller.test.ts's harness.
 */
function pollState(cursor: string): IngressState {
  const keys: string[] = [];
  const heads = new Map<string, string>();
  let at = cursor;
  let cursors = {};
  let fresh = {};
  return {
    lastPollAt: () => at,
    setLastPollAt: (when) => {
      at = when;
    },
    pollCursors: () => cursors,
    setPollCursors: (next) => {
      cursors = { ...next };
    },
    polledNew: () => fresh,
    setPolledNew: (next) => {
      fresh = next;
    },
    polledHead: (channel) => heads.get(channel) ?? null,
    setPolledHead: (channel, sha) => {
      heads.set(channel, sha);
    },
    seenPollKey: (key) => {
      if (keys.includes(key)) return true;
      keys.push(key);
      return false;
    },
    snapshot: () => ({ pollKeys: [...keys] }),
  };
}

/** Rewrite a check_suite fixture onto `sha`. */
function suiteFor(sha: string): string {
  const suite = JSON.parse(fixture('check_suite.completed.json')) as {
    check_suite: { head_sha: string; pull_requests: { head: { sha: string } }[] };
  };
  suite.check_suite.head_sha = sha;
  suite.check_suite.pull_requests[0].head.sha = sha;
  return JSON.stringify(suite);
}

const CLIPPY = { name: 'clippy', url: 'https://github.com/anima-research/rayforce/runs/2700001235' };

test('an overlapping poll and webhook for one head sha deliver it exactly once', async (t) => {
  // The round-2 regression: the poller decided to emit, awaited its listener,
  // and a webhook arriving during that await emitted the same event. There is
  // no window now — the two emissions are serialized, so the second one runs
  // after the first committed and finds itself covered.
  const gate = new CheckGate();
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  const settled = { sha: pull.head.sha, conclusion: 'failure' as const, total: 2, failed: [CLIPPY] };
  api.seedCheckRuns(TEST_REPO, settled);

  const polled: NormalizedEvent[] = [];
  let inHandoff: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    inHandoff = resolve;
  });
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const poller = new Poller({
    api,
    repos: [TEST_REPO],
    state: pollState('2026-10-13T00:00:00.000Z'),
    intervalMs: 60_000,
    checkGate: gate,
    logger: capturingLogger(),
    onEvent: async (event) => {
      polled.push(event);
      if (event.kind !== 'checks.completed') return;
      inHandoff?.();
      await held;
    },
  });

  const webhookApi = new FakeGitHubApi();
  webhookApi.seedCheckRuns(TEST_REPO, settled);
  const r = await rig(t, { api: webhookApi, checkGate: gate });

  const pass = poller.pollOnce();
  await entered; // the poll is inside its hand-off, holding the sha's queue

  // A signed delivery for the same head sha arrives mid-flight. The listener
  // answers 2xx at once; the emission queues behind the poll's.
  const res = await r.deliver('check_suite', suiteFor(pull.head.sha), 'overlap-1');
  assert.ok(res.status >= 200 && res.status < 300);
  await until(() => gate.inFlight === 1, 'the sha to have a queue');
  assert.equal(
    r.events.filter((e) => e.kind === 'checks.completed').length,
    0,
    'the webhook must not emit while another emission for this sha is in flight',
  );

  release?.();
  const result = await pass;
  await r.listener.whenIdle();

  const pollChecks = polled.filter((e) => e.kind === 'checks.completed');
  const hookChecks = r.events.filter((e) => e.kind === 'checks.completed');
  assert.equal(pollChecks.length + hookChecks.length, 1, 'exactly one of the two paths delivered the sha');
  // The poll got there first and committed; the webhook ran next and dedupped.
  assert.equal(pollChecks.length, 1);
  assert.equal(hookChecks.length, 0);
  assert.equal(result.delivered.filter((e) => e.kind === 'checks.completed').length, 1);
  assert.ok(r.log.text().includes('already reported this result'), r.log.text());
  assert.equal(gate.inFlight, 0, 'both emissions drained');
});

test('the reverse order: a webhook that commits first makes the poll stand down', async (t) => {
  const gate = new CheckGate();
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  const settled = { sha: pull.head.sha, conclusion: 'failure' as const, total: 2, failed: [CLIPPY] };
  api.seedCheckRuns(TEST_REPO, settled);

  const webhookApi = new FakeGitHubApi();
  webhookApi.seedCheckRuns(TEST_REPO, settled);
  const r = await rig(t, { api: webhookApi, checkGate: gate });
  await r.deliver('check_suite', suiteFor(pull.head.sha), 'reverse-1');
  await r.listener.whenIdle();
  assert.equal(r.events.filter((e) => e.kind === 'checks.completed').length, 1);

  const polled: NormalizedEvent[] = [];
  const poller = new Poller({
    api,
    repos: [TEST_REPO],
    state: pollState('2026-10-13T00:00:00.000Z'),
    intervalMs: 60_000,
    checkGate: gate,
    logger: capturingLogger(),
    onEvent: (event) => {
      polled.push(event);
    },
  });
  const result = await poller.pollOnce();
  assert.equal(polled.filter((e) => e.kind === 'checks.completed').length, 0, 'the poll stood down');
  assert.equal(result.duplicates, 1);
  assert.equal(poller.checkBacklogSize, 0, 'and retired the head rather than retrying it');
});

test('a webhook refusal after the cursor passed the row does not cost the poll its event', async (t) => {
  // Round-3 finding 1, end to end. Pass 1 sees the checks still running and
  // advances the cursor past the pull-request row. A webhook for the settled
  // sha then blocks in the listener and is refused. Under the old reservation
  // design pass 2 saw that claim, retired the head, and the event was lost by
  // everybody. Now pass 2's emission queues behind the webhook's, runs after
  // it fails, finds nothing committed, and delivers.
  const gate = new CheckGate();
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({ number: 58, updatedAt: '2026-10-13T12:00:00.000Z' });
  let settled = false;
  const polled: NormalizedEvent[] = [];
  let lookedUp: (() => void) | undefined;

  const state = pollState('2026-10-13T00:00:00.000Z');
  const poller = new Poller({
    api: {
      listIssuesSince: (repo, since) => api.listIssuesSince(repo, since),
      listIssueCommentsSince: (repo, since) => api.listIssueCommentsSince(repo, since),
      listReviewCommentsSince: (repo, since) => api.listReviewCommentsSince(repo, since),
      getCheckRuns: async (_repo, sha) => {
        lookedUp?.();
        return settled
          ? { sha, conclusion: 'failure' as const, total: 2, failed: [CLIPPY] }
          : { sha, conclusion: null, total: 3, failed: [] };
      },
    },
    repos: [TEST_REPO],
    state,
    intervalMs: 60_000,
    checkGate: gate,
    logger: capturingLogger(),
    onEvent: (event) => {
      polled.push(event);
    },
  });

  // Pass 1: the row is delivered, the checks are pending, the cursor moves on.
  const first = await poller.pollOnce();
  assert.deepEqual(
    first.delivered.map((e) => e.kind),
    // Amendment 2a: this pull request was created before the cursor and the
    // poll state has no head for it yet, so its first sighting is a synchronize.
    ['pull.synchronize'],
  );
  assert.equal(first.cursorAdvanced, true);
  assert.equal(first.checksBacklog, 1);
  // From here the pull-request row is behind the cursor.
  assert.deepEqual((await api.listIssuesSince(TEST_REPO, state.lastPollAt() as string)).rows, []);

  // The checks settle, and a webhook for the sha blocks in the listener.
  settled = true;
  let inHandoff: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    inHandoff = resolve;
  });
  let fail: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    fail = resolve;
  });
  const webhookApi = new FakeGitHubApi();
  webhookApi.seedCheckRuns(TEST_REPO, { sha: pull.head.sha, conclusion: 'failure', total: 2, failed: [CLIPPY] });
  let webhookRefusals = 0;
  const r = await rig(t, {
    api: webhookApi,
    checkGate: gate,
    onEvent: async (event) => {
      if (event.kind !== 'checks.completed') return;
      inHandoff?.();
      await held;
      webhookRefusals += 1;
      throw new Error('host refused the webhook delivery');
    },
  });
  await r.deliver('check_suite', suiteFor(pull.head.sha), 'refuse-1');
  await entered;

  // Pass 2 starts while that refusal is still pending: its emission queues.
  const reachedLookup = new Promise<void>((resolve) => {
    lookedUp = resolve;
  });
  const pass2 = poller.pollOnce();
  await reachedLookup;
  await new Promise((resolve) => setTimeout(resolve, 5)); // let it reach the gate

  fail?.();
  await r.listener.whenIdle();
  const second = await pass2;

  // The webhook's listener threw, so its delivery was never accepted and it
  // committed nothing — the whole point of commit-after-accept.
  assert.equal(webhookRefusals, 1);
  assert.ok(r.log.text().includes('processing failed'), r.log.text());
  // The poll delivered it, and only then retired the head.
  assert.deepEqual(
    second.delivered.map((e) => e.kind),
    ['checks.completed'],
  );
  assert.equal(second.delivered[0].sha, pull.head.sha);
  assert.deepEqual(second.delivered[0].checks?.failed.map((f) => f.name), ['clippy']);
  assert.equal(second.checksBacklog, 0, 'retired only because its own delivery was accepted');
  assert.deepEqual(polled.filter((e) => e.kind === 'checks.completed').length, 1);
  assert.deepEqual(gate.committedMark(TEST_REPO, pull.head.sha), { rank: 7, failed: ['clippy'] });
});
