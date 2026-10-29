# github-mcpl

An MCPL connector for GitHub. A repository's issues, pull requests,
comments, reviews and check results reach an agent as **push events** and as
**channels**, and the agent acts back through **tools** grouped into feature
sets the host grants (and can roll back). With the App, one server serves
one repository or several of one owner, so one process per owner; with a
user token ([contributor mode](#contributor-mode-user-token)), one serves
the repositories it works in, whoever owns them.

- **Wake, not poll-and-hope.** An issue, a comment, a pull request, a review,
  an inline review comment or a failing check suite becomes one normalized
  event with [tags and metadata](#tags-and-metadata), so the host's wake
  policy decides what is worth an inference and what is not.
- **A channel per thread.** Every issue and pull request is an MCPL channel
  (`github:<owner>/<name>#<number>`); `channels/publish` answers in it, and a
  reply with `threadId: "rt:<id>"` lands inside that review conversation
  rather than at the bottom of the page.
- **Feature sets with rollback.** `github.comments` is checkpointed: a
  rollback deletes the comments created after the checkpoint and restores the
  bodies of the ones edited after it. Nothing GitHub cannot undo is
  checkpointed, and nothing is granted that the host did not grant.
- **No merge, ever.** Not in v1, not behind a flag. The base branch of any
  pull request the server opens or retargets is checked against an allow-list.

Built on [`@animalabs/mcpl-core`](../mcpl-core-ts); sibling of
[slack-mcpl](../slack-mcpl) and [telegram-mcpl](../telegram-mcpl).

> **Status: v1, run end to end against a live GitHub App.** The server answers a
> host's handshake in MCPL or in plain MCP, applies the grant it is given
> (absence is denial), serves the twenty-two tools of the five tool feature
> sets, registers a channel per thread and publishes into one, checkpoints
> every comment write and rolls it back, and turns a webhook delivery or a
> poll pass into a `push/event` and a `channels/incoming` with tags and wake
> metadata. Both ingress paths have been exercised on a private sandbox
> repository: polling, and webhooks over a public tunnel, plus a soak across
> an installation-token expiry. [docs/e2e-report.md](docs/e2e-report.md) has
> every scenario, its timings and every GitHub write the runs made.

## Setup, in order

Everything below runs as the user the agent runs as — on a typical agent
host that is `ubuntu` — and needs no `sudo`. The server is a child process
of the host, so it lives in the agent's home, beside the agent's other
logins. [docs/deploy.md](docs/deploy.md#who-can-read-the-key) says what that
does and does not protect.

### 1. Put the code and Node on the host

Everything after this runs commands out of this repository — step 3 uses a
script from it before GitHub has even created the App — so the checkout comes
first. Node 22.12.0 or newer (nvm is fine), and one clone:

```sh
node --version                                      # v22.12.0 or newer
git clone <this repository> ~/github-mcpl
cd ~/github-mcpl
```

Step 8 builds this same checkout — do not clone it a second time;
`git -C ~/github-mcpl pull` is how you update it later.

### 2. Make the directory the secrets will land in

Everything below writes into `~/.config/github-mcpl`. Create it now, mode
700, so that no key is ever written somewhere looser and chmodded afterwards:

```sh
install -d -m 700 ~/.config/github-mcpl
```

### 3. Create the GitHub App from the manifest

[`app-manifest.json`](app-manifest.json) is a GitHub App manifest: it names
the five permissions the tools need and the eight events the ingress
understands, so you do not have to tick 40 checkboxes correctly. GitHub's
manifest flow is three steps — post the manifest, catch the code GitHub sends
back, exchange the code for the App's credentials — and the third is the one
that hands you the private key and the webhook secret without a download
folder ever touching them.

**a. Post the manifest.** Save this beside the manifest as `create-app.html`,
open it in a browser, paste `app-manifest.json` into the field and submit.
(For an organisation, change the action to
`https://github.com/organizations/<org>/settings/apps/new`.)

```html
<form action="https://github.com/settings/apps/new" method="post">
  <textarea name="manifest" rows="20" cols="100"></textarea>
  <button type="submit">Create the App</button>
</form>
```

Name it on the GitHub page that follows: `rayforce-clone` is the proposal for
the maintainer's clone. The name becomes the bot login with `[bot]` appended
(`rayforce-clone[bot]`), which is what `GITHUB_BOT_LOGIN` must hold.

**b. Catch the code.** GitHub creates the App and redirects your browser to
the manifest's `redirect_url` with `?code=…` — a temporary code, good for one
hour, and the only thing that can fetch the App's credentials. The manifest
points it at `http://localhost:8723/manifest-callback`, so run this one-off
listener on the machine with the browser **before** you submit the form:

```sh
cd ~/github-mcpl                                 # the checkout from step 1
CODE=$(node deploy/capture-manifest-code.mjs)    # then go and submit the form
```

[`deploy/capture-manifest-code.mjs`](deploy/capture-manifest-code.mjs) listens
on loopback for that one redirect, prints the code on stdout — so the command
substitution above captures it — and exits. Everything else it says goes to
stderr, where you can see it. (If you missed the redirect, or your browser is
not on this machine, delete the half-made App and start again, or take path B
below: the code cannot be re-issued.)

This redirect is **not** OAuth. It is how the manifest flow returns the
registration result; the App has no user-authorization flow at all
(`request_oauth_on_install: false`, no `callback_urls`), and it only ever
acts as itself.

**c. Exchange the code for the credentials.** `POST
/app-manifests/<code>/conversions` needs no authentication — the code is the
credential — and answers with the App id, the PEM, the webhook secret and
some OAuth fields this App does not use:

```sh
cd ~/.config/github-mcpl

# Create all three files empty first, mode 600 from the first byte: a
# redirect into a file that already exists keeps that file's mode.
for f in conversion.json app-private-key.pem webhook-secret; do
  install -m 600 /dev/null "$f"
done

curl -sS -X POST -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/app-manifests/$CODE/conversions" \
  > conversion.json

# Split it into the two files the server reads, and nothing else.
jq -r .pem            conversion.json > app-private-key.pem
jq -r .webhook_secret conversion.json > webhook-secret

# The two values that are not secret, for the environment file in step 7.
jq -r '"GITHUB_APP_ID=\(.id)\nGITHUB_BOT_LOGIN=\(.slug)[bot]"' conversion.json

rm -f conversion.json                            # `shred -u`, where you have it
```

Creating the files before anything writes to them is what keeps the key at
mode 600 for its whole life: `install` sets the mode on an empty file, and
the later `>` only truncates and refills it. Never write a key somewhere
looser and move it afterwards. Do not keep `conversion.json`, and do not
paste any of it into a terminal that is being logged: it holds the private
key. The `client_id` and `client_secret` in the response belong to the OAuth
flow this App does not use — there is nothing to store.

> **Path B, by hand.** Without the manifest flow: create the App with
> exactly the permissions and events the manifest lists
> ([Security](#security) says why each one is there), then **Private keys →
> Generate a private key** (a `.pem` downloads once), then **Webhook →
> Secret**, and generate one with `openssl rand -hex 32`. Make the two files
> the same way — empty, mode 600, and only where missing — and fill them in
> place, so the key is never readable by anyone else even for a moment:
>
> ```sh
> cd ~/.config/github-mcpl
> for f in app-private-key.pem webhook-secret; do
>   [ -e "$f" ] || install -m 600 /dev/null "$f"
> done
> cat ~/Downloads/<app>.private-key.pem > app-private-key.pem
> cat > webhook-secret                     # paste the secret, then Ctrl-D
> shred -u ~/Downloads/<app>.private-key.pem   # or rm
> ```
>
> When the key downloaded on another machine (a laptop), fill the file over
> ssh, which writes into the existing file and keeps its mode:
> `ssh <host> 'cat > ~/.config/github-mcpl/app-private-key.pem' < <app>.private-key.pem`.
> The App id is on the App's settings page, and `GITHUB_BOT_LOGIN` is its
> slug with `[bot]` appended.

### 4. Point the webhook somewhere, or turn it off

The App's **Webhook → URL** has to be a public HTTPS address that reaches
this host. Set it now if you have one; otherwise come back after
[choosing how deliveries reach the host](docs/deploy.md#getting-events-in).
If you mean to run polling-only, uncheck **Active** instead, so GitHub stops
queueing deliveries nobody collects.

`X-Hub-Signature-256` is verified with the webhook secret before a delivery
is parsed, so that secret is the only thing standing between your agent and
anyone who learns the URL.

### 5. Install it on the repositories it will serve

**Install App → your account or organisation → Only select repositories →**
pick the ones `GITHUB_REPOS` will name, and no more. The allow-list in the
environment is the second fence; the installation is the first. Start with
one repository: the agent's prompt and wake policies are easier to get right
for one, and a second can be added to `GITHUB_REPOS` later without touching
the App.

### 6. Check the two secret files

```sh
ls -l ~/.config/github-mcpl/
# -rw------- 1 ubuntu ubuntu … app-private-key.pem
# -rw------- 1 ubuntu ubuntu … webhook-secret
```

Mode 600 is enforced, not advised: `readConfig` stats both files and refuses
to start while either carries a group or other bit, naming the file and its
mode (never its contents).

### 7. Set the environment

`readConfig` (in [`src/types.ts`](src/types.ts)) validates all of it and
throws listing every offending variable at once. Secret material is read from
files, never from a variable, and never appears in an error or a log line.
The launcher [`deploy/github-mcpl`](deploy/github-mcpl) loads one file,
`~/.config/github-mcpl/github-mcpl.env`, in both deployment shapes, and
neither starts without it. Start from the example, record the Node to use,
and fill in every `REPLACE_WITH_` value:

```sh
cd ~/github-mcpl
install -m 600 deploy/github-mcpl.env.example ~/.config/github-mcpl/github-mcpl.env
echo "GITHUB_MCPL_NODE=$(command -v node)" >> ~/.config/github-mcpl/github-mcpl.env
"${EDITOR:-vi}" ~/.config/github-mcpl/github-mcpl.env
```

`GITHUB_MCPL_NODE` is the launcher's, not the server's: a host started by
systemd does not have nvm's directories on its `PATH`, so the launcher is
told where Node is instead of looking.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `GITHUB_APP_ID` | yes | — | Numeric App id, from the App's settings page. |
| `GITHUB_APP_PRIVATE_KEY_FILE` | yes | — | Path to the PEM, mode 600. |
| `GITHUB_APP_INSTALLATION_ID` | no | discovered from `GITHUB_REPOS` | Installation to authenticate as. |
| `GITHUB_WEBHOOK_SECRET_FILE` | when `GITHUB_WEBHOOK_PORT` is set | — | Path to the webhook secret, mode 600. |
| `GITHUB_WEBHOOK_PORT` | no | unset = listener off | TCP port of the webhook listener (bind it to loopback, terminate TLS in front). |
| `GITHUB_WEBHOOK_PATH` | no | `/github/webhook` | Path the listener answers on. |
| `GITHUB_POLL_INTERVAL_MS` | no | `0` (off) | Polling fallback: issues and PRs, issue comments and review comments updated since each list's cursor, plus the checks on the heads of the open PRs seen. `0` is off; a non-zero value below `60000` is refused. Partial — it cannot see a submitted review, a review request or a push ([what polling misses](docs/deploy.md#option-3--polling-only-no-webhook-at-all)) — and it is not meant to run alongside the webhook. |
| `GITHUB_REPOS` | yes | — | Comma-separated `owner/name` allow-list; a write anywhere else is refused by name. Several entries must share one owner (one App installation, one token); a second owner is a second server process. With several, every tool call names its repository. |
| `GITHUB_PR_BASE_ALLOW` | no | empty = no PR target allowed | Branches a pull request may target or be retargeted to. A plain `branch` applies to every repository, `owner/name:branch` to that one: `anima-research/rayforce:dev,main`. |
| `GITHUB_STATE_FILE` | no | unset = in-memory only | Durable JSON: checkpoint lineage, rollback bookkeeping, and the polling state: a cursor for each repository and list (`pollCursors`), `lastPollAt` where a list with none starts, and the rows announced as new (`pollNew`). A list with a cursor of its own starts from it, not from `lastPollAt`. |
| `GITHUB_BOT_LOGIN` | yes | — | The App's bot login, e.g. `rayforce-clone[bot]`. From-self and mention detection depend on it. |
| `GITHUB_MAINTAINERS` | no | empty | Comma-separated logins marked `isMaintainer` in metadata and tagged `github:actor=maintainer`. |

### 8. Build and run it

```sh
cd ~/github-mcpl                        # the checkout from step 1
npm ci
npm run build                           # tsc into dist/

# Prove it before the host tries. Expect the startup line on stderr, nothing
# at all on stdout (that is the JSON-RPC channel), and exit 0 at end of input.
deploy/github-mcpl --stdio < /dev/null
# [github-mcpl] info github-mcpl starting {"repos":["owner/repo"], …, "transport":"stdio"}
```

The host starts it for you from then on. Copy
[`examples/recipe-maintainer-clone.json`](examples/recipe-maintainer-clone.json)
(maintainer's clone, full tool surface) or
[`examples/recipe-contributor.json`](examples/recipe-contributor.json)
(contributor-side resident: mentions, review requests and the threads it has
taken part in)
into your host recipe: both carry the `mcpServers.github` entry — the
launcher's absolute path and `--stdio`, nothing else, since every value comes
from the environment file — and a `modules.wake` policy set sized for
GitHub's event volume. Change `/home/ubuntu` in `command` if the agent's home
is elsewhere.

For a standalone daemon under systemd, getting webhook deliveries in, polling
only, who can read the key, and log hygiene, continue in
**[docs/deploy.md](docs/deploy.md)**.

### Wake policies are not optional

A rayforce-sized repository produces 60–115 events a day, and one wake costs
roughly 100k input tokens. A policy set that wakes on everything is about
10M tokens a day of ambient chatter. Both example recipes therefore skip by
default and wake only on what is addressed to the agent:

**The order is the design**, because the host matches first-rule-wins and
`metadataTrue` is an OR-list: one rule that wakes on `isOwnThread` placed
above the CI-success skip wakes the agent on every green build of its own
pull request. Both recipes therefore read exclusions first, the one
exception next, and the wake rules last:

| # | Rule | Matches | Behavior |
| --- | --- | --- | --- |
| 1 | `github-self` | `fromSelf` | `skip` — otherwise the agent answers itself |
| 2 | `github-machine-noise` | `github:push`, `github:ci=success` | `skip` |
| 3 | `github-other-bots` | `chat:from-bot`, without `chat:mention`, `github:pr=review_requested` or `github:ci=failure` | `skip` — dependabot does not get a turn, though a review asked of the agent on its pull request does |
| 4 | `github-ci-failure-own-thread` | `github:ci=failure` **and** `isOwnThread` | `always` — the exception rules 2 and 3 leave room for |
| 5 | `github-direct-address` | `mentioned`, `isReviewRequested`, `isOwnThread`, `isReplyToSelf` | `always` |
| 6 | `github-new-work` (maintainer clone only) | `github:issue=opened`, `github:pr=opened` | `debounce: 60000` — one wake once the burst settles |
| 7 | `github-ambient` | anything else from `github` | `skip`, and `default` is `skip` too |

`test/wp8-policies.test.ts` runs both recipes through connectome-host's own
`EventGate` matcher and asserts that ordering: a green build on the agent's
own pull request is skipped, a broken one wakes it, a bot's pull request
neither wakes nor debounces, a human mention wakes it, and no rule is left
unreachable by an earlier one.

## Contributor mode (user token)

For a resident that contributes to repositories it **cannot install the App on**, such as someone else's upstream: it wakes on reviews, comments and state changes on its own pull requests and on the threads it takes part in.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GITHUB_TOKEN_FILE` | yes (instead of the App variables) | — | Path to a personal access token (classic), mode 600. See **The token** below. |
| `GITHUB_BOT_LOGIN` | no | the token's login | The token owner's login, spelled as GitHub spells it (no `[bot]`). From-self and mention detection use it. Unset, the server takes it from `GET /user` at start, and stops when GitHub doesn't answer. Set, it is checked against the token's own login when GitHub answers, and the server stops if they differ; when GitHub doesn't answer, it starts unchecked and logs a warning. |
| `GITHUB_REPOS` | yes | — | The repositories the agent works in, and the write allow-list. In this mode it may span several owners. Notifications from any other repository are dropped. Spell each as GitHub does: at start the server checks each against GitHub and stops on a different spelling, or a repository the token can't see. |
| `GITHUB_POLL_INTERVAL_MS` | no | `60000` | Notifications poll interval; values below `60000` are refused. GitHub's `X-Poll-Interval` is honoured when it asks for longer. |
| `GITHUB_STATE_FILE` | recommended | — | Keeps the notifications watermark, when GitHub last answered, each thread's cursor, the threads to read again and the dedup ring across restarts. Without it, every start begins as a first start does (below): activity from a longer downtime isn't delivered, and some from before the start can arrive twice. |

Setting both `GITHUB_TOKEN_FILE` and the App variables is a startup error, and so is `GITHUB_APP_INSTALLATION_ID`. `GITHUB_WEBHOOK_PORT` is refused in this mode: GitHub doesn't send webhooks for repositories you don't administer.

**The token.** GitHub serves the notifications endpoints to a personal access token (classic) only; a fine-grained token can't read them. Give it the narrowest scopes that work: `notifications`, plus `public_repo` when the repositories are public. `repo` is full read and write access to every private repository the account can reach, so use it only when a private repository needs it.

**The account.** Use an account the agent alone posts from, such as a machine account. GitHub shows the agent's comments, reviews and pull requests as that account's, and this server treats everything that account does as the agent's own: its own events are tagged from-self and don't wake it, and the comment tools let it edit and delete that account's comments. This is account ownership, not proof that this process wrote a comment. A human's later edits are not protected by a version check: an edit or sticky update can overwrite them, and rollback can restore an older body or delete an agent-created comment after a human changed it. Do not share the posting account or treat rollback as safe concurrent editing.

**How events get in.** Notification polling pauses without API calls or state changes until a connected MCPL host has at least one granted event egress, and pauses again if that ceases to be true. The server lists `GET /notifications?all=true&participating=true&since=…` from where the last listing got to, with `If-Modified-Since` after a complete listing, so an idle inbox can return a `304` that doesn't count against the rate limit. Truncated listings instead retain their window for an unconditional retry. Read and unread threads are listed alike, and nothing is marked read. For each listed issue or pull request in `GITHUB_REPOS`, it reads what is new since its last read: comments, a pull request's review comments and submitted reviews, and its state. Each becomes the same `push/event` and `channels/incoming`, with the same tags and metadata, as in App mode. A thread opened since the last pass arrives as opened, a close or merge as closed (a merge tagged `github:pr=merged` too), with whoever closed or merged it as the actor, and an edit to an issue as edited, attributed to whoever opened it, since GitHub's row doesn't say who edited it; a thread opened and closed between two passes arrives as closed. An edit to a closed issue or pull request arrives as nothing. A reopened issue arrives as edited, as with App mode's repository poll, and a reopened pull request as nothing, as with a webhook delivery. A listed pull request whose notification gives `review_requested` as its reason arrives as `pull.review_requested` too, with the pull request's author as the actor, since the notification doesn't say who asked. It arrives once for each update of the notification listed with that reason, so if GitHub keeps the reason while the thread moves on, a later update, a comment for one, brings it again. Each pass also looks up the checks on the heads of the open pull requests the token's user authored in `GITHUB_REPOS`, the 100 most recently updated, 20 a pass and in turns past that, and a head whose checks have all finished arrives as `checks.completed`, as in App mode, once for each conclusion and set of failed jobs. Once a head's result has arrived with every run finished, it isn't looked up again until its pull request is updated or ten minutes have passed since its head was read, so a re-run on the same head is seen on the first look after that, a pass or so past ten minutes. A head with no check runs two minutes after it was read is left the same way, so runs created later than that arrive with the next look. A failure that arrives while other runs go is looked up each pass until they finish. The tools' `search_issues` searches one repository in `GITHUB_REPOS`: it drops `repo:`, `user:`, `org:` and `owner:` qualifiers from the query, and leaves out, and counts, any result on the page from another repository.

**What a pass costs.** The listing, one request a page of 50 threads, free when it's a `304`. One search for the token user's open pull requests, on the search API's own limit of 30 a minute, which the tools' `search_issues` shares, on every pass whose thread reads met no rate limit, a `304`'s included. Then for each of them not left as above, up to 20 a pass and in turns past that, one check-runs request, more past 100 runs, and one more for its head when it moved since the last pass or that read is ten minutes old. With 20 open pull requests whose checks have finished and nothing moving, that's about 240 requests an hour, besides the 60 searches. Then, for each thread it lists or that waits, two requests for an issue (its row and its comments) and four for a pull request (its row, its comments, its review comments and its reviews), each list taking more when its new rows run past a page, and the reviews one more once a pull request has more than 100 reviews. The first time the server handles an event on a thread after it starts, its event pipeline also reads the thread itself (for a pull request, with its head's check runs), its comments and a pull request's review threads, to learn whether the agent took part there, as in App mode. The agent's own tool calls draw on the same 5,000 an hour.

**When a thread can't be read or delivered.** A thread whose read fails, or whose event is accepted by neither granted egress, waits on a retry list that keeps its place, and is read first on each later eligible pass whose listing gets through, for up to five failed passes in a row. Acceptance by either `channels/incoming` or `push/event` counts as delivery; a decline by the other is logged, not retried. Failed handoffs hold the thread's cursor, not the global listing watermark or conditional header. At the retry limit the server stops trying that notification update and attempts one `thread.read_failed` notice, naming the cause, tagged `chat:mention`; a thread gone or out of the token's reach gets that at once. A retained terminal retry record prevents the same thread/update from starting another retry cycle or repeating the notice, including across restart and if the notice itself was refused. A strictly newer notification update reopens the thread from its retained cursor. GitHub's rate limit counts no pass against a thread: it ends the pass's reads, and the rest wait for the next pass. A thread with more new rows in one of its lists (comments, review comments or reviews) than one read takes, 2,000 a list, is read from its latest update on, and its `thread.read_failed` event says its backlog was skipped. A listing that runs past 20 pages (1,000 threads) delivers what it listed, retains the original window and reach-back anchor, clears the conditional header, and logs an error before retrying unconditionally on the next eligible pass. A persistently saturated window can repeat without reaching its tail; its repeated listing pages and thread reads can exhaust the token's rate limit and degrade tools that share it.

**Where delivery begins.** With no watermark stored, the first start or pass with an eligible host begins one poll interval before that point and logs the instant to stderr. No initial watermark is written while polling is paused; an existing watermark survives the pause. GitHub writes a notification some seconds after the activity it reports (about 20 s on one account in October 2026). So a thread read for the first time is read from five minutes before GitHub's previous answer to a listing, or, at a first start, five minutes before that instant. Comments and reviews from those five minutes arrive, and so does an opening or a close; anything older on that thread doesn't. A thread that opened in those five minutes arrives as opened, with its text as it is now. Otherwise an edit on a thread read for the first time arrives as nothing, since with nothing to compare it with, an edit can't be told from a comment's bump: an edit that mentions the agent on an older issue it hasn't read before doesn't reach it.

**What it can't see.** Threads you aren't part of, pushes, and the checks on pull requests the token's user didn't open. GitHub lists a pull request's thread when someone pushes to it, but none of what this mode reads of a thread shows a push, so it delivers nothing for one. The agent learns of new commits from what comes with them, from a check result, or by reading the pull request. An edit to an open pull request arrives as nothing, as with a webhook delivery. A mention arrives with the comment, review or opening that carries it.

**Security.** A user token can do whatever its user can, wherever the user can. The tools' allow-list (`GITHUB_REPOS`) and the absence of merge still apply, but they're the server's limits, not GitHub's. An `APPROVE` through `github.review` is the user's own approval, and counts toward branch protection wherever the user has write access; the shipped recipe doesn't enable that feature set.

The recipe is App mode's contributor one, [`examples/recipe-contributor.json`](examples/recipe-contributor.json): its wake policies serve both modes, and the launcher reads this mode's variables from the same environment file.

## Plain-MCP mode

When the host does not advertise `experimental.mcpl` in `initialize`, the
server serves **tools only**: every feature set's tools are listed and
callable, and there are no push events, no channels and no rollback. That is
the whole difference — the same binary, the same environment, no flag. It
makes github-mcpl usable from a stock MCP client, at the cost of the part
that makes it interesting (nothing wakes anyone).

## Feature sets and tools

The host grants feature sets; absence is denial (MCPL §5.3). Until the grant
arrives nothing is registered, nothing is listed and no tool runs. Under MCPL
`tools/list` offers exactly the granted surface, so a listing never advertises
a call that would be refused; a plain-MCP client sees every tool, because there
is no grant on that connection to narrow it by.

`github.events` needs only `pushEvents`: a host with no channel support at all
still wakes through `push/event`, and a host that grants the channel paths but
not `pushEvents` still gets its `channels/incoming` deliveries. Each channel
surface is checked at its own call — `channels.register` to announce a channel,
`channels.incoming` to deliver to one, `channels.publish` to write back,
`channels.lifecycle` to open and close.

| Feature set | Tools | Rollback |
| --- | --- | --- |
| `github.events` | — (push events and `channels/incoming` delivery) | no |
| `github.read` | `get_issue`, `get_pull_request`, `list_comments`, `list_review_threads`, `list_pull_request_files`, `get_check_runs`, `search_issues` | no |
| `github.comments` | `comment`, `reply_in_thread`, `edit_own_comment`, `delete_own_comment`, `upsert_sticky_comment` | **yes** |
| `github.review` | `create_review`, `resolve_thread`, `unresolve_thread` | no (GitHub cannot delete a review) |
| `github.issues` | `create_issue`, `edit_issue`, `close_issue`, `reopen_issue` | no |
| `github.pr` | `create_pull_request`, `edit_pull_request`, `request_review` | no |

Notes worth knowing before you grant them:

- `upsert_sticky_comment(thread, marker, body)` finds the agent's own comment
  containing an HTML marker and edits it in place, else creates it. One
  running status comment instead of a tail of them — the same thing
  `rayforce-audit` does with `<!-- rayforce-audit-failure-comment -->`.
- `create_pull_request` and a base change in `edit_pull_request` refuse a base
  outside `GITHUB_PR_BASE_ALLOW`. Empty means no pull request may be opened.
- `github.pr` has no merge tool and no branch deletion. There is nothing to
  disable; the capability does not exist.
- Every write tool refuses a repository outside `GITHUB_REPOS`, by name,
  before the call reaches GitHub.

## Tags and metadata

Every event carries RFC-001 core tags, the `github:` namespace, and a flat
metadata record the host matches `metadataTrue` against. The per-event detail
lands in `docs/events.md` with work package .4; the vocabulary itself is the
contract and is listed here in full.

**Core tags** (producer `github`):

| Tag | When |
| --- | --- |
| `chat:mention` | the body mentions `@<GITHUB_BOT_LOGIN>`, on an event that brings that body (opened, edited, a comment, a review); never on a close, reopen or push |
| `chat:reply` | the event is on a thread the bot authored or commented in, or replies to the bot's comment |
| `chat:ambient` | neither of the above |
| `chat:from-human` / `chat:from-bot` / `chat:from-self` | who acted |
| `chat:thread` | a review comment (it lives in a review conversation) |
| `chat:edited`, `chat:deleted` | an edit or a delete |
| `chat:has-link` | the body carries a URL |

`chat:dm` is never emitted: GitHub has no direct message.

**`github:` tags:**

| Tag | Values |
| --- | --- |
| `github:issue=` | `opened`, `edited`, `closed`, `reopened` |
| `github:pr=` | `opened`, `synchronize`, `ready_for_review`, `review_requested`, `closed`, `merged` |
| `github:review=` | `approved`, `changes_requested`, `commented` |
| `github:review-comment` | an inline comment on a diff |
| `github:ci=` | `success`, `failure` |
| `github:push` | a push with no thread attached |
| `github:read-failed` | contributor mode stopped reading a thread until it next moves, or skipped its backlog; the event also carries `chat:mention`, since the server addresses it to the agent |
| `github:actor=maintainer` | the actor is in `GITHUB_MAINTAINERS` |

**Metadata.** Booleans first — these are what `metadataTrue` matches:

| Key | Meaning |
| --- | --- |
| `mentioned` | the body mentions the bot |
| `isOwnThread` | the bot authored the thread or has commented in it |
| `isReplyToSelf` | the event replies to a comment the bot wrote: a **review** comment whose `in_reply_to_id` is one of the bot's, or a **top-level** comment that immediately follows one of the bot's on the thread (amendment 2b, turn order). Quoting the bot's text does not count in v1 — see `docs/contract-notes.md`. |
| `isReviewRequested` | the bot was asked for a review |
| `isCiFailure` | a check suite on this thread's head failed |
| `fromSelf` | the bot itself acted (**skip this first in every policy set**) |
| `isMaintainer` | the actor is in `GITHUB_MAINTAINERS` |

and the fields `repo` (`owner/name`), `number`, `kind` (`issue` \| `pull`),
`actor`, `sha`, `htmlUrl`. Every string is bounded; raw webhook payloads never
reach metadata and never reach the model.

## Security

- **Secrets live in files, not in the environment and not in the recipe.** The
  App private key and the webhook secret are read from paths named by
  `GITHUB_APP_PRIVATE_KEY_FILE` and `GITHUB_WEBHOOK_SECRET_FILE`, both
  enforced at mode 600. A value in the environment is visible to every child
  process and to `systemctl show`; a value in a recipe ends up in git.
- **The key is as private as the agent's user.** The server runs as the
  agent's own user, so the agent can read the App private key, as it can its
  other logins. A separate service user would not change that on a host where
  the agent has passwordless `sudo`, which is the usual agent host. What
  bounds a leaked key is the rest of this list: the repository allow-list, the
  permissions below, no merge. Generating a new key in the App's settings and
  deleting the old one revokes it. [docs/deploy.md](docs/deploy.md#who-can-read-the-key)
  has the cases where isolation is real.
- **An allow-list of repositories.** `GITHUB_REPOS` is required. Events from
  elsewhere are dropped before they are rendered; writes elsewhere are
  refused by name. Install the App only on the repositories it names: the
  allow-list is a second fence, not the first. Several repositories share
  one agent, one context and one prompt, so keep them to repositories whose
  rules the prompt can state together.
- **A base allow-list.** `GITHUB_PR_BASE_ALLOW` is empty by default, which
  means no pull request may be opened or retargeted at all. For rayforce it is
  `dev`, so the release branch is unreachable even by mistake.
- **No merge.** No tool merges, closes a release branch or deletes a branch.
- **Bodies from strangers are data, not instructions.** An issue body, a
  comment, a review and a check's output are text written by other people,
  reaching a model that holds a write token. The server forwards them as
  content and nothing more — it never acts on them — but the agent's own
  prompt has to say so, and both example recipes do. Treat anyone who can
  open an issue on the repository as someone who can type into your agent's
  context.
- **The permissions are the minimum the tools need:** `issues: write` (issue
  tools and issue comments), `pull_requests: write` (PR tools, reviews,
  review-comment replies, review-thread resolution), `contents: read` (file
  lists and refs; never write), `checks: read` (check runs and conclusions),
  `metadata: read` (mandatory for every App). No `administration`, no
  `workflows`, no `members`, no OAuth user flow — the App acts only as itself.

## Limits in v1

- **One owner per process.** Repositories of two owners are two App
  installations and two tokens; run a process per owner.
- **No attachments.** `channels/publish` with an attachment is refused with a
  clear error; images in an incoming body stay as the links GitHub put there.
- **No CI log fetch.** A failing check arrives with its job names and URLs;
  the agent reads the log by following the URL as a human would, or does
  without. (RFC-005 references for logs and diffs are on the roadmap, not
  here.)
- **No merge, no branch deletion, no release-branch write.**
- **Polling is no faster than 60 s** and cannot see pushes that touch no
  thread.
- **No reactions, no labels, no assignees, no projects, no releases.**

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build     # tsc into dist/
```

Node 22.12 or newer, ESM, TypeScript. Stdout carries only JSON-RPC: every
diagnostic goes through the `Logger`, which writes to stderr. No test in this
package reaches the network.

| File | Work package | Role |
| --- | --- | --- |
| `types.ts` | .1 | Every shared type and constant, the channel and thread id helpers, `readConfig`, `Logger`. Read by all, edited by nobody else. |
| `grant.ts`, `errors.ts` | .1 | Capability-grant state, `uses` validation, the §6.7 degradation receipt, the §6.6 error codes. |
| `github-adapter.ts` | .2 | `GitHubAdapter implements GitHubApi` over octokit: App auth, installation-token refresh, rate-limit backoff. The only file that knows octokit exists. |
| `webhook.ts`, `poller.ts` | .3 | Ingress: signature-checked deliveries and repository since-polls become `NormalizedEvent`s; dedup; allow-list. |
| `tags.ts`, `content.ts` | .4 | Pure functions: `tagsFor`, `renderEvent`, `renderThread`, `renderPullRequestSummary`, `renderChecks`, all bounded by `LIMITS`. |
| `channels.ts` | .5 | Channel registry and descriptors, lazy registration, `channels/incoming`, `channels/publish`, typing as a no-op. |
| `feature-sets.ts`, `tools-*.ts` | .6 | Feature-set declarations and the read, issues, pr and review tools. |
| `tools-comments.ts`, `state.ts` | .7 | Comment tools including the sticky upsert; checkpoint lineage and rollback. |
| `server.ts`, `index.ts` | .9 | Handshake, `featureSets/update`, tool routing, the event pipeline, plain-MCP mode. |

Changelog entries land as fragments in [`changelog.d/`](changelog.d/README.md).
Contract decisions taken where TASK-SRHKG.1's contract left a type
under-specified are in [`docs/contract-notes.md`](docs/contract-notes.md). A
target repository's own operating notes — branch model, commit style, CI
gates, review rounds, issue style — belong with the host's deployment, beside
its recipe, not in this repository: the connector enforces none of them, and
the agent's prompt is where they take effect.
