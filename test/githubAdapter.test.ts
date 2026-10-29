/**
 * GitHubAdapter against a local fake GitHub (TASK-SRHKG.1.2).
 *
 * Nothing here leaves the process: the adapter is pointed at a `node:http`
 * server on 127.0.0.1 that answers the endpoints the contract names, and the
 * real octokit transport runs against it. So the paths, query strings, bodies
 * and headers asserted below are the ones that would go to github.com.
 *
 * The App key is a throwaway RSA pair generated here and written to a mode-600
 * temp file; no PEM is committed and no real key is read. The installation
 * token is a sentinel string, which lets every test assert the same thing: it
 * reaches the `authorization` header and nowhere else — not a log line, not an
 * error, not a stack.
 */

import { strict as assert } from 'node:assert';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  GitHubAdapter,
  GitHubApiError,
  POLL_MAX_PAGES,
  ReadCapError,
  describeFailure,
  isLastingFailure,
  isRateLimit,
  POLL_PR_HEAD_LIMIT,
  REDACTED,
  redactSecrets,
  summarizeChecks,
} from '../src/github-adapter.js';
import { Poller } from '../src/poller.js';
import { GithubState } from '../src/state.js';
import {
  readConfig,
  silentLogger,
  type NormalizedEvent,
  type Config,
  type Logger,
  type RepoRef,
  type ThreadRef,
} from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const REPO: RepoRef = { owner: 'anima-research', name: 'rayforce' };
const ISSUE: ThreadRef = { repo: REPO, number: 7, kind: 'issue' };
const PULL: ThreadRef = { repo: REPO, number: 12, kind: 'pull' };
const HEAD_SHA = 'f00dcafe00000000000000000000000000000000';

/** The sentinel no log line, error or stack may ever contain. */
const TOKEN = 'ghs_TESTINSTALLATIONTOKEN_do_not_log';
const APP_ID = '123456';
const INSTALLATION_ID = 42;

/** One throwaway key for the whole file; generating RSA is not free. */
const KEY_PAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const KEY_FILE = join(mkdtempSync(join(tmpdir(), 'github-mcpl-key-')), 'app.pem');
writeFileSync(KEY_FILE, KEY_PAIR.privateKey, { mode: 0o600 });

function config(extra: Record<string, string | undefined> = {}): Config {
  return readConfig({
    GITHUB_APP_ID: APP_ID,
    GITHUB_APP_PRIVATE_KEY_FILE: KEY_FILE,
    GITHUB_APP_INSTALLATION_ID: String(INSTALLATION_ID),
    GITHUB_REPOS: 'anima-research/rayforce',
    GITHUB_BOT_LOGIN: 'rayforce-clone[bot]',
    GITHUB_PR_BASE_ALLOW: 'dev',
    ...extra,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The fake GitHub
// ─────────────────────────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface Answer {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** A handler may return a promise, which holds the request in flight. */
type Handler = (req: Recorded, nth: number) => Answer | Promise<Answer>;

class FakeGitHub {
  readonly calls: Recorded[] = [];
  private readonly routes = new Map<string, { handler: Handler; count: number }>();
  private server!: Server;
  baseUrl = '';

  /** `on('GET /repos/o/r/issues/7', …)`. A later `on` replaces an earlier one. */
  on(route: string, answer: Answer | Handler): this {
    const handler: Handler = typeof answer === 'function' ? answer : () => answer;
    this.routes.set(route, { handler, count: 0 });
    return this;
  }

  /** Requests recorded for one route, in order. */
  for(route: string): Recorded[] {
    const [method, path] = route.split(' ');
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
        const url = new URL(req.url ?? '/', 'http://fake');
        const raw = Buffer.concat(chunks).toString('utf8');
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers[k] = v;
        }
        const recorded: Recorded = {
          method: req.method ?? 'GET',
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        };
        this.calls.push(recorded);

        const entry = this.routes.get(`${recorded.method} ${recorded.path}`);
        const answer: Answer = entry
          ? await entry.handler(recorded, entry.count++)
          : { status: 404, body: { message: 'Not Found' } };

        const status = answer.status ?? 200;
        const out = {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
          ...(answer.headers ?? {}),
        };
        res.writeHead(status, out);
        res.end(status === 204 || answer.body === undefined ? '' : JSON.stringify(answer.body));
        })();
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** Payloads the adapter is expected to be able to map. */
const ISSUE_PAYLOAD = {
  id: 9001,
  number: 7,
  title: 'A bug',
  body: 'It breaks',
  state: 'open',
  state_reason: null,
  user: { login: 'someone', type: 'User' },
  labels: [{ name: 'bug' }, 'chore'],
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  html_url: 'https://github.com/anima-research/rayforce/issues/7',
};

const PULL_PAYLOAD = {
  number: 12,
  node_id: 'PR_node_12',
  title: 'Fix it',
  body: 'the fix',
  state: 'open',
  draft: false,
  merged: false,
  mergeable: true,
  head: { ref: 'fix/thing', sha: HEAD_SHA },
  base: { ref: 'dev', sha: 'babe0000' },
  user: { login: 'rayforce-clone[bot]', type: 'Bot' },
  requested_reviewers: [{ login: 'maintainer', type: 'User' }],
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  html_url: 'https://github.com/anima-research/rayforce/pull/12',
};

const COMMENT_PAYLOAD = {
  id: 555,
  user: { login: 'someone', type: 'User' },
  body: 'hello',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  html_url: 'https://github.com/anima-research/rayforce/issues/7#issuecomment-555',
};

/** A fake with every endpoint the contract's methods touch already answered. */
function defaultRoutes(fake: FakeGitHub, tokenExpiresInMs = 3_600_000, token = TOKEN): FakeGitHub {
  const r = '/repos/anima-research/rayforce';
  return fake
    .on(`POST /app/installations/${INSTALLATION_ID}/access_tokens`, () => ({
      status: 201,
      body: { token, expires_at: new Date(Date.now() + tokenExpiresInMs).toISOString() },
    }))
    .on(`GET ${r}/installation`, { body: { id: INSTALLATION_ID } })
    .on('GET /app', { body: { id: 777, slug: 'rayforce-clone', name: 'Rayforce Clone' } })
    .on(`GET ${r}/issues/7`, { body: ISSUE_PAYLOAD })
    .on(`POST ${r}/issues`, { status: 201, body: ISSUE_PAYLOAD })
    .on(`PATCH ${r}/issues/7`, { body: { ...ISSUE_PAYLOAD, state: 'closed', state_reason: 'not_planned' } })
    .on(`GET ${r}/issues/7/comments`, { body: [COMMENT_PAYLOAD] })
    .on(`POST ${r}/issues/7/comments`, { status: 201, body: COMMENT_PAYLOAD })
    .on(`PATCH ${r}/issues/comments/555`, { body: { ...COMMENT_PAYLOAD, body: 'edited' } })
    .on(`DELETE ${r}/issues/comments/555`, { status: 204 })
    .on(`PATCH ${r}/pulls/comments/555`, { body: { ...COMMENT_PAYLOAD, body: 'edited', path: 'a.ts' } })
    .on(`DELETE ${r}/pulls/comments/555`, { status: 204 })
    .on(`GET ${r}/pulls/12`, { body: PULL_PAYLOAD })
    .on(`PATCH ${r}/pulls/12`, { body: { ...PULL_PAYLOAD, title: 'Retitled' } })
    .on(`POST ${r}/pulls`, { status: 201, body: PULL_PAYLOAD })
    .on(`GET ${r}/pulls/12/files`, {
      body: [{ filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, changes: 4, patch: 'SECRET' }],
    })
    .on(`POST ${r}/pulls/12/reviews`, {
      status: 200,
      body: { id: 909, state: 'CHANGES_REQUESTED', html_url: 'https://github.com/x#pullrequestreview-909' },
    })
    .on(`POST ${r}/pulls/12/comments/555/replies`, { status: 201, body: { ...COMMENT_PAYLOAD, id: 556, path: 'a.ts', in_reply_to_id: 555 } })
    .on(`POST ${r}/pulls/12/requested_reviewers`, { status: 201, body: PULL_PAYLOAD })
    .on(`GET ${r}/commits/${HEAD_SHA}/check-runs`, { body: { total_count: 0, check_runs: [] } })
    .on('GET /search/issues', {
      body: {
        total_count: 1,
        items: [{ ...ISSUE_PAYLOAD, pull_request: { url: 'x' }, repository_url: 'https://api.github.com/repos/anima-research/rayforce' }],
      },
    })
    .on(`GET ${r}/issues`, { body: [] })
    .on(`GET ${r}/issues/comments`, { body: [] })
    .on(`GET ${r}/pulls/comments`, { body: [] })
    .on('POST /graphql', { body: { data: {} } });
}

interface Rig {
  adapter: GitHubAdapter;
  fake: FakeGitHub;
  /** Every line the adapter logged, rendered the way stderr would render it. */
  logs: string[];
  /** Every backoff the adapter asked for, in milliseconds. */
  sleeps: number[];
  setNow: (ms: number) => void;
  /** The installation token this rig's fake hands out. */
  token: string;
}

const rigs: Rig[] = [];

async function rig(
  options: {
    tokenExpiresInMs?: number;
    env?: Record<string, string | undefined>;
    /** Override the minted token, e.g. with a form no pattern would catch. */
    token?: string;
  } = {},
): Promise<Rig> {
  const token = options.token ?? TOKEN;
  const fake = defaultRoutes(new FakeGitHub(), options.tokenExpiresInMs, token);
  await fake.start();

  const logs: string[] = [];
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    logs.push(`${level} ${message} ${fields ? JSON.stringify(fields) : ''}`);
  };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };

  const sleeps: number[] = [];
  let now = Date.now();

  const adapter = new GitHubAdapter(config(options.env), {
    baseUrl: fake.baseUrl,
    logger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => now,
  });

  const r: Rig = { adapter, fake, logs, sleeps, setNow: (ms) => (now = ms), token };
  rigs.push(r);
  return r;
}

after(async () => {
  await Promise.all(rigs.map((r) => r.fake.stop()));
});

/** The invariant every test shares: the token is in the header and nowhere else. */
function assertNoTokenLeak(r: Rig, extra: string[] = []): void {
  for (const line of [...r.logs, ...extra]) {
    assert.ok(!line.includes(r.token), `token leaked into: ${line}`);
  }
}

/** Spin the event loop until `predicate` holds, or give up and say so. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Everything an error could carry a secret through: message, fields, stack. */
function renderError(err: unknown): string {
  const e = err as Error;
  return `${e.message}\n${e.stack ?? ''}\n${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// App auth
// ─────────────────────────────────────────────────────────────────────────────

test('mints an App JWT the private key verifies, and swaps it for an installation token', async () => {
  const r = await rig();
  await r.adapter.getIssue(ISSUE);

  const mint = r.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`);
  assert.equal(mint.length, 1);

  // The mint call is JWT-authenticated; the issue read is token-authenticated.
  const jwt = mint[0].headers.authorization;
  assert.ok(jwt.startsWith('Bearer '), `expected a JWT, got ${jwt.slice(0, 10)}…`);
  const [header, payload, signature] = jwt.slice('Bearer '.length).split('.');

  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
    iat: number;
    exp: number;
    iss: string;
  };
  assert.equal(claims.iss, APP_ID);
  assert.ok(claims.iat < Math.floor(Date.now() / 1000), 'iat is backdated against clock skew');
  assert.ok(claims.exp - claims.iat <= 600, `GitHub caps an App JWT at 10 minutes, got ${claims.exp - claims.iat}s`);

  assert.ok(
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      createPublicKey(KEY_PAIR.publicKey),
      Buffer.from(signature, 'base64url'),
    ),
    'the JWT signature does not verify against the App key',
  );

  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/7')[0].headers.authorization, `token ${TOKEN}`);
  assertNoTokenLeak(r);
});

test('caches the installation token across calls and re-mints it before it expires', async () => {
  // A token good for an hour is minted once however many calls are made.
  const long = await rig({ tokenExpiresInMs: 3_600_000 });
  await long.adapter.getIssue(ISSUE);
  await long.adapter.getIssue(ISSUE);
  await long.adapter.getIssue(ISSUE);
  assert.equal(long.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 1);

  // A token inside the one-minute refresh margin is re-minted on every call.
  const short = await rig({ tokenExpiresInMs: 30_000 });
  await short.adapter.getIssue(ISSUE);
  await short.adapter.getIssue(ISSUE);
  assert.equal(short.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 2);
  assertNoTokenLeak(short);
});

test('a token that has aged past its expiry is re-minted on the next call', async () => {
  const r = await rig({ tokenExpiresInMs: 3_600_000 });
  await r.adapter.getIssue(ISSUE);
  assert.equal(r.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 1);

  r.setNow(Date.now() + 3_600_000); // the hour is up
  await r.adapter.getIssue(ISSUE);
  assert.equal(r.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 2);
});

test('discovers the installation from GITHUB_REPOS when GITHUB_APP_INSTALLATION_ID is unset', async () => {
  const r = await rig({ env: { GITHUB_APP_INSTALLATION_ID: undefined } });
  await r.adapter.getIssue(ISSUE);

  const discovery = r.fake.for('GET /repos/anima-research/rayforce/installation');
  assert.equal(discovery.length, 1);
  assert.ok(discovery[0].headers.authorization.startsWith('Bearer '), 'discovery is JWT-authenticated');
  // Discovered once, then reused: the second call does not look it up again.
  await r.adapter.getIssue(ISSUE);
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/installation').length, 1);
  assert.equal(r.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 1);
  assertNoTokenLeak(r);
});

test('a 401 on a call re-mints the token once and retries', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', (_req, nth) =>
    nth === 0 ? { status: 401, body: { message: 'Bad credentials' } } : { body: ISSUE_PAYLOAD },
  );

  const issue = await r.adapter.getIssue(ISSUE);
  assert.equal(issue.number, 7);
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/7').length, 2);
  assert.equal(r.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 2);
  assertNoTokenLeak(r);
});

test('a second 401 is not retried again; it surfaces as a 401 error', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', { status: 401, body: { message: 'Bad credentials' } });

  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 401);
  assert.equal(err.githubMessage, 'Bad credentials');
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/7').length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limits
// ─────────────────────────────────────────────────────────────────────────────

test('a 403 secondary rate limit is retried once, after the Retry-After it names', async () => {
  const r = await rig();
  r.fake.on('POST /repos/anima-research/rayforce/issues/7/comments', (_req, nth) =>
    nth === 0
      ? {
          status: 403,
          headers: { 'retry-after': '3' },
          body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
        }
      : { status: 201, body: COMMENT_PAYLOAD },
  );

  const comment = await r.adapter.createComment(ISSUE, 'hello');
  assert.equal(comment.id, 555);
  assert.deepEqual(r.sleeps, [3000]);
  assert.equal(r.fake.for('POST /repos/anima-research/rayforce/issues/7/comments').length, 2);
  assertNoTokenLeak(r);
});

test('the secondary-limit retry is spent once; a second 403 is the caller’s error', async () => {
  const r = await rig();
  const message = 'You have exceeded a secondary rate limit.';
  r.fake.on('POST /repos/anima-research/rayforce/issues/7/comments', {
    status: 403,
    headers: { 'retry-after': '1' },
    body: { message },
  });

  const err = await r.adapter.createComment(ISSUE, 'hi').then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 403);
  assert.equal(err.githubMessage, message);
  assert.deepEqual(r.sleeps, [1000], 'exactly one bounded retry');
  assert.equal(r.fake.for('POST /repos/anima-research/rayforce/issues/7/comments').length, 2);
});

test('a 403 with no Retry-After but a spent budget waits for the reset, bounded', async () => {
  const now = Date.now();
  const r = await rig();
  r.setNow(now);
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', (_req, nth) =>
    nth === 0
      ? {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(now / 1000) + 5),
          },
          body: { message: 'API rate limit exceeded' },
        }
      : { body: ISSUE_PAYLOAD },
  );

  await r.adapter.getIssue(ISSUE);
  assert.equal(r.sleeps.length, 1);
  assert.ok(r.sleeps[0] > 3_000 && r.sleeps[0] <= 5_000, `expected ~5s, got ${r.sleeps[0]}`);
});

test('a reset further out than the backoff bound is not slept on at all', async () => {
  const now = Date.now();
  const r = await rig();
  r.setNow(now);
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    status: 403,
    headers: {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(now / 1000) + 3600),
    },
    body: { message: 'API rate limit exceeded' },
  });

  await assert.rejects(r.adapter.getIssue(ISSUE), (e: unknown) => e instanceof GitHubApiError && e.status === 403);
  assert.deepEqual(r.sleeps, [], 'an hour-long reset is reported, not slept through');
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/7').length, 1);
});

test('octokit’s own retry plugin is off, so a 5xx is one request and the caller’s error', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', { status: 500, body: { message: 'Server Error' } });

  await assert.rejects(r.adapter.getIssue(ISSUE), (e: unknown) => e instanceof GitHubApiError && e.status === 500);
  assert.equal(
    r.fake.for('GET /repos/anima-research/rayforce/issues/7').length,
    1,
    'a bundled plugin retrying underneath would make backoff unbounded and invisible',
  );
  assert.deepEqual(r.sleeps, []);
});

test('x-ratelimit-remaining is read off every answer and a low budget is warned about', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    headers: { 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': '1800000000' },
    body: ISSUE_PAYLOAD,
  });

  await r.adapter.getIssue(ISSUE);
  assert.deepEqual(r.adapter.rateLimitState(), { remaining: 3, resetAt: 1800000000000 });
  assert.ok(
    r.logs.some((l) => l.startsWith('warn github rate limit low')),
    `expected a low-budget warning, got ${JSON.stringify(r.logs)}`,
  );
  assertNoTokenLeak(r);
});

// ─────────────────────────────────────────────────────────────────────────────
// Error redaction
// ─────────────────────────────────────────────────────────────────────────────

test('an error carries the status and GitHub’s message, and no token, URL or header', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    status: 404,
    body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' },
  });

  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 404);
  assert.equal(err.githubMessage, 'Not Found');
  assert.equal(err.operation, 'getIssue');
  assert.equal(err.message, 'GitHub 404 on getIssue: Not Found');

  const rendered = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err, Object.getOwnPropertyNames(err))}`;
  assert.ok(!rendered.includes(TOKEN), 'the token reached the error');
  assert.ok(!rendered.includes(r.fake.baseUrl), 'the request URL reached the error');
  assert.ok(!/authorization/i.test(rendered), 'a header name reached the error');
  assertNoTokenLeak(r, [rendered]);
});

test('no log line from a full session carries the token, however the calls went', async () => {
  const r = await rig({ tokenExpiresInMs: 30_000 });
  r.fake.on('GET /repos/anima-research/rayforce/pulls/12', (_req, nth) =>
    nth === 0 ? { status: 401, body: { message: 'Bad credentials' } } : { body: PULL_PAYLOAD },
  );
  r.fake.on('POST /repos/anima-research/rayforce/issues/7/comments', (_req, nth) =>
    nth === 0
      ? { status: 403, headers: { 'retry-after': '1' }, body: { message: 'secondary rate limit' } }
      : { status: 201, body: COMMENT_PAYLOAD },
  );

  await r.adapter.getPullRequest(PULL);
  await r.adapter.createComment(ISSUE, 'hi');
  await r.adapter.getIssue(ISSUE).catch(() => undefined);

  assert.ok(r.logs.length > 0, 'the session logged something, so the assertion is not vacuous');
  assertNoTokenLeak(r);
  // The token did travel — in the one place it belongs.
  assert.ok(
    r.fake.calls.some((c) => c.headers.authorization === `token ${TOKEN}`),
    'the installation token never reached the authorization header',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Review threads (GraphQL)
// ─────────────────────────────────────────────────────────────────────────────

test('listReviewThreads maps reviewThreads, isResolved and the comment chain', async () => {
  const r = await rig();
  r.fake.on('POST /graphql', {
    body: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'PRRT_open',
                  path: 'src/a.ts',
                  line: 12,
                  originalLine: 9,
                  diffSide: 'RIGHT',
                  isResolved: false,
                  comments: {
                    nodes: [
                      {
                        databaseId: 100,
                        author: { login: 'maintainer', __typename: 'User' },
                        body: 'why?',
                        createdAt: '2026-10-01T00:00:00Z',
                        lastEditedAt: null,
                        replyTo: null,
                      },
                      {
                        databaseId: 101,
                        author: { login: 'rayforce-clone', __typename: 'Bot' },
                        body: 'because',
                        createdAt: '2026-10-01T01:00:00Z',
                        lastEditedAt: '2026-10-01T02:00:00Z',
                        replyTo: { databaseId: 100 },
                      },
                    ],
                  },
                },
                {
                  // Outdated: `line` is null and the original line stands in.
                  id: 'PRRT_outdated',
                  path: 'src/b.ts',
                  line: null,
                  originalLine: 42,
                  diffSide: 'LEFT',
                  isResolved: true,
                  comments: { nodes: [] },
                },
              ],
            },
          },
        },
      },
    },
  });

  const threads = await r.adapter.listReviewThreads(PULL);
  assert.equal(threads.length, 2);

  assert.deepEqual(threads[0], {
    id: 'PRRT_open',
    path: 'src/a.ts',
    line: 12,
    side: 'RIGHT',
    isResolved: false,
    comments: [
      {
        id: 100,
        author: { login: 'maintainer', isBot: false },
        body: 'why?',
        createdAt: '2026-10-01T00:00:00Z',
      },
      {
        id: 101,
        author: { login: 'rayforce-clone', isBot: true },
        body: 'because',
        createdAt: '2026-10-01T01:00:00Z',
        updatedAt: '2026-10-01T02:00:00Z',
        inReplyTo: 100,
      },
    ],
  });

  assert.equal(threads[1].id, 'PRRT_outdated');
  assert.equal(threads[1].line, 42, 'an outdated thread keeps its original line');
  assert.equal(threads[1].side, 'LEFT');
  assert.equal(threads[1].isResolved, true);

  // The query asked for exactly what the contract names, inside the 50 cap.
  const sent = r.fake.for('POST /graphql')[0];
  assert.match(String(sent.body.query), /reviewThreads\(first:\$threads\)/);
  assert.match(String(sent.body.query), /isResolved/);
  assert.deepEqual(sent.body.variables, {
    owner: 'anima-research',
    name: 'rayforce',
    number: 12,
    threads: 50,
    comments: 50,
  });
});

test('resolve and unresolve send their mutations with the thread node id', async () => {
  const r = await rig();
  r.fake.on('POST /graphql', { body: { data: { resolveReviewThread: { thread: { id: 'PRRT_x', isResolved: true } } } } });
  await r.adapter.resolveReviewThread('PRRT_x');
  await r.adapter.unresolveReviewThread('PRRT_x');

  const sent = r.fake.for('POST /graphql');
  assert.equal(sent.length, 2);
  assert.match(String(sent[0].body.query), /mutation.*resolveReviewThread\(input:\{threadId:\$threadId\}\)/s);
  assert.deepEqual(sent[0].body.variables, { threadId: 'PRRT_x' });
  assert.match(String(sent[1].body.query), /unresolveReviewThread\(input:\{threadId:\$threadId\}\)/);
  assert.deepEqual(sent[1].body.variables, { threadId: 'PRRT_x' });
});

test('a GraphQL errors array becomes a GitHubApiError, not a silent empty list', async () => {
  const r = await rig();
  r.fake.on('POST /graphql', { body: { data: null, errors: [{ message: 'Could not resolve to a PullRequest' }] } });

  const err = await r.adapter.listReviewThreads(PULL).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.githubMessage, 'Could not resolve to a PullRequest');
  assert.equal(err.operation, 'listReviewThreads');
  assert.ok(!err.message.includes(TOKEN));
});

// ─────────────────────────────────────────────────────────────────────────────
// Every GitHubApi method maps to its documented call
// ─────────────────────────────────────────────────────────────────────────────

test('reads hit the documented REST paths and map the payloads', async () => {
  const r = await rig();

  const issue = await r.adapter.getIssue(ISSUE);
  assert.deepEqual(issue, {
    number: 7,
    kind: 'issue',
    repo: REPO,
    title: 'A bug',
    body: 'It breaks',
    state: 'open',
    stateReason: null,
    author: { login: 'someone', isBot: false },
    labels: ['bug', 'chore'],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    html_url: 'https://github.com/anima-research/rayforce/issues/7',
  });

  const pull = await r.adapter.getPullRequest(PULL);
  assert.equal(pull.kind, 'pull');
  assert.deepEqual(pull.head, { ref: 'fix/thing', sha: HEAD_SHA });
  assert.deepEqual(pull.base, { ref: 'dev', sha: 'babe0000' });
  assert.equal(pull.draft, false);
  assert.equal(pull.mergeable, true);
  assert.deepEqual(pull.author, { login: 'rayforce-clone[bot]', isBot: true });
  assert.deepEqual(pull.requestedReviewers, ['maintainer']);
  assert.equal(pull.checksSummary, null, 'no check runs on the head sha is null, not an empty summary');

  const files = await r.adapter.listPullRequestFiles(PULL);
  assert.deepEqual(files, [{ filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, changes: 4 }]);
  assert.ok(!JSON.stringify(files).includes('SECRET'), 'the patch text must never be mapped through');

  const comments = await r.adapter.listComments(ISSUE, '2026-10-01T00:00:00Z');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, 555);
  const commentCall = r.fake.for('GET /repos/anima-research/rayforce/issues/7/comments')[0];
  assert.equal(commentCall.query.since, '2026-10-01T00:00:00Z');
  assert.equal(commentCall.query.per_page, '50', 'lists are capped at 50');

  const bot = await r.adapter.getAuthenticatedBot();
  assert.deepEqual(bot, { login: 'rayforce-clone[bot]', id: 777, isBot: true });
  assert.ok(r.fake.for('GET /app')[0].headers.authorization.startsWith('Bearer '), 'GET /app is JWT-authenticated');

  assertNoTokenLeak(r);
});

test('searchIssues scopes to the repository and drops a caller’s repo: qualifier', async () => {
  const r = await rig();
  const { hits, outside } = await r.adapter.searchIssues(REPO, 'repo:someone/else is:open flaky');
  assert.equal(outside, 0);

  assert.deepEqual(hits, [
    {
      number: 7,
      kind: 'pull',
      title: 'A bug',
      state: 'open',
      updatedAt: '2026-10-02T00:00:00Z',
      html_url: 'https://github.com/anima-research/rayforce/issues/7',
    },
  ]);
  const sent = r.fake.for('GET /search/issues')[0];
  assert.equal(sent.query.q, 'repo:anima-research/rayforce is:open flaky');
  assert.equal(sent.query.per_page, '50');

  // An explicit limit is honoured but never exceeds the rendered list bound.
  await r.adapter.searchIssues(REPO, 'x', 5);
  assert.equal(r.fake.for('GET /search/issues')[1].query.per_page, '5');
  await r.adapter.searchIssues(REPO, 'x', 500);
  assert.equal(r.fake.for('GET /search/issues')[2].query.per_page, '50');
});

test('getCheckRuns rolls a sha’s runs up and lists the failures', async () => {
  const r = await rig();
  r.fake.on(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`, {
    body: {
      total_count: 4,
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://ci/build' },
        { name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'https://ci/lint' },
        { name: 'docs', status: 'completed', conclusion: 'skipped', html_url: 'https://ci/docs' },
        { name: 'e2e', status: 'completed', conclusion: 'cancelled', html_url: 'https://ci/e2e' },
      ],
    },
  });

  const summary = await r.adapter.getCheckRuns(REPO, HEAD_SHA);
  assert.equal(summary.sha, HEAD_SHA);
  assert.equal(summary.total, 4);
  assert.equal(summary.conclusion, 'failure', 'the worst conclusion wins');
  assert.deepEqual(summary.failed, [
    { name: 'lint', url: 'https://ci/lint' },
    { name: 'e2e', url: 'https://ci/e2e' },
  ]);

  // A pull request read folds the same summary in.
  const pull = await r.adapter.getPullRequest(PULL);
  assert.equal(pull.checksSummary?.conclusion, 'failure');
});

test('summarizeChecks marks a failure beside a run still going, or an unread page, as unfinished, and nothing else', () => {
  const failed = { name: 'a', status: 'completed', conclusion: 'failure' };
  const going = summarizeChecks('s', [failed, { name: 'b', status: 'in_progress', conclusion: null }]);
  assert.equal(going.conclusion, 'failure');
  assert.equal(going.unfinished, true);
  assert.equal(summarizeChecks('s', [failed], { total: 600, truncated: true }).unfinished, true);
  assert.equal('unfinished' in summarizeChecks('s', [failed, { name: 'b', status: 'completed', conclusion: 'success' }]), false);
});

test('summarizeChecks: running is undecided, all-clear is success, empty is null', () => {
  assert.equal(summarizeChecks('s', []).conclusion, null);
  assert.equal(
    summarizeChecks('s', [{ name: 'a', status: 'in_progress', conclusion: null }]).conclusion,
    null,
    'a run still going leaves the sha undecided',
  );
  assert.equal(
    summarizeChecks('s', [
      { name: 'a', status: 'completed', conclusion: 'success' },
      { name: 'b', status: 'completed', conclusion: 'neutral' },
    ]).conclusion,
    'success',
    'neutral is not a failure',
  );
  assert.equal(
    summarizeChecks('s', [
      { name: 'a', status: 'completed', conclusion: 'timed_out' },
      { name: 'b', status: 'completed', conclusion: 'failure' },
    ]).conclusion,
    'failure',
  );
});

test('comment writes hit the issues or pulls comment path as `review` says', async () => {
  const r = await rig();

  await r.adapter.createComment(ISSUE, 'hello');
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/issues/7/comments')[0].body, { body: 'hello' });

  await r.adapter.updateComment(REPO, 555, 'edited');
  assert.deepEqual(r.fake.for('PATCH /repos/anima-research/rayforce/issues/comments/555')[0].body, { body: 'edited' });

  const reviewEdit = await r.adapter.updateComment(REPO, 555, 'edited', true);
  assert.equal(r.fake.for('PATCH /repos/anima-research/rayforce/pulls/comments/555').length, 1);
  assert.equal(reviewEdit.path, 'a.ts');
  assert.equal(reviewEdit.side, 'RIGHT');

  await r.adapter.deleteComment(REPO, 555);
  assert.equal(r.fake.for('DELETE /repos/anima-research/rayforce/issues/comments/555').length, 1);
  await r.adapter.deleteComment(REPO, 555, true);
  assert.equal(r.fake.for('DELETE /repos/anima-research/rayforce/pulls/comments/555').length, 1);

  const reply = await r.adapter.replyToReviewComment(PULL, 555, 'answering');
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/pulls/12/comments/555/replies')[0].body, {
    body: 'answering',
  });
  assert.equal(reply.inReplyTo, 555);
  assertNoTokenLeak(r);
});

test('createReview posts the event, body and inline comments', async () => {
  const r = await rig();
  const review = await r.adapter.createReview(PULL, {
    event: 'REQUEST_CHANGES',
    body: 'two things',
    comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'this one' }],
  });

  assert.deepEqual(review, { id: 909, state: 'changes_requested', html_url: 'https://github.com/x#pullrequestreview-909' });
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/pulls/12/reviews')[0].body, {
    event: 'REQUEST_CHANGES',
    body: 'two things',
    comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'this one' }],
  });

  // A bare COMMENT review sends no empty `comments` array.
  await r.adapter.createReview(PULL, { event: 'COMMENT' });
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/pulls/12/reviews')[1].body, { event: 'COMMENT' });
});

test('issue create, edit and close-with-reason go through one PATCH', async () => {
  const r = await rig();

  await r.adapter.createIssue(REPO, { title: 'New', body: 'text' });
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/issues')[0].body, { title: 'New', body: 'text' });

  const closed = await r.adapter.updateIssue(ISSUE, { state: 'closed', stateReason: 'not_planned' });
  assert.deepEqual(r.fake.for('PATCH /repos/anima-research/rayforce/issues/7')[0].body, {
    state: 'closed',
    state_reason: 'not_planned',
  });
  assert.equal(closed.state, 'closed');
  assert.equal(closed.stateReason, 'not_planned');

  // An absent field is absent from the body, not sent as null.
  await r.adapter.updateIssue(ISSUE, { title: 'Retitled' });
  assert.deepEqual(r.fake.for('PATCH /repos/anima-research/rayforce/issues/7')[1].body, { title: 'Retitled' });
});

test('pull request create, retarget, reviewers — and the draft flag through GraphQL', async () => {
  const r = await rig();

  await r.adapter.createPullRequest(REPO, { head: 'fix/thing', base: 'dev', title: 'Fix it', body: 'the fix', draft: true });
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/pulls')[0].body, {
    head: 'fix/thing',
    base: 'dev',
    title: 'Fix it',
    body: 'the fix',
    draft: true,
  });

  const retargeted = await r.adapter.updatePullRequest(PULL, { title: 'Retitled', base: 'dev' });
  assert.deepEqual(r.fake.for('PATCH /repos/anima-research/rayforce/pulls/12')[0].body, {
    title: 'Retitled',
    base: 'dev',
  });
  assert.equal(retargeted.title, 'Retitled');
  assert.equal(r.fake.for('POST /graphql').length, 0, 'no draft change means no mutation');

  await r.adapter.requestReviewers(PULL, ['maintainer', 'other']);
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/pulls/12/requested_reviewers')[0].body, {
    reviewers: ['maintainer', 'other'],
  });

  // REST cannot convert a PR to draft; GraphQL can, and the adapter re-reads.
  r.fake.on('GET /repos/anima-research/rayforce/pulls/12', (_req, nth) =>
    nth === 0 ? { body: PULL_PAYLOAD } : { body: { ...PULL_PAYLOAD, draft: true } },
  );
  const drafted = await r.adapter.updatePullRequest(PULL, { draft: true });
  const mutation = r.fake.for('POST /graphql')[0];
  assert.match(String(mutation.body.query), /convertPullRequestToDraft\(input:\{pullRequestId:\$id\}\)/);
  assert.deepEqual(mutation.body.variables, { id: 'PR_node_12' });
  assert.equal(drafted.draft, true);

  // Already a draft: no mutation is sent.
  r.fake.on('GET /repos/anima-research/rayforce/pulls/12', { body: { ...PULL_PAYLOAD, draft: true } });
  await r.adapter.updatePullRequest(PULL, { draft: true });
  assert.equal(r.fake.for('POST /graphql').length, 1, 'a no-op draft change sends nothing');

  // Ready for review takes the other mutation.
  r.fake.on('GET /repos/anima-research/rayforce/pulls/12', (_req, nth) =>
    nth === 0 ? { body: { ...PULL_PAYLOAD, draft: true } } : { body: PULL_PAYLOAD },
  );
  await r.adapter.updatePullRequest(PULL, { draft: false });
  assert.match(String(r.fake.for('POST /graphql')[1].body.query), /markPullRequestReadyForReview/);
  assertNoTokenLeak(r);
});

// ─────────────────────────────────────────────────────────────────────────────
// Polling fallback (contract amendment 1)
// ─────────────────────────────────────────────────────────────────────────────

test('listIssuesSince asks the documented query and fills the head sha of open PRs', async () => {
  const r = await rig();
  const since = '2026-10-10T00:00:00Z';
  r.fake.on('GET /repos/anima-research/rayforce/issues', {
    body: [
      { ...ISSUE_PAYLOAD, id: 1, number: 7 },
      { ...ISSUE_PAYLOAD, id: 2, number: 12, pull_request: { url: 'x' }, state: 'open' },
      {
        ...ISSUE_PAYLOAD,
        id: 3,
        number: 13,
        pull_request: { url: 'x' },
        state: 'closed',
        closed_by: { login: 'rayforce-clone[bot]', type: 'Bot' },
      },
    ],
  });

  const { rows } = await r.adapter.listIssuesSince(REPO, since);
  // The list carries closed_by; a closed row is attributed to its closer.
  assert.deepEqual(rows[2].closedBy, { login: 'rayforce-clone[bot]', isBot: true });
  assert.equal(rows[0].closedBy, undefined);
  const query = r.fake.for('GET /repos/anima-research/rayforce/issues')[0].query;
  assert.equal(query.state, 'all');
  assert.equal(query.sort, 'updated');
  assert.equal(query.since, since);
  assert.equal(query.direction, 'asc', 'a cursor poll must read oldest-first');

  assert.deepEqual(
    rows.map((row) => [row.id, row.number, row.isPullRequest, row.headSha]),
    [
      [1, 7, false, undefined],
      [2, 12, true, HEAD_SHA],
      [3, 13, true, undefined],
    ],
  );
  // Exactly one head read: the closed PR and the issue cost nothing.
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/pulls/12').length, 1);
});

/** An issue row for a paging test: its number is its id, created before any cursor below. */
function pagedIssue(id: number, updatedAt: string) {
  return { ...ISSUE_PAYLOAD, id, number: id, created_at: '2026-10-01T00:00:00Z', updated_at: updatedAt };
}

/** `2026-10-10T01:00:00Z` plus `s` seconds, as GitHub stamps a row. */
function second(s: number): string {
  return new Date(Date.parse('2026-10-10T01:00:00Z') + s * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * Serve `rows` as GitHub serves a `…Since` list: the rows updated at or after
 * `since` (its own second included), oldest change first and then by id, 100
 * to a page by offset, with `Link: rel="next"` while more follow. `rows` is
 * read at each request, so a test can update a row between two of them.
 */
function serveSince(r: Rig, route: string, rows: { id: number; updated_at: string }[]): void {
  r.fake.on(route, (req) => {
    const since = Date.parse(String(req.query.since));
    const page = Number(req.query.page ?? '1');
    const match = rows
      .filter((row) => Date.parse(row.updated_at) >= since)
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.id - b.id);
    const more = page * 100 < match.length;
    return {
      body: match.slice((page - 1) * 100, page * 100),
      ...(more ? { headers: { link: `<${r.fake.baseUrl}${route.split(' ')[1]}?page=${page + 1}>; rel="next"` } } : {}),
    };
  });
}

const ISSUES = 'GET /repos/anima-research/rayforce/issues';

test('a poll follows rel="next" past a short page', async () => {
  // GitHub answered 99 rows and said more follow: the 99 are not the end.
  const r = await rig();
  r.fake.on(ISSUES, (req) =>
    req.query.page === '1' && req.query.since === '2026-10-10T00:00:00Z'
      ? {
          body: Array.from({ length: 99 }, (_, i) => pagedIssue(1 + i, second(i))),
          headers: { link: `<${r.fake.baseUrl}/x?page=2>; rel="next"` },
        }
      : { body: Array.from({ length: 50 }, (_, i) => pagedIssue(100 + i, second(99 + i))) },
  );

  const { rows, resumeAt } = await r.adapter.listIssuesSince(REPO, '2026-10-10T00:00:00Z');
  assert.equal(rows.length, 149);
  assert.equal(resumeAt, undefined);
  assert.equal(r.fake.for(ISSUES).length, 2);
});

test('each request after the first asks from the last row it read, and keeps one copy of each row', async () => {
  const r = await rig();
  const all = Array.from({ length: 250 }, (_, i) => pagedIssue(1 + i, second(i)));
  serveSince(r, ISSUES, all);

  const { rows, resumeAt } = await r.adapter.listIssuesSince(REPO, '2026-10-10T00:00:00Z');
  assert.deepEqual(
    r.fake.for(ISSUES).map((c) => [c.query.since, c.query.page]),
    [
      ['2026-10-10T00:00:00Z', '1'],
      [second(99), '1'],
      [second(198), '1'],
    ],
  );
  // The last row of each page comes back first on the next one, and is kept once.
  assert.deepEqual(
    rows.map((row) => row.id),
    all.map((row) => row.id),
  );
  assert.equal(resumeAt, undefined);
});

test('a row updated between two requests cannot push an unread row onto a page already read', async () => {
  const r = await rig();
  const all = Array.from({ length: 150 }, (_, i) => pagedIssue(1 + i, second(i)));
  r.fake.on(ISSUES, (req, nth) => {
    // Someone comments on #5 once page 1 has been read: it moves to the end.
    if (nth === 1) all[4] = { ...all[4], updated_at: second(500) };
    const since = Date.parse(String(req.query.since));
    const page = Number(req.query.page ?? '1');
    const match = all
      .filter((row) => Date.parse(row.updated_at) >= since)
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
    const more = page * 100 < match.length;
    return {
      body: match.slice((page - 1) * 100, page * 100),
      ...(more ? { headers: { link: `<${r.fake.baseUrl}/x?page=${page + 1}>; rel="next"` } } : {}),
    };
  });

  const { rows } = await r.adapter.listIssuesSince(REPO, '2026-10-10T00:00:00Z');
  const ids = new Set(rows.map((row) => row.id));
  assert.deepEqual(
    all.map((row) => row.id).filter((id) => !ids.has(id)),
    [],
    'every row is read, #101 included, which page 2 by offset would have skipped',
  );
  assert.equal(rows.find((row) => row.id === 5)?.updatedAt, second(500), 'the later copy of #5 is the one kept');
});

test('a read never stops inside a second, even past its request bound', async () => {
  // 350 rows share one second: the read pages through it, then stops nowhere inside it.
  const r = await rig();
  const all = [
    ...Array.from({ length: 350 }, (_, i) => pagedIssue(1 + i, second(1))),
    ...Array.from({ length: 5 }, (_, i) => pagedIssue(400 + i, second(2 + i))),
  ];
  serveSince(r, ISSUES, all);

  const { rows, resumeAt } = await r.adapter.listIssuesSince(REPO, '2026-10-10T00:00:00Z');
  assert.equal(rows.length, 355);
  assert.equal(resumeAt, undefined);
  assert.deepEqual(
    r.fake.for(ISSUES).map((c) => [c.query.since, c.query.page]),
    [
      ['2026-10-10T00:00:00Z', '1'],
      [second(1), '1'],
      [second(1), '2'],
      [second(1), '3'],
      [second(1), '4'],
    ],
  );
});

test('a read the bound finds inside a second reads to the end of the page that finishes it, and stops there', async () => {
  // Rows 1–250 share second 1, which carries the read past its bound; rows 251–350 have a second each.
  const r = await rig();
  const all = [
    ...Array.from({ length: 250 }, (_, i) => pagedIssue(1 + i, second(1))),
    ...Array.from({ length: 100 }, (_, i) => pagedIssue(251 + i, second(2 + i))),
  ];
  serveSince(r, ISSUES, all);

  const first = await r.adapter.listIssuesSince(REPO, '2026-10-10T00:00:00Z');
  assert.deepEqual(
    r.fake.for(ISSUES).map((c) => [c.query.since, c.query.page]),
    [
      ['2026-10-10T00:00:00Z', '1'],
      [second(1), '1'],
      [second(1), '2'],
      [second(1), '3'],
    ],
  );
  // Page 3 finished second 1 and ended at row 300's second: that second waits for the next read.
  assert.equal(first.resumeAt, second(51));
  assert.deepEqual(
    first.rows.map((row) => row.id),
    all.slice(0, 299).map((row) => row.id),
  );

  const next = await r.adapter.listIssuesSince(REPO, first.resumeAt as string);
  assert.deepEqual(
    [...first.rows, ...next.rows].map((row) => row.id),
    all.map((row) => row.id),
    'the two reads together return every row once',
  );
});

test('a Link header without rel="next" ends the read', async () => {
  // GitHub's last page names only prev and first.
  const r = await rig();
  r.fake.on(ISSUES, (_req, nth) =>
    nth === 0
      ? {
          body: Array.from({ length: 100 }, (_, i) => pagedIssue(1 + i, second(i))),
          headers: { link: `<${r.fake.baseUrl}/x?page=1>; rel="prev", <${r.fake.baseUrl}/x?page=1>; rel="first"` },
        }
      : { body: [] },
  );

  const { rows } = await r.adapter.listIssuesSince(REPO, '2026-10-10T00:00:00Z');
  assert.equal(rows.length, 100);
  assert.equal(r.fake.for(ISSUES).length, 1);
});

test('both comment lists stop at the request bound and say where', async () => {
  const r = await rig();
  const comment = (id: number) => ({
    ...COMMENT_PAYLOAD,
    id,
    updated_at: second(id - 1),
    issue_url: 'https://api.github.com/repos/anima-research/rayforce/issues/7',
    pull_request_url: 'https://api.github.com/repos/anima-research/rayforce/pulls/12',
  });
  const all = Array.from({ length: 350 }, (_, i) => comment(1 + i));
  serveSince(r, 'GET /repos/anima-research/rayforce/issues/comments', all);
  serveSince(r, 'GET /repos/anima-research/rayforce/pulls/comments', all);

  for (const read of [
    await r.adapter.listIssueCommentsSince(REPO, '2026-10-10T00:00:00Z'),
    await r.adapter.listReviewCommentsSince(REPO, '2026-10-10T00:00:00Z'),
  ]) {
    assert.equal(read.resumeAt, second(297));
    assert.equal(read.rows.length, 297);
  }
});

test('a page with no stamp to read on from is followed by the next page of the same since', async () => {
  const r = await rig();
  r.fake.on(ISSUES, (req) =>
    req.query.page === '1'
      ? {
          body: Array.from({ length: 100 }, (_, i) => ({ ...pagedIssue(1 + i, ''), updated_at: null })),
          headers: { link: `<${r.fake.baseUrl}/x?page=2>; rel="next"` },
        }
      : { body: Array.from({ length: 3 }, (_, i) => pagedIssue(200 + i, second(i))) },
  );

  const { rows } = await r.adapter.listIssuesSince(REPO, '2026-10-10T00:00:00Z');
  assert.equal(rows.length, 103);
  assert.deepEqual(
    r.fake.for(ISSUES).map((c) => [c.query.since, c.query.page]),
    [
      ['2026-10-10T00:00:00Z', '1'],
      ['2026-10-10T00:00:00Z', '2'],
    ],
  );
});

test('a read the request bound stops leaves the second it stopped in for the next read', async () => {
  const r = await rig();
  const all = Array.from({ length: 350 }, (_, i) => pagedIssue(1 + i, second(i)));
  serveSince(r, ISSUES, all);

  const first = await r.adapter.listIssuesSince(REPO, '2026-10-10T00:00:00Z');
  assert.equal(r.fake.for(ISSUES).length, POLL_MAX_PAGES);
  // The third request ended at row 298's second, so that row waits for the next read.
  assert.equal(first.resumeAt, second(297));
  assert.deepEqual(
    first.rows.map((row) => row.id),
    all.slice(0, 297).map((row) => row.id),
  );
  assert.ok(
    r.logs.some((l) => l.startsWith('warn poll page cap reached; a later pass reads the rest from resumeAt')),
    'a stopped read says so',
  );

  const second2 = await r.adapter.listIssuesSince(REPO, first.resumeAt as string);
  assert.deepEqual(
    [...first.rows, ...second2.rows].map((row) => row.id),
    all.map((row) => row.id),
    'the two reads together return every row once',
  );
  assert.equal(second2.resumeAt, undefined);
});

/** A poller over a rig's adapter, its pass start set by `at`. */
function pollerOver(r: Rig, state: GithubState, at: { now: string }, delivered: NormalizedEvent[]): Poller {
  serveSince(r, 'GET /repos/anima-research/rayforce/issues/comments', []);
  serveSince(r, 'GET /repos/anima-research/rayforce/pulls/comments', []);
  return new Poller({
    api: r.adapter,
    repos: [REPO],
    state,
    intervalMs: 60_000,
    logger: silentLogger(),
    now: () => new Date(at.now),
    onEvent: async (event) => {
      delivered.push(event);
    },
  });
}

test('a pass the request bound stops is read on from where it stopped, and every row arrives once', async () => {
  const r = await rig();
  const all = Array.from({ length: 350 }, (_, i) => pagedIssue(1 + i, second(i)));
  serveSince(r, ISSUES, all);
  const state = GithubState.empty(null, silentLogger());
  state.setLastPollAt('2026-10-10T00:00:00.000Z');
  const at = { now: '2026-10-10T02:00:00.000Z' };
  const delivered: NormalizedEvent[] = [];
  const poller = pollerOver(r, state, at, delivered);

  const first = await poller.pollOnce();
  assert.equal(first.delivered.length, 297);
  assert.deepEqual(state.pollCursors()['anima-research/rayforce:issues'], {
    since: '2026-10-10T00:00:00.000Z',
    resumeAt: second(297),
  });
  assert.deepEqual(state.pollCursors()['anima-research/rayforce:issue_comments'], { since: at.now });
  assert.equal(state.lastPollAt(), second(297), 'every list has delivered what changed before the stop');

  at.now = '2026-10-10T02:01:00.000Z';
  const second2 = await poller.pollOnce();
  assert.equal(
    Date.parse(String(r.fake.for(ISSUES).at(-1)?.query.since)),
    Date.parse(second(297)),
    'the next pass asks from where the last stopped',
  );
  assert.equal(second2.delivered.length, 53);
  assert.deepEqual(
    delivered.map((e) => e.thread?.number),
    all.map((row) => row.id),
    'every row once, in order',
  );
  assert.deepEqual(state.pollCursors()['anima-research/rayforce:issues'], { since: at.now });
  assert.equal(state.lastPollAt(), at.now);
});

test('a row changed later in the second a pass started in arrives next pass, and one opened then is opened once', async () => {
  const r = await rig();
  const all = [{ ...pagedIssue(1, '2026-10-10T02:00:00Z'), created_at: '2026-10-10T02:00:00Z' }];
  serveSince(r, ISSUES, all);
  const state = GithubState.empty(null, silentLogger());
  state.setLastPollAt('2026-10-10T01:59:00.000Z');
  const at = { now: '2026-10-10T02:00:00.700Z' };
  const delivered: NormalizedEvent[] = [];
  const poller = pollerOver(r, state, at, delivered);

  await poller.pollOnce();
  assert.deepEqual(delivered.map((e) => [e.thread?.number, e.kind]), [[1, 'issue.opened']]);
  assert.deepEqual(state.pollCursors()['anima-research/rayforce:issues'], { since: '2026-10-10T02:00:00.000Z' });
  assert.deepEqual(state.polledNew()['anima-research/rayforce:issues'], { '1': '2026-10-10T02:00:00Z' }, 'created inside the next window, so kept');

  // Still inside that second, after the read: #2 changes. Then #1 is edited.
  all.push(pagedIssue(2, '2026-10-10T02:00:00Z'));
  all[0] = { ...all[0], body: 'edited', updated_at: '2026-10-10T02:00:30Z' };
  at.now = '2026-10-10T02:01:00.000Z';
  await poller.pollOnce();
  assert.equal(r.fake.for(ISSUES).at(-1)?.query.since, '2026-10-10T02:00:00.000Z');
  assert.deepEqual(
    delivered.slice(1).map((e) => [e.thread?.number, e.kind]),
    [
      [2, 'issue.edited'],
      [1, 'issue.edited'],
    ],
  );
});

test('across a stopped read, a row opened in the window is opened once', async () => {
  const r = await rig();
  const all: ReturnType<typeof pagedIssue>[] = Array.from({ length: 350 }, (_, i) => pagedIssue(1 + i, second(i)));
  // #10 is opened in the window and read before the stop; #320 is opened in
  // the window but changed again past the stop, so only the next pass reads it.
  all[9] = { ...all[9], created_at: second(0) };
  all[319] = { ...all[319], created_at: second(5) };
  serveSince(r, ISSUES, all);
  const state = GithubState.empty(null, silentLogger());
  state.setLastPollAt('2026-10-10T00:00:00.000Z');
  const at = { now: '2026-10-10T02:00:00.000Z' };
  const delivered: NormalizedEvent[] = [];
  const poller = pollerOver(r, state, at, delivered);

  await poller.pollOnce();
  assert.equal(delivered.find((e) => e.thread?.number === 10)?.kind, 'issue.opened');
  assert.deepEqual(state.polledNew()['anima-research/rayforce:issues'], { '10': second(0) });

  // #10 is edited before the next pass reads on.
  all[9] = { ...all[9], body: 'edited', updated_at: second(400) };
  at.now = '2026-10-10T02:01:00.000Z';
  const next = await poller.pollOnce();
  const kinds = Object.fromEntries(next.delivered.map((e) => [e.thread?.number, e.kind]));
  assert.equal(kinds[320], 'issue.opened', 'opened in the window, though read after the stop');
  assert.equal(kinds[10], 'issue.edited', 'already announced as opened, so not again');
});

test('a poll never reads more than the amendment’s 20 PR heads', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues', {
    body: Array.from({ length: 30 }, (_, i) => ({
      ...ISSUE_PAYLOAD,
      id: i,
      number: 100 + i,
      state: 'open',
      pull_request: { url: 'x' },
    })),
  });
  for (let i = 0; i < 30; i++) {
    r.fake.on(`GET /repos/anima-research/rayforce/pulls/${100 + i}`, {
      body: { ...PULL_PAYLOAD, number: 100 + i },
    });
  }

  const { rows } = await r.adapter.listIssuesSince(REPO, '2026-10-10T00:00:00Z');
  assert.equal(rows.filter((row) => row.headSha !== undefined).length, POLL_PR_HEAD_LIMIT);
});

test('the comment polls carry the issue or pull number the comment hangs on', async () => {
  const r = await rig();
  const since = '2026-10-10T00:00:00Z';
  r.fake.on('GET /repos/anima-research/rayforce/issues/comments', {
    body: [{ ...COMMENT_PAYLOAD, issue_url: 'https://api.github.com/repos/anima-research/rayforce/issues/7' }],
  });
  r.fake.on('GET /repos/anima-research/rayforce/pulls/comments', {
    body: [
      {
        ...COMMENT_PAYLOAD,
        id: 556,
        path: 'src/a.ts',
        in_reply_to_id: 555,
        pull_request_url: 'https://api.github.com/repos/anima-research/rayforce/pulls/12',
      },
    ],
  });

  const { rows: issueComments } = await r.adapter.listIssueCommentsSince(REPO, since);
  assert.equal(issueComments.length, 1);
  assert.equal(issueComments[0].number, 7);
  assert.equal(issueComments[0].path, undefined);
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/comments')[0].query.sort, 'updated');
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/comments')[0].query.since, since);

  const { rows: reviewComments } = await r.adapter.listReviewCommentsSince(REPO, since);
  assert.equal(reviewComments[0].number, 12);
  assert.equal(reviewComments[0].path, 'src/a.ts');
  assert.equal(reviewComments[0].inReplyTo, 555);
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/pulls/comments')[0].query.since, since);
  assertNoTokenLeak(r);
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1: redaction of reflected secrets
// ─────────────────────────────────────────────────────────────────────────────

test('redactSecrets scrubs token forms and URL userinfo, and leaves prose alone', () => {
  assert.equal(redactSecrets('bad credentials for ghs_abc123DEF'), `bad credentials for ${REDACTED}`);
  for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghr_']) {
    assert.equal(redactSecrets(`saw ${prefix}aaaaBBBB1111`), `saw ${REDACTED}`);
  }
  assert.equal(
    redactSecrets('request to https://octocat:hunter2@api.github.com/repos failed'),
    `request to https://${REDACTED}@api.github.com/repos failed`,
  );
  // The JWT pattern fires first and leaves the scheme word standing, which is
  // the point: the credential is gone and the message still reads.
  assert.equal(
    redactSecrets('header was Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2lnbmF0dXJl'),
    `header was Bearer ${REDACTED}`,
  );
  assert.equal(redactSecrets('header was token 0123456789abcdef'), `header was ${REDACTED}`);
  // An ordinary message and an ordinary URL come through untouched.
  assert.equal(
    redactSecrets('Not Found — see https://api.github.com/repos/anima-research/rayforce'),
    'Not Found — see https://api.github.com/repos/anima-research/rayforce',
  );
});

test('a GitHub error that reflects the live token back redacts it everywhere', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    status: 422,
    body: { message: `Bad credentials for ${TOKEN} on this installation` },
  });

  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 422);
  const rendered = renderError(err);
  assert.ok(!rendered.includes(TOKEN), 'the reflected token survived into the error');
  assert.ok(err.githubMessage.includes(REDACTED), `expected a redaction, got: ${err.githubMessage}`);
  assert.ok(err.githubMessage.includes('Bad credentials'), 'the rest of the message is still there');
  assertNoTokenLeak(r, [rendered]);
});

test('a token with no recognizable shape is still redacted, because its value is known', async () => {
  // GitHub's older installation tokens are `v1.<hex>` — no `ghs_`, nothing a
  // pattern would catch. Only substituting the value in hand scrubs it.
  // Built at run time: spelled out, it is exactly what secret scanners match,
  // and GitHub push protection refuses the file.
  const opaque = `v1.${'0123456789abcdef'.repeat(3).slice(0, 40)}`;
  const r = await rig({ token: opaque });
  assert.equal(redactSecrets(opaque), opaque, 'the premise: no pattern matches this token');

  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    status: 401,
    body: { message: `credentials ${opaque} are not valid` },
  });

  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  const rendered = renderError(err);
  assert.ok(!rendered.includes(opaque), 'the opaque token survived into the error');
  assert.ok(err.githubMessage.includes(REDACTED));
  assertNoTokenLeak(r, [rendered]);
});

test('a credential-bearing URL reflected in an error loses its userinfo', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    status: 502,
    body: { message: 'upstream https://octocat:hunter2@api.github.com/repos/x refused the connection' },
  });

  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  const rendered = renderError(err);
  assert.ok(!rendered.includes('hunter2'), 'the password survived into the error');
  assert.ok(!rendered.includes('octocat:'), 'the userinfo survived into the error');
  assert.ok(err.githubMessage.includes(`https://${REDACTED}@api.github.com`));
});

test('a baseUrl with credentials in its userinfo is refused before any request', () => {
  const err = (() => {
    try {
      new GitHubAdapter(config(), { baseUrl: 'https://octocat:hunter2@api.github.com' });
      return null;
    } catch (e: unknown) {
      return e as GitHubApiError;
    }
  })();

  assert.ok(err instanceof GitHubApiError, 'a credential-bearing baseUrl must be refused');
  assert.equal(err.operation, 'constructor');
  const rendered = renderError(err);
  assert.ok(!rendered.includes('hunter2'), 'the refusal quoted the password back');
  assert.ok(!rendered.includes('octocat'), 'the refusal quoted the user back');
  assert.match(err.githubMessage, /userinfo/);
});

test('a log line built from a reflected secret is redacted too', async () => {
  const r = await rig();
  // The retry warning carries the operation, but the rate-limit path also logs
  // what GitHub said; drive a secondary limit whose message quotes the token.
  r.fake.on('POST /repos/anima-research/rayforce/issues/7/comments', {
    status: 403,
    headers: { 'retry-after': '1' },
    body: { message: `secondary rate limit hit by ${TOKEN}` },
  });

  const err = await r.adapter.createComment(ISSUE, 'hi').then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.ok(r.logs.length > 0);
  assertNoTokenLeak(r, [renderError(err)]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1: check runs are paginated
// ─────────────────────────────────────────────────────────────────────────────

function successRuns(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `job-${from + i}`,
    status: 'completed',
    conclusion: 'success',
    html_url: `https://ci/${from + i}`,
  }));
}

test('getCheckRuns follows pages, so a failure on page two is not reported as success', async () => {
  const r = await rig();
  r.fake.on(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`, (req) => ({
    body: {
      total_count: 101,
      check_runs:
        Number(req.query.page) === 1
          ? successRuns(0, 100)
          : [{ name: 'late-failure', status: 'completed', conclusion: 'failure', html_url: 'https://ci/late' }],
    },
  }));

  const summary = await r.adapter.getCheckRuns(REPO, HEAD_SHA);
  assert.equal(summary.total, 101, 'the 101st run is counted');
  assert.equal(summary.conclusion, 'failure', 'a failure on page two is a failure');
  assert.deepEqual(summary.failed, [{ name: 'late-failure', url: 'https://ci/late' }]);
  assert.deepEqual(
    r.fake.for(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`).map((c) => c.query.page),
    ['1', '2'],
  );
});

test('a sha with more check runs than the page bound is undecided, never success', async () => {
  const r = await rig();
  r.fake.on(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`, (req) => ({
    body: { total_count: 1000, check_runs: successRuns((Number(req.query.page) - 1) * 100, 100) },
  }));

  const summary = await r.adapter.getCheckRuns(REPO, HEAD_SHA);
  assert.equal(summary.conclusion, null, 'what was not read cannot be called green');
  assert.equal(summary.total, 1000);
  assert.equal(r.fake.for(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`).length, 5);
  assert.ok(
    r.logs.some((l) => l.startsWith('warn check runs did not fit')),
    `expected a truncation warning, got ${JSON.stringify(r.logs)}`,
  );
});

test('a single complete page still stops at one request', async () => {
  const r = await rig();
  r.fake.on(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`, {
    body: { total_count: 2, check_runs: successRuns(0, 2) },
  });

  const summary = await r.adapter.getCheckRuns(REPO, HEAD_SHA);
  assert.equal(summary.conclusion, 'success');
  assert.equal(summary.total, 2);
  assert.equal(r.fake.for(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`).length, 1);
});

test('getCheckRuns reads on past a short page while total_count says more runs follow', async () => {
  const r = await rig();
  r.fake.on(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`, (req) => ({
    body: {
      total_count: 100,
      check_runs:
        Number(req.query.page) === 1
          ? successRuns(0, 99)
          : [{ name: 'late-failure', status: 'completed', conclusion: 'failure', html_url: 'https://ci/late' }],
    },
  }));

  const summary = await r.adapter.getCheckRuns(REPO, HEAD_SHA);
  assert.equal(summary.conclusion, 'failure', 'a page of 99 was not the last');
  assert.equal(r.fake.for(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`).length, 2);
});

test('getCheckRuns without a total_count reads on past a full page', async () => {
  const r = await rig();
  r.fake.on(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`, (req) => ({
    body: {
      check_runs:
        Number(req.query.page) === 1
          ? successRuns(0, 100)
          : [{ name: 'late-failure', status: 'completed', conclusion: 'failure', html_url: 'https://ci/late' }],
    },
  }));

  const summary = await r.adapter.getCheckRuns(REPO, HEAD_SHA);
  assert.equal(summary.conclusion, 'failure');
  assert.equal(r.fake.for(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`).length, 2);
});

test('getCheckRuns without a total_count is undecided when the page bound stops it', async () => {
  const r = await rig();
  r.fake.on(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`, (req) => ({
    body: { check_runs: successRuns((Number(req.query.page) - 1) * 100, 100) },
  }));

  const summary = await r.adapter.getCheckRuns(REPO, HEAD_SHA);
  assert.equal(summary.conclusion, null, 'what was not read cannot be called green');
  assert.equal(r.fake.for(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`).length, 5);
});

test('getCheckRuns ends at an empty page as undecided, and says the count was not reached', async () => {
  // total_count counts a run that is gone by the time its page is asked for.
  const r = await rig();
  r.fake.on(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`, (req) => ({
    body: { total_count: 101, check_runs: Number(req.query.page) === 1 ? successRuns(0, 100) : [] },
  }));

  const summary = await r.adapter.getCheckRuns(REPO, HEAD_SHA);
  assert.equal(summary.conclusion, null);
  assert.equal(r.fake.for(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`).length, 2);
  assert.ok(r.logs.some((l) => l.startsWith('warn check runs ended before total_count')), r.logs.join('\n'));
});

test('a check-run read that ended short is still a failure when a run it read failed', async () => {
  const r = await rig();
  r.fake.on(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`, (req) => ({
    body: {
      total_count: 101,
      check_runs:
        Number(req.query.page) === 1
          ? [...successRuns(0, 99), { name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'https://ci/lint' }]
          : [],
    },
  }));

  const summary = await r.adapter.getCheckRuns(REPO, HEAD_SHA);
  assert.equal(summary.conclusion, 'failure');
  assert.ok(r.logs.some((l) => l.includes('undecided unless a run read failed')), r.logs.join('\n'));
});

test('summarizeChecks refuses to call a truncated read success', () => {
  const complete = summarizeChecks('s', successRuns(0, 3));
  assert.equal(complete.conclusion, 'success');
  assert.equal(complete.total, 3);

  const partial = summarizeChecks('s', successRuns(0, 3), { total: 9, truncated: true });
  assert.equal(partial.conclusion, null);
  assert.equal(partial.total, 9);

  // A failure already seen stands whatever is still unread.
  const failing = summarizeChecks(
    's',
    [{ name: 'x', status: 'completed', conclusion: 'failure', html_url: 'u' }],
    { total: 9, truncated: true },
  );
  assert.equal(failing.conclusion, 'failure');
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1: a headerless secondary limit waits a full minute
// ─────────────────────────────────────────────────────────────────────────────

test('a secondary limit with no Retry-After waits the minute GitHub asks for', async () => {
  const r = await rig();
  r.fake.on('POST /repos/anima-research/rayforce/issues/7/comments', (_req, nth) =>
    nth === 0
      ? {
          // No `retry-after`, and the budget is not spent: only the message
          // says what happened.
          status: 403,
          body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
        }
      : { status: 201, body: COMMENT_PAYLOAD },
  );

  const comment = await r.adapter.createComment(ISSUE, 'hello');
  assert.equal(comment.id, 555);
  assert.deepEqual(r.sleeps, [60_000], 'retrying a secondary limit sooner than a minute earns the next one');
  assert.equal(r.fake.for('POST /repos/anima-research/rayforce/issues/7/comments').length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1: auth failures keep their status
// ─────────────────────────────────────────────────────────────────────────────

test('a failure minting the installation token keeps its status and names the mint', async () => {
  const r = await rig();
  r.fake.on(`POST /app/installations/${INSTALLATION_ID}/access_tokens`, {
    status: 403,
    body: { message: 'Resource not accessible by integration' },
  });

  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 403, 'the auth status must survive octokit wrapping it as a transport 500');
  assert.equal(err.githubMessage, 'Resource not accessible by integration');
  assert.equal(err.operation, 'mintInstallationToken');
  // The call it was blocking never went out.
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/7').length, 0);
  assertNoTokenLeak(r, [renderError(err)]);
});

test('a failure discovering the installation keeps its status and names the discovery', async () => {
  const r = await rig({ env: { GITHUB_APP_INSTALLATION_ID: undefined } });
  r.fake.on('GET /repos/anima-research/rayforce/installation', {
    status: 404,
    body: { message: 'Not Found' },
  });

  const err = await r.adapter.getPullRequest(PULL).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 404);
  assert.equal(err.githubMessage, 'Not Found');
  assert.equal(err.operation, 'resolveInstallationId');
  assert.equal(r.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 0);
});

test('an auth failure on a GraphQL call keeps its status too', async () => {
  const r = await rig();
  r.fake.on(`POST /app/installations/${INSTALLATION_ID}/access_tokens`, {
    status: 401,
    body: { message: 'A JSON web token could not be decoded' },
  });

  const err = await r.adapter.listReviewThreads(PULL).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 401);
  assert.equal(err.operation, 'mintInstallationToken');
  assert.equal(r.fake.for('POST /graphql').length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1: octokit's own diagnostics go through the Logger
// ─────────────────────────────────────────────────────────────────────────────

test('octokit’s deprecation warning reaches the injected Logger, not stderr', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    headers: { deprecation: 'true', sunset: '2026-12-01' },
    body: ISSUE_PAYLOAD,
  });

  const stderrWrites: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    await r.adapter.getIssue(ISSUE);
  } finally {
    process.stderr.write = original;
  }

  assert.ok(
    r.logs.some((l) => l.includes('octokit:') && l.includes('deprecated')),
    `expected octokit's warning on the Logger, got ${JSON.stringify(r.logs)}`,
  );
  assert.deepEqual(stderrWrites, [], 'octokit wrote straight to stderr, bypassing the Logger');
  assertNoTokenLeak(r);
});

test('an octokit diagnostic is redacted like any other log line', async () => {
  const r = await rig();
  // The deprecation warning quotes the request URL back; make that URL carry
  // something that must not be logged.
  r.fake.on(`GET /repos/anima-research/rayforce/commits/ghs_LEAKED_IN_A_URL/check-runs`, {
    headers: { deprecation: 'true', sunset: '2026-12-01' },
    body: { total_count: 0, check_runs: [] },
  });

  await r.adapter.getCheckRuns(REPO, 'ghs_LEAKED_IN_A_URL');
  const octokitLines = r.logs.filter((l) => l.includes('octokit:'));
  assert.equal(octokitLines.length, 1, `expected one octokit line, got ${JSON.stringify(r.logs)}`);
  assert.ok(!octokitLines[0].includes('ghs_LEAKED_IN_A_URL'), 'octokit’s own message was not redacted');
  assert.ok(octokitLines[0].includes(REDACTED));
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 2: a credential is not safe the moment it is replaced
// ─────────────────────────────────────────────────────────────────────────────

test('a token still in flight when a refresh replaces it is redacted all the same', async () => {
  // Two opaque tokens, of the `v1.<hex>` form GitHub used to issue: no pattern
  // recognizes either, so only substituting the literal values can scrub them,
  // and only remembering both can scrub the one already replaced.
  const TOKEN_A = 'v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const TOKEN_B = 'v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.equal(redactSecrets(TOKEN_A), TOKEN_A, 'the premise: no pattern catches these');
  assert.equal(redactSecrets(TOKEN_B), TOKEN_B);

  const r = await rig();
  const start = Date.now();
  r.setNow(start);

  const issued: string[] = [];
  r.fake.on(`POST /app/installations/${INSTALLATION_ID}/access_tokens`, (_req, nth) => {
    const token = nth === 0 ? TOKEN_A : TOKEN_B;
    issued.push(token);
    // Both tokens claim the same expiry; the clock is what moves.
    return { status: 201, body: { token, expires_at: new Date(start + 3_600_000).toISOString() } };
  });

  // The first request is held open by the fake, mid-flight, carrying token A.
  let release!: (answer: Answer) => void;
  const held = new Promise<Answer>((resolve) => {
    release = resolve;
  });
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', () => held);

  const inFlight = r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  await waitFor(() => r.fake.for('GET /repos/anima-research/rayforce/issues/7').length === 1, 'the held request');
  assert.deepEqual(issued, [TOKEN_A]);
  assert.equal(
    r.fake.for('GET /repos/anima-research/rayforce/issues/7')[0].headers.authorization,
    `token ${TOKEN_A}`,
    'the held request really is carrying token A',
  );

  // The clock moves into the refresh margin and a second request completes,
  // which mints token B and replaces the cache out from under the first.
  r.setNow(start + 3_600_000 - 30_000);
  await r.adapter.listComments(ISSUE);
  assert.deepEqual(issued, [TOKEN_A, TOKEN_B], 'the refresh minted a distinct token');

  // Only now does the held request fail, with GitHub reflecting token A back.
  release({ status: 422, body: { message: `Bad credentials for ${TOKEN_A} on this installation` } });
  const err = await inFlight;

  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 422);
  for (const [name, secret] of [
    ['the replaced token', TOKEN_A],
    ['the current token', TOKEN_B],
  ] as const) {
    assert.ok(!err.message.includes(secret), `${name} survived into message`);
    assert.ok(!err.githubMessage.includes(secret), `${name} survived into githubMessage`);
    assert.ok(!(err.stack ?? '').includes(secret), `${name} survived into the stack`);
    assert.ok(!JSON.stringify(err).includes(secret), `${name} survived into JSON.stringify`);
    assert.ok(!renderError(err).includes(secret), `${name} survived into the serialized error`);
  }
  assert.ok(err.githubMessage.includes(REDACTED), `expected a redaction, got: ${err.githubMessage}`);
  assert.ok(err.githubMessage.includes('Bad credentials'), 'the rest of the message is still there');
  for (const line of r.logs) {
    assert.ok(!line.includes(TOKEN_A) && !line.includes(TOKEN_B), `a token leaked into: ${line}`);
  }
});

/**
 * An opaque `v1.<hex>` token, the form GitHub used to issue: no pattern in
 * `redactSecrets` recognizes it, so only the value passes can scrub it. Every
 * rotation test below depends on that, and asserts it.
 */
function opaqueToken(n: number): string {
  return `v1.${String(n).padStart(2, '0')}${'c'.repeat(38)}`;
}

/**
 * Answer every mint with a fresh opaque token. Returns the list, which grows
 * as the adapter rotates.
 */
function rotatingTokens(r: Rig, expiresAt: number): string[] {
  const issued: string[] = [];
  r.fake.on(`POST /app/installations/${INSTALLATION_ID}/access_tokens`, (_req, nth) => {
    const token = opaqueToken(nth);
    issued.push(token);
    return { status: 201, body: { token, expires_at: new Date(expiresAt).toISOString() } };
  });
  return issued;
}

test('no rotation ages a credential out while the request that sent it is unresolved', async () => {
  // The reviewer's probe, verbatim in shape: one held request, then enough
  // 401-driven rotations to overflow any fixed-size history, no clock advance
  // and never more than two application requests pending.
  const r = await rig();
  const start = Date.now();
  r.setNow(start);
  const issued = rotatingTokens(r, start + 3_600_000);

  // The held request goes out under the first token and stays unresolved.
  let release!: (answer: Answer) => void;
  const held = new Promise<Answer>((resolve) => {
    release = resolve;
  });
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', () => held);

  const inFlight = r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  await waitFor(() => r.fake.for('GET /repos/anima-research/rayforce/issues/7').length === 1, 'the held request');
  const tokenA = issued[0];
  assert.equal(
    r.fake.for('GET /repos/anima-research/rayforce/issues/7')[0].headers.authorization,
    `token ${tokenA}`,
    'the held request really is carrying the first token',
  );
  assert.equal(redactSecrets(tokenA), tokenA, 'the premise: no pattern catches these tokens');

  // Ten sequential calls, each refused once and retried, which mints a fresh
  // token every time. No clock advance: rotation alone drives this.
  r.fake.on('GET /repos/anima-research/rayforce/issues/7/comments', (_req, nth) =>
    nth % 2 === 0 ? { status: 401, body: { message: 'Bad credentials' } } : { body: [COMMENT_PAYLOAD] },
  );
  const ROTATIONS = 10;
  for (let i = 0; i < ROTATIONS; i++) await r.adapter.listComments(ISSUE);
  assert.equal(issued.length, ROTATIONS + 1, 'every 401 retry minted a distinct token');
  assert.ok(issued.length > 9, 'more rotations than any fixed-size history would hold');
  assert.equal(new Set(issued).size, issued.length, 'the tokens really are all distinct');

  // Only now does the held request fail, with GitHub reflecting every token
  // that has existed during its lifetime.
  release({ status: 422, body: { message: `rejected: ${issued.join(' ')}` } });
  const err = await inFlight;

  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 422);
  for (const [i, token] of issued.entries()) {
    assert.ok(!err.message.includes(token), `token ${i} survived into message`);
    assert.ok(!err.githubMessage.includes(token), `token ${i} survived into githubMessage`);
    assert.ok(!(err.stack ?? '').includes(token), `token ${i} survived into the stack`);
    assert.ok(!JSON.stringify(err).includes(token), `token ${i} survived into JSON.stringify`);
    assert.ok(!renderError(err).includes(token), `token ${i} survived into the serialized error`);
  }
  assert.ok(err.githubMessage.includes(REDACTED));
  assert.ok(err.githubMessage.includes('rejected:'), 'the rest of the message is still there');
  for (const line of r.logs) {
    for (const token of issued) assert.ok(!line.includes(token), `a token leaked into: ${line}`);
  }
});

test('retention is by validity, so a credential GitHub would refuse is not kept forever', async () => {
  // The bound on the retention set is expiry, not a count. An installation
  // token cannot be refreshed, so once it is past `expires_at` GitHub rejects
  // it and it has stopped being a secret worth holding.
  const r = await rig();
  const start = Date.now();
  r.setNow(start);
  const issued = rotatingTokens(r, start + 60_000);

  await r.adapter.getIssue(ISSUE);
  const early = issued[0];

  // Well past every issued token's expiry; the next mint prunes.
  r.setNow(start + 24 * 3_600_000);
  await r.adapter.getIssue(ISSUE);
  assert.ok(issued.length >= 2, 'the expired token was replaced');

  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    status: 422,
    body: { message: `stale ${early} and current ${issued[issued.length - 1]}` },
  });
  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  // What can still authenticate is still scrubbed...
  assert.ok(
    !err.githubMessage.includes(issued[issued.length - 1]),
    'a credential that still works must stay redacted',
  );
  // ...and what cannot is no longer carried, which is what keeps the set small.
  assert.ok(
    err.githubMessage.includes(early),
    'a long-expired token is not retained; expiry is what bounds the set',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Contributor mode (user token)
// ─────────────────────────────────────────────────────────────────────────────

const USER_TOKEN = 'ghp_TESTCONTRIBUTORTOKEN_do_not_log';

function tokenConfig(extra: Record<string, string | undefined> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-token-'));
  const file = join(dir, 'token');
  writeFileSync(file, `${USER_TOKEN}\n`, { mode: 0o600 });
  return readConfig({
    GITHUB_TOKEN_FILE: file,
    GITHUB_REPOS: 'anima-research/rayforce',
    GITHUB_BOT_LOGIN: 'a-human',
    ...extra,
  });
}

async function tokenRig(
  routes: (fake: FakeGitHub) => void = () => {},
): Promise<{ adapter: GitHubAdapter; fake: FakeGitHub; logs: string[]; sleeps: number[] }> {
  const fake = new FakeGitHub();
  routes(fake);
  await fake.start();
  const logs: string[] = [];
  const sleeps: number[] = [];
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    logs.push(`${level} ${message} ${fields ? JSON.stringify(fields) : ''}`);
  };
  const logger: Logger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
  const adapter = new GitHubAdapter(tokenConfig(), {
    baseUrl: fake.baseUrl,
    logger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  after(() => fake.stop());
  return { adapter, fake, logs, sleeps };
}

test('contributor mode authenticates every call with the user token, not an installation token', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce/issues/7', { body: ISSUE_PAYLOAD });
  });
  await r.adapter.getIssue(ISSUE);

  const call = r.fake.for('GET /repos/anima-research/rayforce/issues/7')[0];
  assert.equal(call.headers.authorization, `token ${USER_TOKEN}`);
  // No App endpoint is ever touched: there is no installation to mint for.
  assert.equal(r.fake.calls.some((c) => c.path.includes('/access_tokens') || c.path === '/app'), false);
  assert.ok(!r.logs.join('\n').includes(USER_TOKEN), 'the token leaked into a log line');
});

test('a classic token no pattern knows is still kept out of an error that quotes it', async () => {
  // An older classic token is 40 hex characters with no prefix, so only the token the adapter holds can find it.
  const hex = 'a3f9c1e07b2d4c5e8f6a1b2c3d4e5f6a7b8c9d0e';
  const fake = new FakeGitHub();
  fake.on('GET /repos/anima-research/rayforce/issues/7', { status: 500, body: { message: `credential ${hex} could not be checked` } });
  await fake.start();
  after(() => fake.stop());
  const file = join(mkdtempSync(join(tmpdir(), 'github-mcpl-token-')), 'token');
  writeFileSync(file, `${hex}\n`, { mode: 0o600 });
  const adapter = new GitHubAdapter(
    readConfig({ GITHUB_TOKEN_FILE: file, GITHUB_REPOS: 'anima-research/rayforce', GITHUB_BOT_LOGIN: 'a-human' }),
    { baseUrl: fake.baseUrl, sleep: async () => {} },
  );
  const err = await adapter.getIssue(ISSUE).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof GitHubApiError);
  assert.equal(fake.for('GET /repos/anima-research/rayforce/issues/7')[0].headers.authorization, `token ${hex}`);
  assert.ok(!err.message.includes(hex), err.message);
});

test('contributor mode answers getAuthenticatedBot from GET /user, not GET /app', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /user', { body: { login: 'a-human', id: 4242 } });
  });
  const identity = await r.adapter.getAuthenticatedBot();
  assert.deepEqual(identity, { login: 'a-human', id: 4242, isBot: false });
  assert.equal(r.fake.for('GET /user')[0].headers.authorization, `token ${USER_TOKEN}`);
});

test('checkTokenLogin names the login to set when GITHUB_BOT_LOGIN isn\'t the token\'s, spelled exactly', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /user', { body: { login: 'a-human', id: 4242 } });
  });
  assert.deepEqual(await r.adapter.checkTokenLogin('a-human'), { login: 'a-human', problem: null });
  const checked = await r.adapter.checkTokenLogin('A-Human');
  assert.equal(checked.login, null);
  assert.match(checked.problem ?? '', /set GITHUB_BOT_LOGIN to "a-human", spelled exactly so, or leave it unset/);
});

test('checkTokenLogin takes an unset GITHUB_BOT_LOGIN from GET /user', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /user', { body: { login: 'a-human', id: 4242 } });
  });
  assert.deepEqual(await r.adapter.checkTokenLogin(''), { login: 'a-human', problem: null });
});

test('checkTokenLogin lets a start go on when GitHub can\'t be reached and the login is set, and says it checked nothing; unset, it can\'t', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /user', { status: 503, body: { message: 'unavailable' } });
  });
  assert.deepEqual(await r.adapter.checkTokenLogin('a-human'), { login: 'a-human', problem: null });
  assert.ok(r.logs.some((line) => line.includes('GITHUB_BOT_LOGIN is unchecked')));
  const unset = await r.adapter.checkTokenLogin('');
  assert.equal(unset.login, null);
  assert.match(unset.problem ?? '', /GITHUB_BOT_LOGIN is unset and GET \/user failed/);
});

test('contributor mode does not retry a 401: the token cannot be re-minted', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce/issues/7', { status: 401, body: { message: 'Bad credentials' } });
  });
  let calls = 0;
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', () => {
    calls += 1;
    return { status: 401, body: { message: 'Bad credentials' } };
  });
  await assert.rejects(() => r.adapter.getIssue(ISSUE), GitHubApiError);
  assert.equal(calls, 1, 'App mode retries a 401 once; contributor mode has nothing to re-mint');
});

/** A page of `pulls/12/reviews` as GitHub answers it: page 1 names the last page in its `Link` header. */
function reviewPage(page: number, last: number, rows: unknown[]): Answer {
  const url = (n: number) => `<https://api.github.com/repositories/1/pulls/12/reviews?per_page=100&page=${n}>`;
  return { body: rows, headers: page === 1 && last > 1 ? { link: `${url(2)}; rel="next", ${url(last)}; rel="last"` } : {} };
}

function reviewRows(page: number, submittedAt: string, length = 100): unknown[] {
  return Array.from({ length }, (_, i) => ({
    id: page * 1000 + i,
    user: { login: 'human-one' },
    body: 'b',
    state: 'COMMENTED',
    submitted_at: submittedAt,
    html_url: `https://x/${page * 1000 + i}`,
  }));
}

test('listReviewsSince reads back from the last page to the cursor and answers reviews submitted at or after it, oldest first', async () => {
  const pull = { repo: REPO, number: 12, kind: 'pull' as const };
  const r = await tokenRig((fake) => {
    fake.on(`GET /repos/anima-research/rayforce/pulls/12/reviews`, (req): Answer =>
      req.query.page === '2'
        ? reviewPage(2, 2, [
            { id: 2, user: { login: 'human-two' }, body: 'lgtm', state: 'APPROVED', submitted_at: '2026-10-03T00:00:00Z', html_url: 'https://x/2' },
            { id: 1, user: { login: 'human-one' }, body: 'nit', state: 'COMMENTED', submitted_at: '2026-10-02T00:00:00Z', html_url: 'https://x/1' },
          ])
        : reviewPage(1, 2, reviewRows(1, '2026-10-02T00:00:00Z')),
    );
  });
  const rows = await r.adapter.listReviewsSince(pull, '2026-10-02T00:00:00Z');
  assert.equal(rows.length, 102, 'every page is new, so both are read');
  assert.deepEqual(rows.slice(-2).map((row) => row.id), [1, 2], 'the review in the cursor\'s own second is kept; the poller drops a repeat');
  assert.equal(rows[101].state, 'approved');
  assert.deepEqual(r.fake.for('GET /repos/anima-research/rayforce/pulls/12/reviews').map((req) => req.query.page), ['1', '2']);
});

test('listReviewsSince costs a long history nothing: it reads page 1 and back from the last to the cursor, and caps only new reviews', async () => {
  const pull = { repo: REPO, number: 12, kind: 'pull' as const };
  // 30 pages of reviews, the last starting before the cursor: only page 1 and page 30 are read.
  const long = await tokenRig((fake) => {
    fake.on(`GET /repos/anima-research/rayforce/pulls/12/reviews`, (req): Answer => {
      const page = Number(req.query.page);
      if (page !== 30) return reviewPage(page, 30, reviewRows(page, '2026-09-01T00:00:00Z'));
      return reviewPage(30, 30, [...reviewRows(30, '2026-09-30T00:00:00Z', 40), ...reviewRows(31, '2026-10-05T00:00:00Z', 2)]);
    });
  });
  const rows = await long.adapter.listReviewsSince(pull, '2026-10-01T00:00:00Z');
  assert.deepEqual(rows.map((row) => row.id), [31000, 31001]);
  assert.deepEqual(long.fake.for('GET /repos/anima-research/rayforce/pulls/12/reviews').map((req) => req.query.page), ['1', '30']);

  // A list on one page has no Link header: one request.
  const one = await tokenRig((fake) => {
    fake.on(`GET /repos/anima-research/rayforce/pulls/12/reviews`, { body: [...reviewRows(1, '2026-09-01T00:00:00Z', 3), ...reviewRows(2, '2026-10-05T00:00:00Z', 1)] });
  });
  assert.deepEqual((await one.adapter.listReviewsSince(pull, '2026-10-01T00:00:00Z')).map((row) => row.id), [2000]);
  assert.equal(one.fake.for('GET /repos/anima-research/rayforce/pulls/12/reviews').length, 1);

  // More than 20 pages holding new reviews is more than one read takes: the read stops at the 21st page back, the first past the cap that holds a new review.
  const busy = await tokenRig((fake) => {
    fake.on(`GET /repos/anima-research/rayforce/pulls/12/reviews`, (req): Answer =>
      reviewPage(Number(req.query.page), 22, reviewRows(Number(req.query.page), '2026-10-05T00:00:00Z')),
    );
  });
  await assert.rejects(() => busy.adapter.listReviewsSince(pull, '2026-10-01T00:00:00Z'), ReadCapError);
  assert.equal(busy.fake.for('GET /repos/anima-research/rayforce/pulls/12/reviews').length, 22, 'page 1, twenty pages back, and the 21st page back, which holds a new review');

  // Exactly 21 pages: page 1 counts only if it holds a new review.
  for (const [page1At, fails] of [['2026-10-05T00:00:00Z', true], ['2026-09-01T00:00:00Z', false]] as const) {
    const edge = await tokenRig((fake) => {
      fake.on(`GET /repos/anima-research/rayforce/pulls/12/reviews`, (req): Answer => {
        const page = Number(req.query.page);
        return reviewPage(page, 21, reviewRows(page, page === 1 ? page1At : '2026-10-05T00:00:00Z'));
      });
    });
    const read = edge.adapter.listReviewsSince(pull, '2026-10-01T00:00:00Z');
    if (fails) await assert.rejects(read, ReadCapError);
    else assert.equal((await read).length, 2000, 'twenty pages of new reviews above an old page 1 is one read');
  }

  // A page past the cap that holds older and newer reviews counts: 22 pages, the cursor inside page 2.
  const mixed = await tokenRig((fake) => {
    fake.on(`GET /repos/anima-research/rayforce/pulls/12/reviews`, (req): Answer => {
      const page = Number(req.query.page);
      if (page === 1) return reviewPage(1, 22, reviewRows(1, '2026-09-01T00:00:00Z'));
      if (page === 2) return reviewPage(2, 22, [...reviewRows(2, '2026-09-01T00:00:00Z', 50), ...reviewRows(3000, '2026-10-01T00:00:00Z', 50)]);
      return reviewPage(page, 22, reviewRows(page, '2026-10-05T00:00:00Z'));
    });
  });
  await assert.rejects(mixed.adapter.listReviewsSince(pull, '2026-10-01T00:00:00Z'), ReadCapError, 'a review in the cursor\'s own second is new');

  // The same edge with the old boundary on page 2 of 22: page 2 is read, and counts only if it holds a new review.
  for (const [page2At, fails] of [['2026-10-05T00:00:00Z', true], ['2026-09-01T00:00:00Z', false]] as const) {
    const edge = await tokenRig((fake) => {
      fake.on(`GET /repos/anima-research/rayforce/pulls/12/reviews`, (req): Answer => {
        const page = Number(req.query.page);
        return reviewPage(page, 22, reviewRows(page, page === 1 ? '2026-09-01T00:00:00Z' : page === 2 ? page2At : '2026-10-05T00:00:00Z'));
      });
    });
    const read = edge.adapter.listReviewsSince(pull, '2026-10-01T00:00:00Z');
    if (fails) await assert.rejects(read, ReadCapError);
    else assert.equal((await read).length, 2000, 'twenty pages of new reviews above an old page 2 is one read');
    assert.equal(edge.fake.for('GET /repos/anima-research/rayforce/pulls/12/reviews').length, 22, 'page 1, twenty new pages and page 2');
  }
});

test('listReviewsSince fails a page that isn\'t a list, and a Link with a next page but no last', async () => {
  const pull = { repo: REPO, number: 12, kind: 'pull' as const };
  const odd = await tokenRig((fake) => {
    fake.on(`GET /repos/anima-research/rayforce/pulls/12/reviews`, { body: { message: 'not a list' } });
  });
  await assert.rejects(
    () => odd.adapter.listReviewsSince(pull, '2026-10-01T00:00:00Z'),
    (err: Error) => err.message === 'listReviewsSince: GitHub answered page 1 with something other than a list',
    'the operation named once',
  );
  const byCursor = await tokenRig((fake) => {
    fake.on(`GET /repos/anima-research/rayforce/pulls/12/reviews`, {
      body: reviewRows(1, '2026-10-05T00:00:00Z'),
      headers: { link: '<https://api.github.com/repositories/1/pulls/12/reviews?per_page=100&after=abc>; rel="next"' },
    });
  });
  await assert.rejects(() => byCursor.adapter.listReviewsSince(pull, '2026-10-01T00:00:00Z'), /named a next page but no last page/);
});

test('listNotifications lists read threads too, since W, every page, with If-Modified-Since on the first page only', async () => {
  const row = (n: number) => ({
    id: String(n),
    updated_at: '2026-10-15T00:00:00Z',
    reason: 'mention',
    unread: false,
    subject: { type: 'Issue', url: `https://api.github.com/repos/anima-research/rayforce/issues/${n}`, title: `#${n}` },
    repository: { full_name: 'anima-research/rayforce' },
  });
  const r = await tokenRig((fake) => {
    fake.on('GET /notifications', (req): Answer => ({
      headers: req.query.page === '1' ? { 'last-modified': 'Wed, 15 Oct 2026 00:05:00 GMT', date: 'Wed, 15 Oct 2026 00:05:01 GMT', 'x-poll-interval': '90' } : {},
      body: req.query.page === '1' ? Array.from({ length: 50 }, (_, i) => row(i + 1)) : [row(51)],
    }));
  });
  const page = await r.adapter.listNotifications({ since: '2026-10-14T00:00:00.000Z', ifModifiedSince: 'Wed, 15 Oct 2026 00:00:00 GMT' });
  assert.equal(page.notModified, false);
  assert.equal(page.notifications.length, 51);
  assert.equal(page.lastModified, 'Wed, 15 Oct 2026 00:05:00 GMT');
  assert.equal(page.date, 'Wed, 15 Oct 2026 00:05:01 GMT');
  assert.equal(page.pollIntervalSeconds, 90);
  const sent = r.fake.for('GET /notifications');
  assert.deepEqual(
    sent.map((req) => [req.query.all, req.query.participating, req.query.since, req.query.page, req.headers['if-modified-since'] ?? null]),
    [
      ['true', 'true', '2026-10-14T00:00:00.000Z', '1', 'Wed, 15 Oct 2026 00:00:00 GMT'],
      ['true', 'true', '2026-10-14T00:00:00.000Z', '2', null],
    ],
  );
});

test('listNotifications reports a 304 as notModified, with the 304\'s own headers', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /notifications', { status: 304, headers: { 'last-modified': 'Wed, 15 Oct 2026 00:05:00 GMT', 'x-poll-interval': '120' } });
  });
  const page = await r.adapter.listNotifications({ since: '2026-10-14T00:00:00.000Z', ifModifiedSince: 'Wed, 15 Oct 2026 00:05:00 GMT' });
  assert.equal(page.notModified, true);
  assert.deepEqual(page.notifications, []);
  assert.equal(page.lastModified, 'Wed, 15 Oct 2026 00:05:00 GMT');
  assert.equal(page.pollIntervalSeconds, 120);
});

test('listNotifications takes the rate-limit retry every call has', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /notifications', (_req, nth): Answer =>
      nth === 0
        ? { status: 403, headers: { 'retry-after': '1' }, body: { message: 'You have exceeded a secondary rate limit.' } }
        : { headers: { 'last-modified': 'Wed, 15 Oct 2026 00:05:00 GMT' }, body: [] },
    );
  });
  const page = await r.adapter.listNotifications({ since: '2026-10-14T00:00:00.000Z', ifModifiedSince: null });
  assert.equal(page.notModified, false);
  assert.deepEqual(r.sleeps, [1000]);
});

test('listNotifications refused for a token that isn\'t classic names the token type it needs', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /notifications', { status: 403, body: { message: 'Resource not accessible by personal access token' } });
  });
  const err = await r.adapter.listNotifications({ since: '2026-10-14T00:00:00.000Z', ifModifiedSince: null }).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 403);
  assert.match(err.message, /personal access token \(classic\) only/);
});

test('listNotifications maps a subject into a repo, kind and number, and drops what it cannot map', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /notifications', {
      body: [
        {
          id: '1',
          updated_at: '2026-10-15T00:00:00Z',
          reason: 'mention',
          unread: true,
          subject: { type: 'Issue', url: 'https://api.github.com/repos/anima-research/rayforce/issues/7', title: 'A bug' },
          repository: { full_name: 'anima-research/rayforce' },
        },
        {
          id: '2',
          updated_at: '2026-10-15T00:00:00Z',
          reason: 'subscribed',
          unread: true,
          subject: { type: 'Discussion', url: null, title: 'off-topic' },
          repository: { full_name: 'anima-research/rayforce' },
        },
        {
          id: '3',
          updated_at: '2026-10-15T00:00:00Z',
          reason: 'author',
          unread: false,
          subject: { type: 'PullRequest', url: 'https://api.github.com/repos/anima-research/rayforce/pulls/12', title: 'Fix it' },
          repository: { full_name: 'anima-research/rayforce' },
        },
      ],
    });
  });
  const page = await r.adapter.listNotifications({ since: '2026-10-14T00:00:00.000Z', ifModifiedSince: null });
  assert.equal(page.notifications.length, 2);
  assert.deepEqual([page.notifications[1].kind, page.notifications[1].number], ['pull', 12]);
  assert.deepEqual(page.notifications[0], {
    id: '1',
    updatedAt: '2026-10-15T00:00:00Z',
    reason: 'mention',
    unread: true,
    repo: { owner: 'anima-research', name: 'rayforce' },
    kind: 'issue',
    number: 7,
    title: 'A bug',
  });
});

test('getPolledThread reads only the issues endpoint: state, close time and closer, whether a pull request was merged, and no head', async () => {
  const pull = { repo: REPO, number: 12, kind: 'pull' as const };
  const r = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce/issues/12', {
      body: {
        id: 9012,
        number: 12,
        title: 'Fix it',
        body: 'the fix',
        state: 'open',
        user: { login: 'agent' },
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-15T00:00:00Z',
        html_url: 'https://github.com/anima-research/rayforce/pull/12',
        pull_request: { merged_at: null },
      },
    });
    fake.on('GET /repos/anima-research/rayforce/issues/14', {
      body: {
        id: 9014,
        number: 14,
        title: 'Fix more',
        body: '',
        state: 'closed',
        user: { login: 'agent' },
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-15T00:00:00Z',
        closed_at: '2026-10-15T00:00:00Z',
        closed_by: { login: 'maintainer' },
        html_url: 'https://github.com/anima-research/rayforce/pull/14',
        pull_request: { merged_at: '2026-10-15T00:00:00Z' },
      },
    });
    fake.on('GET /repos/anima-research/rayforce/issues/7', {
      body: {
        id: 9007,
        number: 7,
        title: 'A bug',
        body: '',
        state: 'closed',
        user: { login: 'agent' },
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-15T00:00:00Z',
        closed_at: '2026-10-15T00:00:00Z',
        closed_by: { login: 'maintainer' },
        html_url: 'https://github.com/anima-research/rayforce/issues/7',
      },
    });
  });
  const open = await r.adapter.getPolledThread(pull);
  assert.equal(open.isPullRequest, true);
  assert.equal(open.headSha, undefined);
  assert.equal(open.merged, false);
  const merged = await r.adapter.getPolledThread({ repo: REPO, number: 14, kind: 'pull' });
  assert.equal(merged.merged, true);
  const closed = await r.adapter.getPolledThread(ISSUE);
  assert.equal(closed.closedAt, '2026-10-15T00:00:00Z');
  assert.equal(closed.closedBy?.login, 'maintainer');
  assert.equal(closed.merged, undefined, 'an issue says nothing of a merge');
  assert.deepEqual(r.fake.for('GET /repos/anima-research/rayforce/pulls/12'), [], 'an open pull request\'s head is not read');
});

test('listCommentsSince and listPullReviewCommentsSince read one thread\'s rows since its cursor, every page', async () => {
  const pull = { repo: REPO, number: 12, kind: 'pull' as const };
  const rowsOf = (page: string | undefined, base: number) =>
    Array.from({ length: page === '2' ? 3 : 100 }, (_, i) => ({
      id: base + (page === '2' ? 100 : 0) + i,
      user: { login: 'human-one' },
      body: 'b',
      created_at: '2026-10-15T00:00:00Z',
      updated_at: '2026-10-15T00:00:00Z',
      html_url: 'https://x',
    }));
  const r = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce/issues/7/comments', (req): Answer => ({ body: rowsOf(req.query.page, 1000) }));
    fake.on('GET /repos/anima-research/rayforce/pulls/12/comments', (req): Answer => ({ body: rowsOf(req.query.page, 5000) }));
  });
  const comments = await r.adapter.listCommentsSince(ISSUE, '2026-10-14T00:00:00Z');
  assert.equal(comments.length, 103);
  assert.ok(comments.every((c) => c.number === 7));
  const reviewComments = await r.adapter.listPullReviewCommentsSince(pull, '2026-10-14T00:00:00Z');
  assert.equal(reviewComments.length, 103);
  assert.ok(reviewComments.every((c) => c.number === 12));
  const sent = r.fake.for('GET /repos/anima-research/rayforce/pulls/12/comments')[0].query;
  assert.deepEqual([sent.since, sent.sort, sent.direction], ['2026-10-14T00:00:00Z', 'updated', 'asc']);
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/7/comments')[0].query.since, '2026-10-14T00:00:00Z');
});

test('isLastingFailure: gone or out of reach is lasting; a rate limit, a server error or a network failure passes', () => {
  assert.equal(isLastingFailure(new GitHubApiError(404, 'Not Found', 'getPolledThread')), true);
  assert.equal(isLastingFailure(new GitHubApiError(410, 'Gone', 'getPolledThread')), true);
  assert.equal(isLastingFailure(new GitHubApiError(403, 'Resource not accessible by personal access token', 'getPolledThread')), true);
  assert.equal(isLastingFailure(new GitHubApiError(403, 'You have exceeded a secondary rate limit.', 'getPolledThread')), false);
  assert.equal(isLastingFailure(new GitHubApiError(403, 'API rate limit exceeded for user.', 'getPolledThread')), false);
  assert.equal(isLastingFailure(new GitHubApiError(502, 'Bad gateway', 'getPolledThread')), false);
  assert.equal(isLastingFailure(new Error('socket hang up')), false);
});

test('checkTokenLogin refuses a start whose token GitHub refuses, the login set or not', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /user', { status: 401, body: { message: 'Bad credentials' } });
  });
  assert.match((await r.adapter.checkTokenLogin('a-human')).problem ?? '', /GET \/user refused the token in GITHUB_TOKEN_FILE/);
  assert.match((await r.adapter.checkTokenLogin('')).problem ?? '', /GET \/user refused the token in GITHUB_TOKEN_FILE, so its login is unknown/);
});

test('listNotifications reads a page past its cap only to learn whether there was more', async () => {
  const row = (n: number) => ({
    id: String(n),
    updated_at: '2026-10-15T00:00:00Z',
    reason: 'mention',
    unread: false,
    subject: { type: 'Issue', url: `https://api.github.com/repos/anima-research/rayforce/issues/${n}`, title: `#${n}` },
    repository: { full_name: 'anima-research/rayforce' },
  });
  const full = (page: number) => Array.from({ length: 50 }, (_, i) => row(page * 100 + i));
  const exact = await tokenRig((fake) => {
    fake.on('GET /notifications', (req): Answer => ({ body: Number(req.query.page) <= 20 ? full(Number(req.query.page)) : [] }));
  });
  const complete = await exact.adapter.listNotifications({ since: '2026-10-14T00:00:00Z', ifModifiedSince: null });
  assert.equal(complete.notifications.length, 1000);
  assert.equal(complete.truncated, false, 'twenty full pages and an empty twenty-first is the whole list');

  const more = await tokenRig((fake) => {
    fake.on('GET /notifications', (req): Answer => ({ body: full(Number(req.query.page)) }));
  });
  const capped = await more.adapter.listNotifications({ since: '2026-10-14T00:00:00Z', ifModifiedSince: null });
  assert.equal(capped.notifications.length, 1000);
  assert.equal(capped.truncated, true);
  assert.equal(more.fake.for('GET /notifications').length, 21);
});

test('checkTokenLogin: a 403 that isn\'t a rate limit refuses the start; a rate-limited one lets it go on, unchecked', async () => {
  const refused = await tokenRig((fake) => {
    fake.on('GET /user', { status: 403, body: { message: 'Resource not accessible by personal access token' } });
  });
  assert.match((await refused.adapter.checkTokenLogin('a-human')).problem ?? '', /GET \/user refused the token in GITHUB_TOKEN_FILE/);

  const limited = await tokenRig((fake) => {
    fake.on('GET /user', { status: 403, body: { message: 'API rate limit exceeded for user ID 1.' } });
  });
  assert.deepEqual(await limited.adapter.checkTokenLogin('a-human'), { login: 'a-human', problem: null });
  assert.ok(limited.logs.some((line) => line.includes('GITHUB_BOT_LOGIN is unchecked')));
});

test('listOwnOpenPulls asks one search for the user\'s open pull requests in GITHUB_REPOS, and keeps only those', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /search/issues', {
      body: {
        items: [
          { number: 12, updated_at: '2026-10-15T00:09:00Z', html_url: 'https://github.com/anima-research/rayforce/pull/12', repository_url: 'https://api.github.com/repos/Anima-Research/rayforce', pull_request: {} },
          { number: 13, updated_at: '2026-10-15T00:08:00Z', html_url: 'https://github.com/someone/else/pull/13', repository_url: 'https://api.github.com/repos/someone/else', pull_request: {} },
          { number: 14, updated_at: '2026-10-15T00:07:00Z', html_url: 'https://github.com/anima-research/rayforce/issues/14', repository_url: 'https://api.github.com/repos/anima-research/rayforce' },
        ],
      },
    });
  });
  const repos = [{ owner: 'anima-research', name: 'rayforce' }];
  assert.deepEqual(await r.adapter.listOwnOpenPulls('a-human', repos), [
    { repo: repos[0], number: 12, updatedAt: '2026-10-15T00:09:00Z', html_url: 'https://github.com/anima-research/rayforce/pull/12' },
  ]);
  const call = r.fake.for('GET /search/issues')[0];
  assert.equal(call.query.q, 'is:pr is:open author:a-human repo:anima-research/rayforce');
  assert.equal(call.query.sort, 'updated');
});

test('getPullHeadSha reads the pull request alone, with no check runs', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce/pulls/12', { body: { number: 12, head: { sha: 'abc123', ref: 'fix' } } });
  });
  assert.equal(await r.adapter.getPullHeadSha({ repo: { owner: 'anima-research', name: 'rayforce' }, number: 12, kind: 'pull' }), 'abc123');
  assert.equal(r.fake.calls.some((c) => c.path.includes('check-runs')), false);
  const headless = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce/pulls/12', { body: { number: 12, head: {} } });
  });
  await assert.rejects(
    () => headless.adapter.getPullHeadSha({ repo: { owner: 'anima-research', name: 'rayforce' }, number: 12, kind: 'pull' }),
    (err: Error) => err.message === 'getPullHeadSha: GitHub answered with no head sha',
    'the operation named once',
  );
});

test('isRateLimit: a 429, or a 403 that says rate limit; nothing else', () => {
  assert.equal(isRateLimit(new GitHubApiError(429, 'Too Many Requests', 'listCommentsSince')), true);
  assert.equal(isRateLimit(new GitHubApiError(403, 'You have exceeded a secondary rate limit.', 'listCommentsSince')), true);
  assert.equal(isRateLimit(new GitHubApiError(403, 'Resource not accessible by personal access token', 'listCommentsSince')), false);
  assert.equal(isRateLimit(new GitHubApiError(502, 'Bad gateway', 'listCommentsSince')), false);
  assert.equal(isRateLimit(new Error('socket hang up')), false);
});

test('describeFailure says GitHub answered only when it did', () => {
  assert.equal(describeFailure(new GitHubApiError(502, 'Bad gateway', 'getPolledThread')), 'GitHub answered 502: Bad gateway');
  assert.equal(describeFailure(new GitHubApiError(500, 'fetch failed', 'getPolledThread', false, false)), 'the request to GitHub failed: fetch failed');
  assert.equal(describeFailure(new GitHubApiError(0, 'GitHub answered page 2 with something other than a list', 'listCommentsSince')), 'GitHub answered page 2 with something other than a list');
  assert.equal(describeFailure(new Error('socket hang up')), 'the request to GitHub failed: socket hang up');
  assert.equal(new GitHubApiError(0, 'x', 'listCommentsSince').message, 'listCommentsSince: x', 'no "GitHub 0"');
});

test('listNotifications: a page past the cap with any row, or one that fails, marks the listing truncated, which still answers with what was listed', async () => {
  const row = (n: number) => ({
    id: String(n),
    updated_at: '2026-10-15T00:00:00Z',
    reason: 'mention',
    unread: false,
    subject: { type: 'Issue', url: `https://api.github.com/repos/anima-research/rayforce/issues/${n}`, title: `#${n}` },
    repository: { full_name: 'anima-research/rayforce' },
  });
  const full = (page: number) => Array.from({ length: 50 }, (_, i) => row(page * 100 + i));
  const failing = await tokenRig((fake) => {
    fake.on('GET /notifications', (req): Answer =>
      Number(req.query.page) <= 20 ? { body: full(Number(req.query.page)) } : { status: 502, body: { message: 'Bad gateway' } },
    );
  });
  const page = await failing.adapter.listNotifications({ since: '2026-10-14T00:00:00Z', ifModifiedSince: null });
  assert.equal(page.notifications.length, 1000);
  assert.equal(page.truncated, true, 'a probe that fails may have hidden more');

  const unmappable = await tokenRig((fake) => {
    fake.on('GET /notifications', (req): Answer =>
      Number(req.query.page) <= 20
        ? { body: full(Number(req.query.page)) }
        : { body: [{ ...row(1), subject: { type: 'Discussion', url: null, title: 'off-topic' } }] },
    );
  });
  const rest = await unmappable.adapter.listNotifications({ since: '2026-10-14T00:00:00Z', ifModifiedSince: null });
  assert.equal(rest.notifications.length, 1000);
  assert.equal(rest.truncated, true, 'a row the poller can\'t read may still be followed by ones it can');

  const readable = await tokenRig((fake) => {
    fake.on('GET /notifications', (req): Answer => ({ body: Number(req.query.page) <= 20 ? full(Number(req.query.page)) : [row(9999)] }));
  });
  assert.equal((await readable.adapter.listNotifications({ since: '2026-10-14T00:00:00Z', ifModifiedSince: null })).truncated, true);
});

test('a per-thread read takes exactly 2,000 rows whole, fails past them, and fails a page that isn\'t a list', async () => {
  const rows = (page: number, length = 100) =>
    Array.from({ length }, (_, i) => ({
      id: page * 1000 + i,
      user: { login: 'human-one' },
      body: 'b',
      created_at: '2026-10-15T00:00:00Z',
      updated_at: '2026-10-15T00:00:00Z',
      html_url: 'https://x',
    }));
  const exact = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce/issues/7/comments', (req): Answer => ({ body: Number(req.query.page) <= 20 ? rows(Number(req.query.page)) : [] }));
  });
  assert.equal((await exact.adapter.listCommentsSince(ISSUE, '2026-10-14T00:00:00Z')).length, 2000);

  const more = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce/issues/7/comments', (req): Answer => ({ body: rows(Number(req.query.page)) }));
  });
  await assert.rejects(
    () => more.adapter.listCommentsSince(ISSUE, '2026-10-14T00:00:00Z'),
    (err: unknown) =>
      err instanceof ReadCapError && err.message === 'listCommentsSince: more than 2000 comments or reviews to read at once',
  );

  const odd = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce/issues/7/comments', { body: { message: 'not a list' } });
  });
  await assert.rejects(
    () => odd.adapter.listCommentsSince(ISSUE, '2026-10-14T00:00:00Z'),
    (err: Error) => err.message === 'listCommentsSince: GitHub answered page 1 with something other than a list',
    'the operation named once',
  );
});

test('searchIssues drops every repo:, user:, org: and owner: qualifier, so the search stays in the one repository', async () => {
  // A negated one goes too: an owner exclusion inside one repository excludes all of it or nothing, so
  // dropping it loses no useful exclusion, and the scrub stays one pattern.
  for (const qualifier of ['repo:someone/else', 'user:someone', 'org:someone', 'owner:someone', '-user:someone', 'USER:someone']) {
    const r = await rig();
    await r.adapter.searchIssues(REPO, `is:open ${qualifier} flaky`);
    assert.equal(r.fake.for('GET /search/issues')[0].query.q, 'repo:anima-research/rayforce is:open flaky', qualifier);
  }
  // GitHub reads a qualifier right after a quote or a bracket too: `"x"user:octocat` widened a live search.
  for (const [query, sent] of [
    ['"x"user:someone flaky', 'repo:anima-research/rayforce "x" flaky'],
    ['(user:someone) flaky', 'repo:anima-research/rayforce ( ) flaky'],
    ['flaky (bug org:someone)', 'repo:anima-research/rayforce flaky (bug )'],
  ] as const) {
    const r = await rig();
    await r.adapter.searchIssues(REPO, query);
    assert.equal(r.fake.for('GET /search/issues')[0].query.q, sent, query);
  }
});

test('searchIssues leaves out, and counts, any result from another repository; GitHub\'s spelling of this one is kept', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /search/issues', {
      body: {
        total_count: 3,
        items: [
          { ...ISSUE_PAYLOAD, number: 7, repository_url: 'https://api.github.com/repos/Anima-Research/Rayforce' },
          { ...ISSUE_PAYLOAD, number: 8, repository_url: 'https://api.github.com/repos/someone/private-thing' },
          { ...ISSUE_PAYLOAD, number: 9 },
        ],
      },
    });
  });
  const { hits, outside } = await r.adapter.searchIssues(REPO, 'flaky');
  assert.deepEqual(hits.map((h) => h.number), [7]);
  assert.equal(outside, 2, 'one from another repository, and one that names none');
});

test('repoSpellingProblems names an entry GitHub spells otherwise, and one the token can\'t see; GitHub not answering checks nothing', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce', { body: { full_name: 'anima-research/rayforce' } });
    fake.on('GET /repos/the-glassy/github-mcpl', { body: { full_name: 'The-Glassy/github-mcpl' } });
    fake.on('GET /repos/someone/gone', { status: 404, body: { message: 'Not Found' } });
    fake.on('GET /repos/someone/busy', { status: 502, body: { message: 'Bad gateway' } });
  });
  const problems = await r.adapter.repoSpellingProblems([
    { owner: 'anima-research', name: 'rayforce' },
    { owner: 'the-glassy', name: 'github-mcpl' },
    { owner: 'someone', name: 'gone' },
    { owner: 'someone', name: 'busy' },
  ]);
  assert.deepEqual(problems, [
    'GITHUB_REPOS names "the-glassy/github-mcpl", but GitHub spells it "The-Glassy/github-mcpl": set it to "The-Glassy/github-mcpl", spelled exactly so',
    'GITHUB_REPOS names "someone/gone", which the token in GITHUB_TOKEN_FILE can\'t see (GitHub answered 404: Not Found)',
  ]);
  assert.ok(r.logs.some((line) => line.includes('unchecked against GitHub') && line.includes('someone/busy')));
});

test('a request that fails before GitHub answers is told apart from an answer', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce/issues/7', { body: {} });
  });
  await r.fake.stop();
  const err = await r.adapter.getPolledThread(ISSUE).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof GitHubApiError, String(err));
  assert.equal(err.answered, false);
  assert.match(describeFailure(err), /^the request to GitHub failed: /);
});

test('token-mode error diagnostics preserve answered independently of uncertain writes', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce/issues/7', { status: 502, body: { message: 'synthetic read failure' } });
    fake.on('POST /repos/anima-research/rayforce/issues/7/comments', { status: 502, body: { message: 'synthetic write failure' } });
  });
  for (const [call, possiblyDone] of [
    [() => r.adapter.getIssue(ISSUE), false],
    [() => r.adapter.createComment(ISSUE, 'synthetic comment'), true],
  ] as const) {
    await assert.rejects(call, (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.answered, true);
      assert.equal(error.possiblyDone, possiblyDone);
      assert.match(describeFailure(error), /^GitHub answered 502:/);
      return true;
    });
  }
  assert.equal(r.fake.for('POST /repos/anima-research/rayforce/issues/7/comments').length, 1, 'a possibly completed write is not repeated');
  const noAnswer = new GitHubApiError(500, 'synthetic connection loss', 'createComment', true, false);
  assert.equal(noAnswer.possiblyDone, true);
  assert.match(describeFailure(noAnswer), /^the request to GitHub failed:/);
});

test('contributor pagination extracts page numbers but never fetches a response-supplied origin', async () => {
  const r = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce/pulls/12/reviews', (req): Answer => ({
      body: [{ id: Number(req.query.page), submitted_at: '2026-10-15T00:00:00Z', state: 'COMMENTED', user: { login: 'reviewer' } }],
      headers: Number(req.query.page) === 1 ? { link: '<https://untrusted.example.invalid/steal?page=2>; rel="last"' } : {},
    }));
  });
  const rows = await r.adapter.listReviewsSince(PULL, '2026-10-14T00:00:00Z');
  assert.equal(rows.length, 2);
  assert.deepEqual(r.fake.calls.map((call) => call.path), [
    '/repos/anima-research/rayforce/pulls/12/reviews',
    '/repos/anima-research/rayforce/pulls/12/reviews',
  ]);
  assert.ok(r.fake.calls.every((call) => call.headers.authorization === `token ${USER_TOKEN}`));
});

test('token authorization is not forwarded by fetch to a different redirect origin', async () => {
  const sink = new FakeGitHub();
  sink.on('GET /redirected', { body: ISSUE_PAYLOAD });
  await sink.start();
  after(() => sink.stop());
  const r = await tokenRig((fake) => {
    fake.on('GET /repos/anima-research/rayforce/issues/7', { status: 302, headers: { location: `${sink.baseUrl}/redirected` } });
  });
  await r.adapter.getIssue(ISSUE);
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/7')[0].headers.authorization, `token ${USER_TOKEN}`);
  assert.equal(sink.for('GET /redirected').length, 1);
  assert.equal(sink.for('GET /redirected')[0].headers.authorization, undefined);
});
