# Events, tags and metadata

Every GitHub delivery (or polled row) becomes one `NormalizedEvent`, and
`tagsFor(event, ctx)` turns that into a tag set plus wake metadata. This file
is the source of truth a recipe author writes wake policies from: the tables
below are what `src/tags.ts` emits and what `test/tags.test.ts` asserts, row
for row.

Tags are **descriptive, never authoritative** (RFC-001 §7). Admission is the
capability grant's decision; a tag only influences treatment afterwards.

## 1. GitHub event → `NormalizedEvent.kind`

| GitHub webhook event (`action`) | Polled source (amendment 1) | `kind` | Thread |
|---|---|---|---|
| `issues` (`opened`) | `listIssuesSince` | `issue.opened` | issue |
| `issues` (`edited`) | `listIssuesSince` | `issue.edited` | issue |
| `issues` (`closed`) | `listIssuesSince` | `issue.closed` | issue |
| `issues` (`reopened`) | `listIssuesSince` | `issue.reopened` | issue |
| `issue_comment` (`created`) | `listIssueCommentsSince` | `comment.created` | issue or pull |
| `issue_comment` (`edited`) | `listIssueCommentsSince` | `comment.edited` | issue or pull |
| `issue_comment` (`deleted`) | — (a deletion is invisible to a `since` query) | `comment.deleted` | issue or pull |
| `pull_request` (`opened`) | `listIssuesSince` | `pull.opened` | pull |
| `pull_request` (`synchronize`) | — | `pull.synchronize` | pull |
| `pull_request` (`ready_for_review`) | — | `pull.ready_for_review` | pull |
| `pull_request` (`review_requested`) | — (contributor mode: a notification whose reason is `review_requested`) | `pull.review_requested` | pull |
| `pull_request` (`closed`) | `listIssuesSince` | `pull.closed` | pull |
| `pull_request_review` (`submitted`) | — | `review.submitted` | pull |
| `pull_request_review_comment` (`created`) | `listReviewCommentsSince` | `review_comment.created` | pull |
| `pull_request_review_comment` (`edited`) | `listReviewCommentsSince` | `review_comment.edited` | pull |
| `check_suite` (`completed`) | `getCheckRuns` on an open PR head (contributor mode: on the head of each open PR the token's user authored, the 100 most recently updated, until a result with every run finished arrives, or for two minutes with no runs, and again when it moves or ten minutes on) | `checks.completed` | pull |
| `push` | — | `push` | *none* |
| — (contributor mode only: the notifications poller stopped reading a thread) | — | `thread.read_failed` | issue or pull |

A `push` event carries no thread, so its channel id, `metadata.number` and
`metadata.kind` are absent — a recipe that routes on a thread must not expect
them there.

## 2. `kind` → tags

Read this table together with §3 (the tags that do not depend on the kind) and
§4 (addressing): every event gets **one sender tag**, **one addressing tag or
pair**, and then the rows below.

| `kind` | `github:` tags | other tags from the kind |
|---|---|---|
| `issue.opened` | `github:issue=opened` | |
| `issue.edited` | `github:issue=edited` | `chat:edited` |
| `issue.closed` | `github:issue=closed` | |
| `issue.reopened` | `github:issue=reopened` | |
| `comment.created` | *(none)* | |
| `comment.edited` | *(none)* | `chat:edited` |
| `comment.deleted` | *(none)* | `chat:deleted` |
| `pull.opened` | `github:pr=opened` | |
| `pull.synchronize` | `github:pr=synchronize` | |
| `pull.ready_for_review` | `github:pr=ready_for_review` | |
| `pull.review_requested` | `github:pr=review_requested` | Not producible for an App identity (e2e round 3): GitHub does not list an App's bot in the Reviewers picker and drops it from `requested_reviewers` through the API (201, empty list). A human asks this connector for a review with a mention, which wakes `chat:mention`. The kind and tag stay for a reviewer that is a user, as in contributor mode, where a notification whose reason is `review_requested` arrives as this kind, with the pull request's author as its actor, once per notification update. |
| `pull.closed` | `github:pr=closed`, plus `github:pr=merged` when the caller passes `merged: true` | |
| `review.submitted` | `github:review=approved` \| `=changes_requested` \| `=commented`, from `event.review.state` | |
| `review_comment.created` | `github:review-comment` | `chat:thread` |
| `review_comment.edited` | `github:review-comment` | `chat:thread`, `chat:edited` |
| `checks.completed` | `github:ci=failure`, or `github:ci=success`, or *neither* — see below | |
| `push` | `github:push` | |
| `thread.read_failed` | `github:read-failed` | |

A `thread.read_failed` event is contributor mode's notifications poller saying,
on the thread's own channel, that it stopped reading that thread's new
activity: after five passes in a row that failed, or at once for a thread gone
or out of the token's reach. Its body names the cause. The poller reads the
thread again, from where it left off while its place is among the last 200
threads it read, when the thread next moves on GitHub. The same event says a
thread's backlog was skipped, when it had more new comments or reviews than
one read takes, and that its new activity arrives as usual. Its actor is
`github-mcpl[server]`, a login no GitHub account can have, so never the agent,
and it carries `chat:mention` (§4), since the server addresses it to the agent.

A conversation comment carries no `github:` tag of its own: the core
vocabulary already says everything a recipe routes on (who wrote it, whether
it addresses the agent, whether it was an edit or a deletion).

`github:pr=merged` is emitted **beside** `github:pr=closed`, not instead of
it, so a rule written on either fires on a merge.

### `checks.completed`

| `checks.conclusion` | tag | `metadata.isCiFailure` |
|---|---|---|
| `success`, with an empty `failed` list | `github:ci=success` | `false` |
| `failure`, `timed_out`, `action_required` | `github:ci=failure` | `true` |
| anything, with a non-empty `failed` list | `github:ci=failure` | `true` |
| `neutral`, `cancelled`, `skipped`, `stale` | *(none)* | `false` |
| `null` (still running) | *(none)* | `false` |

A suite that was cancelled or skipped is neither a pass nor a failure, and is
left untagged rather than reported as either.

## 3. Tags that do not depend on the kind

| Tag | When |
|---|---|
| `chat:from-self` | `event.actor.login === GITHUB_BOT_LOGIN`, and only then |
| `chat:from-bot` | the actor is some other bot (`actor.isBot`) |
| `chat:from-human` | the actor is neither |
| `chat:has-link` | `event.body` carries an `http(s)://` URL |
| `github:actor=maintainer` | `event.actor.login` is in `GITHUB_MAINTAINERS` |

Exactly one of the three sender tags is emitted. `chat:from-self` is the only
one that depends on configuration, and it is set for exactly one login.

`chat:dm` is never emitted: GitHub has no 1:1 channel this server speaks on.
`chat:reaction` / `chat:reaction-remove` are never emitted either — reactions
are not in the contract's ingress.

## 4. Addressing: mention, reply, ambient

| Tag | When |
|---|---|
| `chat:mention` | `event.body` @-mentions the bot — both `@name` and `@name[bot]` spellings, case-insensitively, for a `GITHUB_BOT_LOGIN` of `name[bot]`. Body only: a mention in a title notifies nobody on GitHub. Only on kinds that bring their text — `issue.opened`, `issue.edited`, `pull.opened`, `comment.created`, `comment.edited`, `review.submitted`, `review_comment.created`, `review_comment.edited`: a close, a reopen, new commits or a deleted comment re-carry a body the bot already saw. A thread the bot took part in still wakes it on those through `chat:reply`. On a `thread.read_failed` event, always: there it means addressed to the agent by the server, not a person's @-mention. |
| `chat:reply` | `ctx.isOwnThread` (the bot authored the thread or has commented in it) **or** `ctx.isReplyToSelf` (see §5) |
| `chat:ambient` | neither of the above |

`chat:ambient` is **never** emitted beside `chat:mention` or `chat:reply`.
RFC-001 §4.1 makes host-side closure additive (`chat:mention ⇒
chat:addressed`), and an event carrying both umbrellas is not interpretable by
a first-match-wins rule list.

`chat:addressed` itself is **not emitted**: its expansion is normative host
behaviour (RFC-001 §4.1, "Hosts MUST expand them"), and the frozen contract
enumerates the core tags this server emits without it. A host rule may still
match `chat:addressed` — after the host's own closure — and will never see it
beside `chat:ambient`.

`ctx.isOwnThread` and `ctx.isReplyToSelf` are facts `tagsFor` cannot derive
from an event: the caller (the channel registry in `channels.ts`) tracks the
threads the bot authored or commented in, and the ids of its own comments.

## 5. Metadata

Every event carries the same metadata object. The booleans are what a host
matches `metadataTrue` rules against; the scalars are bounded (`repo`, `actor`
and `sha` to 120 chars, `htmlUrl` to 512) and no raw payload field ever
reaches them.

| Field | Type | Meaning |
|---|---|---|
| `mentioned` | boolean | same condition as `chat:mention` |
| `isOwnThread` | boolean | `ctx.isOwnThread` |
| `isReplyToSelf` | boolean | `ctx.isReplyToSelf`. For a **review** comment this is GitHub's own relation: `in_reply_to_id` is a comment the bot wrote. GitHub models no such relation for a **top-level** issue or pull-request comment, so amendment 2b derives it from **turn order** — the last comment on the thread older than this one is the bot's. A body that *quotes* the bot without following it is `false` in v1; the quote rule was withdrawn and returns in v1.x (`docs/contract-notes.md`). |
| `isReviewRequested` | boolean | `kind === 'pull.review_requested'`, unless the caller passes `reviewRequestedForSelf: false` |
| `isCiFailure` | boolean | see the `checks.completed` table |
| `fromSelf` | boolean | same condition as `chat:from-self` |
| `isMaintainer` | boolean | same condition as `github:actor=maintainer` |
| `repo` | string | `owner/name` |
| `number` | number \| null | the issue or PR number; `null` for `push` |
| `kind` | `'issue'` \| `'pull'` \| null | the **thread** kind; `null` for `push`. The *event* kind is carried by the `github:` tags, not here. |
| `actor` | string | the actor's login |
| `sha` | string \| null | `event.sha`, for `push`, `pull.synchronize` and `checks.completed` |
| `htmlUrl` | string | the event's GitHub link |

## 6. Rendering bounds

`src/content.ts` is the only path from GitHub to the model, and these are the
bounds it enforces. They are what `test/content.test.ts` asserts.

| What | Bound | On overflow |
|---|---|---|
| A body (event body, comment body, issue/PR body) | `LIMITS.commentChars` = 4000 chars, notice included | `… [truncated N chars]` |
| A diff hunk beside a review comment | `CONTENT_LIMITS.diffHunkLines` = 40 lines | `… [diff hunk truncated, N lines dropped]` |
| A list (comments, review threads, failed checks, files, search hits, labels, reviewers) | `LIMITS.listEntries` = 50 entries | `… and N more (showing 50 of M)` |
| A title, in a header line or a search hit | `LIMITS.titleChars` = 80 chars | `… [truncated N chars]` |

Markdown is passed through verbatim, and so are HTML comments: a sticky marker
(`<!-- sticky:release-notes -->`) is how `upsert_sticky_comment` finds its own
comment again, so the agent has to be able to see one.

**Verbatim means untrimmed.** A body is bounded and otherwise byte-for-byte
what GitHub stored: four leading spaces open an indented code block and two
trailing spaces are a hard break, so neither is stripped. Trimming is used
only to decide whether a body is empty (an all-whitespace body renders as
`(no body)`).

`renderReviewThreads` carries **both** identifiers of a review conversation,
because they address different tools:
`<path>:<line> (<side>) <resolved|unresolved> — thread <ReviewThread.id> (reply id rt:<root comment id>)`.
`ReviewThread.id` is the GraphQL node id `resolve_thread` / `unresolve_thread`
take; `rt:<root comment id>` is the channel thread id `reply_in_thread` takes
(`docs/contract-notes.md`).

`NormalizedEvent.raw` is never read by `tags.ts` or `content.ts`. Both touch
only the named fields of the contract's types, so no raw payload field can
reach a tag, a metadata value or a rendered block.

## 7. The producer ontology

`GITHUB_TAG_ONTOLOGY` (`src/tags.ts`) is the RFC-001 §5 declaration the
feature-set declarations carry. It lists the core tags this server emits,
describes every `github:` tag and its keyed value family, and sets
`open: false` — the vocabulary above is the whole of it.

Two things it deliberately does not do:

- **No `implies` edge into `chat:*`.** RFC-001 §4.1: a producer-declared edge
  into the reserved namespace would let this server promote its own traffic
  into the band a host reserved for being spoken to. The core closure belongs
  to the host and is fixed by the spec.
- **No suggested treatment that promotes unaddressed traffic.** The suggested
  rules only ever make ambient traffic, own echoes, deletions and green CI
  *quieter*. The single `immediate` suggestion requires `chat:reply` beside
  `github:ci=failure` — CI broke on a thread the agent is already in. They are
  advisory either way (RFC-001 §5.2) and apply only on explicit acceptance.
