- Add opt-in `GITHUB_CHECKS_EMIT=failures` to suppress green `checks.completed`
  events in token polling, App polling and webhooks. Failure, cancelled,
  timed-out, action-required, startup-failure and stale results still emit,
  including mixed suites with a failing run. Suppressed results retain the
  existing dedup/state behavior without blocking a later failing rerun.
  The default `all` preserves existing output; invalid values refuse startup.
