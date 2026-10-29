#!/usr/bin/env node
/**
 * github-mcpl — CLI entry point (TASK-SRHKG.1.9).
 *
 * Usage:
 *   github-mcpl --stdio        # MCP-compatible stdio transport
 *   github-mcpl --tcp <port>   # TCP transport for MCPL hosts
 *
 * What startup does, in order: validate the environment (`readConfig`, which
 * names every offending variable and no secret value), build the GitHub
 * adapter, load the checkpoint store, register the five tool modules, start
 * whichever ingress paths the configuration asks for, and serve.
 *
 * Stdout is the JSON-RPC channel and nothing else writes to it; every
 * diagnostic goes through the Logger, which writes to stderr.
 */

import * as net from 'node:net';
import { McplConnection } from '@animalabs/mcpl-core';
import { GitHubAdapter } from './github-adapter.js';
import { CheckGate } from './normalize.js';
import { Poller } from './poller.js';
import { GitHubMcplServer } from './server.js';
import { GithubState } from './state.js';
import { commentsToolModule } from './tools-comments.js';
import { issuesToolModule, prToolModule } from './tools-issues-pr.js';
import { readToolModule } from './tools-read.js';
import { reviewToolModule } from './tools-review.js';
import { ConfigError, readConfig, repoSlug, stderrLogger, type Config, type Logger } from './types.js';
import { WebhookListener, webhookListenerFromConfig } from './webhook.js';

/**
 * The five modules the six feature sets need. `github.events` carries no
 * tools (it is the ingress), so there is no module for it; the other five are
 * exactly `TOOLS_BY_FEATURE_SET`'s keys.
 */
function registerTools(server: GitHubMcplServer): void {
  server.register(readToolModule);
  server.register(commentsToolModule);
  server.register(reviewToolModule);
  server.register(issuesToolModule);
  server.register(prToolModule);
}

/** What `main` has to shut down, in the order it has to shut them down. */
interface Running {
  webhook: WebhookListener | null;
  poller: Poller | null;
  state: GithubState;
}

/**
 * The adapter, with the one startup failure `readConfig` cannot catch named
 * after the variable that caused it.
 *
 * `readConfig` checks that the key file exists and that nobody else can read
 * it, but not that what is in it is a key — only the App authentication can
 * say that, and when it cannot it throws OpenSSL's own string
 * (`error:1E08010C:DECODER routines::unsupported`), which names neither the
 * variable nor the file. An operator who pasted the wrong half of the
 * registration output deserves better than that. The original message is kept
 * after the colon; it carries no key material, only a decoder verdict.
 */
function buildAdapter(config: Config, log: Logger): GitHubAdapter {
  try {
    return new GitHubAdapter(config, { logger: log });
  } catch (err) {
    log.error(
      'GITHUB_APP_PRIVATE_KEY_FILE: the file does not hold a usable RSA private key (expected a ' +
        'PEM beginning "-----BEGIN RSA PRIVATE KEY-----", the one GitHub offered when the App was ' +
        `registered): ${(err as Error).message}`,
    );
    process.exit(1);
  }
}

/**
 * Build the server and start the ingress paths the configuration names.
 *
 * Both paths share **one** {@link CheckGate}: "one `checks.completed` per head
 * sha" has to hold across the two of them, or a webhook delivery and a poll
 * pass for the same head would each emit their own event.
 */
async function build(config: Config, log: Logger): Promise<{ server: GitHubMcplServer; running: Running }> {
  const api = buildAdapter(config, log);
  const state = GithubState.load(config.stateFile, log);
  const server = new GitHubMcplServer(api, {
    botLogin: config.botLogin,
    repos: config.repos,
    maintainers: config.maintainers,
    prBaseAllow: config.prBaseAllow,
    state,
    logger: log,
  });
  registerTools(server);

  const checkGate = new CheckGate();
  const webhook = webhookListenerFromConfig(config, {
    onEvent: server.onEvent,
    api,
    logger: log,
    checkGate,
  });
  if (webhook) {
    const port = await webhook.listen(config.webhookPort as number);
    log.info('webhook listening', { port, path: config.webhookPath });
  }

  const poller =
    config.pollIntervalMs === 0
      ? null
      : new Poller({
          api,
          repos: config.repos,
          state,
          intervalMs: config.pollIntervalMs,
          onEvent: server.onEvent,
          logger: log,
          checkGate,
        });
  if (poller) {
    poller.start();
    log.info('polling', { intervalMs: config.pollIntervalMs });
  }

  return { server, running: { webhook, poller, state } };
}

/**
 * Stop the ingress and flush the state. Idempotent: a second signal while the
 * first shutdown is still running must not start a second one.
 */
async function shutdown(running: Running, log: Logger): Promise<void> {
  running.poller?.stop();
  try {
    await running.poller?.whenIdle();
  } catch (err) {
    log.warn('poller did not settle', { error: String(err) });
  }
  try {
    await running.webhook?.close();
  } catch (err) {
    log.warn('webhook did not close', { error: String(err) });
  }
  try {
    // Last: the poll cursors and the checkpoint lineage must survive the exit.
    await running.state.flush();
  } catch (err) {
    log.error('state flush failed', { error: String(err) });
  }
}

async function main(): Promise<void> {
  const log = stderrLogger();
  const args = process.argv.slice(2);
  const useStdio = args.includes('--stdio');
  const tcpIdx = args.indexOf('--tcp');
  const tcpPort = tcpIdx >= 0 ? Number.parseInt(args[tcpIdx + 1], 10) : undefined;

  if (!useStdio && !(tcpPort && Number.isInteger(tcpPort))) {
    log.error('usage: github-mcpl --stdio | --tcp <port>');
    process.exit(1);
  }

  let config: Config;
  try {
    config = readConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      // Variable names and bounds only — never a secret value.
      for (const problem of err.problems) log.error(problem);
      process.exit(1);
    }
    throw err;
  }

  const { server, running } = await build(config, log);
  log.info('github-mcpl starting', {
    repos: config.repos.map(repoSlug),
    bot: config.botLogin,
    webhook: config.webhookPort === null ? 'off' : `:${config.webhookPort}${config.webhookPath}`,
    poll: config.pollIntervalMs === 0 ? 'off' : `${config.pollIntervalMs}ms`,
    state: config.stateFile ?? 'in-memory',
    transport: useStdio ? 'stdio' : `tcp:${tcpPort}`,
  });

  let stopping: Promise<void> | null = null;
  const stop = (signal: string) => {
    if (stopping) return;
    log.info('shutting down', { signal });
    stopping = shutdown(running, log).then(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  try {
    if (useStdio) {
      await server.serve(McplConnection.fromStreams(process.stdin, process.stdout));
    } else {
      const tcpServer = net.createServer();
      tcpServer.listen(tcpPort, '127.0.0.1');
      await new Promise<void>((resolve) => tcpServer.once('listening', resolve));
      tcpServer.on('error', (err) => log.error('tcp server error', { error: String(err) }));
      log.info('listening', { tcpPort });
      // One host at a time: the grant, the channel registry and the thread
      // memory are per-connection, and a second concurrent peer would be
      // served from the first one's state.
      for (;;) {
        const conn = await McplConnection.acceptTcp(tcpServer);
        await server.serve(conn);
      }
    }
  } finally {
    if (!stopping) await shutdown(running, log);
  }
}

main().catch((err) => {
  stderrLogger().error('fatal', { error: String(err) });
  process.exit(1);
});
