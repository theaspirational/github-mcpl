- Add opt-in `GITHUB_CHECKS_EMIT=failures` to suppress green `checks.completed`
  events in token polling, App polling and webhooks. Failure, cancelled,
  timed-out, action-required and startup-failure results still emit; stale
  runs remain passing and cannot decide a head with pending checks.
  Mixed suites with a failing run still emit. Suppressed results retain the
  existing dedup/state behavior without blocking a later failing rerun.
  The default `all` preserves existing output; invalid values refuse startup.
