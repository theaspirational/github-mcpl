#!/usr/bin/env node
/**
 * A scripted MCPL host for the WP10 end-to-end run (TASK-SRHKG.1.10).
 *
 * It is the host side of `test/harness.ts`, moved off an in-memory stream pair
 * and onto a child process's stdio: it spawns the built server
 * (`node dist/src/index.js --stdio`), speaks MCPL JSON-RPC (newline-delimited,
 * one object per line) over that pipe, grants every capability the manifest
 * declares, answers every request a conforming host answers, and records
 * every inbound request so a scenario can assert on tags and metadata.
 *
 * It carries NO credentials. The App id, the private key path and the state
 * file come from the environment the operator sourced before running it, and
 * are inherited by the child untouched; this script never reads, prints or
 * logs an environment value. The one line it prints about the child is its
 * exit status.
 *
 * Operator interface: one JSON command per line on stdin, one JSON result per
 * line on stdout, so a scenario is a file of commands and its transcript is
 * the evidence. `--log <file>` additionally appends every frame in both
 * directions, plus the child's stderr, to a durable log.
 *
 *   {"cmd":"call","name":"comment","args":{...}}        tools/call
 *   {"cmd":"publish","params":{...}}                    channels/publish (Request)
 *   {"cmd":"notify-publish","params":{...}}             channels/publish (Notification, §14.3)
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
 * `wait` resolves on the first *recorded* request matching `method` (and, when
 * given, whose JSON contains the `contains` substring) — including one that
 * arrived before the wait was issued, so a scenario never races the poller.
 *
 * **A fulfilled RPC is not the same as a successful one.** JSON-RPC answers a
 * refused tool call with a *result* carrying `isError`, not with an error
 * object, so a host that reports "ok" for every answered request calls a
 * refusal a pass — which is how a scenario can look green while the connector
 * declined to do it. Every command is therefore judged on its result
 * ({@link verdictOf}): `isError` on a tool result, `delivered: false` on a
 * publish, and `success: false` or a non-empty `notUndone` on a rollback
 * receipt are all failures.
 *
 * Add `"expectError": true` to a command whose refusal *is* the scenario (a
 * base outside the allow-list). Then a refusal is the pass and a success is
 * the failure. Two things it never excuses, because neither is the connector
 * answering: a timeout, and the child exiting underneath the command.
 *
 * Any failure sets the process exit status to 1, so a scenario file cannot
 * pass by being read without being checked.
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import { McplConnection, method } from '@animalabs/mcpl-core';

// ─────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

const serverEntry = flag('--server', path.resolve('dist/src/index.js'));
const logPath = flag('--log', null);
/**
 * How long a server gets to honour SIGTERM before it is killed. Ten seconds
 * for a real run — the state flush is the thing being waited for — and
 * overridable so the lifecycle check can exercise the escalation without
 * sitting through it.
 */
const shutdownGraceMs = Number.parseInt(flag('--shutdown-grace', '10000'), 10);
const logStream = logPath ? createWriteStream(logPath, { flags: 'a' }) : null;

/**
 * The capability set the manifest declares — `test/harness.ts`'s `FULL_GRANT`.
 * The brief asks for the full grant, so nothing here is conditional: a
 * scenario that wanted a narrower grant would be a different run.
 */
const FULL_GRANT = [
  'tools',
  'channels.register',
  'channels.lifecycle',
  'channels.publish',
  'channels.incoming',
  'pushEvents',
  'channels.typing',
];

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

/** One JSON line to stdout (the operator's transcript) and to `--log`. */
function emit(obj) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
  process.stdout.write(line + '\n');
  logStream?.write(line + '\n');
}

/** Log-only: the frame traffic, which is evidence but not an answer. */
function trace(obj) {
  logStream?.write(JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// The child
// ─────────────────────────────────────────────────────────────────────────────

// `stdio: pipe` on all three: stdout is the JSON-RPC channel and must not be
// shared with a terminal, and stderr is the server's diagnostics, which the
// report cites.
// A `.js` entry runs under this Node; anything else (the launcher,
// deploy/github-mcpl) is spawned as the host spawns it, by its own path.
const [command, args] = serverEntry.endsWith('.js')
  ? [process.execPath, [serverEntry, '--stdio']]
  : [serverEntry, ['--stdio']];
const child = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

createInterface({ input: child.stderr }).on('line', (line) => trace({ dir: 'stderr', line }));

/**
 * The child's exit, kept from the moment it is spawned.
 *
 * Taken here and not inside `quit()`: `child.once('exit')` registered after
 * the child has already gone never fires, so a shutdown that asked for it
 * then would wait forever for an event that happened while it was not
 * looking. A promise created now is already settled by then and resolves at
 * once.
 */
let exitInfo = null;
/**
 * Set before the child is ever signalled, so the exit that follows is known
 * to be the one this host asked for.
 */
let shuttingDown = false;
/**
 * The child exited and nobody asked it to.
 *
 * Tracked separately from the per-command failures because an idle crash
 * belongs to no command: the server could die between two commands, or after
 * the last one, and the run would print the exit and still return 0 (review
 * round 2, finding 3) — a scenario file that ends in `quit`, or just ends,
 * looked exactly as green as one the server survived.
 */
let unexpectedExit = false;
/**
 * The shutdown this host asked for did not go cleanly (review round 3,
 * finding 2).
 *
 * Asking a server to stop and being told it crashed on the way out is not a
 * successful run: the exit status is how a server reports that its own
 * shutdown failed — a state file it could not flush, a listener that would not
 * close — and a host that only checked *whether* the exit was expected
 * reported `{code: 3, expected: true}` and then returned 0.
 */
let badShutdown = false;
/** SIGTERM was ignored long enough that the host had to escalate. */
let escalated = false;

/**
 * Did the child stop the way a healthy server stops when asked?
 *
 * Two shapes are clean, and only two: it exited 0 under its own signal
 * handler, or it had no handler and died of the SIGTERM this host sent, which
 * is the default disposition and not a fault. Having to escalate to SIGKILL is
 * never clean, whatever the child managed to report on the way out: it means
 * the shutdown this host asked for did not happen inside its grace period.
 */
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
      // Reported as a failed result and not only as the `child-exit` line, so
      // the one-line-per-failure reading of a transcript stays true.
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

/** Rejects if the child ever exits, so a command in flight can race it. */
const childLost = exited.then((info) => {
  const err = new Error(`the server exited (code ${info.code}, signal ${info.signal}) with this command in flight`);
  err.fatal = true;
  throw err;
});
// Every command that wins its race abandons this promise; without a handler of
// its own, the eventual exit at `quit()` would surface as an unhandled
// rejection and bury the run's real output.
childLost.catch(() => {});

const conn = McplConnection.fromStreams(child.stdout, child.stdin);

// ─────────────────────────────────────────────────────────────────────────────
// Recording, and answering as a host does
// ─────────────────────────────────────────────────────────────────────────────

/** Every request the server sent, in arrival order. */
const recorded = [];
/** Pending `wait` commands, checked on every arrival. */
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
    // The registry announces a thread, and a host that granted
    // channels.register accepts it.
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
      // Anything else is the server asking for something this host does not
      // implement; refusing is honest and shows up in the transcript.
      conn.sendError(req.id, -32601, `unexpected ${req.method}`);
  }
});

conn.on('notification', (notif) => trace({ dir: 'inbound-notification', method: notif.method, params: notif.params }));

// ─────────────────────────────────────────────────────────────────────────────
// Handshake
// ─────────────────────────────────────────────────────────────────────────────

async function handshake() {
  // Raced against the child, like every command: a server that dies on a bad
  // configuration (an unreadable key, a repository it cannot see) dies before
  // it answers `initialize`, and waiting out the RPC timeout would report that
  // as a slow host rather than as the startup failure its stderr already
  // explains.
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

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Verdicts
// ─────────────────────────────────────────────────────────────────────────────

/** The text blocks of a tool result, joined — what the refusal reason is in. */
function textOf(result) {
  return (result?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Did the server actually do what the command asked?
 *
 * Three answer shapes carry a failure inside a perfectly well-formed JSON-RPC
 * *result*, and each one is a scenario that must not read as a pass:
 *
 *   - a tool result with `isError: true` — the refusal shape of MCP;
 *   - a publish that reports `delivered: false`, with the reason it gives
 *     (an empty body, an unroutable channel);
 *   - a rollback receipt with `success: false`, or with entries in
 *     `notUndone` — comments the rollback could not undo. A receipt that
 *     reports leftovers is not a clean rollback however it is labelled.
 *
 * Anything else is taken at face value: this host asserts on shapes it knows
 * and does not try to grade prose.
 */
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

/**
 * Run one command, losing the race if the child dies under it.
 *
 * Without this a command sent to a server that has already exited sits until
 * its own timeout — thirty seconds of nothing, reported as a timeout rather
 * than as the crash it was.
 */
async function runGuarded(c) {
  if (exitInfo) {
    const err = new Error(`the server had already exited (code ${exitInfo.code}, signal ${exitInfo.signal})`);
    err.fatal = true;
    throw err;
  }
  return await Promise.race([run(c), childLost]);
}

/** A timeout or a dead child: never the connector's considered answer. */
function isFatal(err) {
  return err?.fatal === true || /timed out/i.test(String(err?.message ?? err)) || isGone(err);
}

/**
 * Did this command fail because the server is no longer there?
 *
 * The stream closing usually beats the `exit` event, so a child that dies
 * under a command surfaces as mcpl-core's `ConnectionClosedError` rather than as
 * the exit this host is watching for. Both mean the same thing, and both have
 * to stop the run: every command after them would report it again.
 */
function isGone(err) {
  return err?.fatal === true || err?.name === 'ConnectionClosedError';
}

/** Wait briefly for the child's exit, so a failure can name its code. */
async function exitCode() {
  if (exitInfo) return exitInfo;
  const grace = new Promise((resolve) => setTimeout(() => resolve(null), 2000));
  return await Promise.race([exited, grace]);
}

/**
 * Stop the child the way its own signal handlers expect, and wait for it: the
 * poll cursor and the checkpoint lineage are flushed in `SIGTERM`'s handler,
 * and scenario 9 restarts the server against that file. Killing the pipe
 * instead would lose the flush and make the restart scenario a false failure.
 */
async function quit() {
  // Before anything else, including the early return: an exit already
  // recorded was unexpected and stays that way, and an exit still to come is
  // this shutdown's own.
  shuttingDown = true;
  if (exitInfo) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    // Recorded before the signal, so the exit handler — which runs while this
    // function is still awaiting — already knows the shutdown was escalated.
    escalated = true;
    child.kill('SIGKILL');
  }, shutdownGraceMs);
  await exited;
  clearTimeout(timer);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

try {
  await handshake();
} catch (err) {
  // The server never came up. Its stderr is in the log and says why; this is
  // the one line that says the run did not start, and it exits non-zero so a
  // scenario cannot be read as having passed.
  emit({ event: 'result', ok: false, cmd: 'handshake', error: String(err?.message ?? err) });
  await quit();
  logStream?.end();
  process.exit(1);
}

const rl = createInterface({ input: process.stdin });
let failed = false;

for await (const line of rl) {
  const text = line.trim();
  // Blank lines and `#` comments keep a scenario file readable.
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

  // What happened, before `expectError` is allowed an opinion about it.
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
    // Give the exit a moment to land, so the transcript names the status the
    // server died with instead of only the broken pipe it left behind.
    const info = gone ? await exitCode() : null;
    outcome = {
      ok: false,
      error: String(err?.message ?? err),
      ...(info ? { childExit: info } : {}),
      ...(err?.data === undefined ? {} : { data: err.data }),
    };
  }

  // A scenario whose point is the refusal says so, and then the refusal is the
  // pass — but a *missing* refusal is a failure, because an allow-list that
  // let the call through is exactly what such a scenario exists to catch. A
  // timeout and a dead child are never excused: neither is an answer.
  if (c.expectError && !fatal) {
    outcome = outcome.ok
      ? { ok: false, error: 'expected a refusal and the call succeeded', result: outcome.result }
      : { ...outcome, ok: true, expectedError: outcome.error, error: undefined };
  }

  if (!outcome.ok) failed = true;
  emit({ event: 'result', cmd: c.cmd, label: c.label, ...outcome });

  // The server is gone; every command after this one would report the same
  // thing, so stop and let the exit status say so.
  if (gone) break;
}

await quit();
conn.close();
logStream?.end();
// An idle crash and a failed shutdown each fail the run on their own: no
// command has to have noticed either.
process.exit(failed || unexpectedExit || badShutdown ? 1 : 0);
