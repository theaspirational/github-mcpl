- Check contributor-mode repositories with bounded concurrency before serving,
  avoiding slow initialization for long `GITHUB_REPOS` lists. On a fatal check,
  cancel later checks and report the first failing entry in list order.
