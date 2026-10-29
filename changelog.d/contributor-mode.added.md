- **Contributor mode** (#5): with `GITHUB_TOKEN_FILE` instead of the App variables, the server authenticates
  with a personal access token (classic) and gets its events from `GET /notifications` (the threads its user
  takes part in), so a resident can follow its own pull requests and threads in repositories where the App
  isn't installed. Notifications from repositories outside `GITHUB_REPOS` are dropped, and `GITHUB_REPOS`
  may span several owners. A first start delivers what GitHub notified from one poll interval before it. A
  thread the server stops reading after repeated failures gets one `thread.read_failed` event on its channel
  (tags `github:read-failed` and `chat:mention`). The webhook listener is refused in this mode. A
  notification whose reason is `review_requested` arrives as `pull.review_requested`, and the server looks
  up the checks on the heads of the token user's open pull requests, the 100 most recently updated, so a
  settled result arrives as `checks.completed`, as in App mode. `GITHUB_BOT_LOGIN` is optional in this mode: unset, it is the token's
  login.
- **`search_issues`**, in both modes, drops `user:`, `org:` and `owner:` qualifiers from a query as it already
  dropped `repo:`, since GitHub widens a search to each of them, and leaves out any result from another
  repository on the page, saying how many.
- **A polled merge** is tagged `github:pr=merged` beside `github:pr=closed`, as a webhook delivery's is, in App
  mode's repository poll too: the issues endpoint's row says whether a pull request was merged. Otherwise App
  mode is unchanged.
