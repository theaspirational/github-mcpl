import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  McplConnection,
  method,
  type ChannelDescriptor,
  type ChannelsIncomingParams,
  type ChannelsRegisterParams,
  type ContentBlock,
  type IncomingChannelMessage,
  type JsonRpcRequest,
} from '@animalabs/mcpl-core';
import { ChannelRegistry, threadIdForEvent, type HostConnection } from '../src/channels.js';
import { McplRpcError } from '../src/errors.js';
import { LIMITS, channelId, type EventMetadata, type NormalizedEvent, type ThreadRef } from '../src/types.js';
import { FakeGitHubApi, TEST_BOT, TEST_REPO, until } from './harness.js';

interface FakeHost {
  conn: HostConnection;
  saw: JsonRpcRequest[];
  sent(m: string): JsonRpcRequest[];
  refuse: Set<string>;
  errorOn: Set<string>;
  acceptIncoming: boolean;
  hold(): () => void;
  close(): void;
}

function fakeHost(): FakeHost {
  const toServer = new PassThrough();
  const toHost = new PassThrough();
  const serverConn = McplConnection.fromStreams(toServer, toHost);
  const hostConn = McplConnection.fromStreams(toHost, toServer);

  let parked: (() => void)[] | null = null;

  const state: FakeHost = {
    conn: { send: (m, params) => serverConn.sendRequest(m, params) },
    saw: [],
    sent: (m) => state.saw.filter((r) => r.method === m),
    refuse: new Set<string>(),
    errorOn: new Set<string>(),
    acceptIncoming: true,
    hold: () => {
      parked = [];
      return () => {
        const answers = parked ?? [];
        parked = null;
        for (const answer of answers) answer();
      };
    },
    close: () => {
      serverConn.close();
      hostConn.close();
    },
  };

  hostConn.on('request', (req) => {
    state.saw.push(req);
    const answer = (): void => {
      if (state.errorOn.has(req.method)) {
        hostConn.sendError(req.id, -32000, `the host refuses to answer ${req.method}`);
        return;
      }
      switch (req.method) {
        case method.CHANNELS_REGISTER:
        case method.CHANNELS_CHANGED: {
          const p = req.params as { channels?: ChannelDescriptor[]; added?: ChannelDescriptor[]; updated?: ChannelDescriptor[] };
          const descriptors = [...(p.channels ?? []), ...(p.added ?? []), ...(p.updated ?? [])];
          hostConn.sendResponse(req.id, {
            results: descriptors.map((d) => ({ id: d.id, accepted: !state.refuse.has(d.id) })),
          });
          break;
        }
        case method.CHANNELS_INCOMING: {
          const p = req.params as ChannelsIncomingParams;
          hostConn.sendResponse(req.id, {
            results: p.messages.map((m) => ({ messageId: m.messageId, accepted: state.acceptIncoming })),
          });
          break;
        }
        default:
          hostConn.sendError(req.id, -32601, `unexpected ${req.method}`);
      }
    };

    if (parked) parked.push(answer);
    else answer();
  });

  return state;
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function registry(host: FakeHost): ChannelRegistry {
  return new ChannelRegistry({ host: host.conn, logger: quiet });
}

const DIRECTIONS = ['outbound', 'inbound', 'bidirectional'];

function assertValidDescriptor(value: unknown): ChannelDescriptor {
  assert.equal(typeof value, 'object');
  const d = value as Record<string, unknown>;
  assert.equal(typeof d.id, 'string', 'id is a string');
  assert.ok((d.id as string).length > 0, 'id is not empty');
  assert.equal(typeof d.type, 'string', 'type is a string');
  assert.equal(typeof d.label, 'string', 'label is a string');
  assert.ok(DIRECTIONS.includes(d.direction as string), `direction is one of ${DIRECTIONS.join('|')}`);
  for (const extra of Object.keys(d)) {
    assert.ok(
      ['id', 'type', 'label', 'direction', 'address', 'metadata', 'initiallyOpen', 'capabilities'].includes(extra),
      `no member outside ChannelDescriptor (${extra})`,
    );
  }
  return d as unknown as ChannelDescriptor;
}

function assertValidIncoming(value: unknown): IncomingChannelMessage {
  assert.equal(typeof value, 'object');
  const m = value as Record<string, unknown>;
  assert.equal(typeof m.channelId, 'string');
  assert.equal(typeof m.messageId, 'string');
  const author = m.author as Record<string, unknown>;
  assert.equal(typeof author?.id, 'string', 'author.id is a string');
  assert.equal(typeof author?.name, 'string', 'author.name is a string');
  assert.equal(typeof m.timestamp, 'string');
  assert.ok(!Number.isNaN(Date.parse(m.timestamp as string)), 'timestamp parses');
  assert.ok(Array.isArray(m.content), 'content is an array');
  for (const block of m.content as ContentBlock[]) {
    assert.ok(['text', 'image', 'audio', 'resource'].includes(block.type), 'content block type');
  }
  if (m.threadId !== undefined) assert.equal(typeof m.threadId, 'string');
  if (m.tags !== undefined) {
    assert.ok(Array.isArray(m.tags));
    for (const t of m.tags as unknown[]) assert.equal(typeof t, 'string');
  }
  for (const extra of Object.keys(m)) {
    assert.ok(
      ['channelId', 'messageId', 'threadId', 'author', 'timestamp', 'content', 'metadata', 'tags'].includes(extra),
      `no member outside IncomingChannelMessage (${extra})`,
    );
  }
  return m as unknown as IncomingChannelMessage;
}

const ISSUE: ThreadRef = { repo: TEST_REPO, number: 7, kind: 'issue' };
const PULL: ThreadRef = { repo: TEST_REPO, number: 12, kind: 'pull' };

function metadata(partial: Partial<EventMetadata> = {}): EventMetadata {
  return {
    mentioned: false,
    isOwnThread: false,
    isReplyToSelf: false,
    isReviewRequested: false,
    isCiFailure: false,
    fromSelf: false,
    isMaintainer: false,
    repo: `${TEST_REPO.owner}/${TEST_REPO.name}`,
    number: 7,
    kind: 'issue',
    actor: 'human-one',
    sha: null,
    htmlUrl: 'https://github.com/anima-research/rayforce/issues/7',
    ...partial,
  };
}

function event(partial: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: 'delivery-1',
    receivedAt: '2026-10-14T09:00:00.000Z',
    repo: TEST_REPO,
    kind: 'comment.created',
    thread: ISSUE,
    actor: { login: 'human-one', isBot: false },
    body: 'ping',
    html_url: 'https://github.com/anima-research/rayforce/issues/7#issuecomment-1',
    ...partial,
  };
}

const TEXT: ContentBlock[] = [{ type: 'text', text: 'rendered body' }];

test('registration is lazy: nothing is announced until a thread is touched', async () => {
  const host = fakeHost();
  const reg = registry(host);
  assert.deepEqual(reg.list(), []);
  assert.equal(host.saw.length, 0);

  const descriptor = await reg.ensureChannel(ISSUE, 'Thread safety of the scheduler');
  assert.ok(descriptor);

  const registers = host.sent(method.CHANNELS_REGISTER);
  assert.equal(registers.length, 1, 'one channels/register');
  const params = registers[0].params as ChannelsRegisterParams;
  assert.equal(params.channels.length, 1, 'only the touched thread');
  const sent = assertValidDescriptor(params.channels[0]);

  assert.equal(sent.id, 'github:anima-research/rayforce#7');
  assert.equal(sent.type, 'github');
  assert.equal(sent.direction, 'bidirectional');
  assert.equal(sent.label, 'anima-research/rayforce#7: Thread safety of the scheduler');
  assert.deepEqual(sent.address, { owner: 'anima-research', name: 'rayforce', number: 7, kind: 'issue' });
  assert.deepEqual(sent.metadata, { kind: 'issue', state: 'open' });

  assert.deepEqual(reg.list().map((d) => d.id), [sent.id]);
  assert.deepEqual(reg.threadFor(sent.id), ISSUE);
  host.close();
});

test('a second touch of the same thread does not re-announce it', async () => {
  const host = fakeHost();
  const reg = registry(host);
  await reg.ensureChannel(ISSUE, 'Same title');
  await reg.ensureChannel(ISSUE, 'Same title');
  await reg.deliver(event(), ['chat:ambient'], metadata(), TEXT);

  assert.equal(host.sent(method.CHANNELS_REGISTER).length, 1, 'registered once');
  assert.equal(host.sent(method.CHANNELS_CHANGED).length, 0, 'nothing changed');
  assert.equal(reg.list().length, 1);
  host.close();
});

test('two events racing on one thread register it once', async () => {
  const host = fakeHost();
  const reg = registry(host);
  await Promise.all([
    reg.deliver(event({ id: 'a' }), [], metadata(), TEXT),
    reg.deliver(event({ id: 'b' }), [], metadata(), TEXT),
  ]);
  assert.equal(host.sent(method.CHANNELS_REGISTER).length, 1);
  assert.equal(host.sent(method.CHANNELS_INCOMING).length, 2, 'both messages still delivered');
  host.close();
});

test("a registration still in flight does not swallow the next touch's title and state", async () => {
  const host = fakeHost();
  const reg = registry(host);
  const id = channelId(ISSUE);

  const release = host.hold();
  const first = reg.ensureChannel(ISSUE);
  await until(() => host.sent(method.CHANNELS_REGISTER).length === 1, 'the registration to reach the host');

  const second = reg.deliver(
    event({ id: 'd2', kind: 'issue.closed', title: 'Closed with a title' }),
    ['github:issue=closed'],
    metadata(),
    TEXT,
  );
  release();

  const [registered, delivered] = await Promise.all([first, second]);
  assert.equal(registered?.label, 'anima-research/rayforce#7', 'registered before any title was known');
  assert.equal(delivered.delivered, true);
  assert.equal(host.sent(method.CHANNELS_REGISTER).length, 1, 'still announced once');

  const changed = host.sent(method.CHANNELS_CHANGED);
  assert.equal(changed.length, 1, "the racing event's title and state reach the host");
  const updated = assertValidDescriptor((changed[0].params as { updated: unknown[] }).updated[0]);
  assert.equal(updated.id, id);
  assert.equal(updated.label, 'anima-research/rayforce#7: Closed with a title');
  assert.deepEqual(updated.metadata, { kind: 'issue', state: 'closed' });

  assert.equal(reg.get(id)?.label, updated.label, 'and the registry holds them too');
  assert.deepEqual(reg.get(id)?.metadata, { kind: 'issue', state: 'closed' });
  host.close();
});

test('the first event registers the channel, with the event title', async () => {
  const host = fakeHost();
  const reg = registry(host);
  const outcome = await reg.deliver(
    event({ kind: 'issue.opened', title: 'Scheduler deadlock' }),
    ['github:issue=opened'],
    metadata(),
    TEXT,
  );
  assert.equal(outcome.delivered, true);
  const params = host.sent(method.CHANNELS_REGISTER)[0].params as ChannelsRegisterParams;
  assert.equal(params.channels[0].label, 'anima-research/rayforce#7: Scheduler deadlock');
  host.close();
});

test('a tool touch with no title yet labels the channel without one, and the first title updates it', async () => {
  const host = fakeHost();
  const reg = registry(host);
  await reg.ensureChannel(ISSUE);
  const registered = (host.sent(method.CHANNELS_REGISTER)[0].params as ChannelsRegisterParams).channels[0];
  assert.equal(registered.label, 'anima-research/rayforce#7', 'no trailing colon for an unknown title');

  await reg.deliver(event({ kind: 'issue.edited', title: 'Now it has a title' }), [], metadata(), TEXT);
  const changed = host.sent(method.CHANNELS_CHANGED);
  assert.equal(changed.length, 1);
  const updated = (changed[0].params as { updated: ChannelDescriptor[] }).updated[0];
  assert.equal(updated.label, 'anima-research/rayforce#7: Now it has a title');
  host.close();
});

test('a refused descriptor is not recorded, so a later touch tries again', async () => {
  const host = fakeHost();
  const reg = registry(host);
  host.refuse.add(channelId(ISSUE));

  assert.equal(await reg.ensureChannel(ISSUE, 'Refused'), undefined);
  assert.deepEqual(reg.list(), [], 'not registered');

  const outcome = await reg.deliver(event(), [], metadata(), TEXT);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.reason, 'channel-not-registered');
  assert.equal(host.sent(method.CHANNELS_INCOMING).length, 0, 'no delivery to an unregistered channel');

  host.refuse.clear();
  assert.ok(await reg.ensureChannel(ISSUE, 'Allowed now'));
  assert.equal(host.sent(method.CHANNELS_REGISTER).length, 3, 'each attempt announced');
  host.close();
});

test('the label title is bounded to 80 chars, notice included', async () => {
  const host = fakeHost();
  const reg = registry(host);
  const title = 'x'.repeat(300);
  await reg.ensureChannel(ISSUE, title);

  const sent = (host.sent(method.CHANNELS_REGISTER)[0].params as ChannelsRegisterParams).channels[0];
  const prefix = 'anima-research/rayforce#7: ';
  assert.ok(sent.label.startsWith(prefix));
  const titlePart = sent.label.slice(prefix.length);
  assert.equal(titlePart.length, LIMITS.titleChars, 'exactly 80 chars of title');
  assert.ok(titlePart.includes('truncated'), 'the drop is named, not silent');
  host.close();
});

test('a title change sends channels/changed with the new label', async () => {
  const host = fakeHost();
  const reg = registry(host);
  await reg.deliver(event({ kind: 'issue.opened', title: 'First title' }), [], metadata(), TEXT);
  await reg.deliver(event({ id: 'd2', kind: 'issue.edited', title: 'Second title' }), [], metadata(), TEXT);

  const changed = host.sent(method.CHANNELS_CHANGED);
  assert.equal(changed.length, 1);
  const updated = assertValidDescriptor((changed[0].params as { updated: unknown[] }).updated[0]);
  assert.equal(updated.id, 'github:anima-research/rayforce#7');
  assert.equal(updated.label, 'anima-research/rayforce#7: Second title');
  assert.deepEqual(updated.metadata, { kind: 'issue', state: 'open' });
  assert.equal(reg.get(updated.id)?.label, updated.label, 'the registry holds the new descriptor');
  host.close();
});

test('closing and reopening a thread sends channels/changed with the new state', async () => {
  const host = fakeHost();
  const reg = registry(host);
  await reg.deliver(event({ kind: 'issue.opened', title: 'T' }), [], metadata(), TEXT);

  await reg.deliver(event({ id: 'd2', kind: 'issue.closed', title: 'T' }), [], metadata(), TEXT);
  let changed = host.sent(method.CHANNELS_CHANGED);
  assert.equal(changed.length, 1);
  assert.deepEqual((changed[0].params as { updated: ChannelDescriptor[] }).updated[0].metadata, {
    kind: 'issue',
    state: 'closed',
  });

  await reg.deliver(event({ id: 'd3', kind: 'issue.reopened', title: 'T' }), [], metadata(), TEXT);
  changed = host.sent(method.CHANNELS_CHANGED);
  assert.equal(changed.length, 2);
  assert.deepEqual((changed[1].params as { updated: ChannelDescriptor[] }).updated[0].metadata, {
    kind: 'issue',
    state: 'open',
  });
  host.close();
});

test('a channels/changed the host refuses leaves the acknowledged descriptor in place, and retries', async () => {
  const host = fakeHost();
  const reg = registry(host);
  const id = channelId(ISSUE);
  await reg.ensureChannel(ISSUE, 'First title');
  assert.equal(reg.get(id)?.label, 'anima-research/rayforce#7: First title');

  host.refuse.add(id);
  await reg.ensureChannel(ISSUE, 'Second title');
  assert.equal(host.sent(method.CHANNELS_CHANGED).length, 1, 'the update was sent');
  assert.equal(
    reg.get(id)?.label,
    'anima-research/rayforce#7: First title',
    'the registry reports what the host acknowledged, not what it was told',
  );

  host.refuse.clear();
  await reg.ensureChannel(ISSUE);
  const changed = host.sent(method.CHANNELS_CHANGED);
  assert.equal(changed.length, 2, 'a refused update stays retryable');
  assert.equal(
    (changed[1].params as { updated: ChannelDescriptor[] }).updated[0].label,
    'anima-research/rayforce#7: Second title',
  );
  assert.equal(reg.get(id)?.label, 'anima-research/rayforce#7: Second title');

  await reg.ensureChannel(ISSUE);
  assert.equal(host.sent(method.CHANNELS_CHANGED).length, 2);
  host.close();
});

test('a channels/changed that errors in transport stays retryable', async () => {
  const host = fakeHost();
  const reg = registry(host);
  const id = channelId(ISSUE);
  await reg.ensureChannel(ISSUE, 'First title');

  host.errorOn.add(method.CHANNELS_CHANGED);
  await reg.ensureChannel(ISSUE, 'Second title');
  assert.equal(host.sent(method.CHANNELS_CHANGED).length, 1);
  assert.equal(reg.get(id)?.label, 'anima-research/rayforce#7: First title', 'the cache did not advance');

  host.errorOn.clear();
  await reg.ensureChannel(ISSUE);
  const changed = host.sent(method.CHANNELS_CHANGED);
  assert.equal(changed.length, 2, 'the update is sent again');
  assert.equal(
    (changed[1].params as { updated: ChannelDescriptor[] }).updated[0].label,
    'anima-research/rayforce#7: Second title',
  );
  assert.equal(reg.get(id)?.label, 'anima-research/rayforce#7: Second title');
  host.close();
});

test('an event that moves neither title nor state sends no channels/changed', async () => {
  const host = fakeHost();
  const reg = registry(host);
  await reg.deliver(event({ kind: 'issue.opened', title: 'T' }), [], metadata(), TEXT);
  await reg.deliver(event({ id: 'd2', kind: 'comment.created' }), [], metadata(), TEXT);
  assert.equal(host.sent(method.CHANNELS_CHANGED).length, 0);
  host.close();
});

test('incoming carries the contract shape: sender, timestamp, tags, metadata', async () => {
  const host = fakeHost();
  const reg = registry(host);
  const tags = ['chat:mention', 'chat:from-human', 'github:review-comment'];
  const meta = metadata({ mentioned: true, actor: 'human-one' });

  const outcome = await reg.deliver(event({ id: 'delivery-42' }), tags, meta, TEXT);
  assert.deepEqual(outcome, {
    delivered: true,
    channelId: 'github:anima-research/rayforce#7',
    messageId: 'delivery-42',
    threadId: undefined,
  });

  const incoming = host.sent(method.CHANNELS_INCOMING);
  assert.equal(incoming.length, 1);
  const params = incoming[0].params as ChannelsIncomingParams;
  assert.equal(params.messages.length, 1);
  const message = assertValidIncoming(params.messages[0]);

  assert.equal(message.channelId, 'github:anima-research/rayforce#7');
  assert.equal(message.messageId, 'delivery-42', 'the event id is the message id');
  assert.equal(message.timestamp, '2026-10-14T09:00:00.000Z', 'receivedAt is the timestamp');
  assert.deepEqual(message.author, { id: 'human-one', name: 'human-one' });
  assert.deepEqual(message.content, TEXT);
  assert.deepEqual(message.tags, tags);
  assert.deepEqual(message.metadata, { ...meta, sender: { login: 'human-one', isBot: false } });
  host.close();
});

test('a bot sender is marked isBot in the metadata sender', async () => {
  const host = fakeHost();
  const reg = registry(host);
  await reg.deliver(event({ actor: { login: TEST_BOT.login, isBot: true } }), [], metadata(), TEXT);
  const params = host.sent(method.CHANNELS_INCOMING)[0].params as ChannelsIncomingParams;
  assert.deepEqual((params.messages[0].metadata as { sender: unknown }).sender, {
    login: TEST_BOT.login,
    isBot: true,
  });
  host.close();
});

test('raw is never forwarded', async () => {
  const host = fakeHost();
  const reg = registry(host);
  await reg.deliver(event({ raw: { secret: 'do-not-forward' } }), [], metadata(), TEXT);
  const wire = JSON.stringify(host.sent(method.CHANNELS_INCOMING)[0].params);
  assert.ok(!wire.includes('do-not-forward'), 'the raw payload stays in the pipeline');
  host.close();
});

test('an event with no thread belongs to no channel', async () => {
  const host = fakeHost();
  const reg = registry(host);
  const outcome = await reg.deliver(event({ kind: 'push', thread: undefined }), [], metadata(), TEXT);
  assert.deepEqual(outcome, { delivered: false, reason: 'no-thread' });
  assert.equal(host.saw.length, 0, 'nothing registered, nothing delivered');
  host.close();
});

test('a host that refuses the message reports it undelivered', async () => {
  const host = fakeHost();
  const reg = registry(host);
  host.acceptIncoming = false;
  const outcome = await reg.deliver(event(), [], metadata(), TEXT);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.reason, 'host-refused');
  assert.equal(outcome.messageId, 'delivery-1');
  host.close();
});

test('threadId rules: top-level comments carry none, review comments rt:, review summaries review:', () => {
  assert.equal(threadIdForEvent(event({ kind: 'comment.created' })), undefined);
  assert.equal(threadIdForEvent(event({ kind: 'issue.opened' })), undefined);
  assert.equal(
    threadIdForEvent(
      event({
        kind: 'review_comment.created',
        thread: PULL,
        reviewComment: { id: 555, path: 'src/lib.rs', line: 42, side: 'RIGHT', diffHunk: '@@' },
      }),
    ),
    'rt:555',
    'a root review comment names itself',
  );
  assert.equal(
    threadIdForEvent(
      event({
        kind: 'review_comment.created',
        thread: PULL,
        reviewComment: { id: 556, path: 'src/lib.rs', line: 42, side: 'RIGHT', diffHunk: '@@', inReplyTo: 555 },
      }),
    ),
    'rt:555',
    'a reply names the root',
  );
  assert.equal(
    threadIdForEvent(
      event({ kind: 'review.submitted', thread: PULL, review: { id: 900, state: 'changes_requested' } }),
    ),
    'review:900',
  );
});

test('deliver puts the thread id on the incoming message', async () => {
  const host = fakeHost();
  const reg = registry(host);
  const outcome = await reg.deliver(
    event({
      id: 'rc-1',
      kind: 'review_comment.created',
      thread: PULL,
      reviewComment: { id: 556, path: 'src/lib.rs', line: 42, side: 'RIGHT', diffHunk: '@@', inReplyTo: 555 },
    }),
    ['chat:thread', 'github:review-comment'],
    metadata({ number: 12, kind: 'pull' }),
    TEXT,
  );
  assert.equal(outcome.threadId, 'rt:555');
  const params = host.sent(method.CHANNELS_INCOMING)[0].params as ChannelsIncomingParams;
  assert.equal(params.messages[0].threadId, 'rt:555');
  assert.equal(params.messages[0].channelId, 'github:anima-research/rayforce#12');
  host.close();
});

test('a top-level comment sends no threadId member at all', async () => {
  const host = fakeHost();
  const reg = registry(host);
  await reg.deliver(event(), [], metadata(), TEXT);
  const params = host.sent(method.CHANNELS_INCOMING)[0].params as ChannelsIncomingParams;
  assert.ok(!('threadId' in params.messages[0]), 'absent, not null and not empty');
  host.close();
});

async function publishFixture(): Promise<{ host: FakeHost; reg: ChannelRegistry; api: FakeGitHubApi }> {
  const host = fakeHost();
  const reg = registry(host);
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7, title: 'An issue' });
  api.seedPullRequest({ number: 12, title: 'A pull request' });
  api.seedReviewThread(PULL, { comments: [{ id: 555, author: { login: 'human-one', isBot: false }, body: 'this line', createdAt: '2026-10-01T00:00:00.000Z' }] });
  await reg.ensureChannel(ISSUE, 'An issue');
  await reg.ensureChannel(PULL, 'A pull request');
  api.clearCalls();
  return { host, reg, api };
}

test('publish without a threadId creates a comment and reports the created id', async () => {
  const { host, reg, api } = await publishFixture();
  const outcome = await reg.handlePublish(
    { conversationId: 'conv-1', channelId: channelId(ISSUE), content: [{ type: 'text', text: 'hello' }] },
    api,
  );

  assert.deepEqual(api.callLog(), ['createComment']);
  const call = api.callsTo('createComment')[0];
  assert.deepEqual(call.args[0], ISSUE);
  assert.equal(call.args[1], 'hello');

  assert.equal(outcome.delivered, true);
  assert.equal(outcome.route, 'comment');
  assert.equal(outcome.isReviewComment, false);
  assert.equal(typeof outcome.commentId, 'number');
  assert.equal(outcome.messageId, String(outcome.commentId));
  assert.ok(outcome.htmlUrl?.startsWith('https://github.com/anima-research/rayforce/'));
  assert.deepEqual(outcome.thread, ISSUE);
  host.close();
});

test("publish with 'rt:<id>' replies to the review comment", async () => {
  const { host, reg, api } = await publishFixture();
  const outcome = await reg.handlePublish(
    {
      conversationId: 'conv-1',
      channelId: channelId(PULL),
      threadId: 'rt:555',
      content: [{ type: 'text', text: 'good catch' }],
    },
    api,
  );

  assert.deepEqual(api.callLog(), ['replyToReviewComment']);
  const call = api.callsTo('replyToReviewComment')[0];
  assert.deepEqual(call.args[0], PULL);
  assert.equal(call.args[1], 555, 'the root review comment id');
  assert.equal(call.args[2], 'good catch');

  assert.equal(outcome.delivered, true);
  assert.equal(outcome.route, 'review-reply');
  assert.equal(outcome.isReviewComment, true, 'rollback edits it through pulls/comments');
  assert.equal(typeof outcome.commentId, 'number');
  assert.ok(outcome.htmlUrl?.includes('#discussion_r'));
  host.close();
});

test("publish with 'review:<id>' creates a comment (a review summary has no reply API)", async () => {
  const { host, reg, api } = await publishFixture();
  const outcome = await reg.handlePublish(
    {
      conversationId: 'conv-1',
      channelId: channelId(PULL),
      threadId: 'review:900',
      content: [{ type: 'text', text: 'addressed' }],
    },
    api,
  );

  assert.deepEqual(api.callLog(), ['createComment']);
  assert.deepEqual(api.callsTo('createComment')[0].args[0], PULL);
  assert.equal(outcome.route, 'comment');
  assert.equal(outcome.isReviewComment, false);
  assert.equal(outcome.messageId, String(outcome.commentId));
  host.close();
});

test('publish joins the text blocks and skips an empty turn without an error', async () => {
  const { host, reg, api } = await publishFixture();
  const joined = await reg.handlePublish(
    {
      conversationId: 'conv-1',
      channelId: channelId(ISSUE),
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    },
    api,
  );
  assert.equal(api.callsTo('createComment')[0].args[1], 'first\nsecond');
  assert.equal(joined.delivered, true);

  api.clearCalls();
  const empty = await reg.handlePublish(
    { conversationId: 'conv-1', channelId: channelId(ISSUE), content: [{ type: 'text', text: '   ' }] },
    api,
  );
  assert.equal(empty.delivered, false);
  assert.equal(empty.route, 'none');
  assert.equal(empty.reason, 'empty-content');
  assert.deepEqual(api.callLog(), [], 'no empty comment is posted');
  host.close();
});

async function refusal(fn: () => Promise<unknown>): Promise<McplRpcError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof McplRpcError, `a typed JSON-RPC error, got ${String(err)}`);
    return err;
  }
  throw new assert.AssertionError({ message: 'expected a refusal' });
}

test('publishing to an unknown channel is refused with -32023', async () => {
  const { host, reg, api } = await publishFixture();

  const foreign = await refusal(() =>
    reg.handlePublish(
      { conversationId: 'c', channelId: 'slack:C123', content: [{ type: 'text', text: 'hi' }] },
      api,
    ),
  );
  assert.equal(foreign.code, -32023);
  assert.match(foreign.message, /Unknown channel/);

  const unregistered = await refusal(() =>
    reg.handlePublish(
      {
        conversationId: 'c',
        channelId: 'github:anima-research/rayforce#999',
        content: [{ type: 'text', text: 'hi' }],
      },
      api,
    ),
  );
  assert.equal(unregistered.code, -32023, 'a well-formed id that was never registered');
  assert.deepEqual(api.callLog(), [], 'nothing reached GitHub');
  host.close();
});

test('publishing an attachment is refused with -32602, naming the block', async () => {
  const { host, reg, api } = await publishFixture();
  for (const block of [
    { type: 'image', data: 'AAA', mimeType: 'image/png' },
    { type: 'resource', uri: 'file:///tmp/x' },
    { type: 'audio', uri: 'https://example.invalid/a.wav' },
  ] as ContentBlock[]) {
    const err = await refusal(() =>
      reg.handlePublish(
        {
          conversationId: 'c',
          channelId: channelId(ISSUE),
          content: [{ type: 'text', text: 'see this' }, block],
        },
        api,
      ),
    );
    assert.equal(err.code, -32602);
    assert.match(err.message, /Attachments are not supported/);
    assert.match(err.message, new RegExp(`'${block.type}'`), 'the refusal names the block type');
  }
  assert.deepEqual(api.callLog(), [], 'no partial post of the text part');
  host.close();
});

test('an unparseable threadId is refused with -32602', async () => {
  const { host, reg, api } = await publishFixture();
  const err = await refusal(() =>
    reg.handlePublish(
      {
        conversationId: 'c',
        channelId: channelId(PULL),
        threadId: 'ts:1699999999.000100',
        content: [{ type: 'text', text: 'hi' }],
      },
      api,
    ),
  );
  assert.equal(err.code, -32602);
  assert.match(err.message, /expected 'rt:<review comment id>' or 'review:<review id>'/);
  assert.deepEqual(api.callLog(), []);
  host.close();
});

test('a review-thread reply on an issue channel is refused with -32602', async () => {
  const { host, reg, api } = await publishFixture();
  const err = await refusal(() =>
    reg.handlePublish(
      {
        conversationId: 'c',
        channelId: channelId(ISSUE),
        threadId: 'rt:555',
        content: [{ type: 'text', text: 'hi' }],
      },
      api,
    ),
  );
  assert.equal(err.code, -32602);
  assert.match(err.message, /is an issue/);
  assert.deepEqual(api.callLog(), [], 'review comments live on pull requests only');
  host.close();
});

test('typing is a no-op that answers success', async () => {
  const host = fakeHost();
  const reg = registry(host);
  await reg.ensureChannel(ISSUE, 'An issue');
  const before = host.saw.length;

  assert.deepEqual(reg.handleTyping({ channelId: channelId(ISSUE) }), {});
  assert.deepEqual(reg.handleTyping({ channelId: 'github:anima-research/rayforce#999' }), {}, 'no refusal either');
  assert.equal(host.saw.length, before, 'nothing is written anywhere');
  host.close();
});
