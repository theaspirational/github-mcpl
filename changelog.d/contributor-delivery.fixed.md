- Submitted-review reads preserve page 1 when a later page is empty, while
  keeping the first page's read-cap check and bounded descending paging.
- Contributor notification passes pause without API or state changes when
  no connected MCPL host has a granted event egress. An eligible host resumes
  polling; existing cursors survive the pause.
- Refused deliveries retain their thread cursor without freezing the global
  listing watermark or conditional header. After five failed passes, a
  persisted terminal retry record prevents the same notification update from
  restarting the cycle or repeating its drop notice, even across restart.
- Acceptance by either granted event egress counts as delivery. Declining a
  push no longer makes the poller resend an accepted channel message (or the
  reverse); the declined egress is warned about instead.
- Contributor documentation now describes retained truncated windows and their
  unconditional retries, including the shared-token rate-limit cost when a
  window remains saturated.
