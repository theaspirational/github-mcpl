/**
 * tags.ts — table-driven over every `NormalizedEventKind`, plus the detection
 * rules (mention, self, maintainer), the closure invariants and the bounds.
 *
 * The table is the point: the coverage test below fails the moment a kind is
 * added to the contract without a row here, so "every kind has a tags row" is
 * a test rather than a promise.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CORE_TAGS,
  GITHUB_TAGS,
  NORMALIZED_EVENT_KINDS,
  type NormalizedEvent,
  type NormalizedEventKind,
  type RepoRef,
  type ThreadRef,
} from '../src/types.js';
import {
  EMITTED_TAGS,
  GITHUB_TAG_ONTOLOGY,
  METADATA_LIMITS,
  hasLink,
  mentionsBot,
  tagsFor,
  type GitHubTagContext,
} from '../src/tags.js';

const REPO: RepoRef = { owner: 'anima-research', name: 'rayforce' };
const BOT = 'rayforce-clone[bot]';
const ISSUE: ThreadRef = { repo: REPO, number: 7, kind: 'issue' };
const PULL: ThreadRef = { repo: REPO, number: 12, kind: 'pull' };

/** A deployment with no maintainers and no thread history, unless overridden. */
function ctx(over: Partial<GitHubTagContext> = {}): GitHubTagContext {
  return { botLogin: BOT, maintainers: [], ...over };
}

function event(kind: NormalizedEventKind, over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  const thread = kind.startsWith('issue.') ? ISSUE : kind === 'push' ? undefined : PULL;
  return {
    id: 'delivery-1',
    receivedAt: '2026-10-14T10:00:00Z',
    repo: REPO,
    kind,
    thread,
    actor: { login: 'alice', isBot: false },
    html_url: 'https://github.com/anima-research/rayforce/issues/7#issuecomment-1',
    ...over,
  };
}

function sorted(tags: readonly string[]): string[] {
  return [...tags].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// The table: one row per NormalizedEventKind
// ─────────────────────────────────────────────────────────────────────────────

interface Row {
  kind: NormalizedEventKind;
  /** What the kind carries beyond the baseline event. */
  event?: Partial<NormalizedEvent>;
  ctx?: Partial<GitHubTagContext>;
  /** The exact tag set, for a human author with no thread history. */
  tags: string[];
}

const TAG_TABLE: Row[] = [
  {
    kind: 'issue.opened',
    event: { title: 'Rate limiter drops bursts', body: 'Repro inside.' },
    tags: ['chat:from-human', 'chat:ambient', 'github:issue=opened'],
  },
  {
    kind: 'issue.edited',
    event: { title: 'Rate limiter drops bursts', body: 'Repro inside, clarified.' },
    tags: ['chat:from-human', 'chat:ambient', 'chat:edited', 'github:issue=edited'],
  },
  {
    kind: 'issue.closed',
    event: { title: 'Rate limiter drops bursts' },
    tags: ['chat:from-human', 'chat:ambient', 'github:issue=closed'],
  },
  {
    kind: 'issue.reopened',
    event: { title: 'Rate limiter drops bursts' },
    tags: ['chat:from-human', 'chat:ambient', 'github:issue=reopened'],
  },
  {
    kind: 'comment.created',
    event: { body: 'Looks right to me.' },
    tags: ['chat:from-human', 'chat:ambient'],
  },
  {
    kind: 'comment.edited',
    event: { body: 'Looks right to me (typo).' },
    tags: ['chat:from-human', 'chat:ambient', 'chat:edited'],
  },
  {
    kind: 'comment.deleted',
    tags: ['chat:from-human', 'chat:ambient', 'chat:deleted'],
  },
  {
    kind: 'pull.opened',
    event: { title: 'Fix the limiter', body: 'See https://example.invalid/design', sha: 'a'.repeat(40) },
    tags: ['chat:from-human', 'chat:ambient', 'chat:has-link', 'github:pr=opened'],
  },
  {
    kind: 'pull.synchronize',
    event: { sha: 'b'.repeat(40) },
    tags: ['chat:from-human', 'chat:ambient', 'github:pr=synchronize'],
  },
  {
    kind: 'pull.ready_for_review',
    event: { title: 'Fix the limiter' },
    tags: ['chat:from-human', 'chat:ambient', 'github:pr=ready_for_review'],
  },
  {
    kind: 'pull.review_requested',
    event: { title: 'Fix the limiter' },
    tags: ['chat:from-human', 'chat:ambient', 'github:pr=review_requested'],
  },
  {
    kind: 'pull.closed',
    event: { title: 'Fix the limiter' },
    tags: ['chat:from-human', 'chat:ambient', 'github:pr=closed'],
  },
  {
    kind: 'review.submitted',
    event: { body: 'Two notes below.', review: { id: 55, state: 'changes_requested' } },
    tags: ['chat:from-human', 'chat:ambient', 'github:review=changes_requested'],
  },
  {
    kind: 'review_comment.created',
    event: {
      body: 'This branch never runs.',
      reviewComment: {
        id: 901,
        path: 'src/limiter.ts',
        line: 42,
        side: 'RIGHT',
        diffHunk: '@@ -1,3 +1,4 @@\n-old\n+new',
      },
    },
    tags: ['chat:from-human', 'chat:ambient', 'chat:thread', 'github:review-comment'],
  },
  {
    kind: 'review_comment.edited',
    event: {
      body: 'This branch never runs (edited).',
      reviewComment: {
        id: 901,
        path: 'src/limiter.ts',
        line: 42,
        side: 'RIGHT',
        diffHunk: '@@ -1,3 +1,4 @@\n-old\n+new',
        inReplyTo: 900,
      },
    },
    tags: [
      'chat:from-human',
      'chat:ambient',
      'chat:thread',
      'chat:edited',
      'github:review-comment',
    ],
  },
  {
    kind: 'checks.completed',
    event: {
      actor: { login: 'github-actions[bot]', isBot: true },
      sha: 'c'.repeat(40),
      checks: { conclusion: 'failure', failed: [{ name: 'test', url: 'https://example.invalid/1' }] },
    },
    tags: ['chat:from-bot', 'chat:ambient', 'github:ci=failure'],
  },
  {
    kind: 'push',
    event: { sha: 'd'.repeat(40) },
    tags: ['chat:from-human', 'chat:ambient', 'github:push'],
  },
  {
    kind: 'thread.read_failed',
    event: { actor: { login: 'github-mcpl[server]', isBot: true } },
    // Addressed to the agent by the server, so the advisory's ambient-bot mute can't reach it.
    tags: ['chat:from-bot', 'chat:mention', 'github:read-failed'],
  },
];

test('the table covers every NormalizedEventKind exactly once', () => {
  const rows = TAG_TABLE.map((r) => r.kind);
  assert.deepEqual(sorted(rows), sorted(NORMALIZED_EVENT_KINDS));
  assert.equal(new Set(rows).size, rows.length);
});

for (const row of TAG_TABLE) {
  test(`tagsFor ${row.kind}`, () => {
    const { tags } = tagsFor(event(row.kind, row.event), ctx(row.ctx));
    assert.deepEqual(sorted(tags), sorted(row.tags));
  });
}

test('every tag the table expects is in the declared vocabulary', () => {
  for (const row of TAG_TABLE) {
    for (const tag of row.tags) {
      assert.ok(EMITTED_TAGS.includes(tag), `${tag} is not declared in EMITTED_TAGS`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Closure rules
// ─────────────────────────────────────────────────────────────────────────────

/** The kinds whose body is new text: the only ones a mention can address. */
const TEXT_KINDS: readonly string[] = [
  'issue.opened',
  'issue.edited',
  'pull.opened',
  'comment.created',
  'comment.edited',
  'review.submitted',
  'review_comment.created',
  'review_comment.edited',
];

/** The server's own notices: addressed to the agent by the server, whatever their body says. */
const SERVER_NOTICE_KINDS: readonly string[] = ['thread.read_failed'];

test('a close, reopen, push or new commits never count the mention in a body they re-carry', () => {
  // The 2026-10-15 rehearsal: a polled issue.closed re-carried the issue's
  // body, and its old mention woke the bot that had just closed it.
  for (const kind of NORMALIZED_EVENT_KINDS) {
    const { tags, metadata } = tagsFor(event(kind, { body: '@rayforce-clone please look' }), ctx());
    const counts = TEXT_KINDS.includes(kind) || SERVER_NOTICE_KINDS.includes(kind);
    assert.equal(tags.includes('chat:mention'), counts, `${kind}: chat:mention`);
    assert.equal(metadata.mentioned, counts, `${kind}: metadata.mentioned`);
  }
});

test('chat:ambient never co-occurs with chat:mention or chat:reply, on any kind', () => {
  const addressing: Array<[string, Partial<GitHubTagContext>, Partial<NormalizedEvent>]> = [
    ['mention', {}, { body: `@rayforce-clone please look` }],
    ['own thread', { isOwnThread: true }, {}],
    ['reply to self', { isReplyToSelf: true }, {}],
    ['mention and reply', { isOwnThread: true }, { body: `@rayforce-clone ping` }],
  ];
  for (const kind of NORMALIZED_EVENT_KINDS) {
    for (const [label, ctxOver, eventOver] of addressing) {
      // A mention alone addresses only the kinds that bring their text.
      if (label === 'mention' && !TEXT_KINDS.includes(kind)) continue;
      const { tags } = tagsFor(event(kind, eventOver), ctx(ctxOver));
      const addressed = tags.includes('chat:mention') || tags.includes('chat:reply');
      assert.ok(addressed, `${kind} / ${label}: expected an addressed tag`);
      assert.ok(!tags.includes('chat:ambient'), `${kind} / ${label}: ambient beside addressed`);
    }
    // And the converse: unaddressed traffic is ambient and nothing else. The
    // server's own notice is never unaddressed.
    const { tags } = tagsFor(event(kind), ctx());
    if (SERVER_NOTICE_KINDS.includes(kind)) {
      assert.ok(tags.includes('chat:mention') && !tags.includes('chat:ambient'), `${kind}: the server addresses it`);
      continue;
    }
    assert.ok(tags.includes('chat:ambient'), `${kind}: expected chat:ambient`);
    assert.ok(!tags.includes('chat:mention') && !tags.includes('chat:reply'));
  }
});

test('chat:addressed is never emitted — the host expands it (RFC-001 §4.1)', () => {
  const { tags } = tagsFor(event('comment.created', { body: '@rayforce-clone hi' }), ctx());
  assert.ok(!tags.includes('chat:addressed'));
  assert.ok(!EMITTED_TAGS.includes('chat:addressed'));
});

test('chat:dm is never emitted', () => {
  for (const kind of NORMALIZED_EVENT_KINDS) {
    const { tags } = tagsFor(event(kind), ctx({ isOwnThread: true }));
    assert.ok(!tags.includes('chat:dm'));
  }
});

test('exactly one sender tag, and from-self only for the bot login', () => {
  const senders: Array<[NormalizedEvent['actor'], string]> = [
    [{ login: BOT, isBot: true }, 'chat:from-self'],
    [{ login: 'rayforce-clone', isBot: true }, 'chat:from-bot'],
    [{ login: 'other-app[bot]', isBot: true }, 'chat:from-bot'],
    [{ login: 'alice', isBot: false }, 'chat:from-human'],
  ];
  for (const [actor, expected] of senders) {
    const { tags, metadata } = tagsFor(event('comment.created', { actor }), ctx());
    const emitted = tags.filter((t) => t.startsWith('chat:from-'));
    assert.deepEqual(emitted, [expected], `${actor.login}`);
    assert.equal(metadata.fromSelf, expected === 'chat:from-self');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Mention detection
// ─────────────────────────────────────────────────────────────────────────────

test('mentionsBot accepts both spellings of an App login and rejects near misses', () => {
  const yes = [
    '@rayforce-clone please look',
    'cc @rayforce-clone[bot]',
    'hey @RAYFORCE-CLONE',
    'line\n@rayforce-clone\n',
    '(@rayforce-clone)',
  ];
  const no = [
    'rayforce-clone please look',
    'mail me at bob@rayforce-clone.example',
    '@rayforce-clone-staging is a different app',
    '@rayforce-cloneX',
    'https://example.invalid/@rayforce-clone',
    '',
  ];
  for (const body of yes) assert.ok(mentionsBot(body, BOT), JSON.stringify(body));
  for (const body of no) assert.ok(!mentionsBot(body, BOT), JSON.stringify(body));
  assert.ok(!mentionsBot(undefined, BOT));
  assert.ok(!mentionsBot('@rayforce-clone', ''));
});

test('a mention is read from the body only, not the title', () => {
  const titled = event('issue.opened', { title: '@rayforce-clone fix this', body: 'details' });
  assert.ok(!tagsFor(titled, ctx()).metadata.mentioned);
});

test('hasLink finds http(s) URLs only', () => {
  assert.ok(hasLink('see https://example.invalid/x'));
  assert.ok(hasLink('http://example.invalid'));
  assert.ok(!hasLink('see example.invalid/x'));
  assert.ok(!hasLink('ftp://example.invalid'));
  assert.ok(!hasLink(undefined));
});

// ─────────────────────────────────────────────────────────────────────────────
// github: tags that need more than the kind
// ─────────────────────────────────────────────────────────────────────────────

test('a merged pull request carries both closed and merged', () => {
  const closed = tagsFor(event('pull.closed'), ctx()).tags;
  assert.ok(closed.includes('github:pr=closed'));
  assert.ok(!closed.includes('github:pr=merged'));
  const merged = tagsFor(event('pull.closed'), ctx({ merged: true })).tags;
  assert.ok(merged.includes('github:pr=closed'));
  assert.ok(merged.includes('github:pr=merged'));
});

test('every review verdict maps to its own tag', () => {
  for (const state of ['approved', 'changes_requested', 'commented'] as const) {
    const { tags } = tagsFor(event('review.submitted', { review: { id: 1, state } }), ctx());
    assert.ok(tags.includes(`github:review=${state}`));
  }
});

test('ci tags and isCiFailure follow the conclusion, not the kind', () => {
  const cases: Array<[NonNullable<NormalizedEvent['checks']>, string | null, boolean]> = [
    [{ conclusion: 'success', failed: [] }, 'github:ci=success', false],
    [{ conclusion: 'failure', failed: [{ name: 'test', url: 'u' }] }, 'github:ci=failure', true],
    [{ conclusion: 'timed_out', failed: [] }, 'github:ci=failure', true],
    [{ conclusion: 'action_required', failed: [] }, 'github:ci=failure', true],
    // A green roll-up with a failed job in the list is still a failure.
    [{ conclusion: 'success', failed: [{ name: 'flaky', url: 'u' }] }, 'github:ci=failure', true],
    // Neither a pass nor a failure: no ci tag at all.
    [{ conclusion: 'neutral', failed: [] }, null, false],
    [{ conclusion: 'cancelled', failed: [] }, null, false],
    [{ conclusion: 'skipped', failed: [] }, null, false],
    [{ conclusion: 'stale', failed: [] }, null, false],
    [{ conclusion: null, failed: [] }, null, false],
  ];
  for (const [checks, expected, failure] of cases) {
    const { tags, metadata } = tagsFor(event('checks.completed', { checks }), ctx());
    const ci = tags.filter((t) => t.startsWith('github:ci='));
    assert.deepEqual(ci, expected === null ? [] : [expected], JSON.stringify(checks));
    assert.equal(metadata.isCiFailure, failure);
  }
  assert.equal(tagsFor(event('push'), ctx()).metadata.isCiFailure, false);
});

test('github:actor=maintainer and isMaintainer follow GITHUB_MAINTAINERS', () => {
  const plain = tagsFor(event('comment.created'), ctx());
  assert.ok(!plain.tags.includes('github:actor=maintainer'));
  assert.equal(plain.metadata.isMaintainer, false);
  const maint = tagsFor(event('comment.created'), ctx({ maintainers: ['bob', 'alice'] }));
  assert.ok(maint.tags.includes('github:actor=maintainer'));
  assert.equal(maint.metadata.isMaintainer, true);
});

test('isReviewRequested is set for pull.review_requested and suppressible', () => {
  assert.equal(tagsFor(event('pull.review_requested'), ctx()).metadata.isReviewRequested, true);
  assert.equal(
    tagsFor(event('pull.review_requested'), ctx({ reviewRequestedForSelf: false })).metadata
      .isReviewRequested,
    false,
  );
  for (const kind of NORMALIZED_EVENT_KINDS) {
    if (kind === 'pull.review_requested') continue;
    assert.equal(tagsFor(event(kind), ctx()).metadata.isReviewRequested, false, kind);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

test('metadata carries the scalar fields of the thread, actor and event', () => {
  const { metadata } = tagsFor(
    event('review_comment.created', {
      body: '@rayforce-clone see https://example.invalid/x',
      sha: 'e'.repeat(40),
    }),
    ctx({ isOwnThread: true, isReplyToSelf: true, maintainers: ['alice'] }),
  );
  assert.deepEqual(metadata, {
    mentioned: true,
    isOwnThread: true,
    isReplyToSelf: true,
    isReviewRequested: false,
    isCiFailure: false,
    fromSelf: false,
    isMaintainer: true,
    repo: 'anima-research/rayforce',
    number: 12,
    kind: 'pull',
    actor: 'alice',
    sha: 'e'.repeat(40),
    htmlUrl: 'https://github.com/anima-research/rayforce/issues/7#issuecomment-1',
  });
});

test('metadata booleans default to false and absent fields to null', () => {
  const { metadata } = tagsFor(event('push', { sha: undefined }), ctx());
  assert.equal(metadata.number, null);
  assert.equal(metadata.kind, null);
  assert.equal(metadata.sha, null);
  for (const key of [
    'mentioned',
    'isOwnThread',
    'isReplyToSelf',
    'isReviewRequested',
    'isCiFailure',
    'fromSelf',
    'isMaintainer',
  ] as const) {
    assert.equal(metadata[key], false, key);
  }
});

test('every metadata string is bounded and no raw payload reaches metadata', () => {
  const huge = 'z'.repeat(5000);
  const { metadata } = tagsFor(
    event('comment.created', {
      actor: { login: huge, isBot: false },
      repo: { owner: huge, name: huge },
      html_url: `https://example.invalid/${huge}`,
      sha: huge,
      raw: { secret: 'should-never-appear', token: 'also-not' },
    }),
    ctx(),
  );
  assert.ok(metadata.actor.length <= METADATA_LIMITS.scalarChars);
  assert.ok(metadata.repo.length <= METADATA_LIMITS.scalarChars);
  assert.ok((metadata.sha ?? '').length <= METADATA_LIMITS.scalarChars);
  assert.ok(metadata.htmlUrl.length <= METADATA_LIMITS.urlChars);
  const serialized = JSON.stringify(metadata);
  assert.ok(!serialized.includes('should-never-appear'));
  assert.ok(!serialized.includes('also-not'));
  assert.deepEqual(sorted(Object.keys(metadata)), sorted([
    'mentioned',
    'isOwnThread',
    'isReplyToSelf',
    'isReviewRequested',
    'isCiFailure',
    'fromSelf',
    'isMaintainer',
    'repo',
    'number',
    'kind',
    'actor',
    'sha',
    'htmlUrl',
  ]));
});

// ─────────────────────────────────────────────────────────────────────────────
// The producer ontology (RFC-001 §5)
// ─────────────────────────────────────────────────────────────────────────────

test('the ontology declares the core tags this server emits and no others', () => {
  assert.deepEqual(sorted(GITHUB_TAG_ONTOLOGY.coreTags ?? []), sorted(CORE_TAGS));
});

test('the ontology describes every github: tag, each with a desc', () => {
  const described = Object.keys(GITHUB_TAG_ONTOLOGY.tags ?? {});
  assert.deepEqual(sorted(described), sorted(GITHUB_TAGS));
  for (const [tag, descriptor] of Object.entries(GITHUB_TAG_ONTOLOGY.tags ?? {})) {
    assert.ok(descriptor.desc && descriptor.desc.length > 0, `${tag} has no desc`);
  }
  assert.equal(GITHUB_TAG_ONTOLOGY.open, false);
});

test('no declared implies edge reaches into the reserved chat: namespace', () => {
  for (const [tag, descriptor] of Object.entries(GITHUB_TAG_ONTOLOGY.tags ?? {})) {
    for (const implied of descriptor.implies ?? []) {
      assert.ok(!implied.startsWith('chat:'), `${tag} implies ${implied}`);
    }
  }
});

test('no suggested treatment promotes unaddressed traffic', () => {
  for (const rule of GITHUB_TAG_ONTOLOGY.defaultTreatment ?? []) {
    const matched = [...(rule.tagsAny ?? []), ...(rule.tagsAll ?? [])];
    if (matched.includes('chat:ambient') || matched.includes('chat:from-bot')) {
      assert.notEqual(rule.behavior, 'immediate', JSON.stringify(rule));
    }
    // An `immediate` suggestion is only ever reached by addressed traffic.
    if (rule.behavior === 'immediate') {
      assert.ok(
        (rule.tagsAll ?? []).some((t) => t === 'chat:mention' || t === 'chat:reply'),
        `${JSON.stringify(rule)} suggests immediate without requiring an addressed tag`,
      );
    }
  }
  for (const descriptor of Object.values(GITHUB_TAG_ONTOLOGY.tags ?? {})) {
    assert.notEqual(descriptor.defaultTreatment, 'immediate');
  }
});

test('every keyed family lists the values the github: tags use', () => {
  for (const tag of GITHUB_TAGS) {
    const eq = tag.indexOf('=');
    if (eq < 0) continue;
    const key = tag.slice('github:'.length, eq);
    const value = tag.slice(eq + 1);
    const family = (GITHUB_TAG_ONTOLOGY.keyed ?? {})[key];
    assert.ok(family, `no keyed family for ${key}`);
    assert.ok(family.values?.includes(value), `${key} family omits ${value}`);
  }
});
