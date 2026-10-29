/**
 * github.read, and the feature-set declarations (TASK-SRHKG.1.6).
 *
 * Everything runs against FakeGitHubApi: no network, no octokit, no process
 * ever leaves the test. The declarations are asserted here rather than in a
 * file of their own because .6's test write scope is these three files.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TagBehavior, TreatmentRule } from '@animalabs/mcpl-core';
import { buildFeatureSets, buildServerCapabilities, GITHUB_TAG_ONTOLOGY } from '../src/feature-sets.js';
import { issuesToolModule, prToolModule } from '../src/tools-issues-pr.js';
import { readToolModule } from '../src/tools-read.js';
import { reviewToolModule } from '../src/tools-review.js';
import {
  COMMENTS_FEATURE_SET,
  EVENTS_FEATURE_SET,
  FEATURE_SETS,
  GITHUB_TAGS,
  ISSUES_FEATURE_SET,
  LIMITS,
  PR_FEATURE_SET,
  READ_FEATURE_SET,
  REVIEW_FEATURE_SET,
  ROLLBACK_CAPABLE,
  TOOLS_BY_FEATURE_SET,
  featureSetForTool,
  silentLogger,
  type Issue,
  type PullRequestFile,
  type RepoRef,
  type StateStore,
  type ThreadRef,
  type ToolContext,
  type ToolModule,
  type ToolResult,
} from '../src/types.js';
import { FakeGitHubApi, TEST_BOT, TEST_REPO } from './harness.js';

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers (.6 does not edit test/harness.ts)
// ─────────────────────────────────────────────────────────────────────────────

const OTHER_REPO: RepoRef = { owner: 'someone-else', name: 'not-ours' };

function ctx(api: FakeGitHubApi, over: Partial<ToolContext> = {}): ToolContext {
  return {
    api,
    // github.read, .issues, .pr and .review never touch the checkpoint store
    // (.7's comment tools do), so the seam is left unimplemented on purpose: a
    // tool that reached for it would throw here instead of silently passing.
    state: undefined as unknown as StateStore,
    botLogin: TEST_BOT.login,
    repos: [TEST_REPO],
    prBaseAllow: ['dev'],
    logger: silentLogger(),
    ...over,
  };
}

/** The text of a tool result, asserting it is one text block. */
function text(result: ToolResult): string {
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.equal(block.type, 'text');
  return (block as { type: 'text'; text: string }).text;
}

function ok(result: ToolResult): string {
  assert.equal(result.isError, undefined, `expected success, got: ${text(result)}`);
  return text(result);
}

function failure(result: ToolResult): string {
  assert.equal(result.isError, true, `expected an error result, got: ${text(result)}`);
  return text(result);
}

const ISSUE: ThreadRef = { repo: TEST_REPO, number: 7, kind: 'issue' };
const PULL: ThreadRef = { repo: TEST_REPO, number: 8, kind: 'pull' };

// ─────────────────────────────────────────────────────────────────────────────
// Feature sets
// ─────────────────────────────────────────────────────────────────────────────

test('six feature sets are declared, with the contract’s rollback flags', () => {
  const declared = buildFeatureSets();
  assert.deepEqual(Object.keys(declared).sort(), [...FEATURE_SETS].sort());
  assert.equal(Object.keys(declared).length, 6);

  for (const [name, declaration] of Object.entries(declared)) {
    assert.ok(declaration.description.length > 0, `${name} needs a description`);
    assert.ok(declaration.uses.length > 0, `${name} needs at least one capability path`);
    assert.equal(declaration.rollback, ROLLBACK_CAPABLE.includes(name), `${name} rollback flag`);
  }
  // Only github.comments can undo what it did (§8.1).
  assert.equal(declared[COMMENTS_FEATURE_SET].rollback, true);
  for (const name of [EVENTS_FEATURE_SET, READ_FEATURE_SET, REVIEW_FEATURE_SET, ISSUES_FEATURE_SET, PR_FEATURE_SET]) {
    assert.equal(declared[name].rollback, false, `${name} is not rollback-capable`);
  }
});

test('uses names only the paths a call site needs', () => {
  const declared = buildFeatureSets();
  // `pushEvents` alone, and deliberately: §6.4 derives the whole set from
  // `uses`, so naming the channel paths here made a push-only host — which
  // the Contract names explicitly — lose its events entirely (WP9 review,
  // finding 4). The channel surfaces are checked at their own call sites.
  assert.deepEqual(declared[EVENTS_FEATURE_SET].uses, ['pushEvents']);
  // channels/publish writes a comment, which is what github.comments authorizes.
  assert.deepEqual(declared[COMMENTS_FEATURE_SET].uses, ['tools', 'channels.publish']);
  for (const name of [READ_FEATURE_SET, REVIEW_FEATURE_SET, ISSUES_FEATURE_SET, PR_FEATURE_SET]) {
    assert.deepEqual(declared[name].uses, ['tools'], `${name} only needs tools`);
  }
  // github.events has no tools (the contract), so it must not claim the path.
  assert.ok(!declared[EVENTS_FEATURE_SET].uses.includes('tools'));
});

test('the tag ontology rides on github.events and covers every github: tag', () => {
  const declared = buildFeatureSets();
  assert.equal(declared[EVENTS_FEATURE_SET].tagOntology, GITHUB_TAG_ONTOLOGY);
  for (const name of FEATURE_SETS.filter((n) => n !== EVENTS_FEATURE_SET)) {
    assert.equal(declared[name].tagOntology, undefined, `${name} carries no events`);
  }

  const ontology = GITHUB_TAG_ONTOLOGY;
  for (const tag of GITHUB_TAGS) {
    const eq = tag.indexOf('=');
    if (eq < 0) {
      assert.ok(ontology.tags?.[tag], `${tag} is undeclared`);
      assert.ok(ontology.tags?.[tag].desc, `${tag} has no description`);
    } else {
      const family = tag.slice(0, eq);
      const value = tag.slice(eq + 1);
      assert.ok(ontology.keyed?.[family], `${family} is undeclared`);
      assert.ok(ontology.keyed?.[family].desc, `${family} has no description`);
      assert.ok(ontology.keyed?.[family].values?.includes(value), `${tag} is not among ${family}'s values`);
    }
  }
  // Open-world (RFC-001 §5): a host must tolerate a tag it has not seen.
  assert.equal(ontology.open, true);
});

test('the manifest advertises what the declarations use', () => {
  const manifest = buildServerCapabilities();
  assert.equal(manifest.version, '0.5');
  assert.equal(manifest.pushEvents, true);
  assert.deepEqual(manifest.channels, {
    register: true,
    lifecycle: true,
    publish: true,
    incoming: true,
    typing: true,
  });
  assert.deepEqual(Object.keys(manifest.featureSets as Record<string, unknown>).sort(), [...FEATURE_SETS].sort());
});

test('every tool belongs to exactly one feature set', () => {
  const modules: ToolModule[] = [readToolModule, issuesToolModule, prToolModule, reviewToolModule];
  const owner = new Map<string, string>();
  for (const module of modules) {
    for (const tool of module.tools) {
      assert.equal(owner.get(tool.name), undefined, `${tool.name} is in two modules`);
      owner.set(tool.name, module.featureSet);
      // types.ts is the single answer to who owns a tool; a module may not disagree.
      assert.equal(featureSetForTool(tool.name), module.featureSet, `${tool.name} ownership`);
      assert.ok(
        TOOLS_BY_FEATURE_SET[module.featureSet as keyof typeof TOOLS_BY_FEATURE_SET].includes(tool.name),
        `${tool.name} is not in TOOLS_BY_FEATURE_SET[${module.featureSet}]`,
      );
      assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema.type, 'object');
    }
    // A module implements its feature set's tools and no others.
    assert.deepEqual(
      module.tools.map((t) => t.name).sort(),
      [...TOOLS_BY_FEATURE_SET[module.featureSet as keyof typeof TOOLS_BY_FEATURE_SET]].sort(),
      `${module.featureSet} tool list`,
    );
  }
  // Everything except the comment tools (.7) is implemented here.
  const unimplemented = Object.values(TOOLS_BY_FEATURE_SET)
    .flat()
    .filter((name) => !owner.has(name));
  assert.deepEqual(unimplemented.sort(), [...TOOLS_BY_FEATURE_SET[COMMENTS_FEATURE_SET]].sort());
});

test('every read tool takes an optional repo and declares its required arguments', () => {
  for (const tool of readToolModule.tools) {
    assert.ok(tool.inputSchema.properties.repo, `${tool.name} must accept repo`);
    assert.ok(!(tool.inputSchema.required ?? []).includes('repo'), `${tool.name} must default repo`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// github.read happy paths
// ─────────────────────────────────────────────────────────────────────────────

test('get_issue reads an issue and defaults the repository', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7, title: 'Flaky test', body: 'it fails on CI', labels: ['bug'] });

  const out = ok(await readToolModule.call('get_issue', { number: 7 }, ctx(api)));
  assert.match(out, /issue anima-research\/rayforce#7 \[open\] Flaky test/);
  assert.match(out, /labels: bug/);
  assert.match(out, /it fails on CI/);
  // No repo argument: the single allowed repository is what reached the API.
  assert.deepEqual(api.callsTo('getIssue')[0].args, [ISSUE]);
});

test('with several repositories, a read has to name one', async () => {
  const api = new FakeGitHubApi();
  const second = { owner: TEST_REPO.owner, name: 'chronicle' };
  api.seedIssue({ number: 7, title: 'In rayforce' });
  api.seedIssue({ repo: second, number: 7, title: 'In chronicle' });
  const two = ctx(api, { repos: [TEST_REPO, second] });

  assert.match(failure(await readToolModule.call('get_issue', { number: 7 }, two)), /"repo" is required: GITHUB_REPOS names several/);
  assert.match(failure(await readToolModule.call('get_issue', { thread: '#7' }, two)), /name the repository as owner\/name#7/);
  assert.match(ok(await readToolModule.call('get_issue', { repo: 'anima-research/chronicle', number: 7 }, two)), /In chronicle/);
  assert.match(ok(await readToolModule.call('get_issue', { thread: 'anima-research/rayforce#7' }, two)), /In rayforce/);
});

test('get_pull_request reports refs, mergeability and checks', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({
    number: 8,
    title: 'Fix the flake',
    head: { ref: 'fix-flake', sha: 'a'.repeat(40) },
    base: { ref: 'dev', sha: 'b'.repeat(40) },
    checksSummary: { sha: 'a'.repeat(40), conclusion: 'failure', total: 3, failed: [{ name: 'build', url: 'https://ci/1' }] },
    requestedReviewers: ['human-two'],
  });

  const out = ok(await readToolModule.call('get_pull_request', { number: 8 }, ctx(api)));
  assert.match(out, /pull anima-research\/rayforce#8 \[open\] Fix the flake/);
  assert.match(out, /fix-flake \(a{40}\) → dev/);
  assert.match(out, /mergeable: true/);
  assert.match(out, /reviewers requested: human-two/);
  assert.match(out, /failure \(3 runs, 1 failed\)/);
  assert.match(out, /failed: build https:\/\/ci\/1/);
});

test('list_comments passes since through and renders ids and authors', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7 });
  api.seedComment(ISSUE, { id: 1001, body: 'first', author: { login: 'human-one', isBot: false } });
  api.seedComment(ISSUE, { id: 1002, body: 'second', updatedAt: '2026-10-05T00:00:00.000Z' });

  const all = ok(await readToolModule.call('list_comments', { number: 7 }, ctx(api)));
  assert.match(all, /2 comments on anima-research\/rayforce#7/);
  assert.match(all, /id 1001 by human-one/);

  const since = ok(
    await readToolModule.call('list_comments', { number: 7, since: '2026-10-02T00:00:00.000Z' }, ctx(api)),
  );
  assert.match(since, /1 comment on/);
  assert.match(since, /id 1002/);
  assert.deepEqual(api.callsTo('listComments')[1].args, [ISSUE, '2026-10-02T00:00:00.000Z']);
});

test('list_comments on a pull request asks with kind pull', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8 });
  ok(await readToolModule.call('list_comments', { number: 8, kind: 'pull' }, ctx(api)));
  assert.deepEqual(api.callsTo('listComments')[0].args, [PULL, undefined]);
});

test('list_comments refuses a kind outside issue | pull', async () => {
  const api = new FakeGitHubApi();
  const out = failure(await readToolModule.call('list_comments', { number: 8, kind: 'discussion' }, ctx(api)));
  assert.match(out, /"kind" must be one of issue \| pull/);
  assert.equal(api.calls.length, 0);
});

test('list_review_threads renders path, line, side and resolution', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8 });
  api.seedReviewThread(PULL, { id: 'RT_1', path: 'src/lib.rs', line: 42, side: 'RIGHT', isResolved: false });
  api.seedReviewThread(PULL, { id: 'RT_2', path: 'src/old.rs', line: 3, side: 'LEFT', isResolved: true });

  const out = ok(await readToolModule.call('list_review_threads', { number: 8 }, ctx(api)));
  assert.match(out, /2 review threads on anima-research\/rayforce#8/);
  assert.match(out, /RT_1 src\/lib\.rs:42 RIGHT unresolved/);
  assert.match(out, /RT_2 src\/old\.rs:3 LEFT resolved/);
});

test('list_pull_request_files renders names and stats only', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8 });
  api.seedFiles(PULL, [
    { filename: 'src/lib.rs', status: 'modified', additions: 10, deletions: 2, changes: 12 },
    { filename: 'docs/old.md', status: 'removed', additions: 0, deletions: 40, changes: 40 },
  ]);

  const out = ok(await readToolModule.call('list_pull_request_files', { number: 8 }, ctx(api)));
  assert.match(out, /2 changed files on anima-research\/rayforce#8/);
  assert.match(out, /modified src\/lib\.rs \+10 -2/);
  assert.match(out, /removed docs\/old\.md \+0 -40/);
});

test('get_check_runs reads by sha', async () => {
  const api = new FakeGitHubApi();
  api.seedCheckRuns(TEST_REPO, { sha: 'c'.repeat(40), conclusion: 'success', total: 4, failed: [] });

  const out = ok(await readToolModule.call('get_check_runs', { sha: 'c'.repeat(40) }, ctx(api)));
  assert.match(out, /checks for c{40}: success \(4 runs, 0 failed\)/);
  assert.deepEqual(api.callsTo('getCheckRuns')[0].args, [TEST_REPO, 'c'.repeat(40)]);
});

test('get_check_runs reports a pending summary as pending', async () => {
  const api = new FakeGitHubApi();
  const out = ok(await readToolModule.call('get_check_runs', { sha: 'd'.repeat(40) }, ctx(api)));
  assert.match(out, /pending \(0 runs, 0 failed\)/);
});

test('search_issues bounds the limit to the rendered list bound', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7, title: 'flaky test' });
  api.seedPullRequest({ number: 8, title: 'fix flaky test' });

  const out = ok(await readToolModule.call('search_issues', { query: 'flaky' }, ctx(api)));
  assert.match(out, /2 matches in anima-research\/rayforce for "flaky"/);
  assert.match(out, /issue #7 \[open\] flaky test/);
  assert.match(out, /pull #8 \[open\] fix flaky test/);
  assert.deepEqual(api.callsTo('searchIssues')[0].args, [TEST_REPO, 'flaky', LIMITS.listEntries]);

  api.clearCalls();
  ok(await readToolModule.call('search_issues', { query: 'flaky', limit: 500 }, ctx(api)));
  assert.deepEqual(api.callsTo('searchIssues')[0].args, [TEST_REPO, 'flaky', LIMITS.listEntries]);
});

test('search_issues says how many results from other repositories it left out', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7, title: 'flaky test' });
  api.searchOutside = 2;
  const out = ok(await readToolModule.call('search_issues', { query: 'flaky' }, ctx(api)));
  assert.match(out, /1 match in anima-research\/rayforce for "flaky"/);
  assert.match(out, /2 results on this page from other repositories left out: a search stays inside anima-research\/rayforce/);
  api.seedIssue({ number: 8, title: 'other' });
  const none = ok(await readToolModule.call('search_issues', { query: 'nothing here' }, ctx(api)));
  assert.match(none, /no matches in anima-research\/rayforce for "nothing here"\n2 results on this page from other repositories left out/);
});

test('search_issues says so when nothing matches', async () => {
  const api = new FakeGitHubApi();
  const out = ok(await readToolModule.call('search_issues', { query: 'nothing' }, ctx(api)));
  assert.match(out, /no matches in anima-research\/rayforce for "nothing"/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Allow-list, arguments, bounds, failures
// ─────────────────────────────────────────────────────────────────────────────

test('a repository outside GITHUB_REPOS is refused by name, before any call', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ repo: OTHER_REPO, number: 7 });

  const out = failure(await readToolModule.call('get_issue', { repo: 'someone-else/not-ours', number: 7 }, ctx(api)));
  assert.match(out, /get_issue refused: repository someone-else\/not-ours is not in GITHUB_REPOS/);
  assert.match(out, /allowed: anima-research\/rayforce/);
  assert.equal(api.calls.length, 0);
});

test('the allowed repository may be named explicitly', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7 });
  ok(await readToolModule.call('get_issue', { repo: 'anima-research/rayforce', number: 7 }, ctx(api)));
  assert.deepEqual(api.callsTo('getIssue')[0].args, [ISSUE]);
});

test('a malformed repo argument is rejected as a bad argument, not as a refusal', async () => {
  const api = new FakeGitHubApi();
  const out = failure(await readToolModule.call('get_issue', { repo: 'rayforce', number: 7 }, ctx(api)));
  assert.match(out, /get_issue: "repo" must be owner\/name/);
  assert.equal(api.calls.length, 0);
});

test('a missing or non-integer number is rejected with the argument named', async () => {
  const api = new FakeGitHubApi();
  assert.match(failure(await readToolModule.call('get_issue', {}, ctx(api))), /"number" must be a positive integer/);
  assert.match(
    failure(await readToolModule.call('get_issue', { number: 0 }, ctx(api))),
    /"number" must be a positive integer, got 0/,
  );
  assert.match(
    failure(await readToolModule.call('get_issue', { number: 1.5 }, ctx(api))),
    /"number" must be a positive integer/,
  );
  assert.equal(api.calls.length, 0);
});

test('an unknown tool name is reported rather than silently succeeding', async () => {
  const api = new FakeGitHubApi();
  const out = failure(await readToolModule.call('merge_pull_request', {}, ctx(api)));
  assert.match(out, /unknown tool for github\.read: merge_pull_request/);
});

test('a long unknown tool name cannot make the failure text arbitrarily long', async () => {
  const out = failure(await readToolModule.call('x'.repeat(100_000), {}, ctx(new FakeGitHubApi())));
  assert.ok(out.length < 1_000, `failure text is ${out.length} chars`);
});

test('a GitHub error is reported with its status and message', async () => {
  class NotFoundApi extends FakeGitHubApi {
    override async getIssue(ref: ThreadRef): Promise<Issue> {
      void ref;
      throw Object.assign(new Error('Not Found'), { status: 404 });
    }
  }
  const api = new NotFoundApi();
  const out = failure(await readToolModule.call('get_issue', { number: 7 }, ctx(api)));
  assert.equal(out, 'get_issue failed: GitHub error 404: Not Found');
});

test('an error without a status is still reported', async () => {
  class BrokenApi extends FakeGitHubApi {
    override async getIssue(ref: ThreadRef): Promise<Issue> {
      void ref;
      throw new Error('socket hang up');
    }
  }
  const out = failure(await readToolModule.call('get_issue', { number: 7 }, ctx(new BrokenApi())));
  assert.equal(out, 'get_issue failed: socket hang up');
});

test('a rendered list stops at the list bound and says how many it dropped', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7 });
  for (let i = 0; i < LIMITS.listEntries + 5; i++) api.seedComment(ISSUE, { id: 2000 + i, body: `c${i}` });

  const out = ok(await readToolModule.call('list_comments', { number: 7 }, ctx(api)));
  assert.match(out, new RegExp(`${LIMITS.listEntries + 5} comments on`));
  assert.match(out, new RegExp(`… 5 more not shown \\(list bound ${LIMITS.listEntries}\\)`));
  assert.ok(!out.includes('c54'), 'the 55th comment must not be rendered');
});

test('a long body is truncated with a notice, within the per-comment bound', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7, body: 'x'.repeat(LIMITS.commentChars * 2) });

  const out = ok(await readToolModule.call('get_issue', { number: 7 }, ctx(api)));
  assert.match(out, /truncated \d+ chars/);
  assert.ok(out.length < LIMITS.commentChars + 500, `result stayed bounded (${out.length})`);
});

test('an empty body renders as a marker rather than a blank line', async () => {
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7, body: '' });
  assert.match(ok(await readToolModule.call('get_issue', { number: 7 }, ctx(api))), /\(no body\)/);
});

test('an empty GITHUB_REPOS leaves nothing to act on', async () => {
  const api = new FakeGitHubApi();
  const out = failure(await readToolModule.call('get_issue', { number: 7 }, ctx(api, { repos: [] })));
  assert.match(out, /GITHUB_REPOS names no repository/);
});


// ─────────────────────────────────────────────────────────────────────────────
// Treatment rules are first-match-wins (SPEC §16.7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a host does with an event's tags: the first rule that matches wins.
 * (No rule in this ontology uses a glob, so plain membership is the whole
 * matcher.)
 */
function firstMatch(tags: string[], rules: readonly TreatmentRule[]): TagBehavior | undefined {
  const has = (tag: string): boolean => tags.includes(tag);
  for (const rule of rules) {
    if (rule.tagsAny && !rule.tagsAny.some(has)) continue;
    if (rule.tagsAll && !rule.tagsAll.every(has)) continue;
    if (rule.tagsNone && rule.tagsNone.some(has)) continue;
    return rule.behavior;
  }
  return undefined;
}

test('the self-event mute is first, so it outranks every wake rule', () => {
  const rules = GITHUB_TAG_ONTOLOGY.defaultTreatment ?? [];
  assert.ok(rules.length > 0);
  assert.deepEqual(rules[0], { tagsAny: ['chat:from-self'], behavior: 'mute' });

  // An event carries several tags at once, and the bot's own reply on its own
  // pull request carries both of these. Muted, or it wakes on its own writing.
  assert.equal(firstMatch(['chat:from-self', 'chat:reply'], rules), 'mute');
  assert.equal(firstMatch(['chat:from-self', 'chat:mention', 'github:ci=failure'], rules), 'mute');
  assert.equal(firstMatch(['chat:from-self', 'chat:ambient'], rules), 'mute');

  // Someone else's events still wake it.
  assert.equal(firstMatch(['chat:reply', 'chat:from-human'], rules), 'immediate');
  assert.equal(firstMatch(['chat:mention'], rules), 'immediate');
  assert.equal(firstMatch(['github:pr=review_requested'], rules), 'immediate');
  assert.equal(firstMatch(['github:ci=failure'], rules), 'immediate');
  assert.deepEqual(firstMatch(['chat:ambient', 'github:push'], rules), { throttle: { perMs: 120_000 } });

  // A tag no rule claims falls through to the host's own policy.
  assert.equal(firstMatch(['github:review-comment'], rules), undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bounds on every field, not only the three the contract enumerates
// ─────────────────────────────────────────────────────────────────────────────

test('labels are bounded in count and in length', async () => {
  const api = new FakeGitHubApi();
  const labels = Array.from({ length: LIMITS.listEntries + 10 }, (_, i) => `label-${i}-${'x'.repeat(200)}`);
  api.seedIssue({ number: 7, labels });

  const out = ok(await readToolModule.call('get_issue', { number: 7 }, ctx(api)));
  const line = out.split('\n').find((l) => l.startsWith('labels: '))!;
  assert.match(line, new RegExp(`… 10 more not shown \\(list bound ${LIMITS.listEntries}\\)`));
  assert.ok(!line.includes('label-50-'), 'the 51st label is not rendered');
  for (const entry of line.slice('labels: '.length).split(', ')) {
    assert.ok(entry.length <= LIMITS.titleChars, `"${entry.slice(0, 20)}…" is ${entry.length} chars`);
  }
  // 50 bounded labels and nothing else: no unbounded growth hidden in a field.
  assert.ok(line.length < LIMITS.listEntries * (LIMITS.titleChars + 2) + 64, `labels line is ${line.length} chars`);
});

test('an echoed search query is bounded', async () => {
  const api = new FakeGitHubApi();
  const out = ok(await readToolModule.call('search_issues', { query: 'q'.repeat(100_000) }, ctx(api)));
  assert.match(out, /^no matches in anima-research\/rayforce for "q+… \[truncated \d+ chars\]"$/);
  assert.ok(out.length < 400, `the echo stayed bounded (${out.length} chars)`);
});

test('an echoed sha is bounded', async () => {
  const api = new FakeGitHubApi();
  const out = ok(await readToolModule.call('get_check_runs', { sha: 'f'.repeat(100_000) }, ctx(api)));
  assert.match(out, /truncated \d+ chars/);
  assert.ok(out.length < 200, `the echo stayed bounded (${out.length} chars)`);
});

test('a pull request bounds its reviewer list, its refs and its URL', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({
    number: 8,
    title: 'ok',
    head: { ref: 'h'.repeat(5_000), sha: 's'.repeat(5_000) },
    base: { ref: 'dev', sha: 'b'.repeat(40) },
    author: { login: 'a'.repeat(5_000), isBot: false },
    html_url: `https://github.com/anima-research/rayforce/pull/8?${'q'.repeat(50_000)}`,
    requestedReviewers: Array.from({ length: LIMITS.listEntries + 3 }, (_, i) => `reviewer-${i}${'y'.repeat(500)}`),
  });

  const out = ok(await readToolModule.call('get_pull_request', { number: 8 }, ctx(api)));
  assert.match(out, new RegExp(`… 3 more not shown \\(list bound ${LIMITS.listEntries}\\)`));
  assert.ok(!out.includes('reviewer-50'), 'the 51st reviewer is not rendered');
  // Six bounded fields and a 50-entry list: comfortably inside one comment bound.
  assert.ok(out.length < LIMITS.commentChars + 1_000, `result is ${out.length} chars`);
});

test('a file list bounds its paths and its length', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8 });
  const files: PullRequestFile[] = Array.from({ length: LIMITS.listEntries + 7 }, (_, i) => ({
    filename: `src/${i}/${'deep/'.repeat(400)}mod.rs`,
    status: 'modified',
    additions: 1,
    deletions: 0,
    changes: 1,
  }));
  api.seedFiles(PULL, files);

  const out = ok(await readToolModule.call('list_pull_request_files', { number: 8 }, ctx(api)));
  assert.match(out, new RegExp(`… 7 more not shown \\(list bound ${LIMITS.listEntries}\\)`));
  for (const line of out.split('\n').filter((l) => l.startsWith('modified '))) {
    assert.ok(line.length < 260, `a file line is ${line.length} chars`);
  }
});

test('a review-thread list bounds its ids, paths and comment bodies', async () => {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8 });
  api.seedReviewThread(PULL, {
    id: `RT_${'n'.repeat(5_000)}`,
    path: `src/${'deep/'.repeat(400)}mod.rs`,
    line: 42,
    side: 'RIGHT',
    isResolved: false,
    comments: [
      {
        id: 1001,
        author: { login: 'a'.repeat(5_000), isBot: false },
        body: 'z'.repeat(LIMITS.commentChars * 3),
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  });

  const out = ok(await readToolModule.call('list_review_threads', { number: 8 }, ctx(api)));
  assert.match(out, /truncated \d+ chars/);
  // One thread, one comment: the comment bound plus the bounded header fields.
  assert.ok(out.length < LIMITS.commentChars + 800, `result is ${out.length} chars`);
});

test('a refused repository name is echoed bounded', async () => {
  const api = new FakeGitHubApi();
  const out = failure(
    await readToolModule.call('get_issue', { repo: `${'o'.repeat(50_000)}/name`, number: 7 }, ctx(api)),
  );
  assert.match(out, /refused: repository o+… \[truncated \d+ chars\] is not in GITHUB_REPOS/);
  assert.ok(out.length < 400, `the refusal stayed bounded (${out.length} chars)`);
});

test('an argument error quotes a bounded value', async () => {
  const api = new FakeGitHubApi();
  const out = failure(await readToolModule.call('list_comments', { number: 7, kind: 'k'.repeat(50_000) }, ctx(api)));
  assert.match(out, /"kind" must be one of issue \| pull, got "k+… \[truncated \d+ chars\]"/);
  assert.ok(out.length < 300, `the error stayed bounded (${out.length} chars)`);
});
