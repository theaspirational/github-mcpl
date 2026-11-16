- Isolate definitively gone/inaccessible `GITHUB_REPOS` entries instead of letting
  one repository stop the others. Stay connected even when none validate, preserve
  unavailable repositories' poll cursors, and recheck hourly (also without polling).
- Preserve upstream rename/transfer redirect compatibility, including targets
  accessible to the existing token under a new owner. Emit `repo.renamed` with
  `github:repo=renamed`, configured and canonical names, once per changed target;
  case-only differences are silent. Renamed entries keep working without a config edit.
- Report outages/recovery through `repo.unavailable` / `repo.available` and matching
  `github:repo` tags. Retain the latest availability state and rename notice separately
  until an MCPL host can accept them. Cached channel opens honor availability.
- Bind Search/GraphQL results and review-thread nodes to the current canonical target
  reached through a configured entry, rejecting unrelated identities and wrong pulls.
  Do not automatically retry bare-node resolve/unresolve mutations with stale checks.
- Preserve confirmed availability across transient failures; retry with 5–60 second
  backoff without lifecycle noise. Share failed installation discovery and its backoff
  across repository probes, retaining discovery through healthy siblings.
