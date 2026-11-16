import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { GitHubAdapter, GitHubApiError } from '../src/github-adapter.js';
import { GithubState } from '../src/state.js';
import { commentsToolModule } from '../src/tools-comments.js';
import { issuesToolModule } from '../src/tools-issues-pr.js';
import { readToolModule } from '../src/tools-read.js';
import { readConfig, silentLogger, type RepoRef, type ThreadRef, type ToolContext, type ToolResult } from '../src/types.js';

const REPO: RepoRef = { owner: 'anima-research', name: 'rayforce' };
const PULL: ThreadRef = { repo: REPO, number: 12, kind: 'pull' };
const R = '/repos/anima-research/rayforce';
const INSTALLATION_ID = 42;

const KEY_FILE = join(mkdtempSync(join(tmpdir(), 'github-mcpl-key-')), 'app.pem');
writeFileSync(
  KEY_FILE,
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey,
  { mode: 0o600 },
);

type Answer = { status: number; body?: unknown } | 'lost';

class FakeGitHub {
  readonly received: { method: string; path: string; body: string }[] = [];
  private readonly answers = new Map<string, Answer>([
    [`POST /app/installations/${INSTALLATION_ID}/access_tokens`, { status: 201, body: { token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() } }],
    [`GET ${R}/installation`, { status: 200, body: { id: INSTALLATION_ID } }],
  ]);
  private server: Server | null = null;
  baseUrl = '';

  on(route: string, answer: Answer): this {
    this.answers.set(route, answer);
    return this;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        this.received.push({ method: req.method ?? '', path, body });
        const answer = this.answers.get(`${req.method} ${path}`) ?? { status: 404, body: { message: 'Not Found' } };
        if (answer === 'lost') {
          req.socket.destroy();
          return;
        }
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

const fakes: FakeGitHub[] = [];
after(async () => {
  await Promise.all(fakes.map((f) => f.stop()));
});

async function rig(routes: Record<string, Answer>): Promise<{ fake: FakeGitHub; adapter: GitHubAdapter; ctx: ToolContext }> {
  const fake = new FakeGitHub();
  for (const [route, answer] of Object.entries(routes)) fake.on(route, answer);
  await fake.start();
  fakes.push(fake);
  const config = readConfig({
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY_FILE: KEY_FILE,
    GITHUB_APP_INSTALLATION_ID: String(INSTALLATION_ID),
    GITHUB_REPOS: 'anima-research/rayforce',
    GITHUB_BOT_LOGIN: 'rayforce-clone[bot]',
    GITHUB_PR_BASE_ALLOW: 'dev',
  });
  const logger = silentLogger();
  const adapter = new GitHubAdapter(config, { baseUrl: fake.baseUrl, logger, sleep: async () => {} });
  const ctx: ToolContext = {
    api: adapter,
    state: GithubState.empty(null, logger),
    botLogin: 'rayforce-clone[bot]',
    repos: [REPO],
    prBaseAllow: ['dev'],
    logger,
  };
  return { fake, adapter, ctx };
}

function text(result: ToolResult): string {
  return result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
}

test('a comment GitHub stored whose answer was lost reads as unknown, not as failed', { timeout: 10_000 }, async () => {
  const { fake, ctx } = await rig({ [`POST ${R}/issues/7/comments`]: 'lost' });

  const result = await commentsToolModule.call('comment', { thread: 7, body: 'hello' }, ctx);

  assert.ok(fake.received.some((r) => r.method === 'POST' && r.path === `${R}/issues/7/comments` && r.body.includes('hello')), 'GitHub got the comment');
  assert.equal(result.isError, true);
  const said = text(result);
  assert.match(said, /whether it took effect is unknown/);
  assert.match(said, /rollback has no record of it/);
  assert.doesNotMatch(said, /failed/);
});

test("GitHub's own 5xx on a write reads as unknown too", { timeout: 10_000 }, async () => {
  const { ctx } = await rig({ [`POST ${R}/issues/7/comments`]: { status: 502, body: { message: 'Server Error' } } });

  const result = await commentsToolModule.call('comment', { thread: 7, body: 'hello' }, ctx);

  assert.equal(result.isError, true);
  assert.match(text(result), /GitHub answered createComment with 502 \(Server Error\), so whether it took effect is unknown/);
});

test('an issue GitHub created whose answer was lost reads as unknown, not as failed', { timeout: 10_000 }, async () => {
  const { fake, ctx } = await rig({ [`POST ${R}/issues`]: 'lost' });

  const result = await issuesToolModule.call('create_issue', { title: 'A bug' }, ctx);

  assert.ok(fake.received.some((r) => r.method === 'POST' && r.path === `${R}/issues`), 'GitHub got the issue');
  assert.equal(result.isError, true);
  assert.match(text(result), /^create_issue: no answer came back from GitHub for createIssue \(.+\), so whether it took effect is unknown/);
  assert.doesNotMatch(text(result), /failed|rollback/);
});

test('a read whose answer was lost still reads as failed', { timeout: 10_000 }, async () => {
  const { ctx } = await rig({ [`GET ${R}/issues/7`]: 'lost' });

  const result = await readToolModule.call('get_issue', { number: 7 }, ctx);

  assert.equal(result.isError, true);
  assert.match(text(result), /^get_issue failed: /);
  assert.doesNotMatch(text(result), /unknown/);
});

test("a write tool's own lookup whose answer was lost is a failed read, and nothing is written", { timeout: 10_000 }, async () => {
  const { fake, ctx } = await rig({ [`GET ${R}/issues/7/comments`]: 'lost' });

  const failure = await commentsToolModule.call('upsert_sticky_comment', { thread: 7, marker: 'ci-status', body: 'green' }, ctx).then(
    () => assert.fail('upsert_sticky_comment should have thrown'),
    (err: unknown) => err,
  );

  assert.ok(failure instanceof GitHubApiError);
  assert.equal(failure.operation, 'listComments');
  assert.notEqual(failure.possiblyDone, true);
  assert.ok(!fake.received.some((r) => r.method !== 'GET' && r.path.startsWith(R)), 'nothing was written');
});

test("a token mint whose answer was lost is a failure of the tool's request, which never went out", { timeout: 10_000 }, async () => {
  const { fake, ctx } = await rig({ [`POST /app/installations/${INSTALLATION_ID}/access_tokens`]: 'lost' });

  const read = await readToolModule.call('get_issue', { number: 7 }, ctx);
  assert.equal(read.isError, true);
  assert.match(text(read), /^get_issue failed: /);
  assert.doesNotMatch(text(read), /unknown/);

  const write = await commentsToolModule.call('comment', { thread: 7, body: 'hello' }, ctx).then(
    () => assert.fail('comment should have thrown'),
    (err: unknown) => err,
  );
  assert.ok(write instanceof GitHubApiError);
  assert.equal(write.operation, 'mintInstallationToken');
  assert.notEqual(write.possiblyDone, true);
  assert.ok(!fake.received.some((r) => r.path.startsWith(R)), 'no request for the repository went out');
});

test('a write GitHub refused with a 4xx still reads as failed', { timeout: 10_000 }, async () => {
  const { ctx } = await rig({ [`POST ${R}/issues`]: { status: 422, body: { message: 'Validation Failed' } } });

  const result = await issuesToolModule.call('create_issue', { title: 'A bug' }, ctx);

  assert.equal(result.isError, true);
  assert.match(text(result), /^create_issue failed: GitHub error 422: /);
});

test('a GraphQL mutation whose answer was lost may have taken effect; a GraphQL query may not', { timeout: 10_000 }, async () => {
  const { adapter } = await rig({ 'POST /graphql': 'lost' });

  const mutation = await adapter.resolveReviewThread('PRRT_x').then(
    () => assert.fail('resolveReviewThread should have thrown'),
    (err: unknown) => err,
  );
  assert.ok(mutation instanceof GitHubApiError);
  assert.equal(mutation.possiblyDone, true);
  assert.equal(mutation.answered, false);

  const query = await adapter.listReviewThreads(PULL).then(
    () => assert.fail('listReviewThreads should have thrown'),
    (err: unknown) => err,
  );
  assert.ok(query instanceof GitHubApiError);
  assert.equal(query.possiblyDone, false);
});

