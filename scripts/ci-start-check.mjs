import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../dist/src/index.js", import.meta.url));
const scenario = process.argv[2] ?? 'healthy';
if (!['healthy', 'missing', 'all-missing', 'renamed', 'transient', 'mixed'].includes(scenario)) {
  throw new Error(`unknown offline startup scenario: ${scenario}`);
}
const ANSWER_MS = 30_000;
const EXIT_MS = 10_000;

const dir = mkdtempSync(join(tmpdir(), "github-mcpl-start-"));
const keyFile = join(dir, "app.pem");
writeFileSync(
  keyFile,
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey,
  { mode: 0o600 },
);

const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("./ci-github-fetch.mjs", import.meta.url)), SERVER, "--stdio"], {
  env: {
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
    GITHUB_REPOS: scenario === "mixed" ? "example/repo,example/renamed,example/missing" : scenario === "all-missing" ? "example/repo,example/other" : "example/repo",
    CI_START_SCENARIO: scenario,
    GITHUB_BOT_LOGIN: "example[bot]",
    GITHUB_POLL_INTERVAL_MS: "0",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let answered = false;
let finished = false;
let mixedVerified = false;
const mixedEvents = new Set();
const mixedTools = new Set();

function send(message) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

function closeInput() {
  clearTimeout(timer);
  timer = setTimeout(() => finish(1, `the server didn't exit within ${EXIT_MS / 1000} s of its stdin closing`), EXIT_MS);
  child.stdin.end();
}

function mixedAnswer(msg) {
  if (msg.method === 'push/event') {
    const event = msg.params;
    const expected = event.origin?.kind === 'repo.renamed'
      ? event.origin.repo === 'example/renamed' && event.origin.metadata?.canonicalName === 'new-owner/current'
      : event.origin?.kind === 'repo.unavailable' && event.origin.repo === 'example/missing';
    if (!expected) return finish(1, `unexpected mixed availability event: ${clip(JSON.stringify(event), 500)}`);
    mixedEvents.add(event.origin.kind);
    send({ id: msg.id, result: { accepted: true } });
  } else if (msg.id === 2) {
    if (msg.error) return finish(1, 'mixed feature grant failed');
    for (const [id, repo] of [[3, 'example/repo'], [4, 'example/renamed'], [5, 'example/missing']]) {
      send({ id, method: 'tools/call', params: { name: 'get_issue', arguments: { repo, number: 1 } } });
    }
  } else if ([3, 4, 5].includes(msg.id)) {
    const content = JSON.stringify(msg.result?.content);
    const valid = !msg.error && (msg.id === 5
      ? msg.result?.isError === true && /unavailable/.test(content)
      : !msg.result?.isError && /offline issue/.test(content));
    if (!valid) return finish(1, `mixed tool check failed: ${clip(JSON.stringify(msg), 500)}`);
    mixedTools.add(msg.id);
  }
  if (!mixedVerified && mixedEvents.size === 2 && mixedTools.size === 3) {
    mixedVerified = true;
    closeInput();
  }
}
let timer = setTimeout(() => finish(1, `no answer to initialize within ${ANSWER_MS / 1000} s`), ANSWER_MS);

function finish(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  const line = `ci-start-check/${scenario} (Node ${process.version}): ${message}`;
  if (code === 0) console.log(line);
  else {
    console.error(line);
    if (stderr.trim()) console.error(`server stderr:\n${stderr.trimEnd()}`);
  }
  process.exitCode = code;
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function onAnswer(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    finish(1, `the server wrote a line that isn't JSON: ${clip(line, 200)}`);
    return;
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    finish(1, `the server wrote a line that isn't a JSON-RPC message: ${clip(line, 200)}`);
    return;
  }
  if (answered && scenario === 'mixed') return mixedAnswer(msg);
  if (msg.id !== 1) return;
  const mcpl = msg.result?.capabilities?.experimental?.mcpl;
  if (msg.jsonrpc !== "2.0" || "error" in msg || mcpl === null || typeof mcpl !== "object") {
    finish(1, `initialize was answered without an MCPL result: ${clip(line, 300)}`);
    return;
  }
  answered = true;
  if (scenario === 'mixed') {
    clearTimeout(timer);
    timer = setTimeout(() => finish(1, 'mixed event/tool checks timed out'), ANSWER_MS);
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'featureSets/update', params: { effectiveCapabilities: ['tools', 'pushEvents'] } });
  } else closeInput();
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  let nl;
  while (!finished && (nl = stdout.indexOf("\n")) >= 0) {
    const line = stdout.slice(0, nl).trim();
    stdout = stdout.slice(nl + 1);
    if (line) onAnswer(line);
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => (stderr += chunk));
child.on("error", (err) => finish(1, `couldn't start the server: ${err.message}`));
child.on("close", (code, signal) => {
  if (finished) return;
  if (!answered) finish(1, `the server exited (${signal ?? `code ${code}`}) before answering initialize`);
  else if (code !== 0) finish(1, `the server exited (${signal ?? `code ${code}`}) after answering initialize, not with 0`);
  else if (scenario === 'mixed' && (!mixedVerified || !stderr.includes('repository renamed or transferred') || !stderr.includes('repository set aside'))) {
    finish(1, 'mixed startup did not diagnose both the renamed and missing repository');
  }
  else finish(0, scenario === 'mixed'
    ? 'built server initialized, delivered rename/unavailable events, served healthy and renamed reads, refused missing repo, and exited 0'
    : 'the built server answered initialize over --stdio and exited 0');
});

child.stdin.on("error", () => {});
child.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: { experimental: { mcpl: { version: "0.5" } } },
      clientInfo: { name: "ci-start-check", version: "0" },
    },
  }) + "\n",
);
