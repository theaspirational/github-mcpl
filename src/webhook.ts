/**
 * Webhook ingress (TASK-SRHKG.1.3, §Ingress).
 *
 * A plain `node:http` server on GITHUB_WEBHOOK_PORT and GITHUB_WEBHOOK_PATH.
 * The order of the checks is the security property, so it is spelled out
 * once here and followed exactly in {@link WebhookListener.handle}:
 *
 *   1. method and path                → 405 / 404
 *   2. body read with a 1 MiB cap     → 413, socket destroyed
 *   3. `X-Hub-Signature-256` over the *raw bytes*, constant-time → 401
 *   4. `X-GitHub-Delivery` dedup against a ring of the last 2000 ids → 200
 *   5. `ping`                         → 200, nothing emitted
 *   6. 2xx **sent**, then: parse, repo allow-list, normalize, listener
 *
 * Nothing before step 3 parses the body, and nothing before step 3 touches
 * the dedup ring — an unsigned request can neither be interpreted nor evict
 * a real delivery id. The webhook secret is held in a closure, never logged,
 * and never put in a response body.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  CheckGate,
  checkMarkOf,
  normalizeWebhook,
  resolveCheckEvents,
  type WebhookDelivery,
} from './normalize.js';
import {
  DEFAULT_WEBHOOK_PATH,
  repoAllowed,
  repoSlug,
  silentLogger,
  type Config,
  type GitHubApi,
  type Logger,
  type NormalizedEvent,
  type RepoRef,
} from './types.js';

/** §Ingress body cap: 1 MiB of raw delivery. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** §Ingress: "a ring of the last 2000 ids dedups replays". */
export const DELIVERY_DEDUP_RING = 2000;

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';
const DELIVERY_HEADER = 'x-github-delivery';
const EVENT_HEADER = 'x-github-event';

/** What the ingress hands a normalized event to (.9 wires the pipeline). */
/** False explicitly reports non-delivery. Legacy App ingress ignores the receipt;
 * the notifications poller uses it to retain its cursor and retry. Void remains
 * an accepted handoff for existing listeners. */
export type EventListener = (event: NormalizedEvent) => void | boolean | Promise<void | boolean>;

export interface WebhookListenerOptions {
  /** GITHUB_WEBHOOK_SECRET_FILE's contents. Secret: never logged. */
  secret: string;
  /** GITHUB_WEBHOOK_PATH; defaults to {@link DEFAULT_WEBHOOK_PATH}. */
  path?: string;
  /** GITHUB_REPOS. A delivery for anything else is dropped with one line. */
  repos: readonly RepoRef[];
  /** Where a verified, allowed, fresh event goes. */
  onEvent: EventListener;
  /** Used to fill `checks.failed` on a `checks.completed` event. */
  api?: Pick<GitHubApi, 'getCheckRuns'>;
  /**
   * The "one `checks.completed` per head sha" gate. Pass the poller's own gate
   * to serialize the two ingress paths against each other; left out, the
   * listener keeps a private one.
   */
  checkGate?: CheckGate;
  logger?: Logger;
  /** Overridable in tests; the stamp on `NormalizedEvent.receivedAt`. */
  now?: () => Date;
  /** Overridable in tests. Defaults to {@link MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
}

/** A bounded FIFO set: `add` returns true when the id was already present. */
export class DeliveryRing {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(readonly capacity: number) {}

  add(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return false;
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * The listener. `listen()` binds, `close()` unbinds, and `whenIdle()` waits
 * for the post-response processing of every delivery accepted so far — the
 * contract answers 2xx *before* the event is handled, so a test that wants
 * to assert on the handling has to wait for it.
 */
export class WebhookListener {
  private readonly secret: string;
  private readonly path: string;
  private readonly repos: readonly RepoRef[];
  private readonly onEvent: EventListener;
  private readonly api: Pick<GitHubApi, 'getCheckRuns'> | undefined;
  private readonly checkGate: CheckGate;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly maxBodyBytes: number;
  private readonly ring = new DeliveryRing(DELIVERY_DEDUP_RING);
  private readonly inFlight = new Set<Promise<void>>();
  private server: Server | undefined;

  constructor(opts: WebhookListenerOptions) {
    this.secret = opts.secret;
    this.path = opts.path ?? DEFAULT_WEBHOOK_PATH;
    this.repos = opts.repos;
    this.onEvent = opts.onEvent;
    this.api = opts.api;
    this.checkGate = opts.checkGate ?? new CheckGate();
    this.logger = opts.logger ?? silentLogger();
    this.now = opts.now ?? (() => new Date());
    this.maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  }

  /** Bind and resolve with the port actually bound (0 picks a free one). */
  async listen(port: number, host = '127.0.0.1'): Promise<number> {
    if (this.server) throw new Error('webhook listener is already listening');
    const server = createServer((req, res) => {
      this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;
    this.logger.info('webhook listener bound', { port: bound, path: this.path });
    return bound;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.whenIdle();
  }

  /** Resolve once every accepted delivery has finished being processed. */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  /** How many delivery ids the ring currently remembers (tests, diagnostics). */
  get rememberedDeliveries(): number {
    return this.ring.size;
  }

  get dedupCapacity(): number {
    return this.ring.capacity;
  }

  // ── Request handling ──

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      // A browser hitting the path is noise, not a delivery.
      respond(res, 405, 'method not allowed');
      req.resume();
      return;
    }
    const url = req.url ?? '/';
    if (url.split('?', 1)[0] !== this.path) {
      respond(res, 404, 'not found');
      req.resume();
      return;
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      this.logger.warn('webhook delivery refused: body over the cap', {
        declaredBytes: declared,
        capBytes: this.maxBodyBytes,
      });
      respond(res, 413, 'payload too large');
      req.destroy();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > this.maxBodyBytes) {
        aborted = true;
        this.logger.warn('webhook delivery refused: body over the cap', {
          readBytes: size,
          capBytes: this.maxBodyBytes,
        });
        respond(res, 413, 'payload too large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => {
      if (!aborted) {
        aborted = true;
        this.logger.warn('webhook delivery aborted while reading the body');
      }
    });

    req.on('end', () => {
      if (aborted) return;
      this.afterBody(req, res, Buffer.concat(chunks));
    });
  }

  /** Steps 3 to 6. `body` is the raw bytes; it is not parsed before step 6. */
  private afterBody(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    // 3. Signature over the raw bytes, before anything interprets them.
    if (!this.signatureValid(header(req, SIGNATURE_HEADER), body)) {
      this.logger.warn('webhook delivery rejected: X-Hub-Signature-256 did not verify', {
        delivery: header(req, DELIVERY_HEADER) ?? '(none)',
        bytes: body.length,
      });
      respond(res, 401, 'signature mismatch');
      return;
    }

    const delivery = header(req, DELIVERY_HEADER);
    const event = header(req, EVENT_HEADER);
    if (!delivery || !event) {
      respond(res, 400, 'missing X-GitHub-Delivery or X-GitHub-Event');
      return;
    }

    // 4. Replay. Only verified deliveries may write to the ring.
    if (this.ring.add(delivery)) {
      this.logger.info('webhook delivery dropped: replay of a delivery id already seen', { delivery, event });
      respond(res, 200, 'duplicate delivery');
      return;
    }

    // 5. GitHub's own reachability check.
    if (event === 'ping') {
      this.logger.info('webhook ping answered', { delivery });
      respond(res, 200, 'pong');
      return;
    }

    // 6. 2xx first, then the work.
    respond(res, 202, 'accepted');
    const receivedAt = this.now().toISOString();
    const task = this.process({ id: delivery, event, body, receivedAt }).catch((err: unknown) => {
      this.logger.error('webhook delivery processing failed', {
        delivery,
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  /**
   * HMAC-SHA256 over the raw body, compared in constant time. A missing,
   * misprefixed or wrong-length header is rejected without a compare (there
   * is nothing of equal length to compare against, and the length of a
   * signature is not a secret).
   */
  private signatureValid(provided: string | undefined, body: Buffer): boolean {
    if (!provided || !provided.startsWith(SIGNATURE_PREFIX)) return false;
    const hex = provided.slice(SIGNATURE_PREFIX.length);
    if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
    const expected = createHmac('sha256', this.secret).update(body).digest();
    const actual = Buffer.from(hex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async process(raw: {
    id: string;
    event: string;
    body: Buffer;
    receivedAt: string;
  }): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(raw.body.toString('utf8'));
    } catch {
      this.logger.warn('webhook delivery dropped: body is not JSON', { delivery: raw.id, event: raw.event });
      return;
    }

    const delivery: WebhookDelivery = {
      id: raw.id,
      event: raw.event,
      payload,
      receivedAt: raw.receivedAt,
    };

    const events = normalizeWebhook(delivery);
    if (events.length === 0) {
      this.logger.debug('webhook delivery carries no event this ingress maps', {
        delivery: raw.id,
        event: raw.event,
      });
      return;
    }

    // One stderr line per dropped delivery, naming the repository the
    // allow-list does not hold (§Ingress).
    const repo = events[0].repo;
    if (!repoAllowed(repo, this.repos)) {
      this.logger.warn('webhook delivery dropped: repository outside GITHUB_REPOS', {
        delivery: raw.id,
        event: raw.event,
        repo: repoSlug(repo),
      });
      return;
    }

    // The lookup also decides readiness: a sha with a suite still running is
    // held back here, so the one emission it gets names every failed job.
    const resolved = this.api ? await resolveCheckEvents(events, this.api, this.logger) : events;

    for (const normalized of resolved) {
      const mark = checkMarkOf(normalized);
      if (mark === null) {
        await this.onEvent(normalized);
        continue;
      }
      // §Ingress wants one checks event per head sha, and two suites on one
      // commit are two deliveries the delivery-id ring cannot collapse. The
      // gate serializes this emission against every other one for the same
      // sha — including a poll pass running right now — and drops it if what
      // the listener already accepted covers it.
      const delivered = await this.checkGate.emit(normalized.repo, normalized.sha as string, mark, async () => {
        await this.onEvent(normalized);
      });
      if (!delivered) {
        this.logger.info('checks event dropped: this head sha already reported this result or a stronger one', {
          delivery: raw.id,
          sha: normalized.sha,
          conclusion: normalized.checks?.conclusion ?? null,
        });
      }
    }
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
}

/** Responses are plain text and never echo a header, a body or the secret. */
function respond(res: ServerResponse, status: number, message: string): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${message}\n`);
}

/**
 * The listener a validated {@link Config} describes, or `null` when
 * GITHUB_WEBHOOK_PORT is absent ("webhook listener off"). `readConfig`
 * already guarantees a secret whenever the port is set.
 */
export function webhookListenerFromConfig(
  config: Config,
  deps: Pick<WebhookListenerOptions, 'onEvent' | 'api' | 'logger' | 'checkGate'>,
): WebhookListener | null {
  if (config.webhookPort === null || config.webhookSecret === null) return null;
  return new WebhookListener({
    secret: config.webhookSecret,
    path: config.webhookPath,
    repos: config.repos,
    ...deps,
  });
}
