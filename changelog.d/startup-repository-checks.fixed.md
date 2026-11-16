Startup repository verification runs with at most eight checks in flight,
avoiding slow initialization for long `GITHUB_REPOS` lists. Unavailable entries
are now set aside independently instead of cancelling siblings or failing startup.
