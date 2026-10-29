# Contract notes

TASK-SRHKG.1's Contract section is frozen; it does not, however, fix every
type signature. This file records the decisions the .1 skeleton had to take so
that .2 to .8 compile against one surface, and the places where a later work
package may legitimately want to extend its own module instead.

One rule throughout: where the contract named something, the name is kept
verbatim (`html_url`, `diffHunk`, `isResolved`), even where it mixes snake and
camel case, so a reviewer can map a contract bullet to a type by sight.

## `GitHubApi` signatures

- **`getCheckRuns(repo, sha)`** — the contract writes `getCheckRuns(sha)`, but
  a sha alone does not name a repository. The repo is the first argument, as
  it is for `updateComment`, `deleteComment`, `createIssue`, `searchIssues`
  and `createPullRequest`, all of which act on a repository rather than on a
  thread.
- **`createReview(pull, input)`** — the contract writes
  `createReview({ event, body, comments[] })`. The review payload is that
  object (`CreateReviewInput`); the pull request it is submitted on is a
  separate first argument, so every pull-scoped method reads the same way.
- **`resolveReviewThread(reviewThreadId: string)`** — GitHub resolves a review
  thread only through GraphQL, by node id. So `ReviewThread.id` is that node
  id (a string), and the channel-facing thread id of the contract,
  `rt:<root review comment id>`, is built from `comments[0].id` by
  `reviewThreadId()`. The two ids are deliberately different things: one
  addresses the API, the other addresses a channel thread.
- **Amendment 1: no notifications API.** An App installation token cannot
  call `GET /notifications` (user-level endpoint), so the contract's
  `listNotifications`/`markNotificationRead` are replaced by three
  repo-scoped `since` queries: `listIssuesSince` (issues and PRs,
  `issues?state=all&sort=updated&since=`), `listIssueCommentsSince`
  (`issues/comments?sort=updated&since=`) and `listReviewCommentsSince`
  (`pulls/comments?sort=updated&since=`), returning `PolledIssue` /
  `PolledComment` rows, each list read by `updated_at` rather than by page
  offset, three requests a pass and more only to finish a second. The poller
  (.3) keeps a cursor for each repository's list in whole seconds
  (`pollCursors`, starting from `lastPollAt` until it has its own), which a
  read stopped at that bound leaves where it stopped, dedups
  with the key `<kind>:<id>:<updated_at>` through `StateStore.seenPollKey`
  (ring of `POLL_DEDUP_RING` = 2000 keys, .7), names poll events
  `poll:<kind>:<id>:<updated_at>`, and asks `getCheckRuns` for the heads of
  the open PRs it saw, at most 20 per poll. These endpoints carry no
  `X-Poll-Interval`; `MIN_POLL_INTERVAL_MS` is the floor.
  - Each `…Since` method returns `PollRead<T>`, `{ rows, resumeAt? }`:
    `resumeAt` is set when the request bound stopped the read, and names the
    second the next read asks from.
  - `StateSnapshot` gains `pollCursors` (`<owner>/<name>:<list>` →
    `{ since, resumeAt? }`) and `pollNew` (the same key → id → `created_at`),
    read and written through `StateStore.pollCursors`/`setPollCursors` and
    `polledNew`/`setPolledNew`. Both fields are **additive**: a state file
    without them loads with no cursors and nothing remembered, so every list
    starts from `lastPollAt`, and a release before them ignores them and
    reads `lastPollAt`, up to which every list has delivered.
- **Amendment 2a: a poll row's kind comes from `created_at` against the
  cursor.** Amendment 1 left the polling ingress unable to tell an opened
  issue from an edited one, so every open issue row arrived as `issue.edited`
  and a recipe keyed on `github:issue=opened` could never fire on it (found by
  the WP10 end-to-end run). A `since` query still carries no action, but it
  does carry `created_at`, and that is enough: `PolledIssue` gains `createdAt`
  and `normalizePolledIssue(repo, row, receivedAt, since, previousHeadSha?, announced?)`
  derives the kind from it.
  - An **issue** row created at or after `since`, and not announced as new
    already (`announced`), is `issue.opened`; otherwise
    `issue.edited`, as before. Closed rows stay `issue.closed`. `since` is
    the start of the list's window, which stays put while a stopped read is
    caught up. The state also keeps the rows announced as new while their
    `created_at` is inside the window (`pollNew`), so a row read again there
    is not opened twice.
  - A **pull-request** row created at or after `since`, and not announced
    as new already, is `pull.opened`. An
    open row seen again is `pull.synchronize` when its head sha moved away
    from the one the last pass recorded, and is **dropped** (null) when it did
    not: every comment on a pull request bumps its row, and the comment and
    review-comment rows of the same pass already carry that change, so the
    row beside them was pure duplicate volume. Closed rows stay `pull.closed`.
    A first sighting has no recorded head and so counts as moved — an open
    pull request older than the cursor arrives once as `pull.synchronize`
    rather than not at all, which is the bounded cost of not leaving a cold
    start blind to what is already open.
  - The comparison is of instants, not strings: GitHub stamps rows without
    milliseconds while a cursor is written with them (`.000Z`, and any
    precision in a state file an older release wrote), and `'Z'` sorts after
    `'.'`.
  - `StateSnapshot` gains `pollHeads` (`<owner>/<name>#<number>` → head sha),
    bounded by `POLL_HEAD_MEMORY` = 200 and recorded on a dropped row as well
    as on a delivered one. The field is **additive**: a state file written
    before this amendment is still a valid version-1 snapshot and loads with
    no heads known.
- **Amendment 2b: `isReplyToSelf` for a top-level comment.** GitHub's issues
  endpoint models no reply relation at all — an issue comment has no
  `in_reply_to_id` — so `isReplyToSelf` could only ever be true for a *review*
  comment, and every human answer to a comment the bot had made on an issue
  reached the host as plain `chat:ambient` (also found by the WP10 run). A
  review comment keeps the exact rule (`inReplyTo ∈ botReviewIds`); a
  top-level comment gets one derived rule:

  **Turn order.** The last comment on the thread older than this one is the
  bot's. `NormalizedEvent` gains `comment: { id }` for a top-level comment so
  it can be placed; `ThreadKnowledge.recentComments` holds the thread's
  bounded tail of `{ id, mine }`, oldest first.

  It is fed by the existing bounded history read (`knowledgeFor` keeps what
  `listComments` already returned), and additionally by every writer that
  learns of a comment without a re-read — a `channels/publish`, the
  `createComment` seam behind the comment tools, and the bot's own comment
  arriving back through either ingress. A comment that is *removed* leaves
  the order and its id is tombstoned, so no later sighting re-seats it.
  `learn` stays a merge: `mine` only goes false → true and `recentComments`
  is inserted by id, so writers may interleave freely.

  **Revision, 2026-10-14 — the quote rule is withdrawn from v1.** As first
  written the amendment had a second rule: a body carrying a `> ` line
  matching a line of the bot's most recent comment, which is what GitHub's
  "Quote reply" writes. It was never wrong about quoting; it was wrong about
  *which body* the bot's most recent comment currently had. Five consecutive
  review rounds each reproduced another interleaving where the server matched
  text GitHub no longer held and claimed a reply that never happened — a tool
  edit the record never saw, a rollback restoring a body, a history snapshot
  merged after the write it predated, a deletion webhook re-seating what it
  reported gone, and a creation echo and a lagging read arriving out of order
  from GitHub's own side. Each fix was right and each left another, the last
  being an equal-`updated_at` disagreement with no local write to break the
  tie. Ordering body versions correctly needs provenance on every observation,
  which is a feature rather than a patch, so v1 ships turn order alone — it
  asks nothing about bodies and so admits none of these — and the quote rule
  returns in a follow-up with provenance-aware body versioning. The cost is
  that a human quoting the bot after somebody else's turn reads as
  `isReplyToSelf: false`; `chat:reply` is unaffected, since the contract
  already fires it for any thread the bot has commented in.

- **`updateComment` / `deleteComment` take `review?: boolean`** (review
  finding): GitHub edits and deletes review comments through
  `pulls/comments/{id}` and issue comments through `issues/comments/{id}`,
  and the rollback records already carry that discriminator, so the seam
  carries it too. Absent means issue comment.
- **`bounded(text, max)` counts its truncation notice against `max`**, so a
  channel label's title part is at most 80 chars and a rendered comment at
  most 4000, notice included.
- **`searchIssues(repo, query, limit?)`** — `limit` defaults to
  `LIMITS.listEntries` (50) at the call site; the contract bounds rendered
  lists at 50 entries, and fetching more than can be rendered is waste.
- Reads of a pull request return `checksSummary: ChecksSummary | null`. The
  contract lists `checksSummary` among the fields of `getPullRequest`; `null`
  is "not fetched or no checks on the head sha", which is distinct from a
  summary with `conclusion: null` ("checks are still running").

## `parseChannelId` does not return a `ThreadRef`

The channel id is `github:<owner>/<name>#<number>` and carries no
`issue | pull` discriminator (GitHub shares one number space between issues
and PRs within a repository, so the number alone cannot tell them apart). So
`parseChannelId` returns `ParsedChannelId { repo, number }` and the channel
registry in .5 — which registered the channel and therefore knows its kind —
supplies `kind` when it needs a full `ThreadRef`. `channelAddress(thread)`
builds the descriptor address `{ owner, name, number, kind }` the contract
names, from a `ThreadRef` that still has its kind.

## Types the contract implies but does not name

- **`StateStore`** (types.ts) — `ToolContext` carries `state`, and .6 and .7
  are built in parallel, so the state seam has to exist before .7 writes
  `state.ts`. The interface is exactly the contract's state bullet: checkpoint
  lineage, the comment ids created and the previous bodies of the comments
  edited per checkpoint, the last poll time and the poll dedup ring
  (amendment 1), plus an atomic `flush()`. `StateSnapshot` is the on-disk
  JSON shape.
- **`EventMetadata`, `TagResult`, `TagContext`** (types.ts) — the metadata
  bullet enumerates the fields, and both .4 (which produces them) and .5
  (which sends them on `channels/incoming`) need the same type. `TagContext`
  carries what tags.ts cannot derive from the event alone: the bot login, the
  maintainer list, and the two thread-history facts (`isOwnThread`,
  `isReplyToSelf`) that only the caller can know.
- **`CORE_TAGS` and `GITHUB_TAGS`** (types.ts) — the tag vocabulary is
  enumerated in the contract and is needed by .4 (emission) and .6 (the
  `tagOntology` of the declarations). Keeping the two lists in types.ts is
  what stops them from drifting apart in two files owned by two packages.
- **`LIMITS` and `bounded()`** (types.ts) — the contract's bounds (comments 4k
  chars, lists 50 entries, titles 80 chars) as one constant, so .4, .5 and .6
  cannot each pick their own. `channelLabel()` is in types.ts for the same
  reason: it is the contract's label format and its 80-char bound.
- **`errors.ts`** — not in the module map, but `grant.ts` is a copy of
  slack-mcpl's and that file imports `McplRpcError`. It is slack-mcpl's
  `errors.ts` verbatim (protocol-generic).
- **`ToolContext.prBaseAllow`** — the contract says `ToolContext` carries
  "api, state, bot login, repo allow-list, logger", but `github.pr` has to
  check a PR base against `GITHUB_PR_BASE_ALLOW`, and a tool cannot reach the
  environment. The allow-list is the sixth field rather than a second,
  divergent way for .6 to find it.
- **`GITHUB_API_METHODS`** — the method-name list, so the harness can assert
  `FakeGitHubApi` covers all of them (`as const satisfies readonly (keyof
  GitHubApi)[]`: adding a method to the interface without the constant is a
  type error).

## Environment decisions

The contract names the variables but not every default or requiredness.

- `GITHUB_WEBHOOK_SECRET_FILE` is required **only** when
  `GITHUB_WEBHOOK_PORT` is set. Without a listener there is nothing to verify;
  with one, an unverified delivery must never be parsed, so the secret is not
  optional.
- Both secret files are refused unless mode 600 (no group or other bits). The
  contract states mode 600 as a property of the files, and a readable private
  key is worth failing startup over.
- `GITHUB_POLL_INTERVAL_MS` defaults to `0` (off), matching "notifications
  fallback". A non-zero value below `MIN_POLL_INTERVAL_MS` (60000) is refused
  rather than silently raised, so an operator's 10-second poll is a startup
  error and not a rate-limit surprise.
- `GITHUB_PR_BASE_ALLOW` is optional and defaults to empty, which means no
  branch is an allowed PR target: `create_pull_request` and a base change in
  `edit_pull_request` then refuse. Deny-by-default; an operator who wants PRs
  names the branch. An entry is `branch` (every repository) or
  `owner/name:branch` (that one); a scoped entry outside `GITHUB_REPOS` is a
  startup error.
- `GITHUB_REPOS` took exactly one entry in v1. With the App it now takes
  several of one owner: one owner is one App installation and one token,
  which is what the adapter holds. Contributor mode's user token reaches
  every owner its user can, so there the list may span owners. With several
  entries the tools' `repo` argument and the repository half of `thread`
  stop defaulting and become required.
- `GITHUB_STATE_FILE` is optional; absent means the state lives in memory for
  the life of the process and `flush()` is a no-op. Checkpoints still work,
  they just do not survive a restart.
- `GITHUB_REPOS` set but empty is a startup error, as is more than one entry
  (v1). Both are reported as `GITHUB_REPOS: …`.
- `GITHUB_BOT_LOGIN` is required with the App: from-self detection is a
  correctness property (without it the server can answer itself), so it is
  not something to guess. Contributor mode can leave it unset, since there
  `GET /user` says whose the token is: startup takes that login, and stops
  when GitHub doesn't answer.

## Not materialized by .1

> Historical, and all of it has since landed: .2 to .8 wrote the modules and
> .9 wired them, so `server.ts` and `index.ts` are the real server and the
> real entry point, `feature-sets.ts` exists and `octokit` is used by the
> adapter. The list is kept because the *reasons* below are still the reasons
> the seams are shaped as they are. The one item still open is the
> `changelog.d` fold.

- `octokit` is a declared dependency but is imported nowhere yet; .2 is the
  first and only user.
- `server.ts` and `index.ts` are stubs. `serve()` answers every request with
  `-32601` so a host and the harness can attach and detach; there is no
  handshake, no manifest, no routing. `index.ts` validates the environment and
  starts the stub with a `GitHubApi` proxy that throws if touched.
- No `feature-sets.ts`: `CapabilityGrant` takes its declarations through the
  constructor (as slack-mcpl's does), so .6 can write that file without
  touching `grant.ts`. `TOOLS_BY_FEATURE_SET`, `ROLLBACK_CAPABLE` and
  `featureSetForTool()` in types.ts are what .6 builds its declarations from.
- The `changelog.d` fold (`scripts/release-changelog.mjs` and the `version`
  npm script) is not copied: the package scripts are the five the task names
  (build, typecheck, test, start, clean). Fragments accumulate until the first
  release wires the script.
