/**
 * Feature-set declarations — MCPL 0.5 (SPEC §5.1, §6.1, §6.2), TASK-SRHKG.1.6.
 *
 * Six feature sets, exactly as the contract's "Feature sets and tools" section
 * names them:
 *
 *   github.events   — ingress: push/event and channels/incoming. No tools.
 *   github.read     — the read tools (tools-read.ts).
 *   github.comments — the comment tools (tools-comments.ts, .7). Rollback-capable.
 *   github.review   — create_review, resolve_thread, unresolve_thread.
 *   github.issues   — create_issue, edit_issue, close_issue, reopen_issue.
 *   github.pr       — create_pull_request, edit_pull_request, request_review.
 *
 * Which tool belongs to which set is not restated here: `TOOLS_BY_FEATURE_SET`
 * in types.ts is the single answer, and `ROLLBACK_CAPABLE` the single answer to
 * which set can undo itself (§8.1: only github.comments — a GitHub review
 * cannot be deleted, an issue edit cannot be un-edited).
 *
 * `uses` is a closed vocabulary (§6.2) and derivation is fail-closed (§6.4):
 * an inaccurate declaration disables the feature set, so every path below is
 * justified by a call site rather than by aspiration:
 *
 *   tools              — every set with tools; the MCP tool surface (§5.1).
 *   pushEvents         — the pipeline sends push/event for every event (.9),
 *                        and it is the *only* path github.events declares: see
 *                        {@link EVENTS_USES}.
 *   channels.publish   — channels/publish writes a comment or a review reply
 *                        (.5 over the comment API), which is what
 *                        github.comments authorizes; a host that disables
 *                        github.comments must not get a write through publish,
 *                        so the path is declared there and not on github.events.
 *
 * The other three channel paths this server uses — `channels.register` (the
 * registry announces a thread lazily, .5), `channels.lifecycle` (channels/open
 * and channels/close) and `channels.incoming` (an event delivered to its
 * channel) — are declared by no feature set and checked at their own call
 * sites instead. They are capabilities the server *uses when it has them*, not
 * capabilities any set needs to function, and §6.4 would otherwise make the
 * whole of github.events depend on all of them (WP9 review, finding 4).
 * `channels.typing` is answered as a no-op behind the same per-call check.
 *
 * Deliberately NOT declared: channels.streaming (a comment is posted once),
 * channels.acknowledge (no handler), and every inference path (this server
 * asks nothing of the host's model).
 */

import type {
  CapabilityPath,
  FeatureSetDeclaration,
  KeyedTagDescriptor,
  McplManifest,
  TagDescriptor,
  TagOntology,
  TreatmentRule,
} from '@animalabs/mcpl-core';
import {
  COMMENTS_FEATURE_SET,
  CORE_TAGS,
  EVENTS_FEATURE_SET,
  FEATURE_SETS,
  GITHUB_TAGS,
  ISSUES_FEATURE_SET,
  PR_FEATURE_SET,
  READ_FEATURE_SET,
  REVIEW_FEATURE_SET,
  ROLLBACK_CAPABLE,
  type FeatureSetName,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tag ontology (RFC-001 §5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the `github:` tags mean. One line per tag family; the values themselves
 * are derived from `GITHUB_TAGS` below, so a tag added to types.ts cannot go
 * undeclared here without the ontology test noticing.
 */
const GITHUB_TAG_DESCRIPTIONS: Record<string, string> = {
  'github:issue': 'An issue changed: opened, edited, closed or reopened.',
  'github:pr': 'A pull request changed: opened, new commits, ready for review, a reviewer requested, closed or merged.',
  'github:review': 'A review was submitted on a pull request, with its verdict.',
  'github:ci': 'The check runs on a pull request head finished, with their conclusion.',
  'github:actor': 'Who acted, where the deployment distinguishes them (maintainer).',
  'github:review-comment': 'A comment on a line of a diff, inside a review thread.',
  'github:push': 'Commits were pushed to a branch.',
  'github:read-failed': 'Contributor mode stopped reading a thread, and says why.',
};

/** Tag families whose value domain is ordered within this namespace. */
const ORDERED_FAMILIES: ReadonlySet<string> = new Set<string>();

/**
 * The producer ontology for the events of github.events.
 *
 * ponytail: WP4 writes tags.ts (the emission side of the same vocabulary). If
 * it grows an ontology export, WP9 imports it here and deletes this builder;
 * until then both sides derive from `CORE_TAGS` and `GITHUB_TAGS` in types.ts,
 * which is what keeps them from drifting.
 */
export function buildTagOntology(): TagOntology {
  const tags: Record<string, TagDescriptor> = {};
  const keyed: Record<string, KeyedTagDescriptor> = {};

  for (const tag of GITHUB_TAGS) {
    const eq = tag.indexOf('=');
    if (eq < 0) {
      tags[tag] = { desc: GITHUB_TAG_DESCRIPTIONS[tag], facet: 'content', stability: 'stable' };
      continue;
    }
    const family = tag.slice(0, eq);
    const value = tag.slice(eq + 1);
    const entry = (keyed[family] ??= {
      desc: GITHUB_TAG_DESCRIPTIONS[family],
      values: [],
      ordered: ORDERED_FAMILIES.has(family),
    });
    entry.values?.push(value);
  }

  // Seeded BELOW a host's own rules (§6 precedence): a hint, never a policy.
  // Matching is first-match-wins (§16.7), so the order here is the rule: the
  // mute goes first because an event carries several tags at once. The bot's
  // own comment on its own pull request is tagged `chat:from-self` *and*
  // `chat:reply`, and with the wake rules first that event would wake it on
  // its own writing — a loop, which is exactly what the mute exists to stop.
  const defaultTreatment: TreatmentRule[] = [
    // The bot's own writes come back as events; waking on them loops. First,
    // and deliberately so: nothing below may outrank it.
    { tagsAny: ['chat:from-self'], behavior: 'mute' },
    // Addressed at the bot, or a verdict it has to act on.
    {
      tagsAny: ['chat:mention', 'chat:reply', 'github:pr=review_requested', 'github:review=changes_requested'],
      behavior: 'immediate',
    },
    // A red build on work the bot is involved in.
    { tagsAny: ['github:ci=failure'], behavior: 'immediate' },
    // Repository background noise.
    { tagsAny: ['chat:ambient', 'github:push', 'github:ci=success'], behavior: { throttle: { perMs: 120_000 } } },
  ];

  return {
    coreTags: [...CORE_TAGS],
    tags,
    keyed,
    defaultTreatment,
    // §5: open-world. A host must tolerate a `github:` tag it has not seen.
    open: true,
  };
}

/** The ontology as declared, built once. */
export const GITHUB_TAG_ONTOLOGY: TagOntology = buildTagOntology();

// ─────────────────────────────────────────────────────────────────────────────
// Declarations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `github.events` uses **`pushEvents` only**.
 *
 * It used to name the four channel paths as well, and §6.4's fail-closed
 * derivation then made the whole set depend on all five: a host that granted
 * `pushEvents` and no channel capability — which the Contract names
 * explicitly, a host without channels still has to wake — got a degraded
 * receipt and no events at all (WP9 review, finding 4).
 *
 * The honest declaration is the one capability the set cannot work without.
 * push/event is how an event reaches a host that has nothing else; the channel
 * surfaces are *additional* ways the same event is offered, and each is gated
 * at its own call site instead (`channels.incoming` to deliver a message,
 * `channels.register` to announce a channel, `channels.publish` to write back,
 * `channels.lifecycle` to answer open and close). So §6.4 still disables the
 * set when push is denied, and a channels-only grant still gets its
 * deliveries — see `GitHubMcplServer.handleEvent`.
 */
const EVENTS_USES: CapabilityPath[] = ['pushEvents'];

const DESCRIPTIONS: Record<FeatureSetName, string> = {
  [EVENTS_FEATURE_SET]:
    'Receive GitHub activity on the allowed repository — issues, pull requests, comments, ' +
    'reviews, review comments, check results and pushes — as events and as channel ' +
    'deliveries. Carries no tools.',
  [READ_FEATURE_SET]:
    'Read issues, pull requests, comments, review threads, changed files, check runs and ' +
    'search results from the allowed repository. No writes.',
  [COMMENTS_FEATURE_SET]:
    'Write comments on issues and pull requests: a new comment, a reply inside a review ' +
    'thread, an edit or delete of the bot’s own comment, and a sticky comment kept ' +
    'up to date in place. Undoable since a checkpoint.',
  [REVIEW_FEATURE_SET]:
    'Submit a pull-request review — comment, approve or request changes — with inline ' +
    'comments on diff lines, and resolve or unresolve a review thread. A submitted review ' +
    'cannot be withdrawn.',
  [ISSUES_FEATURE_SET]:
    'Open an issue, edit its title or body, close it with a reason (optionally commenting ' +
    'first) and reopen it.',
  [PR_FEATURE_SET]:
    'Open a pull request against an allowed base branch, edit its title, body, base or ' +
    'draft state, and request reviewers. Merging and branch deletion are not offered.',
};

/**
 * The six declarations, keyed by feature-set name (§6.1).
 *
 * `rollback` is derived from `ROLLBACK_CAPABLE` rather than written out, and it
 * is stated explicitly (including `false`) so a host reads a decision rather
 * than an absence.
 */
export function buildFeatureSets(): Record<string, FeatureSetDeclaration> {
  const declarations: Record<string, FeatureSetDeclaration> = {};
  for (const name of FEATURE_SETS) {
    const uses: CapabilityPath[] =
      name === EVENTS_FEATURE_SET
        ? [...EVENTS_USES]
        : name === COMMENTS_FEATURE_SET
          ? ['tools', 'channels.publish']
          : ['tools'];
    const declaration: FeatureSetDeclaration = {
      description: DESCRIPTIONS[name],
      uses,
      rollback: ROLLBACK_CAPABLE.includes(name),
    };
    // The tag vocabulary describes events, and github.events is the only set
    // that carries them (§16).
    if (name === EVENTS_FEATURE_SET) declaration.tagOntology = GITHUB_TAG_ONTOLOGY;
    declarations[name] = declaration;
  }
  return declarations;
}

/**
 * The `experimental.mcpl` manifest presented at `initialize` (§5.1). Capability
 * members are the union of what the declarations use; `tools` is advertised by
 * MCP's own `capabilities.tools` and carried here only for shape (§5.1).
 */
export function buildServerCapabilities(): McplManifest {
  return {
    version: '0.5',
    pushEvents: true,
    channels: {
      register: true,
      lifecycle: true,
      publish: true,
      incoming: true,
      typing: true,
    },
    featureSets: buildFeatureSets(),
  };
}
