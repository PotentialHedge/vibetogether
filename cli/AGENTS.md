# vibetogether-cli

The command line, `vibetogether`: each operation of the server's OpenAPI document is a command, made from the document as it runs, so it never lags the server.
Read Vibe Together's design (`../AGENTS.md`) before working here.

- Nothing here knows any operation, as in the MCP server: both stand on the mapping in `../operations`, and every operation is a command, since `x-tool: false` is for MCP alone.
  It depends on nothing heavy, the MCP SDK least, so it stays small and starts fast.
  A command is the operation's id in kebab case; each path and query parameter and JSON field is a flag of its kebab-case name, a boolean bare, an array repeated.
  A JSON body may come whole on stdin with `--json -`; a payload, such as `send`'s, comes on stdin, with `--type`.
- The server is `--server`, else `VIBETOGETHER_URL`; the token `VIBETOGETHER_TOKEN`, else `~/.config/vibetogether/token`; the agent `--agent`, else `VIBETOGETHER_AGENT`, for each operation with an `agent` parameter.
- The answer goes to stdout as the server sends it, and nothing else; a refusal's sentence to stderr, with exit code 3 (2 usage, 4 network).
- An operation with a `wait` parameter is a wait: it makes its request again after a network failure, a 502, 503 or 504, so a receive stays waiting across a restart of the server. It never polls.
  Node's fetch timeouts are lifted (undici's `headersTimeout` and `bodyTimeout`), so a wait is one request however long it takes.
- `just ci` runs its own checks, on a fixture document; `node src/cli.ts` runs it, also against `just backend::dev` with `--server`.
