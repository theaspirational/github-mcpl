import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { McplConnection } from '@animalabs/mcpl-core';
import { GitHubMcplServer } from '../src/server.js';
import type { Logger } from '../src/types.js';
import { FakeGitHubApi, TEST_BOT, TEST_REPO } from './harness.js';

function capturingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  };
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

/** A server serving one connection whose host side is written as raw lines, so a frame reaches the server's reader byte for byte. */
function rawHost() {
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const logger = capturingLogger();
  const server = new GitHubMcplServer(new FakeGitHubApi(), { botLogin: TEST_BOT.login, repos: [TEST_REPO], logger });
  const served = server.serve(McplConnection.fromStreams(toServer, toHost));

  const answers = new Map<number, unknown>();
  let buffered = '';
  toHost.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      const msg = JSON.parse(line) as { id?: number };
      if (typeof msg.id === 'number') answers.set(msg.id, msg);
    }
  });

  async function answerTo(id: number, ms = 2000): Promise<unknown> {
    const deadline = Date.now() + ms;
    while (!answers.has(id)) {
      if (Date.now() > deadline) throw new Error(`no answer to request ${id} within ${ms} ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return answers.get(id);
  }

  async function initialize(): Promise<void> {
    toServer.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw-host', version: '0' } },
      }) + '\n',
    );
    await answerTo(1);
    toServer.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  return { toServer, logger, served, answerTo, initialize };
}

test('a request whose string holds U+2028 or U+2029 is answered', { timeout: 5000 }, async (t) => {
  const h = rawHost();
  t.after(() => h.toServer.end());
  await h.initialize();

  // Written by hand: JSON.stringify leaves U+2028 and U+2029 unescaped, as a host's encoder may.
  h.toServer.write(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"cursor":"a\u2028b"}}\n`);
  h.toServer.write(`{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{"cursor":"a\u2029b"}}\n`);

  for (const id of [2, 3]) {
    const answer = (await h.answerTo(id)) as { result?: unknown };
    assert.ok(answer.result, `request ${id} is answered with a result`);
  }
});

test('a malformed line is logged, and the next request is answered', { timeout: 5000 }, async (t) => {
  const h = rawHost();
  t.after(() => h.toServer.end());
  await h.initialize();

  h.toServer.write('not json\n');
  h.toServer.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');

  const answer = (await h.answerTo(2)) as { result?: unknown };
  assert.ok(answer.result, 'request 2 is answered after the malformed line');
  assert.ok(
    h.logger.lines.some((l) => l.startsWith('error ') && l.includes('Malformed JSON-RPC message')),
    `the malformed line is logged: ${JSON.stringify(h.logger.lines)}`,
  );
});

test('a stream error ends serve() and is logged', { timeout: 5000 }, async () => {
  const h = rawHost();
  await h.initialize();

  h.toServer.destroy(new Error('read ECONNRESET (test)'));
  await h.served;

  assert.ok(
    h.logger.lines.some((l) => l.startsWith('error ') && l.includes('read ECONNRESET (test)')),
    `the stream error is logged: ${JSON.stringify(h.logger.lines)}`,
  );
});

test('a clean host EOF ends serve without a connection error', { timeout: 5000 }, async () => {
  const h = rawHost();
  await h.initialize();
  h.toServer.end();
  await h.served;
  assert.equal(h.logger.lines.some((line) => line.startsWith('error ')), false);
});

test('UTF-8 split inside a multibyte character remains one JSON-RPC request', { timeout: 5000 }, async (t) => {
  const h = rawHost();
  t.after(() => h.toServer.end());
  await h.initialize();
  const wire = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { cursor: '雪🙂\u2028\u2029' } }) + '\n');
  // Every byte separately exercises the transport decoder, not just JSON's handling of separators.
  for (const byte of wire) h.toServer.write(Buffer.from([byte]));
  const answer = await h.answerTo(4) as { result?: unknown };
  assert.ok(answer.result);
  assert.equal(h.logger.lines.some((line) => line.startsWith('error ')), false);
});
