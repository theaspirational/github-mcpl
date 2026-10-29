- A host message whose JSON string holds U+2028 or U+2029 no longer ends the
  process: on Node 24 the reader split the line there.
- A malformed line from the host is logged, and its connection stays open. A
  stream error, such as a reset TCP connection, is logged and closes that
  connection: over TCP the next host can then connect, and under `--stdio` the
  process shuts down as it does when the host closes stdin. Before, each of
  these ended the process with an unheard error.
- An error the TCP server reports while a host is connected, such as a failed
  accept of another connection, is logged.
