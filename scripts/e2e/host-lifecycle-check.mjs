#!/usr/bin/env node
/**
 * The one automated check on {@link ../e2e/fake-host.mjs}'s own behaviour.
 *
 * `npm test` covers `src/`; the end-to-end host is a script and nothing in the
 * suite would catch a regression in it. Three review rounds found three
 * separate ways it reported a green run over a server that had failed — a
 * refusal taken for a success (round 2), a crash between commands (round 3
 * finding 3), and a server that crashed *during* its own shutdown (round 3
 * finding 2) — so the lifecycle it has to get right is checked here instead.
 *
 * It needs no credentials and no network: each case spawns the host against a
 * tiny stub server written to a temp directory, which answers the MCPL
 * handshake and then behaves badly in one specific way. What is asserted is
 * the host's **exit status** and the verdict on its `child-exit` line, because
 * those are what a scenario run is read by.
 *
 *   node scripts/e2e/host-lifecycle-check.mjs
 *
 * Exits 0 when every case holds, 1 on the first that does not, naming it.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const HOST = path.join(import.meta.dirname, 'fake-host.mjs');
const workspace = mkdtempSync(path.join(tmpdir(), 'github-mcpl-host-check-'));

/**
 * A stub server, parameterised by how it misbehaves.
 *
 * `onSigterm`: `'clean'` exits 0, `'fail'` exits 3, `'ignore'` does nothing at
 * all so the host has to escalate, and `'default'` installs no handler so the
 * signal itself ends the process. `crashWhenIdle` exits 3 shortly after the
 * grant, with no command in flight.
 */
function stub(name, { onSigterm = 'clean', crashWhenIdle = false } = {}) {
  // fake-host invokes .js entries through Node; other suffixes are executables.
  const file = path.join(workspace, `${name}.js`);
  writeFileSync(
    file,
    `import { createInterface } from 'node:readline';
${onSigterm === 'clean' ? "process.on('SIGTERM', () => process.exit(0));" : ''}
${onSigterm === 'fail' ? "process.on('SIGTERM', () => process.exit(3));" : ''}
${onSigterm === 'ignore' ? "process.on('SIGTERM', () => {});" : ''}
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  const result =
    req.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: '${name}', version: '0' } }
      : req.method === 'featureSets/update'
        ? { accepted: true, unavailableFeatures: [], notes: [] }
        : { content: [{ type: 'text', text: 'ok' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
  ${crashWhenIdle ? "if (req.method === 'featureSets/update') setTimeout(() => process.exit(3), 30);" : ''}
});
// Keep the process alive between commands, as a server with a poll timer is.
setInterval(() => {}, 1000);
`,
  );
  return file;
}

/**
 * Run the host against `server`, closing its stdin the way `closing` says.
 *
 * `quit` sends the command; `eof` just closes the pipe. Either way the input
 * is delayed, so the stub has a window to misbehave while the host sits idle
 * on stdin with nothing in flight — which is the state round 3's finding 3
 * was about and which a command sent immediately would hide.
 */
function run(server, closing, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST, '--server', server, '--shutdown-grace', '700', ...extra], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // No credentials: the stub needs none, and this check must not read any.
      env: { PATH: process.env.PATH },
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', reject);
    setTimeout(() => {
      if (closing === 'quit') child.stdin.write('{"cmd":"quit"}\n');
      child.stdin.end();
    }, 400);
    child.on('exit', (code) => {
      const lines = out
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      resolve({
        exit: code,
        childExit: lines.find((l) => l.event === 'child-exit') ?? null,
        failures: lines.filter((l) => l.event === 'result' && l.ok === false),
      });
    });
  });
}

const CASES = [
  {
    name: 'a healthy server asked to quit',
    server: () => stub('healthy'),
    closing: 'quit',
    exit: 0,
    clean: true,
  },
  {
    name: 'a healthy server at EOF',
    server: () => stub('healthy'),
    closing: 'eof',
    exit: 0,
    clean: true,
  },
  {
    name: 'a server with no SIGTERM handler, which the signal itself stops',
    server: () => stub('default-disposition', { onSigterm: 'default' }),
    closing: 'quit',
    exit: 0,
    clean: true,
  },
  {
    name: 'a server that crashes while idle, then a quit',
    server: () => stub('idle-crash', { crashWhenIdle: true }),
    closing: 'quit',
    exit: 1,
    expected: false,
  },
  {
    name: 'a server that crashes while idle, then EOF',
    server: () => stub('idle-crash', { crashWhenIdle: true }),
    closing: 'eof',
    exit: 1,
    expected: false,
  },
  {
    name: 'a server that exits 3 from its own SIGTERM handler',
    server: () => stub('bad-shutdown', { onSigterm: 'fail' }),
    closing: 'quit',
    exit: 1,
    clean: false,
  },
  {
    name: 'a server that ignores SIGTERM until it is killed',
    server: () => stub('ignores-sigterm', { onSigterm: 'ignore' }),
    closing: 'quit',
    exit: 1,
    clean: false,
  },
];

let failed = 0;
try {
  for (const testCase of CASES) {
    const got = await run(testCase.server(), testCase.closing);
    const problems = [];
    if (got.exit !== testCase.exit) problems.push(`exit ${got.exit}, wanted ${testCase.exit}`);
    if (testCase.clean !== undefined && got.childExit?.clean !== testCase.clean) {
      problems.push(`child-exit.clean ${got.childExit?.clean}, wanted ${testCase.clean}`);
    }
    if (testCase.expected !== undefined && got.childExit?.expected !== testCase.expected) {
      problems.push(`child-exit.expected ${got.childExit?.expected}, wanted ${testCase.expected}`);
    }
    // A failing run has to say why, or the status is the only evidence there is.
    if (testCase.exit === 1 && got.failures.length === 0) problems.push('exit 1 with no failed result reported');
    if (testCase.exit === 0 && got.failures.length > 0) {
      problems.push(`exit 0 but ${got.failures.length} failed result(s)`);
    }

    const verdict = problems.length === 0 ? 'ok' : 'NOT OK';
    console.log(
      `${verdict}  ${testCase.name} — exit ${got.exit}, child-exit ${JSON.stringify(got.childExit && { code: got.childExit.code, signal: got.childExit.signal, expected: got.childExit.expected, clean: got.childExit.clean })}`,
    );
    for (const problem of problems) console.log(`      ${problem}`);
    if (problems.length > 0) failed += 1;
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(`${CASES.length - failed}/${CASES.length} host lifecycle cases hold`);
process.exit(failed > 0 ? 1 : 0);
