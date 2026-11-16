#!/usr/bin/env node
/**
 * A scripted MCPL host: it spawns the built server, speaks MCPL JSON-RPC over
 * its stdio, grants every capability the manifest declares, and records every
 * request the server sends so a scenario can assert on it.
 *
 * It reads no environment value itself; the child inherits the environment
 * untouched. `--log <file>` appends the transcript, every command but `quit`,
 * the server's notifications and the child's stderr to that file, and the
 * server's stderr can name the installation id.
 *
 * One JSON command per line on stdin, one JSON result per line on stdout:
 *
 *   {"cmd":"call","name":"comment","args":{...}}        tools/call
 *   {"cmd":"publish","params":{...}}                    channels/publish (Request)
 *   {"cmd":"notify-publish","params":{...}}             channels/publish (Notification)
 *   {"cmd":"checkpoint"}                                state/checkpoint
 *   {"cmd":"rollback","params":{...}}                   state/rollback
 *   {"cmd":"tools"}                                     tools/list
 *   {"cmd":"channels"}                                  channels/list
 *   {"cmd":"request","method":"...","params":{...}}      any other MCPL request
 *   {"cmd":"wait","method":"push/event","contains":"...","timeoutMs":90000}
 *   {"cmd":"events","method":"channels/incoming"}       dump what was recorded
 *   {"cmd":"reset"}                                     forget recorded requests
 *   {"cmd":"sleep","ms":1000}
 *   {"cmd":"quit"}                                      shut the child down
 *
 * `wait` resolves on the first recorded request matching `method` (and, when
 * given, whose JSON contains `contains`), including one that arrived before
 * the wait was issued.
 *
 * A tool call the connector refuses comes back as a result carrying `isError`,
 * not as a JSON-RPC error, except an unknown tool or one the grant denies, which
 * is a JSON-RPC error. So results are judged: `isError` fails any command, and
 * so do `delivered: false` from `publish` and `success: false` or a non-empty
 * `notUndone` from `rollback`.
 *
 * `"expectError": true` marks a command whose refusal is the scenario: a
 * refusal passes and a success fails. A timeout, or the child exiting under
 * the command, fails either way.
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import { McplConnection, method } from '@animalabs/mcpl-core';

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

const serverEntry = flag('--server', path.resolve('dist/src/index.js'));
const logPath = flag('--log', null);
const shutdownGraceMs = Number.parseInt(flag('--shutdown-grace', '10000'), 10);
const logStream = logPath ? createWriteStream(logPath, { flags: 'a' }) : null;

const FULL_GRANT = [
  'tools',
  'channels.register',
  'channels.lifecycle',
  'channels.publish',
  'channels.incoming',
  'pushEvents',
  'channels.typing',
];

function emit(obj) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
  process.stdout.write(line + '\n');
  logStream?.write(line + '\n');
}

function trace(obj) {
  logStream?.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
}

const [command, args] = serverEntry.endsWith('.js')
  ? [process.execPath, [serverEntry, '--stdio']]
  : [serverEntry, ['--stdio']];
const child = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

createInterface({ input: child.stderr }).on('line', (line) => trace({ dir: 'stderr', line }));

/**
 * Kept from the moment the child is spawned: `child.once('exit')` registered
 * after the child has gone never fires.
 */
let exitInfo = null;
let shuttingDown = false;
let unexpectedExit = false;
let badShutdown = false;
let escalated = false;

function shutdownWasClean(code, signal) {
  if (escalated) return false;
  return code === 0 || (code === null && signal === 'SIGTERM');
}

const exited = new Promise((resolve) => {
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };
    const clean = shuttingDown && shutdownWasClean(code, signal);
    if (!shuttingDown) {
      unexpectedExit = true;
      emit({
        event: 'result',
        ok: false,
        cmd: 'child',
        error: `the server exited without being asked to (code ${code}, signal ${signal})`,
      });
    } else if (!clean) {
      badShutdown = true;
      emit({
        event: 'result',
        ok: false,
        cmd: 'shutdown',
        error: escalated
          ? `the server ignored SIGTERM and had to be killed (code ${code}, signal ${signal})`
          : `the server failed its own shutdown (code ${code}, signal ${signal})`,
      });
    }
    emit({ event: 'child-exit', code, signal, expected: shuttingDown, clean });
    resolve(exitInfo);
  });
});

const childLost = exited.then((info) => {
  const err = new Error(`the server exited (code ${info.code}, signal ${info.signal}) with this command in flight`);
  err.fatal = true;
  throw err;
});
childLost.catch(() => {});

const conn = McplConnection.fromStreams(child.stdout, child.stdin);

const recorded = [];
const waiters = [];

function matches(entry, spec) {
  if (spec.method && entry.method !== spec.method) return false;
  if (spec.contains && !JSON.stringify(entry.params ?? null).includes(spec.contains)) return false;
  return true;
}

function record(req) {
  const entry = { seq: recorded.length + 1, at: new Date().toISOString(), method: req.method, params: req.params };
  recorded.push(entry);
  emit({ event: 'inbound', ...entry });
  for (const w of [...waiters]) {
    if (matches(entry, w.spec)) {
      clearTimeout(w.timer);
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(entry);
    }
  }
}

conn.on('request', (req) => {
  record(req);
  switch (req.method) {
    case method.CHANNELS_REGISTER:
    case method.CHANNELS_CHANGED: {
      const p = req.params ?? {};
      const channels = p.channels ?? p.updated ?? [];
      conn.sendResponse(req.id, { results: channels.map((c) => ({ id: c.id, accepted: true })) });
      break;
    }
    case method.CHANNELS_INCOMING: {
      const messages = req.params?.messages ?? [];
      conn.sendResponse(req.id, { results: messages.map((m) => ({ messageId: m.messageId, accepted: true })) });
      break;
    }
    case method.PUSH_EVENT:
      conn.sendResponse(req.id, { accepted: true });
      break;
    default:
      conn.sendError(req.id, -32601, `unexpected ${req.method}`);
  }
});

conn.on('notification', (notif) => trace({ dir: 'inbound-notification', method: notif.method, params: notif.params }));

async function handshake() {
  const init = await Promise.race([handshakeRequests(), childLost]);
  emit({ event: 'initialized', serverInfo: init.serverInfo, capabilities: init.capabilities });
  const receipt = await Promise.race([
    conn.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: [...FULL_GRANT] }),
    childLost,
  ]);
  emit({ event: 'granted', grant: FULL_GRANT, degradation: receipt });
}

async function handshakeRequests() {
  const init = await conn.sendRequest(method.INITIALIZE, {
    protocolVersion: '2024-11-05',
    capabilities: { experimental: { mcpl: { version: '0.5' } } },
    clientInfo: { name: 'wp10-e2e-host', version: '0' },
  });
  conn.sendNotification('notifications/initialized');
  return { serverInfo: init?.serverInfo, capabilities: init?.capabilities };
}

async function run(c) {
  switch (c.cmd) {
    case 'call':
      return await conn.sendRequest('tools/call', { name: c.name, arguments: c.args ?? {} }, c.timeoutMs ?? 60000);
    case 'tools':
      return await conn.sendRequest('tools/list', {});
    case 'channels':
      return await conn.sendRequest(method.CHANNELS_LIST, {});
    case 'publish':
      return await conn.sendRequest(method.CHANNELS_PUBLISH, c.params ?? {}, c.timeoutMs ?? 60000);
    case 'notify-publish':
      conn.sendNotification(method.CHANNELS_PUBLISH, c.params ?? {});
      return { sent: true };
    case 'checkpoint':
      return await conn.sendRequest('state/checkpoint', c.params ?? {});
    case 'rollback':
      return await conn.sendRequest(method.STATE_ROLLBACK, c.params ?? {}, c.timeoutMs ?? 120000);
    case 'request':
      return await conn.sendRequest(c.method, c.params ?? {}, c.timeoutMs ?? 60000);
    case 'wait': {
      const hit = recorded.find((e) => matches(e, c));
      if (hit) return { matched: hit, fromBacklog: true };
      const timeoutMs = c.timeoutMs ?? 90000;
      return await new Promise((resolve, reject) => {
        const w = { spec: c, resolve: (e) => resolve({ matched: e, fromBacklog: false }) };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timed out after ${timeoutMs}ms waiting for ${c.method ?? 'any'}${c.contains ? ` containing ${c.contains}` : ''}`));
        }, timeoutMs);
        waiters.push(w);
      });
    }
    case 'events':
      return { recorded: recorded.filter((e) => matches(e, c)) };
    case 'reset':
      recorded.length = 0;
      return { reset: true };
    case 'sleep':
      await new Promise((r) => setTimeout(r, c.ms ?? 1000));
      return { slept: c.ms ?? 1000 };
    default:
      throw new Error(`unknown cmd '${c.cmd}'`);
  }
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function verdictOf(c, result) {
  if (result && typeof result === 'object') {
    if (result.isError === true) return { ok: false, reason: textOf(result) || 'tool reported isError' };
    if (c.cmd === 'publish' && result.delivered === false) {
      return { ok: false, reason: `publish not delivered: ${result.reason ?? 'no reason given'}` };
    }
    if (c.cmd === 'rollback') {
      if (result.success === false) return { ok: false, reason: `rollback failed: ${result.reason ?? 'no reason given'}` };
      if (Array.isArray(result.notUndone) && result.notUndone.length > 0) {
        return { ok: false, reason: `rollback left ${result.notUndone.length} item(s) not undone` };
      }
    }
  }
  return { ok: true };
}

async function runGuarded(c) {
  if (exitInfo) {
    const err = new Error(`the server had already exited (code ${exitInfo.code}, signal ${exitInfo.signal})`);
    err.fatal = true;
    throw err;
  }
  return await Promise.race([run(c), childLost]);
}

function isFatal(err) {
  return err?.fatal === true || /timed out/i.test(String(err?.message ?? err)) || isGone(err);
}

/**
 * The stream closing usually beats the `exit` event, so a child that dies under
 * a command surfaces as mcpl-core's `ConnectionClosedError`.
 */
function isGone(err) {
  return err?.fatal === true || err?.name === 'ConnectionClosedError';
}

async function exitCode() {
  if (exitInfo) return exitInfo;
  const grace = new Promise((resolve) => setTimeout(() => resolve(null), 2000));
  return await Promise.race([exited, grace]);
}

async function quit() {
  shuttingDown = true;
  if (exitInfo) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    escalated = true;
    child.kill('SIGKILL');
  }, shutdownGraceMs);
  await exited;
  clearTimeout(timer);
}

try {
  await handshake();
} catch (err) {
  emit({ event: 'result', ok: false, cmd: 'handshake', error: String(err?.message ?? err) });
  await quit();
  logStream?.end();
  process.exit(1);
}

const rl = createInterface({ input: process.stdin });
let failed = false;

for await (const line of rl) {
  const text = line.trim();
  if (!text || text.startsWith('#')) continue;
  let c;
  try {
    c = JSON.parse(text);
  } catch (err) {
    emit({ event: 'result', ok: false, error: `not JSON: ${text}` });
    failed = true;
    continue;
  }
  if (c.cmd === 'quit') break;
  trace({ dir: 'command', c });

  let outcome;
  let fatal = false;
  let gone = false;
  try {
    const result = await runGuarded(c);
    const verdict = verdictOf(c, result);
    outcome = verdict.ok ? { ok: true, result } : { ok: false, error: verdict.reason, result };
  } catch (err) {
    fatal = isFatal(err);
    gone = isGone(err);
    const info = gone ? await exitCode() : null;
    outcome = {
      ok: false,
      error: String(err?.message ?? err),
      ...(info ? { childExit: info } : {}),
      ...(err?.data === undefined ? {} : { data: err.data }),
    };
  }

  if (c.expectError && !fatal) {
    outcome = outcome.ok
      ? { ok: false, error: 'expected a refusal and the call succeeded', result: outcome.result }
      : { ...outcome, ok: true, expectedError: outcome.error, error: undefined };
  }

  if (!outcome.ok) failed = true;
  emit({ event: 'result', cmd: c.cmd, label: c.label, ...outcome });

  if (gone) break;
}

await quit();
conn.close();
logStream?.end();
process.exit(failed || unexpectedExit || badShutdown ? 1 : 0);
