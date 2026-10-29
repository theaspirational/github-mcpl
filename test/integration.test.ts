/**
 * The wired server (TASK-SRHKG.1.9): the seven packages as one connection.
 *
 * Every case here goes through the real `GitHubMcplServer` over a real
 * `McplConnection` pair (the {@link harness}), the real `WebhookListener` over
 * a loopback port, the real `Poller`, the real `ChannelRegistry` and the real
 * tool modules. Only GitHub itself is a fake. That is the point of the file:
 * the packages were each green in isolation, and what is under test is the
 * wiring between them — the handshake, the grant, the routing, and the event
 * pipeline from an HTTP delivery to a `channels/incoming` the host answers.
 */

import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { method, type PushEventParams } from '@animalabs/mcpl-core';
import { CheckGate, normalizeNotifiedReviewRequest, normalizePolledIssue, normalizeWebhook } from '../src/normalize.js';
import { Poller } from '../src/poller.js';
import { GithubState } from '../src/state.js';
import { WebhookListener } from '../src/webhook.js';
import {
  COMMENTS_FEATURE_SET,
  EVENTS_FEATURE_SET,
  READ_FEATURE_SET,
  channelId,
  silentLogger,
  type Comment,
  type NormalizedEvent,
  type PolledIssue,
} from '../src/types.js';
import {
  FULL_GRANT,
  FakeGitHubApi,
  TEST_BOT,
  TEST_REPO,
  callTool,
  grant,
  harness,
  incoming,
  initialize,
  pushes,
  textOf,
  until,
  type Harness,
} from './harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Not a credential: a literal only this test file knows, to sign with. */
const SECRET = 'test-webhook-signing-material-0123456789';
/** The head sha the check fixtures carry. */
const HEAD = '4d7b2e8c1a93f05627de4b1c8a0f3927e5c6d418';

const ISSUE = { repo: TEST_REPO, number: 41, kind: 'issue' } as const;
const PULL = { repo: TEST_REPO, number: 58, kind: 'pull' } as const;

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/**
 * The webhook listener, bound to a loopback port and feeding `server.onEvent`
 * — the same single pipeline entry `src/index.ts` hands it. Returns a
 * `deliver` that signs a fixture the way GitHub signs a delivery.
 */
async function webhook(
  t: TestContext,
  h: Harness,
  gate: CheckGate = new CheckGate(),
): Promise<(event: string, body: string, id?: string) => Promise<Response>> {
  const listener = new WebhookListener({
    secret: SECRET,
    path: '/github/webhook',
    repos: [TEST_REPO],
    logger: silentLogger(),
    api: h.api,
    checkGate: gate,
    onEvent: h.server.onEvent,
  });
  const port = await listener.listen(0);
  t.after(() => listener.close());
  const url = `http://127.0.0.1:${port}/github/webhook`;
  let n = 0;
  return async (event, body, id = `d-${++n}`) => {
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': id,
        'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
      },
    });
    await listener.whenIdle();
    return res;
  };
}

/** A harness with a silent logger, closed when the test ends. */
function rig(t: TestContext, opts: Parameters<typeof harness>[0] = {}): Harness {
  const h = harness({ logger: silentLogger(), ...opts });
  t.after(() => h.close());
  return h;
}

/** The JSON-RPC error a request was refused with. */
async function refusal(call: Promise<unknown>): Promise<{ code: number; message: string; data?: unknown }> {
  try {
    await call;
  } catch (err) {
    const e = err as { code: number; message: string; data?: unknown };
    assert.equal(typeof e.code, 'number', `expected a JSON-RPC error, got ${String(err)}`);
    return e;
  }
  throw new Error('expected a refusal, the call succeeded');
}

/** JSON-RPC: the method does not exist on this connection. */
const ERR_METHOD_NOT_FOUND = -32601;

// The server writes to the host in order on one stream, so once the answer to
// a later request is back, everything it sent before has arrived.
async function hostCaughtUp(h: Harness): Promise<void> {
  await h.host.sendRequest('tools/list', {});
}

function accepted(res: Response): void {
  assert.ok(res.status >= 200 && res.status < 300, `the delivery was refused with ${res.status}`);
}
/** MCPL §6.6: a capability the host did not grant. */
const ERR_CAPABILITY_DENIED = -32002;
/** MCPL §8.7: the checkpoint is unknown or pruned. */
const ERR_UNKNOWN_CHECKPOINT = -32005;

// ─────────────────────────────────────────────────────────────────────────────
// The handshake
// ─────────────────────────────────────────────────────────────────────────────

test('the MCPL handshake answers the six feature-set declarations and MCP tools', async (t) => {
  const h = rig(t);
  const result = await initialize(h, true);
  const manifest = (result.capabilities as { experimental: { mcpl: Record<string, unknown> } }).experimental.mcpl;

  // MCP's own tools capability is there whatever the mode (§5.1).
  assert.deepEqual(result.capabilities.tools, {});
  assert.equal(manifest.version, '0.5');
  assert.deepEqual(Object.keys(manifest.featureSets as object), [
    EVENTS_FEATURE_SET,
    READ_FEATURE_SET,
    COMMENTS_FEATURE_SET,
    'github.review',
    'github.issues',
    'github.pr',
  ]);
  assert.equal(manifest.pushEvents, true);
  assert.deepEqual(manifest.channels, {
    register: true,
    lifecycle: true,
    publish: true,
    incoming: true,
    typing: true,
  });
  assert.equal(h.server.isMcpl, true);
  // Only github.events carries the tag vocabulary (§16).
  const sets = manifest.featureSets as Record<string, { tagOntology?: unknown; rollback: boolean }>;
  assert.ok(sets[EVENTS_FEATURE_SET].tagOntology, 'github.events declares the ontology');
  assert.equal(sets[READ_FEATURE_SET].tagOntology, undefined);
  // github.comments is the one rollback-capable set (§8.2).
  const rollable = Object.entries(sets)
    .filter(([, d]) => d.rollback)
    .map(([name]) => name);
  assert.deepEqual(rollable, [COMMENTS_FEATURE_SET]);
});

test('a full grant degrades nothing and opens every surface', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);

  const receipt = await grant(h, FULL_GRANT);
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.mode, undefined, 'nothing degraded');
  assert.deepEqual(receipt.unavailableFeatures, []);

  // A read tool, a channel method and a checkpoint all answer.
  assert.match(textOf(await callTool(h, 'get_issue', { number: 41 })), /#41/);
  await h.host.sendRequest(method.CHANNELS_LIST, {});
  const checkpoint = (await h.host.sendRequest('state/checkpoint', {})) as { checkpoint: string };
  assert.match(checkpoint.checkpoint, /^chk_/);
});

test('a reduced grant names every feature set it disables, and the server honours it', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);

  // `tools` only: the read tools work, every channel method is denied, and
  // github.comments goes with them because its declaration uses
  // channels.publish as well as tools (§6.4 — an unmet `uses` disables).
  const receipt = await grant(h, ['tools']);
  assert.equal(receipt.mode, 'degraded');
  const byName = new Map(receipt.unavailableFeatures.map((f) => [f.featureSet, f]));
  assert.deepEqual([...byName.keys()], [EVENTS_FEATURE_SET, COMMENTS_FEATURE_SET]);
  assert.deepEqual(byName.get(EVENTS_FEATURE_SET)?.missingCapabilities, ['pushEvents']);
  assert.deepEqual(byName.get(COMMENTS_FEATURE_SET)?.missingCapabilities, ['channels.publish']);
  for (const f of byName.values()) assert.equal(f.effect, 'disabled');

  assert.match(textOf(await callTool(h, 'get_issue', { number: 41 })), /#41/);
  assert.equal(textOf(await callTool(h, 'create_issue', { title: 'x', body: 'y' })).length > 0, true);
  // github.comments is disabled, so its tools are refused even though `tools`
  // was granted — the refusal names the feature set, not the capability.
  const denied = await refusal(callTool(h, 'comment', { thread: '#41', body: 'hello' }));
  assert.equal(denied.code, ERR_CAPABILITY_DENIED);
  assert.match(denied.message, /github\.comments/);
  assert.equal((await refusal(h.host.sendRequest(method.CHANNELS_LIST, {}))).code, ERR_CAPABILITY_DENIED);

  // And the listing matches the refusals: a disabled set's tools are not
  // offered, so a model is never shown an affordance this grant would refuse.
  const listed = (await h.host.sendRequest('tools/list', {})) as { tools: { name: string }[] };
  const names = listed.tools.map((t) => t.name);
  assert.ok(names.includes('get_issue'), 'github.read is granted');
  for (const tool of ['comment', 'reply_in_thread', 'edit_own_comment', 'delete_own_comment', 'upsert_sticky_comment']) {
    assert.ok(!names.includes(tool), `${tool} belongs to a disabled feature set and must not be listed`);
  }
  assert.equal(names.length, h.server.toolDefinitions().length - 5);
});

test('a host that grants nothing gets refusals on every tool, channel and push', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);

  // §5.3: absence is denial even *before* the first featureSets/update.
  assert.equal((await refusal(callTool(h, 'get_issue', { number: 41 }))).code, ERR_CAPABILITY_DENIED);

  const receipt = await grant(h, []);
  assert.equal(receipt.mode, 'degraded');
  assert.equal(receipt.unavailableFeatures.length, 6, 'all six disabled');

  // Every tool, by name, from every module.
  assert.ok(h.server.toolDefinitions().length >= 20, 'the whole tool surface is registered');
  for (const tool of h.server.toolDefinitions()) {
    const denied = await refusal(callTool(h, tool.name, {}));
    assert.equal(denied.code, ERR_CAPABILITY_DENIED, `${tool.name} was not refused`);
    assert.equal((denied.data as { capability: string }).capability, 'tools');
  }

  // Every channel method.
  for (const m of [method.CHANNELS_LIST, method.CHANNELS_OPEN, method.CHANNELS_PUBLISH, method.CHANNELS_TYPING]) {
    const denied = await refusal(h.host.sendRequest(m, { channelId: channelId(ISSUE), content: [], state: 'active' }));
    assert.equal(denied.code, ERR_CAPABILITY_DENIED, `${m} was not refused`);
  }

  // And no push: an event has nowhere to go.
  const deliver = await webhook(t, h);
  accepted(await deliver('issues', fixture('issues.opened.json'), 'denied-1'));
  await hostCaughtUp(h);
  assert.deepEqual(pushes(h), [], 'no push/event under an empty grant');
  assert.deepEqual(incoming(h), [], 'and no channels/incoming');

  // And nothing is listed either. This assertion used to be its opposite —
  // "a host has to be able to see the surface it is deciding about" — which
  // was wrong twice over (WP9 review, finding 6): the surface a host decides
  // about is the *manifest's* feature-set declarations, which `initialize`
  // already carried, and a listing that offers 22 tools while every call is
  // refused is a listing that lies.
  const listed = (await h.host.sendRequest('tools/list', {})) as { tools: { name: string }[] };
  assert.deepEqual(listed.tools, [], 'the empty allowlist offers no tool');
});

test('an unknown tool name is refused by name, before the grant is consulted', async (t) => {
  const h = rig(t);
  await initialize(h, true);
  // No grant at all, so a capability answer would be the "available" one —
  // and a typo is still reported as a typo (§ the .9 brief).
  const unknown = await refusal(callTool(h, 'merge_pull_request', {}));
  assert.equal(unknown.code, ERR_METHOD_NOT_FOUND);
  assert.match(unknown.message, /Unknown tool: merge_pull_request/);
  assert.deepEqual(unknown.data, { tool: 'merge_pull_request' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plain MCP
// ─────────────────────────────────────────────────────────────────────────────

test('a plain-MCP host sees tools only: no manifest, no push, no channels, no rollback', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });

  const result = await initialize(h, false);
  assert.deepEqual(result.capabilities, { tools: {} }, 'no experimental.mcpl');
  assert.equal(h.server.isMcpl, false);

  // Tools work, and with no grant to consult they are not capability-gated:
  // plain MCP has no grant mechanism, and refusing everything would make the
  // server useless to an ordinary MCP client.
  const listed = (await h.host.sendRequest('tools/list', {})) as { tools: { name: string }[] };
  assert.equal(listed.tools.length, h.server.toolDefinitions().length);
  assert.ok(listed.tools.some((tool) => tool.name === 'comment'));
  assert.match(textOf(await callTool(h, 'get_issue', { number: 41 })), /#41/);

  // Every MCPL method does not exist on this connection.
  for (const m of [
    method.FEATURE_SETS_UPDATE,
    method.MCPL_MANIFEST,
    method.CHANNELS_LIST,
    method.CHANNELS_OPEN,
    method.CHANNELS_CLOSE,
    method.CHANNELS_PUBLISH,
    method.CHANNELS_TYPING,
    method.STATE_ROLLBACK,
    'state/checkpoint',
  ]) {
    const refused = await refusal(h.host.sendRequest(m, { channelId: channelId(ISSUE), featureSet: COMMENTS_FEATURE_SET }));
    assert.equal(refused.code, ERR_METHOD_NOT_FOUND, `${m} should not exist in plain MCP`);
    assert.match(refused.message, /needs MCPL/);
  }

  // And no event reaches the host: there is no push and no channel.
  const deliver = await webhook(t, h);
  accepted(await deliver('issues', fixture('issues.opened.json'), 'plain-1'));
  await hostCaughtUp(h);
  assert.deepEqual(h.hostSaw, [], 'the server sent the host nothing at all');
});

// ─────────────────────────────────────────────────────────────────────────────
// The event pipeline
// ─────────────────────────────────────────────────────────────────────────────

test('an issue webhook delivery arrives as push/event and channels/incoming with its tags', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const deliver = await webhook(t, h);
  const res = await deliver('issues', fixture('issues.opened.json'), 'delivery-aaa');
  assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);
  await until(() => pushes(h).length === 1 && incoming(h).length === 1, 'the event to reach the host');

  const TAGS = ['chat:from-human', 'chat:ambient', 'github:issue=opened'];

  const push = pushes(h)[0];
  assert.equal(push.featureSet, EVENTS_FEATURE_SET);
  assert.equal(push.eventId, 'delivery-aaa', 'the delivery id is the event id');
  assert.deepEqual(push.tags, TAGS);
  const origin = push.origin as Record<string, unknown>;
  assert.equal(origin.source, 'github');
  assert.equal(origin.kind, 'issue.opened');
  assert.equal(origin.repo, 'anima-research/rayforce');
  assert.equal(origin.channelId, channelId(ISSUE));
  assert.deepEqual(origin.sender, { login: 'octocat', isBot: false });
  // The wake metadata rides on `origin`, where a host's matchers read it.
  const metadata = origin.metadata as Record<string, unknown>;
  assert.equal(metadata.isOwnThread, false);
  assert.equal(metadata.fromSelf, false);
  assert.equal(metadata.isCiFailure, false);
  assert.match(textOf(push.payload as { content: [] }), /Scheduler drops the last batch/);

  // The same event as a channel message, with the same tags and metadata.
  const message = incoming(h)[0];
  assert.equal(message.channelId, channelId(ISSUE));
  assert.equal(message.messageId, 'delivery-aaa');
  assert.deepEqual(message.tags, TAGS);
  assert.deepEqual(message.author, { id: 'octocat', name: 'octocat' });
  assert.deepEqual(message.content, (push.payload as { content: unknown }).content);

  // The channel was registered before the message was delivered.
  const registered = h.hostSaw.findIndex((r) => r.method === method.CHANNELS_REGISTER);
  const delivered = h.hostSaw.findIndex((r) => r.method === method.CHANNELS_INCOMING);
  assert.ok(registered >= 0 && registered < delivered, 'registration precedes delivery');
});

test('a CI failure carries the failed jobs and their urls, and the bot’s own suite stays ambient', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, head: { ref: 'fix-final-batch', sha: HEAD } });
  api.seedCheckRuns(TEST_REPO, {
    sha: HEAD,
    conclusion: 'failure',
    total: 3,
    failed: [
      { name: 'test (ubuntu-latest)', url: 'https://github.com/anima-research/rayforce/runs/2700001234' },
      { name: 'clippy', url: 'https://github.com/anima-research/rayforce/runs/2700001235' },
    ],
  });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const deliver = await webhook(t, h);
  await deliver('check_suite', fixture('check_suite.completed.json'), 'ci-1');
  await until(() => pushes(h).length === 1, 'the CI event');

  const push = pushes(h)[0];
  // The fixture's sender is the bot, and `chat:from-self` is decided first —
  // the treatment is ambient, not a wake, however bad the build is. That
  // ordering is WP6's and this test is what keeps it.
  assert.deepEqual(push.tags, ['chat:from-self', 'chat:ambient', 'github:ci=failure']);
  const metadata = (push.origin as { metadata: Record<string, unknown> }).metadata;
  assert.equal(metadata.isCiFailure, true);
  assert.equal(metadata.fromSelf, true);
  assert.equal(metadata.sha, HEAD);

  // Every failed job, by name and by url, is in the rendered body.
  const text = textOf(push.payload as { content: [] });
  assert.match(text, /checks: failure, 2 failed/);
  assert.match(text, /test \(ubuntu-latest\) — https:\/\/github\.com\/anima-research\/rayforce\/runs\/2700001234/);
  assert.match(text, /clippy — https:\/\/github\.com\/anima-research\/rayforce\/runs\/2700001235/);
  // And it is a channel delivery too, because a check suite has a pull request.
  assert.equal(incoming(h)[0].channelId, channelId(PULL));
});

test('a poll pass produces the same event shape as a webhook delivery', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, updatedAt: '2026-10-13T12:00:00.000Z' });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const state = GithubState.empty(null, silentLogger());
  state.setLastPollAt('2026-10-13T00:00:00.000Z');
  const poller = new Poller({
    api,
    repos: [TEST_REPO],
    state,
    intervalMs: 60_000,
    onEvent: h.server.onEvent,
    logger: silentLogger(),
    checkGate: new CheckGate(),
  });
  const result = await poller.pollOnce();
  assert.equal(result.delivered.length, 1);
  await until(() => pushes(h).length === 1 && incoming(h).length === 1, 'the polled event');

  const push = pushes(h)[0];
  // The ingress path is not visible in the shape: same featureSet, same
  // origin members, same metadata keys, same channel id. Only the event id
  // says where it came from (a poll key rather than a delivery id).
  assert.equal(push.featureSet, EVENTS_FEATURE_SET);
  assert.match(push.eventId, /^poll:issue:41:/);
  assert.equal((push.origin as { channelId: string }).channelId, channelId(ISSUE));
  assert.deepEqual(push.tags, ['chat:from-human', 'chat:ambient', 'chat:edited', 'github:issue=edited']);

  const webhookOrigin = await originOfWebhookIssue(t);
  assert.deepEqual(
    Object.keys(push.origin as object).sort(),
    Object.keys(webhookOrigin).sort(),
    'the two ingress paths build the same origin',
  );
  assert.deepEqual(
    Object.keys((push.origin as { metadata: object }).metadata).sort(),
    Object.keys((webhookOrigin as { metadata: object }).metadata).sort(),
    'and the same metadata',
  );
  assert.equal(incoming(h)[0].channelId, channelId(ISSUE));
});

test('amendment 2a: a polled issue opened since the cursor reaches the host as github:issue=opened', async (t) => {
  const api = new FakeGitHubApi();
  // One issue opened after the cursor, one older issue merely touched since.
  api.seedIssue({ number: 41, createdAt: '2026-10-13T12:00:00.000Z', updatedAt: '2026-10-13T12:00:00.000Z' });
  api.seedIssue({ number: 42, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-13T13:00:00.000Z' });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const state = GithubState.empty(null, silentLogger());
  state.setLastPollAt('2026-10-13T06:00:00.000Z');
  const poller = new Poller({
    api,
    repos: [TEST_REPO],
    state,
    intervalMs: 60_000,
    onEvent: h.server.onEvent,
    logger: silentLogger(),
    checkGate: new CheckGate(),
  });
  await poller.pollOnce();
  await until(() => pushes(h).length === 2 && incoming(h).length === 2, 'both polled events');

  // The whole point of the amendment: a recipe keyed on `github:issue=opened`
  // fires on the polling ingress, which before it could only say `=edited`.
  const opened = pushes(h)[0];
  assert.equal((opened.origin as { number: number }).number, 41);
  assert.equal((opened.origin as { kind: string }).kind, 'issue.opened');
  assert.deepEqual(opened.tags, ['chat:from-human', 'chat:ambient', 'github:issue=opened']);
  // `chat:edited` is gone with it: an opened issue was not edited.
  assert.ok(!opened.tags.includes('chat:edited'));

  // And the older row is still an edit, so the distinction is real and not a
  // blanket rename.
  const edited = pushes(h)[1];
  assert.equal((edited.origin as { number: number }).number, 42);
  assert.deepEqual(edited.tags, ['chat:from-human', 'chat:ambient', 'chat:edited', 'github:issue=edited']);

  // It reaches the channel too, with the same tags.
  assert.deepEqual(incoming(h)[0].tags, ['chat:from-human', 'chat:ambient', 'github:issue=opened']);
});

test('amendment 2a: a polled pull-request row with an unmoved head never reaches the host', async (t) => {
  const api = new FakeGitHubApi();
  const pull = api.seedPullRequest({
    number: 58,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-13T12:00:00.000Z',
  });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const state = GithubState.empty(null, silentLogger());
  state.setLastPollAt('2026-10-13T06:00:00.000Z');
  const poller = new Poller({
    api,
    repos: [TEST_REPO],
    state,
    intervalMs: 60_000,
    onEvent: h.server.onEvent,
    logger: silentLogger(),
    checkGate: new CheckGate(),
  });

  // Pass one: a first sighting, so the head counts as moved.
  await poller.pollOnce();
  await until(() => pushes(h).length >= 1, 'the first sighting');
  assert.equal((pushes(h)[0].origin as { kind: string }).kind, 'pull.synchronize');
  const afterFirst = pushes(h).length;

  // Pass two: a human comments. The comment reaches the host; the pull-request
  // row it bumped does not, because the head did not move. That is the
  // duplicate volume the amendment removes — one human action, one event.
  api.seedComment(
    { repo: TEST_REPO, number: 58, kind: 'pull' },
    { id: 7007, body: 'a note', updatedAt: '2026-10-13T14:00:00.000Z' },
  );
  pull.updatedAt = '2026-10-13T14:00:00.000Z';
  // Pinned rather than inherited: pass one advanced the cursor to its own
  // `receivedAt`, which is the real clock here, and these rows are stamped in
  // the fixture's past. The pass under test is "the second time this poller
  // sees this pull request", and that is what the head record carries.
  // Each list's own cursor is cleared, so every list starts from it.
  state.setLastPollAt('2026-10-13T13:00:00.000Z');
  state.setPollCursors({});
  await poller.pollOnce();
  await until(() => pushes(h).length === afterFirst + 1, 'the comment, and nothing else');
  assert.equal((pushes(h)[afterFirst].origin as { kind: string }).kind, 'comment.created');
  assert.equal(
    pushes(h).filter((e) => (e.origin as { kind: string }).kind === 'pull.synchronize').length,
    1,
    'the pull-request row was announced once, not once per comment',
  );
});

test('a polled merge reaches the host as github:pr=merged beside github:pr=closed, as a webhook\'s does', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);
  const row: PolledIssue = {
    id: 5800,
    number: 58,
    isPullRequest: true,
    title: 'Fix it',
    body: '',
    state: 'closed',
    author: { login: 'octocat', isBot: false },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-13T12:00:00Z',
    html_url: `https://github.com/${TEST_REPO.owner}/${TEST_REPO.name}/pull/58`,
    closedBy: { login: 'maintainer', isBot: false },
    closedAt: '2026-10-13T12:00:00Z',
    merged: true,
  };
  const event = normalizePolledIssue(TEST_REPO, row, '2026-10-13T12:01:00.000Z', '2026-10-13T11:00:00Z');
  assert.equal(event?.kind, 'pull.closed');
  await h.server.onEvent(event as NormalizedEvent);
  await until(() => pushes(h).length === 1, 'the merge');
  const tags = pushes(h)[0]?.tags ?? [];
  assert.ok(tags.includes('github:pr=closed'));
  assert.ok(tags.includes('github:pr=merged'));

  // A polled close that wasn't a merge is closed alone.
  const closedOnly = normalizePolledIssue(TEST_REPO, { ...row, id: 5900, number: 59, merged: false }, '2026-10-13T12:01:00.000Z', '2026-10-13T11:00:00Z');
  await h.server.onEvent(closedOnly as NormalizedEvent);
  await until(() => pushes(h).length === 2, 'the close');
  const closedTags = pushes(h)[1]?.tags ?? [];
  assert.ok(closedTags.includes('github:pr=closed'));
  assert.ok(!closedTags.includes('github:pr=merged'));

  // And a webhook's merge still says so from its nested pull_request.merged.
  const deliver = await webhook(t, h);
  await deliver('pull_request', fixture('pull_request.closed.json'), 'merge-webhook-1');
  await until(() => pushes(h).length === 3, 'the webhook merge');
  assert.ok((pushes(h)[2]?.tags ?? []).includes('github:pr=merged'));
});

test('a review request from a notification reaches the host as github:pr=review_requested with isReviewRequested, as a webhook\'s does', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);
  const row: PolledIssue = {
    id: 5800,
    number: 58,
    isPullRequest: true,
    title: 'Fix it',
    body: '',
    state: 'open',
    author: { login: 'octocat', isBot: false },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-13T12:00:00Z',
    html_url: `https://github.com/${TEST_REPO.owner}/${TEST_REPO.name}/pull/58`,
  };
  const event = normalizeNotifiedReviewRequest(TEST_REPO, row, { id: '9001', updatedAt: '2026-10-13T12:00:20Z' }, '2026-10-13T12:01:00.000Z');
  await h.server.onEvent(event);
  await until(() => pushes(h).length === 1, 'the review request');
  assert.ok((pushes(h)[0]?.tags ?? []).includes('github:pr=review_requested'));
  const metadata = (pushes(h)[0].origin as { metadata: Record<string, unknown> }).metadata;
  assert.equal(metadata.isReviewRequested, true, 'the notification names no reviewer, and its reason says it is the token user');
});

/** The `origin` a webhook issue delivery produces, for the shape comparison. */
async function originOfWebhookIssue(t: TestContext): Promise<Record<string, unknown>> {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);
  const deliver = await webhook(t, h);
  await deliver('issues', fixture('issues.opened.json'), 'shape-1');
  await until(() => pushes(h).length === 1, 'the webhook event');
  return pushes(h)[0].origin as Record<string, unknown>;
}

test('a disabled github.events stops the traffic at once, push and incoming alike', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);
  const deliver = await webhook(t, h);
  await deliver('issues', fixture('issues.opened.json'), 'before-1');
  await until(() => pushes(h).length === 1, 'the first event');

  // §6.7, the Notification form: descriptive, and a reduction takes effect.
  h.host.sendNotification(method.FEATURE_SETS_UPDATE, { disabled: [EVENTS_FEATURE_SET] });
  await until(() => !h.server.grant.isFeatureSetActive(EVENTS_FEATURE_SET), 'the notification to land');

  accepted(await deliver('issues', fixture('issues.closed.json'), 'after-1'));
  await hostCaughtUp(h);
  assert.equal(pushes(h).length, 1, 'no second push');
  assert.equal(incoming(h).length, 1, 'and no second delivery');
});

/** A promise and the handle that settles it, for a deliberately held await. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A normalized issue comment, as either ingress path hands one to `onEvent`. */
function issueComment(id: string): NormalizedEvent {
  return {
    id,
    receivedAt: '2026-10-01T00:00:00.000Z',
    repo: TEST_REPO,
    kind: 'comment.created',
    thread: { ...ISSUE },
    actor: { login: 'human-one', isBot: false },
    body: 'a followup',
    html_url: `https://github.com/${TEST_REPO.owner}/${TEST_REPO.name}/issues/41#issuecomment-1`,
  };
}

/**
 * An event whose thread lookup is held open, with the grant narrowed and
 * acknowledged before the lookup is released.
 *
 * Every step of the pipeline awaits something, and a decision taken before an
 * await is a decision the host may already have been told was withdrawn (WP9
 * review round 2, finding 1). `reduce` is applied while the event sits in
 * `getIssue`; nothing may go out after it.
 */
async function reducedMidFlight(
  t: TestContext,
  reduce: (h: Harness) => Promise<unknown>,
): Promise<{ h: Harness; emitted: string[] }> {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);
  // Registered up front, so the only await left before the two sends is the
  // thread lookup — the window this test is about.
  await h.host.sendRequest(method.CHANNELS_OPEN, { address: { ...TEST_REPO, number: 41, kind: 'issue' } });

  const entered = deferred();
  const release = deferred();
  const realGetIssue = api.getIssue.bind(api);
  api.getIssue = async (ref) => {
    entered.resolve();
    await release.promise;
    return realGetIssue(ref);
  };

  const inFlight = h.server.onEvent(issueComment('mid-flight'));
  await entered.promise;
  await reduce(h);
  const before = h.hostSaw.length;
  release.resolve();
  await inFlight;
  return { h, emitted: h.hostSaw.slice(before).map((r) => r.method) };
}

test('a capability revoked while an event is in flight stops both of its egress paths', async (t) => {
  const { h, emitted } = await reducedMidFlight(t, async (h) => {
    const receipt = await grant(h, []);
    assert.equal(receipt.accepted, true, 'the host was told the reduction landed');
  });

  assert.deepEqual(emitted, [], 'neither channels/incoming nor push/event went out');
  assert.deepEqual(h.ungranted, [], 'and the host was never called on an ungranted capability');
});

test('a github.events disablement while an event is in flight stops both of its egress paths', async (t) => {
  const { h, emitted } = await reducedMidFlight(t, async (h) => {
    // The capabilities are all still granted; the feature set is not selected,
    // which §6.7 makes just as binding.
    const receipt = await grant(h, FULL_GRANT, { disabled: [EVENTS_FEATURE_SET] });
    assert.equal(receipt.accepted, true);
    assert.equal(h.server.grant.isFeatureSetSelected(EVENTS_FEATURE_SET), false);
  });

  assert.deepEqual(emitted, []);
  assert.deepEqual(h.ungranted, []);
});

test('channels.incoming revoked while the registration is in flight stops the delivery, not the push', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  // The channel is unregistered, so this event's delivery waits on the
  // `channels/register` round trip — and the registry, not its caller, is what
  // has to ask again before `channels/incoming` goes out.
  const registering = deferred();
  const held = deferred();
  const h = rig(t, {
    api,
    hold: (req) => {
      if (req.method !== method.CHANNELS_REGISTER) return undefined;
      registering.resolve();
      return held.promise;
    },
  });
  await initialize(h, true);
  await grant(h);

  const inFlight = h.server.onEvent(issueComment('registering'));
  await registering.promise;
  // Everything but the incoming delivery: the push path must still carry the
  // event, which is what makes this a per-path recheck and not a kill switch.
  const receipt = await grant(
    h,
    FULL_GRANT.filter((c) => c !== 'channels.incoming'),
  );
  assert.equal(receipt.accepted, true);
  held.resolve();
  await inFlight;

  assert.deepEqual(incoming(h), [], 'the delivery behind the registration was dropped');
  assert.equal(pushes(h).length, 1, 'and the push, still granted, went out');
  assert.deepEqual(h.ungranted, []);
});

test('a human reply to the bot’s own review comment is a reply to self', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, head: { ref: 'fix-final-batch', sha: HEAD } });
  // The bot wrote the root of this review thread, and the delivery below is a
  // human answering exactly that comment (`in_reply_to_id`).
  const reviewThread = api.seedReviewThread(PULL, {
    comments: [{ id: 2500000077, author: TEST_BOT, body: 'this needs a bound', createdAt: '2026-10-01T00:00:00.000Z' }],
  });
  assert.equal(reviewThread.comments[0].id, 2500000077);
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  // The reply fixture is the bot answering a human; this is the mirror of it,
  // so the reply is a *human* answering the bot — which is the wake signal.
  const payload = JSON.parse(fixture('pull_request_review_comment.created.reply.json'));
  const human = { login: 'octocat', id: 583231, type: 'User' };
  payload.sender = human;
  payload.comment.user = human;
  assert.equal(payload.comment.in_reply_to_id, 2500000077);

  const deliver = await webhook(t, h);
  await deliver('pull_request_review_comment', JSON.stringify(payload), 'reply-1');
  await until(() => pushes(h).length === 1, 'the reply event');

  const metadata = (pushes(h)[0].origin as { metadata: Record<string, unknown> }).metadata;
  assert.equal(metadata.isOwnThread, true, 'the bot has a comment in this thread');
  assert.equal(metadata.isReplyToSelf, true, 'and the reply names that comment');
  const tags = pushes(h)[0].tags ?? [];
  assert.ok(tags.includes('chat:reply'), tags.join(','));

  // The lookup is two bounded reads for a pull request, and then cached: a
  // second event on the same thread asks GitHub nothing.
  assert.ok(api.callsTo('listComments').length >= 1, 'the first event read the comments');
  assert.ok(api.callsTo('listReviewThreads').length >= 1, 'and the review threads');
  await deliver('issue_comment', fixture('issue_comment.created.on_pull.json'), 'reply-2');
  await until(() => pushes(h).length === 2, 'the second event');
  assert.ok(api.callsTo('listComments').length <= 1, 'the thread history is cached');
  assert.ok(api.callsTo('listReviewThreads').length <= 1);
  // The second event is on the same thread, so it is own-thread too.
  const second = (pushes(h)[1].origin as { metadata: Record<string, unknown> }).metadata;
  assert.equal(second.isOwnThread, true);
  // Amendment 2b can make a top-level comment a reply to self, but on its own
  // two rules: this one neither follows a top-level comment of the bot's (the
  // bot's only words here are review comments).
  assert.equal(second.isReplyToSelf, false, 'it does not follow a top-level comment of the bot’s');
});

/** The `metadata` of one `push/event`'s origin. */
function metadataOf(push: PushEventParams): Record<string, unknown> {
  return (push.origin as { metadata: Record<string, unknown> }).metadata;
}

/**
 * A human's top-level comment on issue 41, as either ingress hands one over.
 * `id` is the comment's own GitHub id, which amendment 2b needs to place it in
 * the thread's turn order.
 */
function humanComment(id: number, body: string): NormalizedEvent {
  return {
    id: `delivery-${id}`,
    receivedAt: '2026-10-01T00:00:00.000Z',
    repo: TEST_REPO,
    kind: 'comment.created',
    thread: { ...ISSUE },
    actor: { login: 'human-one', isBot: false },
    body,
    html_url: `https://github.com/${TEST_REPO.owner}/${TEST_REPO.name}/issues/41#issuecomment-${id}`,
    comment: { id },
  };
}

test('amendment 2b: a human comment straight after the bot’s is a reply to self', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  // The conversation so far: a human, then the bot, then the human again.
  api.seedComment(ISSUE, { id: 7001, author: { login: 'human-one', isBot: false }, body: 'can you look?' });
  api.seedComment(ISSUE, { id: 7002, author: TEST_BOT, body: 'Looking now. The batch drains twice.' });
  api.seedComment(ISSUE, { id: 7003, author: { login: 'human-one', isBot: false }, body: 'thanks, that explains it' });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  await h.server.onEvent(humanComment(7003, 'thanks, that explains it'));
  await until(() => pushes(h).length === 1, 'the comment event');

  const metadata = metadataOf(pushes(h)[0]);
  assert.equal(metadata.isOwnThread, true);
  // Before amendment 2b this was false and the event was plain `chat:ambient`:
  // GitHub gives an issue comment no reply relation, so the bot never saw a
  // follow-up on its own comment.
  assert.equal(metadata.isReplyToSelf, true, 'it is the comment right after the bot’s');
  assert.ok((pushes(h)[0].tags ?? []).includes('chat:reply'), (pushes(h)[0].tags ?? []).join(','));
});

test('amendment 2b in v1: quoting the bot is NOT a reply to self when a human spoke last', async (t) => {
  // The withdrawn quote rule, pinned (Amendment 2 revision, 2026-10-14).
  //
  // This exact thread used to answer `true`; under v1 it answers `false`.
  // The rule needed the server to track which *version* of the bot's body
  // was current, and five consecutive review rounds each found another
  // interleaving where it matched text GitHub no longer held. It returns in
  // v1.x with provenance-aware body versioning, and this case is what will
  // flip back. Until then, reinstating it has to be a decision rather than
  // an accident.
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  api.seedComment(ISSUE, { id: 7001, author: TEST_BOT, body: 'The batch drains twice.\nI will bound it.' });
  // Somebody else spoke after the bot, so the turn-order rule does not apply.
  api.seedComment(ISSUE, { id: 7002, author: { login: 'human-two', isBot: false }, body: 'subscribing' });
  api.seedComment(ISSUE, { id: 7003, author: { login: 'human-one', isBot: false }, body: '> The batch drains twice.\n\nwhere?' });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  await h.server.onEvent(humanComment(7003, '> The batch drains twice.\n\nwhere?'));
  await until(() => pushes(h).length === 1, 'the quoting comment');
  const metadata = metadataOf(pushes(h)[0]);
  assert.equal(metadata.isReplyToSelf, false, 'v1 reads turn order only, and a human spoke last');
  // What the withdrawal costs is this flag and nothing coarser: the contract
  // makes `chat:reply` fire for a thread the bot has merely commented in, so
  // the event still reaches a reply-shaped recipe and only a rule matching
  // `isReplyToSelf` itself can tell the difference.
  assert.equal(metadata.isOwnThread, true, 'the bot has written here');
  assert.ok((pushes(h)[0].tags ?? []).includes('chat:reply'), (pushes(h)[0].tags ?? []).join(','));
});

test('amendment 2b: a comment after another human’s is still ambient', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, author: { login: 'human-two', isBot: false } });
  // The bot has said nothing on this thread at all.
  api.seedComment(ISSUE, { id: 7001, author: { login: 'human-two', isBot: false }, body: 'any takers?' });
  api.seedComment(ISSUE, { id: 7002, author: { login: 'human-one', isBot: false }, body: 'not me' });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  await h.server.onEvent(humanComment(7002, 'not me'));
  await until(() => pushes(h).length === 1, 'the comment event');

  const metadata = metadataOf(pushes(h)[0]);
  assert.equal(metadata.isReplyToSelf, false, 'nothing of the bot’s to reply to');
  assert.equal(metadata.isOwnThread, false);
  // The amendment widened `isReplyToSelf`; it did not make everything a reply.
  assert.ok((pushes(h)[0].tags ?? []).includes('chat:ambient'), (pushes(h)[0].tags ?? []).join(','));
});

// ── Round 3, finding 1: a rollback keeps the reply knowledge true ──

test('a rollback that deletes the bot’s comment takes it out of the turn order (finding 1)', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, author: { login: 'human-one', isBot: false } });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const mark = (await h.host.sendRequest('state/checkpoint', {})) as { checkpoint: string };
  assert.equal((await callTool(h, 'comment', { thread: '#41', body: 'Temporary bot answer.' })).isError, undefined);
  const botId = (await api.listComments(ISSUE)).at(-1)?.id as number;

  // Load the history while the comment still exists, so the record holds it.
  await h.server.onEvent({
    id: 'load-history',
    receivedAt: '2026-10-01T00:00:00.000Z',
    repo: TEST_REPO,
    kind: 'issue.edited',
    thread: { ...ISSUE },
    actor: { login: 'human-one', isBot: false },
    html_url: `https://github.com/${TEST_REPO.owner}/${TEST_REPO.name}/issues/41`,
  });
  await until(() => pushes(h).length === 1, 'the history-loading event');

  const rolled = (await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: COMMENTS_FEATURE_SET,
    checkpoint: mark.checkpoint,
  })) as { success: boolean };
  assert.equal(rolled.success, true);
  assert.deepEqual(await api.listComments(ISSUE), [], 'GitHub has no bot comment left');

  // An unrelated human comment. Its predecessor on GitHub is nothing at all,
  // so it is ambient — before the fix the deleted comment was still sitting in
  // the turn order and made this a reply to self.
  const body = 'Unrelated human question.';
  api.seedComment(ISSUE, { id: botId + 1, author: { login: 'human-one', isBot: false }, body });
  await h.server.onEvent(humanComment(botId + 1, body));
  await until(() => pushes(h).length === 2, 'the unrelated comment');
  assert.equal(metadataOf(pushes(h)[1]).isReplyToSelf, false, 'a deleted predecessor is not a predecessor');
  // `isOwnThread` is history and survives: the bot did write here.
  assert.equal(metadataOf(pushes(h)[1]).isOwnThread, true, 'the bot having spoken is not undone');
});

test('a partial rollback leaves the turn order matching what actually happened (finding 1)', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, author: { login: 'human-one', isBot: false } });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  // The ids are chosen so the deletion actually moves the turn order: the
  // bot's second comment has to be the one immediately before the comment
  // judged at the end, with somebody else's turn behind it. The fake
  // allocates from 1000 upwards and `seedComment` does not advance that
  // counter, so the two seeded comments sit below it and the tool-created
  // one lands above both. The sticky is seeded carrying its marker, which is
  // how `upsert_sticky_comment` finds a comment to edit rather than create.
  const sticky = api.seedComment(ISSUE, { id: 100, author: TEST_BOT, body: '<!-- state -->\nOlder answer.' });
  const human = api.seedComment(ISSUE, { id: 200, author: { login: 'human-one', isBot: false }, body: 'intervening' });

  const args = { thread: { ...TEST_REPO, number: 41, kind: 'issue' }, marker: 'state' };
  const mark = (await h.host.sendRequest('state/checkpoint', {})) as { checkpoint: string };
  // One edit (to be restored) and one create (to be deleted).
  assert.equal((await callTool(h, 'upsert_sticky_comment', { ...args, body: 'Newer answer.' })).isError, undefined);
  assert.equal((await callTool(h, 'comment', { thread: '#41', body: 'A second bot comment.' })).isError, undefined);
  const createdId = (await api.listComments(ISSUE)).at(-1)?.id as number;
  assert.ok(createdId > human.id, 'the created comment is the thread’s last');

  // The restore fails; the delete succeeds.
  api.updateComment = async () => {
    throw new Error('GitHub 502 on the edit');
  };
  const rolled = (await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: COMMENTS_FEATURE_SET,
    checkpoint: mark.checkpoint,
  })) as { success: boolean; undone: { action: string; commentId: number }[]; notUndone: { action: string }[] };
  assert.deepEqual(
    rolled.undone.map((u) => `${u.action}:${u.commentId}`),
    [`delete:${createdId}`],
    'only the delete went through',
  );
  assert.deepEqual(
    rolled.notUndone.map((u) => u.action),
    ['restore'],
  );

  // GitHub's side of "what actually happened": the created comment is gone
  // and the sticky still holds the body the restore failed to undo.
  assert.deepEqual(
    (await api.listComments(ISSUE)).map((c) => c.id),
    [sticky.id, human.id],
  );
  assert.equal((await api.listComments(ISSUE)).find((c) => c.id === sticky.id)?.body, '<!-- state -->\nNewer answer.');

  // The turn order's side. Under v1 the failed restore has nothing to say to
  // it — a restore puts a body back on a comment that never left the thread
  // — so the whole of the partial case is that the *successful* delete took
  // its comment out of the order. The next comment therefore follows the
  // human, not the bot comment the rollback removed.
  await h.server.onEvent(humanComment(createdId + 1, 'and then?'));
  await until(() => pushes(h).length === 1, 'the comment after the partial rollback');
  assert.equal(metadataOf(pushes(h)[0]).isReplyToSelf, false, 'the deleted comment is not a predecessor');
  // The bot did write here, and a write it has since undone is not evidence
  // that it never spoke.
  assert.equal(metadataOf(pushes(h)[0]).isOwnThread, true, 'the thread is still the bot’s');
});

test('deleting the newer bot comment leaves the older one as the predecessor (finding 1)', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, author: { login: 'human-one', isBot: false } });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  assert.equal((await callTool(h, 'comment', { thread: '#41', body: 'The older bot answer.' })).isError, undefined);
  const olderId = (await api.listComments(ISSUE)).at(-1)?.id as number;
  const mark = (await h.host.sendRequest('state/checkpoint', {})) as { checkpoint: string };
  assert.equal((await callTool(h, 'comment', { thread: '#41', body: 'The newer bot answer.' })).isError, undefined);

  const rolled = (await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: COMMENTS_FEATURE_SET,
    checkpoint: mark.checkpoint,
  })) as { success: boolean };
  assert.equal(rolled.success, true);
  assert.deepEqual(
    (await api.listComments(ISSUE)).map((c) => c.body),
    ['The older bot answer.'],
    'only the older bot comment survives',
  );

  // The companion to "takes it out of the turn order": a removal must take
  // out the one comment and no more. The older comment is still the bot's
  // and still in the order, so the next human comment follows *it* and is a
  // reply to self — which is what a removal that over-reached would lose.
  await h.server.onEvent(humanComment(olderId + 5, 'which one?'));
  await until(() => pushes(h).length === 1, 'the comment after the rollback');
  const metadata = metadataOf(pushes(h)[0]);
  assert.equal(metadata.isReplyToSelf, true, 'the older bot comment is now the predecessor');
  assert.equal(metadata.isOwnThread, true);
});

test('delete_own_comment takes the comment out of the turn order (finding 1)', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, author: { login: 'human-one', isBot: false } });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  assert.equal((await callTool(h, 'comment', { thread: '#41', body: 'A bot answer.' })).isError, undefined);
  const botId = (await api.listComments(ISSUE)).at(-1)?.id as number;

  // Load the history while it exists.
  await h.server.onEvent({
    id: 'load-history',
    receivedAt: '2026-10-01T00:00:00.000Z',
    repo: TEST_REPO,
    kind: 'issue.edited',
    thread: { ...ISSUE },
    actor: { login: 'human-one', isBot: false },
    html_url: `https://github.com/${TEST_REPO.owner}/${TEST_REPO.name}/issues/41`,
  });
  await until(() => pushes(h).length === 1, 'the history-loading event');

  const deleted = await callTool(h, 'delete_own_comment', { thread: '#41', commentId: botId, review: false });
  assert.equal(deleted.isError, undefined, textOf(deleted));
  assert.deepEqual(await api.listComments(ISSUE), [], 'the comment is gone from GitHub');

  // Not a rollback this time — the tool straight out. The same removal has to
  // happen, or the next human comment replies to a comment that is not there.
  const body = 'Anything at all.';
  api.seedComment(ISSUE, { id: botId + 1, author: { login: 'human-one', isBot: false }, body });
  await h.server.onEvent(humanComment(botId + 1, body));
  await until(() => pushes(h).length === 2, 'the comment after the deletion');
  assert.equal(metadataOf(pushes(h)[1]).isReplyToSelf, false, 'a deleted comment is not a predecessor');
  assert.equal(metadataOf(pushes(h)[1]).isOwnThread, true, 'the bot having spoken is not undone');
});

// ── Round 4, finding 1: a deletion event is a removal, not an insertion ──

/** An `issue_comment.deleted` delivery body for one comment on issue 41. */
function deletionDelivery(comment: { id: number; body: string }, sender: { login: string; type: string }): string {
  return JSON.stringify({
    action: 'deleted',
    repository: { full_name: `${TEST_REPO.owner}/${TEST_REPO.name}`, name: TEST_REPO.name, owner: { login: TEST_REPO.owner } },
    sender,
    issue: { number: 41, title: 'deletion' },
    comment: {
      id: comment.id,
      body: comment.body,
      html_url: `https://github.com/${TEST_REPO.owner}/${TEST_REPO.name}/issues/41#issuecomment-${comment.id}`,
    },
  });
}

test('a deletion webhook after a rollback-delete does not put the comment back (finding 1)', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, author: { login: 'human-one', isBot: false } });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);
  const deliver = await webhook(t, h);

  const mark = (await h.host.sendRequest('state/checkpoint', {})) as { checkpoint: string };
  assert.equal((await callTool(h, 'comment', { thread: '#41', body: 'Temporary bot answer.' })).isError, undefined);
  const bot = (await api.listComments(ISSUE)).at(-1) as { id: number; body: string };

  const rolled = (await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: COMMENTS_FEATURE_SET,
    checkpoint: mark.checkpoint,
  })) as { success: boolean };
  assert.equal(rolled.success, true);
  assert.deepEqual(await api.listComments(ISSUE), []);

  // GitHub now tells us what we already did — over the real listener, on
  // signed loopback HTTP, so the normalizer and the whole event path are in
  // it. The kind has to be `comment.deleted` for the rest to mean anything.
  const body = deletionDelivery(bot, { login: TEST_BOT.login, type: 'Bot' });
  assert.deepEqual(
    normalizeWebhook({ id: 'deletion-1', receivedAt: '2026-10-01T00:00:00.000Z', event: 'issue_comment', payload: JSON.parse(body) }).map(
      (e) => e.kind,
    ),
    ['comment.deleted'],
  );
  const res = await deliver('issue_comment', body, 'deletion-1');
  assert.ok(res.ok);

  // The confirmation must not resurrect what it is confirming.
  const unrelated = 'Unrelated human question.';
  api.seedComment(ISSUE, { id: bot.id + 10, author: { login: 'human-one', isBot: false }, body: unrelated });
  await h.server.onEvent(humanComment(bot.id + 10, unrelated));
  await until(() => pushes(h).some((e) => (e.origin as { kind: string }).kind === 'comment.created'), 'the unrelated comment');
  const after = pushes(h).filter((e) => (e.origin as { kind: string }).kind === 'comment.created');
  assert.equal(metadataOf(after[0]).isReplyToSelf, false, 'a deleted predecessor is not a predecessor');

  // A second comment after the deletion: still not a reply, and the thread
  // is still the bot's — `own` is history, not a census of the page.
  api.seedComment(ISSUE, { id: bot.id + 11, author: { login: 'human-one', isBot: false }, body: 'and again?' });
  await h.server.onEvent(humanComment(bot.id + 11, 'and again?'));
  await until(() => pushes(h).filter((e) => (e.origin as { kind: string }).kind === 'comment.created').length === 2, 'the second comment');
  const quoted = pushes(h).filter((e) => (e.origin as { kind: string }).kind === 'comment.created')[1];
  assert.equal(metadataOf(quoted).isReplyToSelf, false, 'the deleted comment is not a predecessor');
  // And the bot having written here is still history.
  assert.equal(metadataOf(quoted).isOwnThread, true);
});

test('a human deleting their own comment leaves the bot’s turn order right (finding 1)', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, author: { login: 'human-one', isBot: false } });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);
  const deliver = await webhook(t, h);

  // The bot speaks, then a human speaks after it, then the human deletes
  // their own comment — which puts the bot's comment back at the end.
  assert.equal((await callTool(h, 'comment', { thread: '#41', body: 'The bot answer.' })).isError, undefined);
  const botId = (await api.listComments(ISSUE)).at(-1)?.id as number;
  const humanId = botId + 10;
  api.seedComment(ISSUE, { id: humanId, author: { login: 'human-one', isBot: false }, body: 'human noise' });
  await h.server.onEvent(humanComment(humanId, 'human noise'));
  await until(() => pushes(h).length === 1, 'the human comment');
  await api.deleteComment(TEST_REPO, humanId, false);

  const res = await deliver(
    'issue_comment',
    deletionDelivery({ id: humanId, body: 'human noise' }, { login: 'human-one', type: 'User' }),
    'deletion-2',
  );
  assert.ok(res.ok);

  // With the human's comment gone, the bot's is the last one again, so the
  // next comment follows the bot. Before the fix the deletion re-inserted the
  // human's id and the next comment read as following *it* instead.
  //
  // Counted from the deletion delivery, which is itself an event and so a
  // push of its own.
  const before = pushes(h).length;
  const next = 'And now?';
  api.seedComment(ISSUE, { id: humanId + 1, author: { login: 'human-one', isBot: false }, body: next });
  await h.server.onEvent(humanComment(humanId + 1, next));
  await until(() => pushes(h).length > before, 'the comment after the deletion');
  assert.equal(metadataOf(pushes(h).at(-1) as PushEventParams).isReplyToSelf, true, 'the bot’s comment is the predecessor again');
});

// ── Round 4, finding 2: a late history snapshot does not resurrect a removal ──

/**
 * Hold the *first* `listComments` snapshot open.
 *
 * Returns the moment the snapshot has been taken and a release for it, so a
 * test can land a deletion or a restore in the window between GitHub
 * answering and the server merging what it answered — the window production
 * has because `server.onEvent` runs independently of the serialized
 * host-request loop.
 */
function holdFirstHistoryRead(api: FakeGitHubApi): { taken: Promise<void>; release: () => void } {
  const original = api.listComments.bind(api);
  let signalTaken!: () => void;
  let signalRelease!: () => void;
  const taken = new Promise<void>((r) => {
    signalTaken = r;
  });
  const heldUntil = new Promise<void>((r) => {
    signalRelease = r;
  });
  let first = true;
  api.listComments = async (...args: Parameters<typeof original>) => {
    const snapshot = await original(...args);
    if (!first) return snapshot;
    first = false;
    // Deep-copied, because the fake's shallow `[...list]` shares the comment
    // objects with the store, so an edit landing during the hold would show
    // through and there would be nothing stale to merge. A real response is
    // JSON that left the server before the edit happened; this is that.
    const held = structuredClone(snapshot);
    signalTaken();
    await heldUntil;
    return held;
  };
  return { taken, release: signalRelease };
}

test('a history snapshot taken before a rollback-delete does not bring the comment back (finding 2)', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, author: { login: 'human-one', isBot: false } });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const mark = (await h.host.sendRequest('state/checkpoint', {})) as { checkpoint: string };
  assert.equal((await callTool(h, 'comment', { thread: '#41', body: 'Temporary bot answer.' })).isError, undefined);
  const botId = (await api.listComments(ISSUE)).at(-1)?.id as number;

  // An event's history read is started and held open with the bot's comment
  // still in the snapshot it took.
  const hold = holdFirstHistoryRead(api);
  const inFlight = h.server.onEvent({
    id: 'load-history',
    receivedAt: '2026-10-01T00:00:00.000Z',
    repo: TEST_REPO,
    kind: 'issue.edited',
    thread: { ...ISSUE },
    actor: { login: 'human-one', isBot: false },
    html_url: `https://github.com/${TEST_REPO.owner}/${TEST_REPO.name}/issues/41`,
  });
  await hold.taken;

  // The rollback deletes it while that snapshot is in the server's hand.
  const rolled = (await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: COMMENTS_FEATURE_SET,
    checkpoint: mark.checkpoint,
  })) as { success: boolean };
  assert.equal(rolled.success, true);
  assert.deepEqual(await api.listComments(ISSUE), []);

  // Now the stale snapshot lands. Merging it would seat the deleted comment
  // back into the turn order, which is exactly what used to happen: `learn`
  // only inserts, so no later read would have expunged it either.
  hold.release();
  await inFlight;

  const unrelated = 'Unrelated human question.';
  api.seedComment(ISSUE, { id: botId + 10, author: { login: 'human-one', isBot: false }, body: unrelated });
  await h.server.onEvent(humanComment(botId + 10, unrelated));
  await until(() => pushes(h).length === 2, 'the unrelated comment');
  assert.equal(metadataOf(pushes(h)[1]).isReplyToSelf, false, 'a deleted predecessor is not a predecessor');

  api.seedComment(ISSUE, { id: botId + 11, author: { login: 'human-one', isBot: false }, body: 'and again?' });
  await h.server.onEvent(humanComment(botId + 11, 'and again?'));
  await until(() => pushes(h).length === 3, 'the second comment after the snapshot');
  assert.equal(metadataOf(pushes(h)[2]).isReplyToSelf, false, 'the stale snapshot seated nothing');
  // Historical ownership survives the removal, as it must.
  assert.equal(metadataOf(pushes(h)[2]).isOwnThread, true, 'the bot having spoken is not undone');
});

test('a read that still lists a deleted comment does not bring it back either (finding 2)', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, author: { login: 'human-one', isBot: false } });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  assert.equal((await callTool(h, 'comment', { thread: '#41', body: 'Temporary bot answer.' })).isError, undefined);
  const gone = (await api.listComments(ISSUE)).at(-1) as { id: number; body: string };
  assert.equal((await callTool(h, 'delete_own_comment', { thread: '#41', commentId: gone.id })).isError, undefined);

  // GitHub's list has not caught up: the read the deletion triggers is
  // started *after* it, so no generation can tell it is wrong. Only knowing
  // the id is gone can. (The replica lag is the point of the test; a list
  // this server has already contradicted must not win just by being newer.)
  const original = api.listComments.bind(api);
  let lagging = true;
  api.listComments = async (...args: Parameters<typeof original>) => {
    const list = await original(...args);
    if (!lagging) return list;
    lagging = false;
    return [...list, { ...gone, author: { login: TEST_BOT.login, isBot: true } } as (typeof list)[number]];
  };

  const unrelated = 'Unrelated human question.';
  api.seedComment(ISSUE, { id: gone.id + 10, author: { login: 'human-one', isBot: false }, body: unrelated });
  await h.server.onEvent(humanComment(gone.id + 10, unrelated));
  await until(() => pushes(h).length === 1, 'the unrelated comment');
  assert.equal(metadataOf(pushes(h)[0]).isReplyToSelf, false, 'a lagging list does not undo a deletion');

  api.seedComment(ISSUE, { id: gone.id + 11, author: { login: 'human-one', isBot: false }, body: 'and again?' });
  await h.server.onEvent(humanComment(gone.id + 11, 'and again?'));
  await until(() => pushes(h).length === 2, 'the second comment after the lagging read');
  assert.equal(metadataOf(pushes(h)[1]).isReplyToSelf, false, 'nor does a later read seat it');
});

// ── Round 8: a successful edit still teaches the comment's identity ──

/**
 * A thread whose first — and only — history read misses the bot's comment.
 *
 * The record is loaded by an event *before* the tool call, which is the
 * whole point: a loaded record is never read again, so whatever that one
 * lagging answer omitted can only be learned from the call itself.
 */
async function loadedWithoutTheBotsComment(t: TestContext): Promise<{ h: Harness; api: FakeGitHubApi }> {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  api.seedComment(ISSUE, { id: 7001, author: { login: 'human-one', isBot: false }, body: 'first human' });
  api.seedComment(ISSUE, { id: 7002, author: TEST_BOT, body: '<!-- status -->\nold bot' });

  // A replica that has not caught up: the bounded history read answers
  // without 7002. Every later read is honest.
  const live = api.listComments.bind(api);
  let reads = 0;
  api.listComments = async (...args: Parameters<typeof live>) => {
    const answer = await live(...args);
    reads += 1;
    return reads === 1 ? answer.filter((c) => c.id !== 7002) : answer;
  };

  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);
  await h.server.onEvent(humanComment(7001, 'first human'));
  await until(() => pushes(h).length === 1, 'the warming event');
  assert.ok(reads >= 1, 'the lagging read is the one that loaded the record');
  return { h, api };
}

for (const tool of ['edit_own_comment', 'upsert_sticky_comment'] as const) {
  test(`a successful ${tool} puts the comment into the turn order (round 8)`, async (t) => {
    const { h, api } = await loadedWithoutTheBotsComment(t);

    const thread = { ...TEST_REPO, number: 41 };
    const edited = await callTool(
      h,
      tool,
      tool === 'edit_own_comment'
        ? { thread, commentId: 7002, review: false, body: 'new bot' }
        : { thread, marker: 'status', body: 'new bot' },
    );
    assert.equal(edited.isError, undefined, textOf(edited));
    // It edited the comment that was already there rather than posting a new
    // one — otherwise the test would be about a creation, which never
    // regressed.
    assert.deepEqual((await api.listComments(ISSUE)).map((c) => c.id), [7001, 7002]);

    // No webhook echo of the bot's own edit: the call itself has to be what
    // teaches the id, which is exactly what round 7 removed.
    api.seedComment(ISSUE, { id: 7003, author: { login: 'human-one', isBot: false }, body: 'reply to bot' });
    await h.server.onEvent(humanComment(7003, 'reply to bot'));
    await until(() => pushes(h).length === 2, 'the human comment after the bot');

    const metadata = metadataOf(pushes(h)[1]);
    assert.equal(metadata.isReplyToSelf, true, 'the edited bot comment is 7003’s predecessor');
    assert.equal(metadata.isOwnThread, true);
  });
}

test('a review-comment edit stays out of the top-level turn order (round 8)', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, head: { ref: 'fix-final-batch', sha: HEAD } });
  // The bot owns a *review* comment, numbered on the other endpoint.
  // Its id is chosen to sit *between* the two top-level comments below, which
  // is the whole hazard: GitHub numbers the two endpoints separately, so a
  // review id can land anywhere among the issue-comment ids. Were it to leak
  // into the top-level order it would become 6010's predecessor and claim a
  // reply that never happened.
  const review = api.seedReviewThread(PULL, {
    comments: [{ id: 6005, author: TEST_BOT, body: 'bot review note', createdAt: '2026-10-01T00:00:00.000Z' }],
  });
  // The last top-level comment is a human's.
  api.seedComment(PULL, { id: 6002, author: { login: 'human-one', isBot: false }, body: 'unrelated' });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  await h.server.onEvent({ ...humanComment(6002, 'unrelated'), thread: { ...PULL } });
  await until(() => pushes(h).length === 1, 'the warming event');

  const edited = await callTool(h, 'edit_own_comment', {
    thread: { ...TEST_REPO, number: 58, kind: 'pull' },
    commentId: review.comments[0].id,
    review: true,
    body: 'bot review note, revised',
  });
  assert.equal(edited.isError, undefined, textOf(edited));

  // The next top-level comment follows the *human* at 6002, not the review
  // comment at 6005 the bot just edited.
  api.seedComment(PULL, { id: 6010, author: { login: 'human-one', isBot: false }, body: 'and then?' });
  await h.server.onEvent({ ...humanComment(6010, 'and then?'), thread: { ...PULL } });
  await until(() => pushes(h).length === 2, 'the next top-level comment');
  assert.equal(metadataOf(pushes(h)[1]).isReplyToSelf, false, 'a review edit is not a top-level turn');
});

test('amendment 2b: a comment the bot tool-wrote is remembered, so the next human comment replies to it', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, author: { login: 'human-one', isBot: false } });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  // The bot answers with the `comment` tool. Nothing invalidates the thread's
  // history on this path, so if the write were not recorded the record would
  // not know the bot had spoken — which is the gap this closes.
  const written = await callTool(h, 'comment', { thread: { ...TEST_REPO, number: 41, kind: 'issue' }, body: 'Looking now.' });
  assert.equal(written.isError, undefined, textOf(written));
  const botCommentId = (await api.listComments(ISSUE)).at(-1)?.id as number;
  assert.ok(botCommentId > 0);

  // A human answers it. The reply has to be seen even though GitHub's issue
  // comment carries no `in_reply_to_id`.
  api.seedComment(ISSUE, { id: botCommentId + 1, author: { login: 'human-one', isBot: false }, body: 'thanks' });
  await h.server.onEvent(humanComment(botCommentId + 1, 'thanks'));
  await until(() => pushes(h).length >= 1, 'the human reply');

  const metadata = metadataOf(pushes(h).at(-1) as PushEventParams);
  assert.equal(metadata.isReplyToSelf, true, 'the bot’s tool write is the comment before this one');
});

test('a review reply a tool wrote is remembered, so a human answer to it is a reply to self', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, head: { ref: 'fix-final-batch', sha: HEAD } });
  // A human opened this review conversation and the bot has written nothing on
  // the pull request yet.
  api.seedReviewThread(PULL, {
    comments: [
      { id: 2500000077, author: { login: 'octocat', isBot: false }, body: 'why this bound?', createdAt: '2026-10-01T00:00:00.000Z' },
    ],
  });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  // One event first, so the thread history is cached: a cached entry is never
  // looked up again, which is what made the tool's own reply invisible to the
  // knowledge (WP9 review round 2, finding 2). Anything the test asserts below
  // can therefore only have come from the tool call.
  const deliver = await webhook(t, h);
  await deliver('issue_comment', fixture('issue_comment.created.on_pull.json'), 'warm-1');
  await until(() => pushes(h).length === 1, 'the warming event');
  assert.equal(metadataOf(pushes(h)[0]).isOwnThread, false, 'the bot is not in this thread yet');
  assert.ok(api.callsTo('listReviewThreads').length >= 1, 'the warming event loaded the history');

  const written = await callTool(h, 'reply_in_thread', {
    thread: PULL,
    threadId: 'rt:2500000077',
    body: 'because the ring is bounded',
  });
  assert.notEqual(written.isError, true, textOf(written));
  // The id GitHub answered with, read off the state record rather than the
  // prose, and without an API call of its own.
  const record = Object.values(h.server.state.snapshot().created).flat().at(-1);
  assert.ok(record, 'the reply was recorded');
  assert.equal(record.review, true, 'as a review comment');

  // A human answers the comment the tool just created, before any webhook of
  // the bot's own reply has arrived.
  const payload = JSON.parse(fixture('pull_request_review_comment.created.reply.json'));
  const human = { login: 'octocat', id: 583231, type: 'User' };
  payload.sender = human;
  payload.comment.user = human;
  payload.comment.id = 2500000079;
  payload.comment.in_reply_to_id = record.commentId;
  await deliver('pull_request_review_comment', JSON.stringify(payload), 'answer-1');
  await until(() => pushes(h).length === 2, 'the human answer');

  const metadata = metadataOf(pushes(h)[1]);
  assert.equal(metadata.isOwnThread, true);
  assert.equal(metadata.isReplyToSelf, true, 'the comment it answers is the one the tool wrote');
  assert.ok((pushes(h)[1].tags ?? []).includes('chat:reply'), (pushes(h)[1].tags ?? []).join(','));
  assert.ok(api.callsTo('listReviewThreads').length <= 1, 'and nothing was looked up a second time');
});

test('an issue comment the bot wrote is never taken for the review comment a reply names', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, head: { ref: 'fix-final-batch', sha: HEAD } });
  api.seedReviewThread(PULL, {
    comments: [
      { id: 2500000077, author: { login: 'octocat', isBot: false }, body: 'why this bound?', createdAt: '2026-10-01T00:00:00.000Z' },
    ],
  });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  // An *issue* comment on the pull request. GitHub numbers the two endpoints
  // separately, so its id must never satisfy a review comment's `inReplyTo`.
  const written = await callTool(h, 'comment', { thread: PULL, body: 'summary of the run' });
  assert.notEqual(written.isError, true, textOf(written));
  const record = Object.values(h.server.state.snapshot().created).flat().at(-1);
  assert.ok(record);
  assert.equal(record.review, false, 'an issue comment');

  const payload = JSON.parse(fixture('pull_request_review_comment.created.reply.json'));
  const human = { login: 'octocat', id: 583231, type: 'User' };
  payload.sender = human;
  payload.comment.user = human;
  payload.comment.id = 2500000079;
  payload.comment.in_reply_to_id = record.commentId;
  const deliver = await webhook(t, h);
  await deliver('pull_request_review_comment', JSON.stringify(payload), 'collision-1');
  await until(() => pushes(h).length === 1, 'the review reply');

  const metadata = metadataOf(pushes(h)[0]);
  assert.equal(metadata.isOwnThread, true, 'the bot has written on the thread');
  assert.equal(metadata.isReplyToSelf, false, 'but not the review comment this answers');
});

test('an issue thread costs at most two lookups: the author and the comments', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  api.seedComment(ISSUE, { author: TEST_BOT, body: 'on it' });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const deliver = await webhook(t, h);
  await deliver('issue_comment', fixture('issue_comment.created.json'), 'own-1');
  await until(() => pushes(h).length === 1, 'the comment event');

  const metadata = (pushes(h)[0].origin as { metadata: Record<string, unknown> }).metadata;
  assert.equal(metadata.isOwnThread, true, 'the bot has spoken on this issue');
  assert.equal(metadata.mentioned, true, 'and the body mentions it');
  assert.ok(api.callsTo('getIssue').length <= 1, 'at most one author read, for a thread the bot may have opened');
  assert.ok(api.callsTo('listComments').length <= 1, 'at most one comments read');
  assert.equal(api.callsTo('listReviewThreads').length, 0, 'an issue has no review threads');
  assert.equal(api.callsTo('getPullRequest').length, 0, 'and it is not a pull request');
});

// ─────────────────────────────────────────────────────────────────────────────
// Channels and tools
// ─────────────────────────────────────────────────────────────────────────────

test('channels/open answers by address, and publish routes by threadId', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58 });
  const reviewThread = api.seedReviewThread(PULL);
  const root = reviewThread.comments[0].id;
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  // A thread the server has not announced yet is registered on demand, so the
  // host gets a descriptor rather than a refusal.
  const opened = (await h.host.sendRequest(method.CHANNELS_OPEN, {
    address: { owner: TEST_REPO.owner, name: TEST_REPO.name, number: 58, kind: 'pull' },
  })) as { channel: { id: string; address: unknown } };
  assert.equal(opened.channel.id, channelId(PULL));
  assert.deepEqual(opened.channel.address, { owner: TEST_REPO.owner, name: TEST_REPO.name, number: 58, kind: 'pull' });

  // No threadId: a top-level comment. Never the latest thread on the channel.
  const top = (await h.host.sendRequest(method.CHANNELS_PUBLISH, {
    channelId: channelId(PULL),
    content: [{ type: 'text', text: 'top-level answer' }],
  })) as { delivered: boolean; route: string; commentId: number; isReviewComment: boolean };
  assert.equal(top.delivered, true);
  assert.equal(top.route, 'comment');
  assert.equal(top.isReviewComment, false);

  // `rt:<root review comment id>`: a reply inside that review conversation.
  const reply = (await h.host.sendRequest(method.CHANNELS_PUBLISH, {
    channelId: channelId(PULL),
    threadId: `rt:${root}`,
    content: [{ type: 'text', text: 'inline reply' }],
  })) as { delivered: boolean; route: string; commentId: number; isReviewComment: boolean };
  assert.equal(reply.route, 'review-reply');
  assert.equal(reply.isReviewComment, true);

  // One top-level comment on the thread itself, one reply through the review
  // endpoint: the route is the `threadId`'s, not a guess at the last thread.
  assert.deepEqual(
    api.callsTo('createComment').map((c) => (c.args[0] as { number: number }).number),
    [58],
  );
  assert.equal(api.callsTo('replyToReviewComment').length, 1);
  assert.equal(api.callsTo('replyToReviewComment')[0].args[1], root);
  // The top-level comment landed on the issue surface of the pull request.
  assert.deepEqual(
    (await api.listComments(PULL)).map((c) => c.body),
    ['top-level answer'],
  );
  // And the reply inside the review thread.
  const threads = await api.listReviewThreads(PULL);
  assert.deepEqual(
    threads[0].comments.map((c) => c.body),
    ['this line', 'inline reply'],
  );
});

test('channels/close reports whether the channel was registered, and tears nothing down', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const unknown = (await h.host.sendRequest(method.CHANNELS_CLOSE, { channelId: channelId(ISSUE) })) as {
    closed: boolean;
  };
  assert.equal(unknown.closed, false);

  const deliver = await webhook(t, h);
  await deliver('issues', fixture('issues.opened.json'), 'close-1');
  await until(() => incoming(h).length === 1, 'the first delivery');

  const known = (await h.host.sendRequest(method.CHANNELS_CLOSE, { channelId: channelId(ISSUE) })) as {
    closed: boolean;
  };
  assert.equal(known.closed, true);
  // A GitHub thread outlives a host's interest in it: a later event is still
  // delivered, because it is still a push and still the same channel.
  await deliver('issues', fixture('issues.closed.json'), 'close-2');
  await until(() => incoming(h).length === 2, 'the delivery after close');
});

test('create_review submits the inline comments with the review', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58 });
  api.seedFiles(PULL, [{ filename: 'src/lib.rs', status: 'modified', additions: 3, deletions: 1, changes: 4 }]);
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const result = await callTool(h, 'create_review', {
    number: 58,
    event: 'COMMENT',
    body: 'looks close',
    comments: [
      { path: 'src/lib.rs', line: 42, side: 'RIGHT', body: 'off by one' },
      { path: 'src/lib.rs', line: 43, side: 'RIGHT', body: 'and this' },
    ],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /with 2 inline comments/);
  // github.review is not rollback-capable, so no checkpoint rides along.
  assert.equal(result.state, undefined);

  const [review] = api.submittedReviews();
  assert.equal(review.state, 'commented');
  assert.deepEqual(
    api.callsTo('createReview').map((c) => (c.args[1] as { comments: { body: string }[] }).comments.map((x) => x.body)),
    [['off by one', 'and this']],
  );
});

test('upsert_sticky_comment creates once and then edits in place', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const first = await callTool(h, 'upsert_sticky_comment', { thread: '#58', marker: 'ci-status', body: 'run 1' });
  const second = await callTool(h, 'upsert_sticky_comment', { thread: '#58', marker: 'ci-status', body: 'run 2' });
  assert.match(textOf(first), /created sticky <!-- ci-status -->/);
  assert.match(textOf(second), /updated sticky <!-- ci-status -->/);

  assert.equal(api.callsTo('createComment').length, 1, 'created once');
  assert.equal(api.callsTo('updateComment').length, 1, 'then edited');
  // The `review` flag names the endpoint: a sticky is an issue comment.
  assert.equal(api.callsTo('updateComment')[0].args[3], false);
  assert.deepEqual(
    (await api.listComments(PULL)).map((c) => c.body),
    ['<!-- ci-status -->\nrun 2'],
  );

  // Both calls are checkpointed, and the second's parent is the first (§8.2).
  assert.equal(second.state?.parent, first.state?.checkpoint);
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkpoint and rollback
// ─────────────────────────────────────────────────────────────────────────────

test('checkpoint, two comments, rollback — the comments are deleted', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const mark = (await h.host.sendRequest('state/checkpoint', {})) as { checkpoint: string; parent: string | null };
  assert.equal(mark.parent, null, 'the first checkpoint has no parent');

  const first = await callTool(h, 'comment', { thread: '#58', body: 'first' });
  const second = await callTool(h, 'comment', { thread: '#58', body: 'second' });
  // Each github.comments call answers its own checkpoint and its parent.
  assert.equal(first.state?.parent, mark.checkpoint);
  assert.equal(second.state?.parent, first.state?.checkpoint);
  assert.deepEqual(
    (await api.listComments(PULL)).map((c) => c.body),
    ['first', 'second'],
  );

  const rolled = (await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: COMMENTS_FEATURE_SET,
    checkpoint: mark.checkpoint,
  })) as { checkpoint: string; success: boolean; undone: { action: string; commentId: number }[]; notUndone: [] };
  assert.equal(rolled.success, true);
  assert.equal(rolled.checkpoint, mark.checkpoint);
  assert.deepEqual(rolled.notUndone, []);
  // Newest first, and both deletes.
  assert.deepEqual(
    rolled.undone.map((u) => u.action),
    ['delete', 'delete'],
  );
  assert.deepEqual(await api.listComments(PULL), [], 'both comments are gone');
  assert.equal(api.callsTo('deleteComment').length, 2);
});

test('a published comment is rolled back exactly as a tool call is', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const mark = (await h.host.sendRequest('state/checkpoint', {})) as { checkpoint: string };
  await h.host.sendRequest(method.CHANNELS_OPEN, {
    address: { owner: TEST_REPO.owner, name: TEST_REPO.name, number: 58, kind: 'pull' },
  });
  await h.host.sendRequest(method.CHANNELS_PUBLISH, {
    channelId: channelId(PULL),
    content: [{ type: 'text', text: 'published, then undone' }],
  });
  assert.equal((await api.listComments(PULL)).length, 1);

  const rolled = (await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: COMMENTS_FEATURE_SET,
    checkpoint: mark.checkpoint,
  })) as { success: boolean; undone: { action: string }[] };
  assert.equal(rolled.success, true);
  assert.deepEqual(
    rolled.undone.map((u) => u.action),
    ['delete'],
  );
  assert.deepEqual(await api.listComments(PULL), [], 'the publish was undone');
});

test('a rollback of an unknown checkpoint is -32005, and of another feature set is refused', async (t) => {
  const h = rig(t);
  await initialize(h, true);
  await grant(h);

  const unknown = await refusal(
    h.host.sendRequest(method.STATE_ROLLBACK, { featureSet: COMMENTS_FEATURE_SET, checkpoint: 'chk_nope' }),
  );
  assert.equal(unknown.code, ERR_UNKNOWN_CHECKPOINT);

  // Only github.comments is rollback-capable. A rollback naming another set
  // is answered — WP7's choice — with an unsuccessful *result* that says so,
  // never with a checkpoint error, because the checkpoint was never the
  // problem.
  const wrongSet = (await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: READ_FEATURE_SET,
    checkpoint: 'chk_nope',
  })) as { success: boolean; reason: string; undone: []; notUndone: [] };
  assert.equal(wrongSet.success, false);
  assert.match(wrongSet.reason, /does not support rollback/);
  assert.deepEqual(wrongSet.undone, []);

  // `state/checkpoint` does refuse one, because there is nothing to answer:
  // taking a checkpoint of a set that cannot be rolled back is a bad call.
  const wrongCheckpointSet = await refusal(h.host.sendRequest('state/checkpoint', { featureSet: READ_FEATURE_SET }));
  assert.equal(wrongCheckpointSet.code, -32602);
  assert.match(wrongCheckpointSet.message, /not rollback-capable/);
});

// ─────────────────────────────────────────────────────────────────────────────
// End to end
// ─────────────────────────────────────────────────────────────────────────────

test('end to end: a delivery wakes the host, the host answers in the channel, and the answer is undone', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const state = GithubState.empty(null, silentLogger());
  const h = rig(t, { api, state });
  await initialize(h, true);
  await grant(h);

  // 1. One webhook fixture in.
  const deliver = await webhook(t, h);
  const res = await deliver('issues', fixture('issues.opened.json'), 'e2e-1');
  assert.ok(res.status >= 200 && res.status < 300);
  await until(() => incoming(h).length === 1 && pushes(h).length === 1, 'the wake');

  // 2. Out as a channel message with its tags, on the thread's own channel.
  const message = incoming(h)[0];
  assert.equal(message.channelId, channelId(ISSUE));
  assert.deepEqual(message.tags, ['chat:from-human', 'chat:ambient', 'github:issue=opened']);

  // 3. The host marks a point it may want back, then answers twice: once
  //    through the channel it was woken on, once through the tool.
  const mark = (await h.host.sendRequest('state/checkpoint', {})) as { checkpoint: string };
  await h.host.sendRequest(method.CHANNELS_PUBLISH, {
    channelId: message.channelId,
    content: [{ type: 'text', text: 'looking at it' }],
  });
  const tooled = await callTool(h, 'comment', { thread: `github:${TEST_REPO.owner}/${TEST_REPO.name}#41`, body: 'fixed in abc123' });
  assert.equal(tooled.isError, undefined, textOf(tooled));
  assert.deepEqual(
    (await api.listComments(ISSUE)).map((c) => c.body),
    ['looking at it', 'fixed in abc123'],
  );
  // The tool call was checkpointed on top of the host's mark (§8.2).
  assert.equal(tooled.state?.parent, mark.checkpoint);

  // 4. Rollback takes both of them away: a publish and a tool call are the
  //    same write as far as the checkpoint is concerned.
  const rolled = (await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: COMMENTS_FEATURE_SET,
    checkpoint: mark.checkpoint,
  })) as { success: boolean; undone: { action: string }[]; notUndone: [] };
  assert.equal(rolled.success, true);
  assert.deepEqual(rolled.undone.map((u) => u.action), ['delete', 'delete']);
  assert.deepEqual(await api.listComments(ISSUE), []);

  // 5. The store the server was handed is the store that recorded it all —
  //    `ToolContext.state`, the publish path and `state/checkpoint` are one
  //    seam, not three.
  assert.deepEqual(state.lineage().map((c) => c.id).slice(0, 2), [mark.checkpoint, tooled.state?.checkpoint]);
  assert.equal(state.current(), mark.checkpoint, 'the rollback moved current back to the mark');
  assert.equal(state.rollback(mark.checkpoint)?.created.length, 0, 'and nothing is left to undo');
});

test('the ingress paths share one check gate: a webhook and a poll do not both emit the head', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, head: { ref: 'fix-final-batch', sha: HEAD } });
  api.seedCheckRuns(TEST_REPO, { sha: HEAD, conclusion: 'failure', total: 2, failed: [{ name: 'clippy', url: 'u' }] });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  // The one gate `src/index.ts` hands to both.
  const gate = new CheckGate();
  const deliver = await webhook(t, h, gate);
  await deliver('check_suite', fixture('check_suite.completed.json'), 'gate-1');
  await until(() => pushes(h).length === 1, 'the webhook check event');

  const polled: NormalizedEvent[] = [];
  const state = GithubState.empty(null, silentLogger());
  state.setLastPollAt('2026-10-13T00:00:00.000Z');
  const poller = new Poller({
    api,
    repos: [TEST_REPO],
    state,
    intervalMs: 60_000,
    onEvent: async (event) => {
      polled.push(event);
      await h.server.onEvent(event);
    },
    logger: silentLogger(),
    checkGate: gate,
  });
  await poller.pollOnce();
  await poller.whenIdle();
  assert.equal(
    polled.filter((e) => e.kind === 'checks.completed').length,
    0,
    'the poll stood down on a head the webhook already reported',
  );
  assert.equal(
    pushes(h).filter((p: PushEventParams) => (p.origin as { kind: string }).kind === 'checks.completed').length,
    1,
    'one checks.completed reached the host',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The review round: one case per finding (WP9 review, findings 1–8)
// ─────────────────────────────────────────────────────────────────────────────

/** A human comment on `thread`, the shape both ingress paths produce. */
function commentEvent(id: string, thread: NormalizedEvent['thread'] = ISSUE): NormalizedEvent {
  return {
    id,
    receivedAt: new Date().toISOString(),
    repo: TEST_REPO,
    kind: 'comment.created',
    thread,
    actor: { login: 'human-one', isBot: false },
    body: 'a human follow-up',
    html_url: `https://github.com/${TEST_REPO.owner}/${TEST_REPO.name}/issues/${thread?.number}#issuecomment-1`,
  };
}

test('finding 1: the channel path is bound by GITHUB_REPOS, at open and at every write', async (t) => {
  const api = new FakeGitHubApi();
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const outside = { owner: 'outside', name: 'not-allowed', number: 77, kind: 'issue' } as const;
  const refused = await refusal(h.host.sendRequest(method.CHANNELS_OPEN, { type: 'github', address: outside }));
  assert.equal(refused.code, -32602);
  assert.match(refused.message, /outside\/not-allowed is not in GITHUB_REPOS/);
  assert.deepEqual(refused.data, {
    repo: 'outside/not-allowed',
    allowed: [`${TEST_REPO.owner}/${TEST_REPO.name}`],
  });

  // Nothing was announced and nothing was written: the refusal came before
  // the registration, so there is no channel to publish to either.
  assert.deepEqual(h.hostSaw.map((r) => r.method), [], 'no outbound registration');
  const unknown = await refusal(
    h.host.sendRequest(method.CHANNELS_PUBLISH, {
      channelId: 'github:outside/not-allowed#77',
      content: [{ type: 'text', text: 'outside write' }],
    }),
  );
  assert.equal(unknown.code, -32023, 'an unknown channel, because it was never registered');
  assert.deepEqual(api.calls, [], 'no GitHub call was made at any point');
});

test('finding 1: a channel registered before the allow-list narrowed cannot be written to', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);
  await h.host.sendRequest(method.CHANNELS_OPEN, {
    address: { owner: TEST_REPO.owner, name: TEST_REPO.name, number: 41, kind: 'issue' },
  });

  // The configuration narrows under the server's feet — a state file and a
  // registry outlive a GITHUB_REPOS change.
  (h.server.options as { repos: unknown }).repos = [{ owner: 'other', name: 'repo' }];
  const refused = await refusal(
    h.host.sendRequest(method.CHANNELS_PUBLISH, {
      channelId: channelId(ISSUE),
      content: [{ type: 'text', text: 'after the narrowing' }],
    }),
  );
  assert.equal(refused.code, -32602);
  assert.match(refused.message, /channels\/publish: repository anima-research\/rayforce is not in GITHUB_REPOS/);
  assert.deepEqual(api.callsTo('createComment'), [], 'the refusal came before the GitHub call');
});

test('finding 2: opening a new channel needs channels.register; reading one back does not', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);

  // `channels.lifecycle` alone answers the method, and refuses to announce.
  await grant(h, ['channels.lifecycle']);
  const address = { owner: TEST_REPO.owner, name: TEST_REPO.name, number: 41, kind: 'issue' };
  const refused = await refusal(h.host.sendRequest(method.CHANNELS_OPEN, { type: 'github', address }));
  assert.equal(refused.code, ERR_CAPABILITY_DENIED);
  assert.deepEqual(refused.data, { capability: 'channels.register' });
  assert.deepEqual(h.hostSaw.map((r) => r.method), [], 'no channels/register went out');
  assert.deepEqual(h.ungranted, [], 'and the host had nothing to refuse');

  // With the capability it registers once.
  await grant(h, ['channels.lifecycle', 'channels.register']);
  const opened = (await h.host.sendRequest(method.CHANNELS_OPEN, { type: 'github', address })) as {
    channel: { id: string };
  };
  assert.equal(opened.channel.id, channelId(ISSUE));
  assert.equal(h.hostSaw.filter((r) => r.method === method.CHANNELS_REGISTER).length, 1);

  // And once the descriptor exists, reading it back announces nothing — so a
  // grant narrowed back to lifecycle still answers the lookup.
  await grant(h, ['channels.lifecycle']);
  const again = (await h.host.sendRequest(method.CHANNELS_OPEN, { type: 'github', address })) as {
    channel: { id: string };
  };
  assert.equal(again.channel.id, channelId(ISSUE));
  assert.equal(h.hostSaw.filter((r) => r.method === method.CHANNELS_REGISTER).length, 1, 'no second registration');
  assert.deepEqual(h.ungranted, []);
});

test('finding 2: an event cannot register a channel without channels.register either', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);
  // Delivery granted, registration not: the delivery needs a descriptor and
  // may not announce one, so nothing is sent and nothing is claimed.
  await grant(h, ['pushEvents', 'channels.incoming']);

  await h.server.onEvent(commentEvent('no-register-1'));
  await until(() => pushes(h).length === 1, 'the push');
  assert.deepEqual(incoming(h), [], 'no channels/incoming without a registered channel');
  assert.deepEqual(h.ungranted, [], 'and no ungranted outbound call');
});

test('finding 3: a checkpoint is on disk before it is acknowledged, tool and explicit alike', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-wp9-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');

  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const state = GithubState.load(file, silentLogger());
  const h = rig(t, { api, state });
  await initialize(h, true);
  await grant(h);

  const tooled = await callTool(h, 'comment', { thread: '#41', body: 'one write' });
  assert.equal(tooled.isError, undefined, textOf(tooled));
  const afterTool = GithubState.load(file, silentLogger());
  assert.equal(
    afterTool.checkpointStatus(tooled.state?.checkpoint as string),
    'live',
    'the checkpoint the tool reported survives a reload',
  );
  // And so does the write it names, so the reloaded store can undo it.
  assert.equal(afterTool.rollback(tooled.state?.checkpoint as string)?.created.length, 0);

  const explicit = (await h.host.sendRequest('state/checkpoint', {})) as { checkpoint: string };
  assert.equal(GithubState.load(file, silentLogger()).checkpointStatus(explicit.checkpoint), 'live');
});

test('finding 3: a checkpoint that cannot be persisted is an error, not a durable success', async (t) => {
  const api = new FakeGitHubApi();
  // A path no directory can be made at: a real flush failure, not a fake one.
  const state = GithubState.empty('/dev/null/not-a-directory/state.json', silentLogger());
  const h = rig(t, { api, state });
  await initialize(h, true);
  await grant(h);

  const failed = await refusal(h.host.sendRequest('state/checkpoint', {}));
  assert.equal(failed.code, -32603);
  assert.match(failed.message, /checkpoint chk_[0-9a-f]+ could not be persisted/);
  assert.deepEqual(Object.keys(failed.data as object), ['checkpoint'], 'the id it could not persist');
});

test('finding 4: a push-only grant still wakes the host, and a channels-only grant still delivers', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);

  // The Contract's push-only host: no channel capability at all.
  const receipt = await grant(h, ['pushEvents']);
  assert.ok(
    !receipt.unavailableFeatures.some((f) => f.featureSet === EVENTS_FEATURE_SET),
    'github.events is not degraded by the absence of channels',
  );
  await h.server.onEvent(commentEvent('push-only-1'));
  await until(() => pushes(h).length === 1, 'the push');
  assert.deepEqual(incoming(h), [], 'and no delivery, which was not granted');
  assert.deepEqual(h.ungranted, []);

  // The mirror: channels and no push.
  await grant(h, ['channels.register', 'channels.incoming']);
  await h.server.onEvent(commentEvent('channels-only-1'));
  await until(() => incoming(h).length === 1, 'the delivery');
  assert.equal(pushes(h).length, 1, 'still just the first push');
  assert.deepEqual(h.ungranted, []);
});

test('finding 5: channels/publish as a Notification writes, and is booked for rollback', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);
  await h.host.sendRequest(method.CHANNELS_OPEN, {
    address: { owner: TEST_REPO.owner, name: TEST_REPO.name, number: 41, kind: 'issue' },
  });

  const mark = (await h.host.sendRequest('state/checkpoint', {})) as { checkpoint: string };
  h.host.sendNotification(method.CHANNELS_PUBLISH, {
    channelId: channelId(ISSUE),
    content: [{ type: 'text', text: 'answered without an id' }],
  });
  // A Request after the Notification is the barrier: the server takes the
  // host's messages in the order it sent them.
  await h.host.sendRequest(method.CHANNELS_LIST, {});
  assert.deepEqual(
    (await api.listComments(ISSUE)).map((c) => c.body),
    ['answered without an id'],
  );

  // The same bookkeeping as the Request form: the write is undoable.
  const rolled = (await h.host.sendRequest(method.STATE_ROLLBACK, {
    featureSet: COMMENTS_FEATURE_SET,
    checkpoint: mark.checkpoint,
  })) as { success: boolean; undone: { action: string }[] };
  assert.equal(rolled.success, true);
  assert.deepEqual(rolled.undone.map((u) => u.action), ['delete']);
});

test('finding 5: a publish Notification on an ungranted capability writes nothing', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);
  await h.host.sendRequest(method.CHANNELS_OPEN, {
    address: { owner: TEST_REPO.owner, name: TEST_REPO.name, number: 41, kind: 'issue' },
  });

  // The grant narrows; the channel stays registered, and the write does not.
  await grant(h, ['channels.lifecycle']);
  h.host.sendNotification(method.CHANNELS_PUBLISH, {
    channelId: channelId(ISSUE),
    content: [{ type: 'text', text: 'after the narrowing' }],
  });
  await h.host.sendRequest(method.MCPL_MANIFEST, {});
  assert.deepEqual(api.callsTo('createComment'), [], 'the refusal was logged, not written');
});

test('finding 7: a thread the bot opened is its own thread with no comment on it', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, author: { login: TEST_BOT.login, isBot: true } });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  await h.server.onEvent(commentEvent('bot-authored-1'));
  await until(() => pushes(h).length === 1, 'the event');
  const metadata = (pushes(h)[0].origin as { metadata: Record<string, unknown> }).metadata;
  assert.equal(metadata.isOwnThread, true, 'the bot opened this issue');
  assert.equal(metadata.isReplyToSelf, false, 'an issue comment names nothing it answers');
  assert.ok(api.callLog().includes('getIssue'), 'one bounded author lookup');
});

test('finding 7: a successful tool write updates the cached thread knowledge', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41 });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  // Cold: nobody has spoken on this thread, so the cache says not-own.
  await h.server.onEvent(commentEvent('before-write'));
  await until(() => pushes(h).length === 1, 'the first event');
  assert.equal((pushes(h)[0].origin as { metadata: { isOwnThread: boolean } }).metadata.isOwnThread, false);

  const tooled = await callTool(h, 'comment', { thread: '#41', body: 'on it' });
  assert.equal(tooled.isError, undefined, textOf(tooled));

  // The bot's own webhook has not come back, and the knowledge is current
  // anyway — from the write, not from a second lookup.
  const lookups = api.callsTo('listComments').length;
  await h.server.onEvent(commentEvent('after-write'));
  await until(() => pushes(h).length === 2, 'the second event');
  assert.equal((pushes(h)[1].origin as { metadata: { isOwnThread: boolean } }).metadata.isOwnThread, true);
  assert.ok(api.callsTo('listComments').length <= lookups, 'and it cost no new history lookup');
});

test('finding 7: a write recorded before a restart is still an own thread', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-wp9-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');

  const first = new FakeGitHubApi();
  first.seedIssue({ number: 41 });
  const h1 = rig(t, { api: first, state: GithubState.load(file, silentLogger()) });
  await initialize(h1, true);
  await grant(h1);
  assert.equal((await callTool(h1, 'comment', { thread: '#41', body: 'before the restart' })).isError, undefined);

  // A new process, a new connection, a fresh thread memory — and a GitHub
  // that has forgotten the comment (so only the state file can answer).
  const second = new FakeGitHubApi();
  second.seedIssue({ number: 41 });
  const h2 = rig(t, { api: second, state: GithubState.load(file, silentLogger()) });
  await initialize(h2, true);
  await grant(h2);
  await h2.server.onEvent(commentEvent('after-restart'));
  await until(() => pushes(h2).length === 1, 'the event');
  assert.equal((pushes(h2)[0].origin as { metadata: { isOwnThread: boolean } }).metadata.isOwnThread, true);
});

test('finding 8: a successful tool touch registers the thread’s channel, with its title', async (t) => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 41, title: 'the sticky one' });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  assert.equal((await callTool(h, 'comment', { thread: '#41', body: 'first touch' })).isError, undefined);
  const listed = (await h.host.sendRequest(method.CHANNELS_LIST, {})) as { channels: { id: string; label: string }[] };
  assert.deepEqual(listed.channels.map((c) => c.id), [channelId(ISSUE)]);

  // A publish on the touched channel now works, which is the point: before
  // this, a tool write left the channel unknown.
  const published = (await h.host.sendRequest(method.CHANNELS_PUBLISH, {
    channelId: channelId(ISSUE),
    content: [{ type: 'text', text: 'and an answer in the channel' }],
  })) as { delivered: boolean };
  assert.equal(published.delivered, true);

  // The title comes from the thread a read resolved, never from the rendered
  // result text: `get_issue` answers with the issue, and the label follows.
  await callTool(h, 'get_issue', { number: 41 });
  await until(
    () => (h.server as unknown as { channels: { get(id: string): { label: string } | undefined } }).channels
      ?.get(channelId(ISSUE))?.label === `${TEST_REPO.owner}/${TEST_REPO.name}#41: the sticky one`,
    'the label to carry the title',
  );
});

test('finding 8: a tool touch registers nothing without channels.register, and nothing in plain MCP', async (t) => {
  const granted = new FakeGitHubApi();
  granted.seedIssue({ number: 41 });
  const h = rig(t, { api: granted });
  await initialize(h, true);
  // `tools` and `channels.publish` make github.comments active; registration
  // is not granted, so the touch announces nothing.
  await grant(h, ['tools', 'channels.publish']);
  assert.equal((await callTool(h, 'comment', { thread: '#41', body: 'no registration' })).isError, undefined);
  assert.deepEqual(h.hostSaw.map((r) => r.method), [], 'no outbound registration');
  assert.deepEqual(h.ungranted, []);

  const plainApi = new FakeGitHubApi();
  plainApi.seedIssue({ number: 41 });
  const plain = rig(t, { api: plainApi });
  await initialize(plain, false);
  assert.equal((await callTool(plain, 'comment', { thread: '#41', body: 'plain mode' })).isError, undefined);
  assert.deepEqual(plain.hostSaw, [], 'a plain-MCP host has no channel surface at all');
});

// ─────────────────────────────────────────────────────────────────────────────
// WP9 review round 3: one thread record, one rule
//
// The three findings of round 3 were three writers of the per-thread knowledge
// disagreeing: a tool touch guessing the kind, a history read installing a
// snapshot over a write, and a partial record passing for a loaded one. The
// rules now live at the top of `ThreadKnowledge` in src/server.ts, and these
// are their cases.
// ─────────────────────────────────────────────────────────────────────────────

/** A human review-comment reply event, as the ingress would normalize one. */
function reviewReply(id: string, inReplyTo: number, commentId = 9000): NormalizedEvent {
  return {
    id,
    receivedAt: new Date().toISOString(),
    repo: TEST_REPO,
    kind: 'review_comment.created',
    thread: PULL,
    actor: { login: 'human-one', isBot: false },
    body: 'and what about this?',
    html_url: `https://github.com/${TEST_REPO.owner}/${TEST_REPO.name}/pull/58#discussion_r${commentId}`,
    reviewComment: {
      id: commentId,
      path: 'src/lib.rs',
      line: 42,
      side: 'RIGHT',
      diffHunk: '@@ -1 +1 @@',
      inReplyTo,
    },
  };
}

/** The review-comment fixture as a *human* answering `inReplyTo` on PR 58. */
function humanReplyPayload(inReplyTo: number, commentId: number): string {
  const payload = JSON.parse(fixture('pull_request_review_comment.created.json'));
  const human = { login: 'octocat', id: 583231, type: 'User' };
  payload.sender = human;
  payload.comment.user = human;
  payload.comment.id = commentId;
  payload.comment.in_reply_to_id = inReplyTo;
  // Not the bot's pull request: `isOwnThread` must come from the thread's
  // comments here, never from its author.
  payload.pull_request.user = { login: 'human-one', id: 7, type: 'User' };
  return JSON.stringify(payload);
}

/** The descriptors `channels/list` reports, with their addresses. */
async function listed(h: Harness): Promise<{ id: string; address: { kind: string } }[]> {
  const result = (await h.host.sendRequest(method.CHANNELS_LIST, {})) as {
    channels: { id: string; address: { kind: string } }[];
  };
  return result.channels;
}

test('round 3, finding 1: a shorthand tool touch on a pull request registers it as one, and a review reply publishes', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, head: { ref: 'fix-final-batch', sha: HEAD } });
  const root = api.seedReviewThread(PULL, {
    comments: [
      { id: 2500000077, author: { login: 'octocat', isBot: false }, body: 'why this bound?', createdAt: '2026-10-01T00:00:00.000Z' },
    ],
  }).comments[0].id;
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  // `#58` means `issue` to every thread parser in the package — it is the
  // default, and the shorthand carries nothing else. The channel must still
  // be announced as the pull request it is.
  const tooled = await callTool(h, 'comment', { thread: '#58', body: 'status' });
  assert.equal(tooled.isError, undefined, textOf(tooled));
  assert.deepEqual(
    (await listed(h)).map((c) => [c.id, c.address.kind]),
    [[channelId(PULL), 'pull']],
    'the kind was resolved before the channel was registered',
  );

  // A real delivery, which is authoritative about the kind, and the `rt:` id
  // the host is handed with it.
  const deliver = await webhook(t, h);
  await deliver('pull_request_review_comment', humanReplyPayload(root, 2500000079), 'short-tool-1');
  await until(() => incoming(h).length === 1, 'the review comment');
  assert.equal(incoming(h)[0].threadId, `rt:${root}`);

  // And the host answers in that review conversation — the path that was a
  // -32602 for the rest of the connection before this.
  const published = (await h.host.sendRequest(method.CHANNELS_PUBLISH, {
    channelId: channelId(PULL),
    threadId: incoming(h)[0].threadId,
    content: [{ type: 'text', text: 'answered in the review thread' }],
  })) as { delivered: boolean; route: string };
  assert.equal(published.delivered, true);
  assert.equal(published.route, 'review-reply');
  assert.equal(api.callsTo('replyToReviewComment').length, 1);
  assert.equal(api.callsTo('replyToReviewComment')[0].args[1], root);
  assert.deepEqual(h.ungranted, []);
});

test('round 3, finding 1: a kind the API could not resolve is reconciled by the first event, and the host is told', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, head: { ref: 'fix-final-batch', sha: HEAD } });
  const root = api.seedReviewThread(PULL, {
    comments: [
      { id: 2500000077, author: { login: 'octocat', isBot: false }, body: 'why this bound?', createdAt: '2026-10-01T00:00:00.000Z' },
    ],
  }).comments[0].id;

  // The one call the kind resolution makes fails with a status that says
  // nothing about the thread (not a 404), so the kind stays unresolved and
  // the registration falls back to the shorthand's guess.
  const real = api.getPullRequest.bind(api);
  let unavailable = 1;
  api.getPullRequest = async (ref) => {
    if (unavailable-- > 0) throw Object.assign(new Error('GitHub 503 on getPullRequest: unavailable'), { status: 503 });
    return real(ref);
  };

  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);
  assert.equal((await callTool(h, 'comment', { thread: '#58', body: 'status' })).isError, undefined);
  assert.deepEqual(
    (await listed(h)).map((c) => c.address.kind),
    ['issue'],
    'unresolved, so the channel carries the guess for now',
  );

  const deliver = await webhook(t, h);
  await deliver('pull_request_review_comment', humanReplyPayload(root, 2500000079), 'reconcile-1');
  await until(() => incoming(h).length === 1, 'the review comment');

  // The event was authoritative, so the channel is a pull request now — and
  // the host was told, because the descriptor's address moved.
  const changed = h.hostSaw.filter((r) => r.method === method.CHANNELS_CHANGED);
  assert.equal(changed.length, 1, h.hostSaw.map((r) => r.method).join(','));
  assert.equal(
    ((changed[0].params as { updated: { address: { kind: string } }[] }).updated[0].address.kind),
    'pull',
  );
  assert.deepEqual((await listed(h)).map((c) => c.address.kind), ['pull']);

  const published = (await h.host.sendRequest(method.CHANNELS_PUBLISH, {
    channelId: channelId(PULL),
    threadId: `rt:${root}`,
    content: [{ type: 'text', text: 'answered after the reconciliation' }],
  })) as { delivered: boolean; route: string };
  assert.equal(published.route, 'review-reply');
  assert.deepEqual(h.ungranted, []);
});

test('round 3, finding 2: a history read that completes after a tool write keeps what the write learned', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, head: { ref: 'fix-final-batch', sha: HEAD } });
  const root = api.seedReviewThread(PULL, {
    comments: [
      { id: 2500000077, author: { login: 'octocat', isBot: false }, body: 'why this bound?', createdAt: '2026-10-01T00:00:00.000Z' },
    ],
  }).comments[0].id;

  // Hold the history read open on its last bounded call, which is where the
  // snapshot used to be taken.
  const real = api.listReviewThreads.bind(api);
  let entered: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  api.listReviewThreads = async (pull) => {
    // Cloned, so the rows are the thread as it stood *before* the write: the
    // fake hands out its own objects, and a reader that keeps them would see
    // the tool's comment appear inside them and never reproduce the race.
    const rows = structuredClone(await real(pull));
    entered();
    await held;
    return rows;
  };

  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  const pending = h.server.onEvent(commentEvent('held-lookup', PULL));
  await reached;

  // The write happens inside the lookup's window, and learns two things the
  // lookup cannot know: the thread is the bot's, and the id of the review
  // comment it just created.
  const written = await callTool(h, 'reply_in_thread', { thread: PULL, threadId: `rt:${root}`, body: 'because it is bounded' });
  assert.equal(written.isError, undefined, textOf(written));
  const record = Object.values(h.server.state.snapshot().created).flat().at(-1) as { commentId: number } | undefined;
  assert.ok(record, 'the reply was recorded');

  release();
  await pending;

  // A human answers the comment the tool wrote, after the lookup has landed.
  await h.server.onEvent(reviewReply('after-the-lookup', record.commentId, 2500000079));
  await until(() => pushes(h).length === 2, 'the human answer');
  const metadata = metadataOf(pushes(h)[1]);
  assert.equal(metadata.isOwnThread, true, 'the write is still known');
  assert.equal(metadata.isReplyToSelf, true, 'and so is the id it created');
  assert.ok((pushes(h)[1].tags ?? []).includes('chat:reply'), (pushes(h)[1].tags ?? []).join(','));
  assert.ok(api.callsTo('listReviewThreads').length <= 1, 'at most one history read');
});

test('round 3, finding 3: a tool touch leaves the thread unloaded, so the first event still reads its history', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, head: { ref: 'fix-final-batch', sha: HEAD } });
  // The bot wrote a review comment here before this connection existed, so
  // only the history read can know its id.
  api.seedReviewThread(PULL, {
    comments: [{ id: 2500000123, author: TEST_BOT, body: 'this needs a bound', createdAt: '2026-10-01T00:00:00.000Z' }],
  });
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  // A tool write first: it knows `own`, and nothing about the history.
  assert.equal((await callTool(h, 'comment', { thread: PULL, body: 'status' })).isError, undefined);
  assert.equal(api.callsTo('listReviewThreads').length, 0, 'a tool write reads no history');

  await h.server.onEvent(reviewReply('answer-the-old-one', 2500000123, 2500000079));
  await until(() => pushes(h).length === 1, 'the human reply');
  const metadata = metadataOf(pushes(h)[0]);
  assert.equal(metadata.isOwnThread, true);
  assert.equal(metadata.isReplyToSelf, true, 'the bot wrote the comment this answers');
  assert.ok(api.callsTo('listReviewThreads').length <= 1, 'at most one history read');

  // And it is loaded now: a second event asks GitHub nothing.
  await h.server.onEvent(commentEvent('second', PULL));
  await until(() => pushes(h).length === 2, 'the second event');
  assert.ok(api.callsTo('listReviewThreads').length <= 1);
});

test('round 3, finding 3: create_review’s inline comments invalidate the history, and one reload finds them', async (t) => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 58, head: { ref: 'fix-final-batch', sha: HEAD } });
  api.seedFiles(PULL, [{ filename: 'src/lib.rs', status: 'modified', additions: 3, deletions: 1, changes: 4 }]);
  const h = rig(t, { api });
  await initialize(h, true);
  await grant(h);

  // Warm the thread first, so the record is loaded and would never be read
  // again on its own.
  await h.server.onEvent(commentEvent('warm', PULL));
  await until(() => pushes(h).length === 1, 'the warming event');
  assert.ok(api.callsTo('listReviewThreads').length >= 1, 'the warming event loaded the history');

  const review = await callTool(h, 'create_review', {
    number: 58,
    event: 'COMMENT',
    body: 'two notes',
    comments: [{ path: 'src/lib.rs', line: 42, side: 'RIGHT', body: 'off by one' }],
  });
  assert.equal(review.isError, undefined, textOf(review));

  // GitHub answered with the review's id and not the comment's, so the id a
  // human reply will name is only in GitHub's copy of the thread.
  const threads = await api.listReviewThreads(PULL);
  const inline = threads.flatMap((rt) => rt.comments).find((c) => c.author.login === TEST_BOT.login);
  assert.ok(inline, 'the review created an inline comment');
  const before = api.callsTo('listReviewThreads').length;

  await h.server.onEvent(reviewReply('answer-the-inline-one', inline.id, 2500000079));
  await until(() => pushes(h).length === 2, 'the human reply');
  assert.equal(metadataOf(pushes(h)[1]).isReplyToSelf, true, 'the reload found the inline comment');
  assert.ok(api.callsTo('listReviewThreads').length <= before + 1, 'at most one reload');

  // The submitted review's own id is not a comment id, and is never treated
  // as one: a reply naming it is not a reply to the bot.
  const [submitted] = api.submittedReviews();
  await h.server.onEvent(reviewReply('answer-the-review-id', submitted.id, 2500000080));
  await until(() => pushes(h).length === 3, 'the reply naming the review id');
  assert.equal(metadataOf(pushes(h)[2]).isReplyToSelf, false);
  assert.ok(api.callsTo('listReviewThreads').length <= before + 1, 'and naming the review id reads nothing more');
});
