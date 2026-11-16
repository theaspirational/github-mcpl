import {
  ERR_UNKNOWN_CHANNEL,
  method,
  type ChannelDescriptor,
  type ChannelsChangedResult,
  type ChannelsIncomingParams,
  type ChannelsIncomingResult,
  type ChannelsPublishParams,
  type ChannelsPublishResult,
  type ChannelsRegisterParams,
  type ChannelsRegisterResult,
  type ChannelsTypingParams,
  type ContentBlock,
  type IncomingChannelMessage,
} from '@animalabs/mcpl-core';
import { McplRpcError } from './errors.js';
import {
  CHANNEL_TYPE,
  channelAddress,
  channelId,
  channelLabel,
  parseThreadId,
  repoSlug,
  stderrLogger,
  type Comment,
  type EventMetadata,
  type GitHubApi,
  type Logger,
  type NormalizedEvent,
  type ThreadRef,
} from './types.js';

const ERR_INVALID_PARAMS = -32602;

export interface HostConnection {
  send(method: string, params: unknown): Promise<unknown>;
}

export interface ChannelRegistryOptions {
  host: HostConnection;
  logger?: Logger;
  /**
   * Asked before each announcement rather than once, since MCPL lets the host
   * narrow the grant at any time.
   */
  canRegister?: () => boolean;
  canDeliver?: () => boolean;
}

/**
 * mcpl-core's `ChannelsPublishParams` has no `threadId`, and a publish is
 * routed by it, so the field is added here as optional.
 */
export interface GitHubPublishParams extends ChannelsPublishParams {
  threadId?: string;
}

export type PublishRoute = 'comment' | 'review-reply' | 'none';

/**
 * MCPL wants a refusal as a JSON-RPC error object, not a result carrying a
 * failure flag, so a refused publish throws instead of returning one of these.
 */
export interface PublishOutcome extends ChannelsPublishResult {
  delivered: boolean;
  messageId?: string;
  commentId?: number;
  htmlUrl?: string;
  route: PublishRoute;
  isReviewComment?: boolean;
  thread?: ThreadRef;
  reason?: string;
}

export interface DeliveryOutcome {
  delivered: boolean;
  channelId?: string;
  messageId?: string;
  threadId?: string;
  reason?: string;
}

/**
 * mcpl-core's `IncomingChannelMessage.author` is `{ id, name }` and can't carry
 * `isBot`, so `sender` rides in the open `metadata`.
 */
export interface IncomingMetadata extends EventMetadata {
  sender: { login: string; isBot: boolean };
}

export function threadIdForEvent(event: NormalizedEvent): string | undefined {
  if (event.reviewComment) {
    const root = event.reviewComment.inReplyTo ?? event.reviewComment.id;
    return `rt:${root}`;
  }
  if (event.review) return `review:${event.review.id}`;
  return undefined;
}

export function toDescriptor(thread: ThreadRef, title?: string, state: ThreadState = 'open'): ChannelDescriptor {
  return {
    id: channelId(thread),
    type: CHANNEL_TYPE,
    label: title === undefined ? `${repoSlug(thread.repo)}#${thread.number}` : channelLabel(thread, title),
    direction: 'bidirectional',
    address: channelAddress(thread),
    metadata: { kind: thread.kind, state },
  };
}

export type ThreadState = 'open' | 'closed';

function stateAfter(event: NormalizedEvent, current: ThreadState): ThreadState {
  switch (event.kind) {
    case 'issue.closed':
    case 'pull.closed':
      return 'closed';
    case 'issue.reopened':
    case 'issue.opened':
    case 'pull.opened':
      return 'open';
    default:
      return current;
  }
}

interface ChannelRecord {
  thread: ThreadRef;
  acknowledged: ChannelDescriptor;
  title?: string;
  state: ThreadState;
}

function sameDescriptor(a: ChannelDescriptor, b: ChannelDescriptor): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    JSON.stringify(a.address) === JSON.stringify(b.address) &&
    JSON.stringify(a.metadata) === JSON.stringify(b.metadata)
  );
}

export class ChannelRegistry {
  private readonly host: HostConnection;
  private readonly logger: Logger;
  private readonly canRegister: () => boolean;
  private readonly canDeliver: () => boolean;
  private readonly records = new Map<string, ChannelRecord>();
  private readonly queue = new Map<string, Promise<void>>();

  constructor(opts: ChannelRegistryOptions) {
    this.host = opts.host;
    this.logger = opts.logger ?? stderrLogger('channels');
    this.canRegister = opts.canRegister ?? (() => true);
    this.canDeliver = opts.canDeliver ?? (() => true);
  }

  list(): ChannelDescriptor[] {
    return [...this.records.values()].map((r) => r.acknowledged);
  }

  get(id: string): ChannelDescriptor | undefined {
    return this.records.get(id)?.acknowledged;
  }

  threadFor(id: string): ThreadRef | undefined {
    return this.records.get(id)?.thread;
  }

  async ensureChannel(thread: ThreadRef, title?: string, state?: ThreadState): Promise<ChannelDescriptor | undefined> {
    return this.touch(thread, (current) => ({ title, state: state ?? current?.state ?? 'open' }));
  }

  private touch(
    thread: ThreadRef,
    fields: (current: ChannelRecord | undefined) => { title?: string; state: ThreadState },
  ): Promise<ChannelDescriptor | undefined> {
    const id = channelId(thread);
    return this.enqueue(id, async () => {
      const known = this.records.get(id);
      const { title, state } = fields(known);
      if (!known) return this.register(thread, title, state);
      if (known.thread.kind !== thread.kind) {
        this.logger.debug('channel kind reconciled', { channel: id, from: known.thread.kind, to: thread.kind });
        known.thread = thread;
      }
      await this.refresh(known, title, state);
      return known.acknowledged;
    });
  }

  private enqueue<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(id) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    const settled = tail.then(() => {
      if (this.queue.get(id) === settled) this.queue.delete(id);
    });
    this.queue.set(id, settled);
    return run;
  }

  private async register(
    thread: ThreadRef,
    title: string | undefined,
    state: ThreadState,
  ): Promise<ChannelDescriptor | undefined> {
    const descriptor = toDescriptor(thread, title, state);
    if (!this.canRegister()) {
      this.logger.info('channel not announced', { channel: descriptor.id, reason: 'registration is not granted' });
      return undefined;
    }
    const params: ChannelsRegisterParams = { channels: [descriptor] };
    let result: ChannelsRegisterResult | undefined;
    try {
      result = (await this.host.send(method.CHANNELS_REGISTER, params)) as ChannelsRegisterResult | undefined;
    } catch (err) {
      this.logger.warn('channels/register failed', { channel: descriptor.id, error: (err as Error).message });
      return undefined;
    }

    const entry = result?.results?.find((r) => r.id === descriptor.id);
    if (entry && entry.accepted === false) {
      this.logger.info('host refused channel', { channel: descriptor.id, reason: entry.reason });
      return undefined;
    }

    this.records.set(descriptor.id, { thread, acknowledged: descriptor, title, state });
    this.logger.debug('channel registered', { channel: descriptor.id, label: descriptor.label });
    return descriptor;
  }

  private async refresh(record: ChannelRecord, title?: string, state?: ThreadState): Promise<void> {
    if (title !== undefined) record.title = title;
    if (state !== undefined) record.state = state;

    const desired = toDescriptor(record.thread, record.title, record.state);
    if (sameDescriptor(desired, record.acknowledged)) return;

    if (!this.canRegister()) {
      this.logger.info('channel update not announced', { channel: desired.id, reason: 'registration is not granted' });
      return;
    }

    let result: ChannelsChangedResult | undefined;
    try {
      result = (await this.host.send(method.CHANNELS_CHANGED, { updated: [desired] })) as
        | ChannelsChangedResult
        | undefined;
    } catch (err) {
      this.logger.warn('channels/changed failed', { channel: desired.id, error: (err as Error).message });
      return;
    }

    const entry = result?.results?.find((r) => r.id === desired.id);
    if (entry && entry.accepted === false) {
      this.logger.info('host refused channel update', { channel: desired.id, reason: entry.reason });
      return;
    }

    record.acknowledged = desired;
    this.logger.debug('channel changed', { channel: desired.id, label: desired.label, state: record.state });
  }

  async deliver(
    event: NormalizedEvent,
    tags: string[],
    metadata: EventMetadata,
    content: ContentBlock[],
  ): Promise<DeliveryOutcome> {
    if (!event.thread) {
      return { delivered: false, reason: 'no-thread' };
    }

    const thread = event.thread;
    const id = channelId(thread);
    const descriptor = await this.touch(thread, (current) => ({
      title: event.title,
      state: stateAfter(event, current?.state ?? 'open'),
    }));
    if (!descriptor) return { delivered: false, channelId: id, reason: 'channel-not-registered' };

    if (!this.canDeliver()) {
      this.logger.info('channel delivery not sent', {
        channel: descriptor.id,
        event: event.id,
        reason: 'incoming is not granted',
      });
      return { delivered: false, channelId: descriptor.id, messageId: event.id, reason: 'incoming-not-granted' };
    }

    const threadId = threadIdForEvent(event);
    const incomingMetadata: IncomingMetadata = {
      ...metadata,
      sender: { login: event.actor.login, isBot: event.actor.isBot },
    };
    const message: IncomingChannelMessage = {
      channelId: descriptor.id,
      messageId: event.id,
      ...(threadId ? { threadId } : {}),
      author: { id: event.actor.login, name: event.actor.login },
      timestamp: event.receivedAt,
      content,
      metadata: incomingMetadata,
      tags,
    };

    const params: ChannelsIncomingParams = { messages: [message] };
    let result: ChannelsIncomingResult | undefined;
    try {
      result = (await this.host.send(method.CHANNELS_INCOMING, params)) as ChannelsIncomingResult | undefined;
    } catch (err) {
      this.logger.warn('channels/incoming failed', { channel: descriptor.id, error: (err as Error).message });
      return { delivered: false, channelId: descriptor.id, messageId: event.id, threadId, reason: 'host-error' };
    }

    const entry = result?.results?.find((r) => r.messageId === event.id);
    const delivered = entry?.accepted !== false;
    return {
      delivered,
      channelId: descriptor.id,
      messageId: event.id,
      threadId,
      ...(delivered ? {} : { reason: 'host-refused' }),
    };
  }

  /**
   * A publish with no `threadId`, or with `review:<id>`, becomes a comment on
   * the thread, since GitHub has no reply API for a review summary. A publish
   * whose text is empty once trimmed posts nothing, whatever its `threadId`,
   * and returns `delivered: false`, `route: 'none'` and
   * `reason: 'empty-content'`. Refused with -32023 for a channel that isn't
   * registered, and with -32602 for a non-text block, a `threadId` of another
   * form, or an `rt:` reply on an issue.
   */
  async handlePublish(params: GitHubPublishParams, api: GitHubApi): Promise<PublishOutcome> {
    const record = this.records.get(params.channelId);
    if (!record) {
      throw new McplRpcError(ERR_UNKNOWN_CHANNEL, `Unknown channel: ${params.channelId}`, {
        channelId: params.channelId,
      });
    }
    const thread = record.thread;

    const attachment = (params.content ?? []).find((block) => block.type !== 'text');
    if (attachment) {
      throw new McplRpcError(
        ERR_INVALID_PARAMS,
        `Attachments are not supported: github-mcpl publishes text only, got a '${attachment.type}' block`,
        { channelId: params.channelId, blockType: attachment.type },
      );
    }

    const text = (params.content ?? [])
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!text) {
      this.logger.debug('publish skipped', { channel: params.channelId, reason: 'empty-content' });
      return { delivered: false, route: 'none', thread, reason: 'empty-content' };
    }

    const parsed = parseThreadId(params.threadId);
    if (params.threadId !== undefined && parsed === null) {
      throw new McplRpcError(
        ERR_INVALID_PARAMS,
        `Unknown threadId '${params.threadId}': expected 'rt:<review comment id>' or 'review:<review id>'`,
        { channelId: params.channelId, threadId: params.threadId },
      );
    }

    if (parsed?.kind === 'review-thread') {
      if (thread.kind !== 'pull') {
        throw new McplRpcError(
          ERR_INVALID_PARAMS,
          `threadId '${params.threadId}' names a review conversation, and ${params.channelId} is an issue`,
          { channelId: params.channelId, threadId: params.threadId },
        );
      }
      const comment = await api.replyToReviewComment(thread, parsed.rootCommentId, text);
      return this.published(comment, 'review-reply', thread, true);
    }

    const comment = await api.createComment(thread, text);
    return this.published(comment, 'comment', thread, false);
  }

  private published(comment: Comment, route: PublishRoute, thread: ThreadRef, isReviewComment: boolean): PublishOutcome {
    this.logger.debug('published', { route, commentId: comment.id, thread: `${repoSlug(thread.repo)}#${thread.number}` });
    return {
      delivered: true,
      messageId: String(comment.id),
      commentId: comment.id,
      htmlUrl: comment.html_url,
      route,
      isReviewComment,
      thread,
    };
  }

  /**
   * GitHub has no typing indicator on an issue or pull request, so
   * `channels/typing` answers an empty success and does nothing.
   */
  handleTyping(params: ChannelsTypingParams): Record<string, never> {
    this.logger.debug('typing ignored', { channel: params.channelId });
    return {};
  }
}
