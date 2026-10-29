/**
 * The example recipes' wake policies, run through the host's own matcher.
 *
 * A wake policy set is ordered, first-match-wins, and `metadataTrue` is an
 * OR-list — three facts that make "obviously correct" orderings wrong in
 * ways only evaluation catches (review round 1: an `isOwnThread` wake placed
 * above the CI-success skip woke the agent on every green build of its own
 * pull request). So these tests do not re-implement the semantics: they load
 * `EventGate` from connectome's agent-framework and ask `probe()`, which is
 * the same matcher the host runs, side-effect-free and offline.
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { normalizeNotifiedReviewRequest } from '../src/normalize.js';
import { tagsFor } from '../src/tags.js';
import type { PolledIssue } from '../src/types.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

const recipe = (name: string): any =>
  JSON.parse(readFileSync(join(packageDir, 'examples', name), 'utf8'));

/** The host's event shape, as much of it as a wake policy can match on. */
interface GateEventInfo {
  content: string;
  eventType: string;
  serverId: string;
  channelId: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

interface GateDecision {
  trigger: boolean;
  policyName: string | null;
  behavior: unknown;
}

interface GateModule {
  EventGate: new (opts: Record<string, unknown>) => { probe(info: GateEventInfo): GateDecision };
  findShadowedPolicies(policies: unknown[]): unknown[];
  formatShadowWarning(warning: unknown): string;
}

/**
 * Where a sibling agent-framework checkout can be: beside this package in a
 * `repos/` tree, or — when this package is a linked git worktree, whose
 * parent directory holds nothing else — beside the checkout its `.git` file
 * points at.
 */
function gateModuleCandidates(): string[] {
  const seeds = [packageDir];
  const dotGit = join(packageDir, '.git');
  if (existsSync(dotGit) && statSync(dotGit).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    // …/<checkout>/.git/worktrees/<name> → …/<checkout>
    if (m) seeds.push(resolve(m[1].trim(), '..', '..', '..'));
  }

  const roots: string[] = [];
  for (const seed of seeds) {
    for (let dir = seed, i = 0; i < 6; i++, dir = dirname(dir)) {
      if (!roots.includes(dir)) roots.push(dir);
      if (dirname(dir) === dir) break;
    }
  }

  const out: string[] = [];
  const forced = process.env.GITHUB_MCPL_GATE_MODULE;
  if (forced) out.push(forced);
  for (const root of roots) {
    out.push(join(root, 'node_modules/@animalabs/agent-framework/dist/src/gate/event-gate.js'));
    out.push(join(root, 'agent-framework/dist/src/gate/event-gate.js'));
    out.push(join(root, 'repos/agent-framework/dist/src/gate/event-gate.js'));
  }
  return out;
}

const candidates = gateModuleCandidates();
const gatePath = candidates.find((p) => existsSync(p));

async function loadGate(): Promise<GateModule> {
  assert.ok(gatePath, skipReason);
  // A computed specifier on purpose: the path is outside the package, so it
  // must not become a compile-time module resolution.
  return (await import(gatePath as string)) as GateModule;
}

/** An EventGate over one recipe's wake config, with every host callback inert. */
async function gateFor(recipeName: string): Promise<{ probe(info: GateEventInfo): GateDecision }> {
  const { EventGate } = await loadGate();
  return new EventGate({
    // A fresh temp dir per gate: the constructor seeds gate.json there, and
    // nothing in this test may touch a real agent's config.
    configPath: join(mkdtempSync(join(tmpdir(), 'github-mcpl-gate-')), 'gate.json'),
    initialConfig: recipe(recipeName).modules.wake,
    emitTrace: () => {},
    addMessage: () => {},
    requestInference: () => {},
    getAgentNames: () => ['test'],
  });
}

const skipReason =
  `no agent-framework beside this checkout (${candidates.length} paths tried); ` +
  'run `npm install --no-save @animalabs/agent-framework`, or set GITHUB_MCPL_GATE_MODULE to the gate module, to run these';

const skip = !gatePath && !process.env.CI && skipReason;

// ─── the events, as tags.ts (.4) will produce them ──────────────────────────

const base = {
  eventType: 'mcpl:push-event',
  serverId: 'github',
  channelId: 'github:owner/repo#12',
};

/** A green build on the agent's own pull request. */
const ownThreadCiSuccess: GateEventInfo = {
  ...base,
  content: 'All checks have passed',
  tags: ['github:ci=success', 'chat:from-bot', 'chat:ambient'],
  metadata: { isOwnThread: true, isCiFailure: false, fromSelf: false, repo: 'owner/repo', number: 12 },
};

/** The same pull request, build broken. */
const ownThreadCiFailure: GateEventInfo = {
  ...base,
  content: 'build-and-test failed',
  tags: ['github:ci=failure', 'chat:from-bot', 'chat:ambient'],
  metadata: { isOwnThread: true, isCiFailure: true, fromSelf: false, repo: 'owner/repo', number: 12 },
};

/** Dependabot opens a pull request nobody asked the agent about. */
const botOpenedPull: GateEventInfo = {
  ...base,
  channelId: 'github:owner/repo#13',
  content: 'Bump left-pad from 1.0.0 to 1.0.1',
  tags: ['github:pr=opened', 'chat:from-bot', 'chat:ambient'],
  metadata: { isOwnThread: false, mentioned: false, fromSelf: false, repo: 'owner/repo', number: 13 },
};

/** A human opens a pull request. */
const humanOpenedPull: GateEventInfo = {
  ...base,
  channelId: 'github:owner/repo#14',
  content: 'fix(parser): accept an empty list',
  tags: ['github:pr=opened', 'chat:from-human', 'chat:ambient', 'github:actor=maintainer'],
  metadata: { isOwnThread: false, mentioned: false, isMaintainer: true, repo: 'owner/repo', number: 14 },
};

/** A human says the agent's name. */
const humanMention: GateEventInfo = {
  ...base,
  eventType: 'mcpl:channel-incoming',
  content: '@rayforce-clone can you look at the tsan failure?',
  tags: ['chat:mention', 'chat:from-human', 'github:actor=maintainer'],
  metadata: { mentioned: true, isOwnThread: false, fromSelf: false, repo: 'owner/repo', number: 12 },
};

/** The agent's own comment coming back round. */
const ownComment: GateEventInfo = {
  ...base,
  eventType: 'mcpl:channel-incoming',
  content: 'Fixed in 1a2b3c4.',
  tags: ['chat:from-self', 'chat:from-bot'],
  metadata: { fromSelf: true, isOwnThread: true, repo: 'owner/repo', number: 12 },
};

/** A push to a branch, no thread attached. */
const push: GateEventInfo = {
  ...base,
  channelId: 'github:owner/repo#0',
  content: '3 commits to dev',
  tags: ['github:push', 'chat:from-human', 'chat:ambient'],
  metadata: { isOwnThread: false, fromSelf: false, repo: 'owner/repo' },
};

/**
 * Contributor mode's notice that the poller stopped reading a thread, tagged
 * by tags.ts itself, on a thread the agent never spoke in: the case where a
 * missed mention is all the agent would otherwise lose.
 */
const readFailedNotice: GateEventInfo = (() => {
  const { tags, metadata } = tagsFor(
    {
      id: 'poll:read_failed:github:owner/repo#12:2026-10-15T00:10:00.000Z',
      receivedAt: '2026-10-15T00:10:00.000Z',
      repo: { owner: 'owner', name: 'repo' },
      kind: 'thread.read_failed',
      thread: { repo: { owner: 'owner', name: 'repo' }, number: 12, kind: 'issue' },
      actor: { login: 'github-mcpl[server]', isBot: true },
      html_url: 'https://github.com/owner/repo/issues/12',
      body: "github-mcpl stopped reading this thread's new activity: GitHub answered 404: Not Found, so the thread is gone or out of this token's reach.",
    },
    { botLogin: 'rayforce-clone', maintainers: [], isOwnThread: false },
  );
  return { ...base, eventType: 'mcpl:channel-incoming', content: 'github-mcpl stopped reading this thread', tags, metadata: { ...metadata } };
})();

// ─── what both recipes must do ───────────────────────────────────────────────

for (const name of ['recipe-maintainer-clone.json', 'recipe-contributor.json']) {
  test(`${name}: a green build on the agent's own thread does not wake it`, { skip }, async () => {
    const d = (await gateFor(name)).probe(ownThreadCiSuccess);
    assert.equal(d.trigger, false, `woke via ${d.policyName}`);
    assert.equal(d.policyName, 'github-machine-noise');
  });

  test(`${name}: a broken build on the agent's own thread wakes it`, { skip }, async () => {
    const d = (await gateFor(name)).probe(ownThreadCiFailure);
    assert.equal(d.trigger, true);
    assert.equal(d.policyName, 'github-ci-failure-own-thread');
  });

  test(`${name}: a bot's pull request neither wakes nor debounces`, { skip }, async () => {
    const d = (await gateFor(name)).probe(botOpenedPull);
    assert.equal(d.trigger, false);
    assert.equal(d.policyName, 'github-other-bots', 'a bot must be excluded before any wake or debounce rule');
    assert.equal(d.behavior, 'skip', 'skip, not a debounce that fires 60 s later');
  });

  test(`${name}: a human mention wakes it`, { skip }, async () => {
    const d = (await gateFor(name)).probe(humanMention);
    assert.equal(d.trigger, true);
    assert.equal(d.policyName, 'github-direct-address');
  });

  test(`${name}: its own comment does not wake it`, { skip }, async () => {
    const d = (await gateFor(name)).probe(ownComment);
    assert.equal(d.trigger, false);
    assert.equal(d.policyName, 'github-self');
  });

  test(`${name}: a push does not wake it`, { skip }, async () => {
    const d = (await gateFor(name)).probe(push);
    assert.equal(d.trigger, false);
    assert.equal(d.policyName, 'github-machine-noise');
  });

  test(`${name}: the server's notice that it stopped reading a thread wakes it, on a thread it never spoke in`, { skip }, async () => {
    const d = (await gateFor(name)).probe(readFailedNotice);
    assert.equal(d.trigger, true, `skipped via ${d.policyName}`);
    assert.equal(d.policyName, 'github-direct-address');
  });

  test(`${name}: no rule is unreachable`, { skip }, async () => {
    const { findShadowedPolicies, formatShadowWarning } = await loadGate();
    const warnings = findShadowedPolicies(recipe(name).modules.wake.policies);
    assert.deepEqual(warnings.map(formatShadowWarning), [], 'first match wins: an earlier rule eats a later one');
  });
}

test('recipe-contributor.json: a review request from contributor mode\'s notifications wakes it, on a pull request it never spoke in', { skip }, async () => {
  const row: PolledIssue = {
    id: 1200,
    number: 12,
    isPullRequest: true,
    title: 'Fix it',
    body: 'text',
    state: 'open',
    author: { login: 'human-one', isBot: false },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-15T00:09:30Z',
    html_url: 'https://github.com/owner/repo/pull/12',
  };
  const gate = await gateFor('recipe-contributor.json');
  // A bot's pull request too: the review is asked of the agent, whoever opened it.
  for (const author of [{ login: 'human-one', isBot: false }, { login: 'dependabot[bot]', isBot: true }]) {
    const event = normalizeNotifiedReviewRequest({ owner: 'owner', name: 'repo' }, { ...row, author }, { id: '9001', updatedAt: '2026-10-15T00:09:50Z' }, '2026-10-15T00:10:00.000Z');
    const { tags, metadata } = tagsFor(event, { botLogin: 'a-human', maintainers: [], isOwnThread: false });
    const d = gate.probe({ ...base, eventType: 'mcpl:channel-incoming', content: 'review requested', tags, metadata: { ...metadata } });
    assert.equal(d.trigger, true, `${author.login}: skipped via ${d.policyName}`);
    assert.equal(d.policyName, 'github-direct-address');
  }
});

// ─── where they differ ───────────────────────────────────────────────────────

test('recipe-maintainer-clone.json: a human opening a pull request debounces, it does not wake at once', { skip }, async () => {
  const d = (await gateFor('recipe-maintainer-clone.json')).probe(humanOpenedPull);
  assert.equal(d.policyName, 'github-new-work');
  assert.deepEqual(d.behavior, { debounce: 60000 });
  assert.equal(d.trigger, false, 'a debounce never triggers inline; it fires once the burst settles');
});

test('recipe-contributor.json: a human opening a pull request is ambient, the contributor does not triage', { skip }, async () => {
  const d = (await gateFor('recipe-contributor.json')).probe(humanOpenedPull);
  assert.equal(d.trigger, false);
  assert.equal(d.policyName, 'github-ambient');
});

test('recipe-contributor.json: a thread the agent took part in wakes it, issue or pull request', { skip }, async () => {
  const gate = await gateFor('recipe-contributor.json');
  for (const kind of ['issue', 'pull'] as const) {
    const d = gate.probe({
      ...base,
      eventType: 'mcpl:channel-incoming',
      content: 'and one more thing',
      tags: ['chat:reply', 'chat:from-human'],
      metadata: { isOwnThread: true, mentioned: false, fromSelf: false, kind, repo: 'owner/repo', number: 12 },
    });
    assert.equal(d.trigger, true, `${kind}: did not wake`);
    assert.equal(d.policyName, 'github-participated-threads');
  }
});
