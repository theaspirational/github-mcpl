import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RepoAvailability, REPO_RECHECK_MS, REPO_RETRY_MS, REPO_MAX_RETRY_MS } from '../src/repo-availability.js';
import { Poller, pollCursorKey } from '../src/poller.js';
import { GithubState } from '../src/state.js';
import { repoSlug, parseRepoSlug, type NormalizedEvent } from '../src/types.js';
import { FakeGitHubApi, harness, initialize, grant, pushes, until, callTool, textOf } from './harness.js';

const good = { owner: 'antra-tess', name: 'healthy' };
const bad = { owner: 'antra-tess', name: 'zulip_mcp' };
const renamed = 'anima-research/zulip_mcp';
const missing = () => Object.assign(new Error('sensitive response must not reach event'), { status: 404 });

function setup() {
  let answer: string | Error = missing();
  const events: NormalizedEvent[] = [];
  const warnings: unknown[] = [];
  const availability = new RepoAvailability([bad, good], async (repo) => {
    if (repo.name === good.name) return repoSlug(repo);
    if (answer instanceof Error) throw answer;
    return answer;
  }, async (event) => { events.push(event); }, {
    warn: (...args) => { warnings.push(args); }, info() {}, debug() {}, error() {},
  });
  return { availability, events, warnings, answer: (value: string | Error) => { answer = value; } };
}

test('renames and transfers stay available, notify once per canonical target, and case-only changes are silent', async () => {
  const r = setup();
  r.answer(renamed);
  await r.availability.initialize();
  assert.equal(r.availability.available(good), true);
  assert.equal(r.availability.available(bad), true);
  assert.equal(r.events.length, 1);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.events[0].kind, 'repo.renamed');
  assert.deepEqual(r.events[0].repo, bad);
  assert.equal(r.events[0].availability?.canonicalName, renamed);
  assert.match(r.events[0].body!, /antra-tess\/zulip_mcp resolves to anima-research\/zulip_mcp/);
  r.availability.assertAvailable(bad);
  assert.throws(() => r.availability.assertAvailable({ owner: 'anima-research', name: 'zulip_mcp' }), /not validated/);
  await r.availability.recheck();
  r.answer(renamed.toUpperCase());
  await r.availability.recheck();
  assert.equal(r.events.length, 1);
  r.answer('new-owner/new-name');
  await r.availability.recheck();
  assert.equal(r.events.length, 2);
  assert.equal(r.events[1].kind, 'repo.renamed');
  assert.equal(r.events[1].availability?.canonicalName, 'new-owner/new-name');
  r.answer(missing());
  await r.availability.recheck();
  assert.equal(r.availability.available(bad), false);
  assert.equal(r.events[2].kind, 'repo.unavailable');
  await r.availability.recheck();
  assert.equal(r.events.length, 3);
  r.answer('new-owner/new-name');
  await r.availability.recheck();
  assert.equal(r.availability.available(bad), true);
  assert.equal(r.events[3].kind, 'repo.available');
  await r.availability.recheck();
  assert.equal(r.events.length, 4, 'same rename is not repeated after an outage');
  r.answer(repoSlug(bad));
  await r.availability.recheck();
  assert.equal(r.events.length, 5, 'returning to the configured name is another canonical change');
  assert.equal(r.events[4].kind, 'repo.renamed');
  assert.equal(r.events[4].availability?.canonicalName, repoSlug(bad));
  assert.ok(!JSON.stringify(r.events).includes('sensitive'));
});

test('startup stays alive with all repositories unavailable, operations fail closed', async () => {
  for (const probe of [async () => { throw missing(); }, async () => { throw Object.assign(new Error('gone'), { status: 410 }); }]) {
    const availability = new RepoAvailability([bad], probe, async () => {});
    await availability.initialize();
    assert.equal(availability.available(bad), false);
    assert.throws(() => availability.assertAvailable(bad), /unavailable/);
  }
  for (const slug of ['bad', 'owner/name/extra', 'owner/with space', 'owner/repo?x', 'owner/..']) {
    assert.equal(parseRepoSlug(slug), null, slug);
  }
});

test('hourly rechecks recover even without a poller', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const r = setup();
  await r.availability.initialize();
  r.availability.start();
  r.answer(repoSlug(bad));
  t.mock.timers.tick(REPO_RECHECK_MS - 1);
  assert.equal(r.availability.available(bad), false);
  t.mock.timers.tick(1);
  await r.availability.stop();
  assert.equal(r.availability.available(bad), true);
  assert.equal(r.events.at(-1)?.kind, 'repo.available');
});

test('runtime outage isolates polling and preserves its cursor; recovery catches up', async () => {
  const r = setup();
  r.answer(repoSlug(bad));
  await r.availability.initialize();
  const api = new FakeGitHubApi();
  const original = api.listIssuesSince.bind(api);
  const state = GithubState.load(null);
  const before = '2026-11-16T00:00:00.000Z';
  state.setLastPollAt(before);
  api.seedIssue({ repo: good, number: 1, createdAt: '2026-11-16T00:00:01.000Z', updatedAt: '2026-11-16T00:00:01.000Z' });
  api.seedIssue({ repo: bad, number: 2, createdAt: '2026-11-16T00:00:01.000Z', updatedAt: '2026-11-16T00:00:01.000Z' });
  r.answer(missing());
  // First failing API request discovers the outage, not the hourly timer.
  api.listIssuesSince = async (repo, since) => {
    if (repo.name === bad.name) throw missing();
    return original(repo, since);
  };
  const poller = new Poller({ api: r.availability.guard(api), repos: [bad, good], state,
    repoAvailable: (repo) => r.availability.available(repo), intervalMs: 60000,
    now: () => new Date('2026-11-16T01:00:00Z'), onEvent: async () => {},
  });
  const first = await poller.pollOnce();
  assert.equal(first.failed, 1);
  assert.equal(first.delivered.length, 1);
  assert.deepEqual(first.delivered[0].repo, good);
  assert.equal(state.pollCursors()[pollCursorKey(bad, 'issues')].since, before);
  assert.equal(state.pollCursors()[pollCursorKey(good, 'issues')].since, '2026-11-16T01:00:00.000Z');
  assert.equal(r.events.length, 1);
  assert.equal((await poller.pollOnce()).failed, 0, 'disabled repos are skipped, not repeatedly requested');
  assert.equal(r.events.length, 1);
  await assert.rejects(r.availability.guard(api).createIssue(bad, { title: 'no', body: '' }), /unavailable.*404/);
  assert.equal(api.callsTo('createIssue').length, 0);
  r.answer(repoSlug(bad));
  api.listIssuesSince = original;
  await r.availability.recheck();
  assert.equal((await poller.pollOnce()).delivered[0].repo.name, bad.name);
});

test('missing issue / denied write does not disable a healthy repository', async () => {
  const r = setup();
  await r.availability.initialize();
  const api = new FakeGitHubApi();
  api.getIssue = async () => { throw missing(); };
  await assert.rejects(r.availability.guard(api).getIssue({ repo: good, number: 99, kind: 'issue' }), /sensitive/);
  assert.equal(r.availability.available(good), true);
  assert.equal(r.events.length, 1);
});

test('startup warning waits for grant, goes through push without a channel, and tools refuse it', async (t) => {
  const r = setup();
  const h = harness({ repos: [bad, good],
    assertRepoAvailable: (repo) => r.availability.assertAvailable(repo),
    repoAvailable: (repo) => r.availability.available(repo),
  });
  t.after(() => h.close());
  await r.availability.initialize();
  await h.server.onEvent(r.events[0]);
  assert.equal(pushes(h).length, 0);
  await initialize(h, true);
  await grant(h, ['tools', 'pushEvents']);
  await until(() => pushes(h).length === 1, 'startup warning');
  const push = pushes(h)[0];
  assert.equal(push.featureSet, 'github.events');
  assert.ok(push.tags?.includes('github:repo=unavailable'));
  assert.match(JSON.stringify(push.origin), /antra-tess\/zulip_mcp/);
  assert.equal(h.hostSaw.some((req) => req.method === 'channels/register'), false);
  await grant(h, ['tools', 'pushEvents']);
  assert.equal(pushes(h).length, 1);
  const result = await callTool(h, 'get_issue', { repo: repoSlug(bad), number: 1 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /unavailable.*404/);
  assert.equal(h.api.callsTo('getIssue').length, 0);
  r.answer(repoSlug(bad));
  await r.availability.recheck();
  await h.server.onEvent(r.events.at(-1)!);
  assert.equal(pushes(h).length, 2);
  assert.ok(pushes(h)[1].tags?.includes('github:repo=available'));
});

test('search and GraphQL preflights accept the configured entry resolving to a renamed target', async () => {
  const r = setup();
  r.answer(repoSlug(bad));
  await r.availability.initialize();
  const api = new FakeGitHubApi();
  r.answer(renamed);
  await r.availability.guard(api).searchIssues(bad, 'test');
  await r.availability.guard(api).listReviewThreads({ repo: bad, number: 1, kind: 'pull' });
  assert.equal(api.callsTo('searchIssues').length, 1);
  assert.equal(api.callsTo('listReviewThreads').length, 1);
  assert.equal(r.availability.available(bad), true);
  assert.deepEqual(r.events.map((e) => e.kind), ['repo.renamed']);
});

test('access revoked, deleted and changed definitive reasons are distinct, stable states', async () => {
  const r = setup();
  r.answer(repoSlug(bad));
  await r.availability.initialize();
  for (const [i, status] of [403, 404, 410].entries()) {
    r.answer(Object.assign(new Error('do not forward'), { status }));
    await r.availability.recheck();
    await r.availability.recheck();
    assert.equal(r.events.length, i + 1);
    assert.match(r.events[i].body!, new RegExp(String(status)));
  }
});

test('all repositories lost at runtime stay closed while checks can recover them', async () => {
  let available = true;
  const events: NormalizedEvent[] = [];
  const availability = new RepoAvailability([good], async (repo) => {
    if (!available) throw missing();
    return repoSlug(repo);
  }, async (event) => { events.push(event); });
  await availability.initialize();
  available = false;
  await availability.recheck();
  assert.throws(() => availability.assertAvailable(good), /unavailable/);
  available = true;
  await availability.recheck();
  availability.assertAvailable(good);
  assert.deepEqual(events.map((e) => e.kind), ['repo.unavailable', 'repo.available']);
});

test('pending outage coalesces to recovery while push is not granted', async (t) => {
  const r = setup();
  const h = harness({ repos: [bad, good] });
  t.after(() => h.close());
  await initialize(h, true);
  await grant(h, ['tools']);
  await r.availability.initialize();
  await h.server.onEvent(r.events[0]);
  r.answer(repoSlug(bad));
  await r.availability.recheck();
  await h.server.onEvent(r.events[1]);
  assert.equal(pushes(h).length, 0);
  await grant(h, ['tools', 'pushEvents']);
  await until(() => pushes(h).length === 1, 'latest state');
  assert.ok(pushes(h)[0].tags?.includes('github:repo=available'));
});

test('canonical spelling and availability lookup are case insensitive', async () => {
  const events: NormalizedEvent[] = [];
  const a = new RepoAvailability([good], async () => 'Antra-Tess/Healthy', async (e) => { events.push(e); });
  await a.initialize();
  a.assertAvailable(good);
  a.assertAvailable({ owner: 'ANTRA-TESS', name: 'HEALTHY' });
  assert.deepEqual(events, []);
});

for (const failure of [new Error('network'), ...[301, 401, 429, 500, 503].map((status) => Object.assign(new Error('secret'), { status })),
  Object.assign(new Error('rate limit'), { status: 403, rateLimited: true })]) {
  test(`transient ${failure.message}/${'status' in failure ? failure.status : 0} preserves last confirmed state without events`, async () => {
    const r = setup();
    r.answer(repoSlug(bad));
    await r.availability.initialize();
    r.answer(failure);
    const api = new FakeGitHubApi();
    api.seedIssue({ repo: bad, number: 1 });
    const guarded = r.availability.guard(api);
    await assert.rejects(guarded.searchIssues(bad, 'test'), /temporarily failed/);
    assert.equal(api.callsTo('searchIssues').length, 0);
    assert.equal(r.availability.available(bad), true);
    // A transient validation failure does not quarantine a working REST entry.
    await guarded.getIssue({ repo: bad, number: 1, kind: 'issue' });
    assert.equal(api.callsTo('getIssue').length, 1);
    assert.equal(r.events.length, 0);
    r.answer(repoSlug(bad));
    await r.availability.recheck();
    await guarded.searchIssues(bad, 'test');
    assert.equal(r.events.length, 0);
    // Nor does a transient error clear an already confirmed outage.
    r.answer(missing());
    await r.availability.recheck();
    r.answer(failure);
    await r.availability.recheck();
    assert.equal(r.availability.available(bad), false);
    assert.equal(r.events.length, 1);
    assert.match(r.events[0].body!, /404/);
  });
}

test('transient startup stays unknown, retries promptly with capped backoff, then enables silently', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let failing = true;
  let probes = 0;
  const events: NormalizedEvent[] = [];
  const a = new RepoAvailability([good], async () => {
    probes++;
    if (failing) throw new Error('network');
    return repoSlug(good);
  }, async (e) => { events.push(e); });
  await a.initialize();
  a.start();
  assert.equal(a.available(good), false);
  assert.throws(() => a.assertAvailable(good), /not validated/);
  assert.deepEqual(events, []);
  for (const delay of [REPO_RETRY_MS, 10_000, 20_000, 40_000, REPO_MAX_RETRY_MS, REPO_MAX_RETRY_MS]) {
    const before = probes;
    t.mock.timers.tick(delay - 1);
    await a.stop();
    assert.equal(probes, before, 'no early retry');
    a.start();
    // Timer ticks at 5 s granularity, at most 5 s after the due time.
    t.mock.timers.tick(REPO_RETRY_MS);
    await a.stop();
    assert.equal(probes, before + 1);
    a.start();
  }
  failing = false;
  t.mock.timers.tick(REPO_MAX_RETRY_MS);
  await a.stop();
  assert.equal(a.available(good), true);
  assert.deepEqual(events, []);
});

test('single unavailable repo delivers its startup event and recovers on the independent timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let missingRepo = true;
  const a = new RepoAvailability([bad], async () => {
    if (missingRepo) throw missing();
    return repoSlug(bad);
  }, async (e) => h.server.onEvent(e));
  const h = harness({ repos: [bad], assertRepoAvailable: (repo) => a.assertAvailable(repo), repoAvailable: (repo) => a.available(repo) });
  t.after(() => h.close());
  await a.initialize();
  a.start();
  await initialize(h, true);
  await grant(h, ['tools', 'pushEvents']);
  await until(() => pushes(h).length === 1, 'single repo startup event');
  assert.ok(pushes(h)[0].tags?.includes('github:repo=unavailable'));
  assert.equal((await callTool(h, 'get_issue', { number: 1 })).isError, true);
  assert.equal(h.api.callsTo('getIssue').length, 0);
  missingRepo = false;
  t.mock.timers.tick(REPO_RECHECK_MS);
  await a.stop();
  assert.equal(a.available(bad), true);
  await until(() => pushes(h).length === 2, 'single repo recovery event');
  assert.ok(pushes(h)[1].tags?.includes('github:repo=available'));
  h.api.seedIssue({ repo: bad, number: 1 });
  assert.notEqual((await callTool(h, 'get_issue', { number: 1 })).isError, true);
});

test('cached channel opens by id and address refuse an unavailable repository', async (t) => {
  const r = setup();
  r.answer(repoSlug(bad));
  await r.availability.initialize();
  const h = harness({ repos: [bad], assertRepoAvailable: (repo) => r.availability.assertAvailable(repo) });
  t.after(() => h.close());
  h.api.seedIssue({ repo: bad, number: 1 });
  await initialize(h, true);
  await grant(h);
  const address = { ...bad, number: 1, kind: 'issue' };
  const opened = await h.host.sendRequest('channels/open', { address }) as { channel: { id: string } };
  r.answer(missing());
  await r.availability.recheck();
  for (const args of [{ channelId: opened.channel.id }, { address }]) {
    await assert.rejects(h.host.sendRequest('channels/open', args), /unavailable/);
  }
  r.answer(repoSlug(bad));
  await r.availability.recheck();
  await h.host.sendRequest('channels/open', { channelId: opened.channel.id });
});

test('operation-triggered validation also honors transient backoff and coalesces retries', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let probes = 0;
  let transient = false;
  const a = new RepoAvailability([good], async () => {
    probes++;
    if (transient) throw Object.assign(new Error('network'), { status: 503 });
    return repoSlug(good);
  }, async () => { assert.fail('transient failures must not emit events'); });
  await a.initialize();
  transient = true;
  const api = a.guard(new FakeGitHubApi());
  await assert.rejects(api.searchIssues(good, 'test'), /temporarily failed/);
  assert.equal(probes, 2);
  await assert.rejects(api.searchIssues(good, 'test'), /temporarily failed/);
  assert.equal(probes, 2, 'repeated calls must not defeat backoff');
  t.mock.timers.tick(REPO_RETRY_MS);
  transient = false;
  await Promise.all([api.searchIssues(good, 'test'), api.searchIssues(good, 'test')]);
  assert.equal(probes, 3, 'concurrent retry preflights coalesce');
});

test('rename notice waits for grant, names both owners, and tools keep working through the configured entry', async (t) => {
  const r = setup();
  r.answer(renamed);
  const h = harness({ repos: [bad], assertRepoAvailable: (repo) => r.availability.assertAvailable(repo) });
  t.after(() => h.close());
  h.api.seedIssue({ repo: bad, number: 1 });
  await r.availability.initialize();
  await h.server.onEvent(r.events[0]);
  assert.equal(pushes(h).length, 0);
  await initialize(h, true);
  await grant(h, ['tools', 'pushEvents']);
  await until(() => pushes(h).length === 1, 'rename notice');
  const push = pushes(h)[0];
  assert.ok(push.tags?.includes('github:repo=renamed'));
  assert.match(JSON.stringify(push.origin), /antra-tess\/zulip_mcp/);
  assert.match(JSON.stringify(push.origin), /anima-research\/zulip_mcp/);
  assert.match(JSON.stringify(push.origin), /"repoUnavailable":false/);
  assert.equal(h.hostSaw.some((req) => req.method === 'channels/register'), false);
  assert.notEqual((await callTool(h, 'get_issue', { number: 1 })).isError, true);
  await r.availability.recheck();
  await grant(h, ['tools', 'pushEvents']);
  assert.equal(r.events.length, 1);
  assert.equal(pushes(h).length, 1);
});

test('pending rename notices coalesce separately from availability recovery', async (t) => {
  const r = setup();
  const h = harness({ repos: [bad] });
  t.after(() => h.close());
  await initialize(h, true);
  await grant(h, ['tools']);
  await r.availability.initialize();
  await h.server.onEvent(r.events[0]); // unavailable
  r.answer(renamed);
  await r.availability.recheck();
  for (const event of r.events.slice(1)) await h.server.onEvent(event); // recovered + renamed
  r.answer('third-owner/latest');
  await r.availability.recheck();
  await h.server.onEvent(r.events.at(-1)!);
  await grant(h, ['tools', 'pushEvents']);
  await until(() => pushes(h).length === 2, 'recovery and latest rename');
  assert.ok(pushes(h).some((p) => p.tags?.includes('github:repo=available')));
  const notice = pushes(h).find((p) => p.tags?.includes('github:repo=renamed'))!;
  assert.match(JSON.stringify(notice.origin), /third-owner\/latest/);
  assert.doesNotMatch(JSON.stringify(notice.origin), /anima-research\/zulip_mcp/);
});

for (const operation of ['resolveInstallationId', 'mintInstallationToken']) {
  test(`shared ${operation} denial is sanitized, coalesced and recovers without repo blame`, async () => {
    let failed = true;
    const events: NormalizedEvent[] = [];
    const warnings: unknown[] = [];
    const a = new RepoAvailability([bad, good], async repo => {
      if (failed) throw Object.assign(new Error('secret response ghp_sensitive'), { status: 404, operation });
      return repoSlug(repo);
    }, async event => { events.push(event); }, {
      warn: (...args) => { warnings.push(args); }, info() {}, debug() {}, error() {},
    });
    await a.initialize();
    await a.recheck();
    assert.deepEqual(events.map(e => e.kind), ['installation.unavailable']);
    assert.equal(warnings.length, 1);
    assert.match(JSON.stringify(warnings), /404/);
    assert.match(JSON.stringify(warnings), /GITHUB_APP_INSTALLATION_ID/);
    assert.equal(events[0].installation?.operation, operation);
    assert.ok(!JSON.stringify([events, warnings]).includes('sensitive'));
    assert.equal(a.available(good), false);
    failed = false;
    await a.recheck();
    await a.recheck();
    assert.deepEqual(events.map(e => e.kind), ['installation.unavailable', 'installation.available']);
    assert.equal(a.available(good), true);
    failed = true;
    await a.recheck();
    assert.equal(a.available(good), true, 'shared failure preserves last confirmed repo state');
    assert.equal(events.at(-1)?.kind, 'installation.unavailable');
  });
}

test('shared installation diagnostic reaches the agent after grant and recovers', async (t) => {
  const h = harness({ repos: [bad, good], repoAvailable: () => false });
  t.after(() => h.close());
  let failed = true;
  const a = new RepoAvailability([bad, good], async repo => {
    if (failed) throw Object.assign(new Error('secret'), { status: 404, operation: 'mintInstallationToken' });
    return repoSlug(repo);
  }, h.server.onEvent);
  await a.initialize();
  await initialize(h, true);
  assert.equal(pushes(h).length, 0);
  await grant(h, ['tools', 'pushEvents']);
  await until(() => pushes(h).length === 1, 'installation warning');
  assert.ok(pushes(h)[0].tags?.includes('github:installation=unavailable'));
  assert.ok(JSON.stringify(pushes(h)[0]).includes('GitHub connector'));
  failed = false;
  await a.recheck();
  await until(() => pushes(h).length === 2, 'installation recovery');
  assert.ok(pushes(h)[1].tags?.includes('github:installation=available'));
});

for (const transient of [
  { status: 0, rateLimited: false },
  { status: 503, rateLimited: false },
  { status: 429, rateLimited: true },
  { status: 403, rateLimited: true },
]) {
  test(`discovery classification uses every outcome, not the representative 404 (${JSON.stringify(transient)})`, async () => {
    const events: NormalizedEvent[] = [];
    const denied = { repo: bad, status: 404, rateLimited: false };
    let outcomes = [denied, { repo: good, ...transient }];
    const a = new RepoAvailability([bad, good], async () => {
      throw Object.assign(new Error('discovery failed'), {
        status: 404, operation: 'resolveInstallationId', installationDiscovery: outcomes,
      });
    }, async event => { events.push(event); });
    await a.initialize();
    outcomes.reverse();
    await a.recheck();
    assert.equal(events.length, 0);
    outcomes = [];
    await a.recheck();
    assert.equal(events.length, 0, 'an empty sweep is not definitive denial');
    outcomes = [denied, { repo: good, status: 403, rateLimited: false }];
    await a.recheck();
    await a.recheck();
    assert.deepEqual(events.map(event => event.kind), ['installation.unavailable']);
    outcomes = [denied, { repo: good, ...transient }];
    await a.recheck();
    assert.deepEqual(events.map(event => event.kind), ['installation.unavailable'], 'inconclusive is not recovery');
  });
}
