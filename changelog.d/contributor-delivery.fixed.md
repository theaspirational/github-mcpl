- Submitted-review reads continue through empty pages rather than skipping
  earlier pages, with an explicit read cap even for an all-empty walk.
- Contributor notification passes pause without API or state changes when
  no connected MCPL host has a granted event egress. An eligible host resumes
  polling; existing cursors survive the pause.
- Refused thread-event handoffs retain their cursor without freezing the global
  listing watermark or conditional header. After five failed passes, a
  persisted terminal retry record prevents the same notification update from
  restarting the cycle or repeating its drop notice, even across restart.
  A refused `checks.completed` stays on its head/TTL schedule, with no retry
  limit and no drop notice.
- Acceptance by either granted event egress counts as delivery. Declining a
  push no longer makes the poller resend an accepted channel message (or the
  reverse); the sibling egress's decline is warned about and treated as final,
  so the message is not re-sent on that egress.
- Contributor documentation now describes retained truncated windows and their
  unconditional retries, including the shared-token rate-limit cost when a
  window remains saturated.
