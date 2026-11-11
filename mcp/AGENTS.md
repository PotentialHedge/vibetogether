# vibetogether-mcp

An MCP server that lets an agent take part in a Vibe Together session.
It speaks chat (`../website/public/specs/chat.md`), statuses included, on top of agentwire (`../agentwire/agentwire.md`),
as a service of its own: agentwire stays transport only.
Read Vibe Together's design (`../AGENTS.md`) before working here.

- Streamable HTTP at `/mcp`, so adding it to a harness is one URL.
- Tools: `join`, `send`, `receive`, `status`, `participants`, `leave` and `read`, on a session, written here with their behaviour.
  `read` reads a session's log without joining it (`GET <link>/log`), with the agent's token, as the web app does.
  With an account service, every other tool is one of its operations, generated from its OpenAPI document, Luis's decision (2026-11-10): each operation a token may call is a tool of its id, with its description and arguments, called as the same request with the agent's token (`src/operations.rs`), and the document's concepts go into the instructions. The document is read again after a minute.
  `join` shows the relay's `about`, which the account service gives for a session of a project: the project and its repos.
  `status` and `participants` take over Hivemind's status and inspect, Luis's agreement (2026-11-09); `participants` reads each one's latest status from the log, so the relay stays agnostic to it.
  Every tool but `join` and `read` takes the participant's own link, which `join` returns:
  protocol version 2026-07-28 has no MCP sessions, so the link is the participant.
- `receive` returns once an entry pings the participant, or once its optional `wait` is over, with everything since the last receive, each marked ping or fyi.
  For a client that declares the tasks extension (SEP-2663) it answers with a task at once;
  otherwise it blocks, with progress notifications when the client asks for them.
- Read receipts are truthful, the user's decision: a message counts as read exactly when it is in the agent's context.
  The server waits with `after=<last taken>&read=<last handed over>`, and acknowledges entries with `read=` as it hands them over:
  for a task, when the client fetches its finished result; for a blocking receive, as it returns.
- The relay keeps one receive per participant, and a newer one ends the waiting one.
  So every receive of the server's own but the waiting one, as for `participants` or a handover, tells the waiting one to receive again (`Participant::replaced`).
- Images reach the agent as MCP image content, up to 5 MB; other files as how to fetch them.
  `send` takes text, or a file in base64 with its type and name, at most the relay's 10 MB.
- The server acts on links of its own relay only, `AGENTWIRE_RELAY`, and of the form the relay makes, so no tool argument makes it send a request, or an agent's token, anywhere else (`tests/links.rs`).
- Beside the relay, it reaches it directly (`AGENTWIRE_RELAY_ADDRESS`, the module's `relayAddress`), keeping the public origin in its links, and names the agent's client in `X-Forwarded-For` on each request it makes for it, so that the relay's limits hold per agent's client rather than for the server as a whole wherever the relay counts by address; it counts an agent signed in to an account by the account.
- It logs each request's method, path, status and time to stderr, and nothing of its query, headers or body.
- The server's only state is in memory: per link, the entries it took from the relay and has not handed over yet.
- With an account service (`../accounts/api.md`, "The MCP server"), nothing works without an account, Luis's decision (2026-11-10): "always require accounts and every sessions only allows in memebers".
  Every request without a token, or with one the service rejects through `GET /api/me`, gets MCP's 401 challenge, naming the server's metadata, which the account service serves, so the client signs in as it connects.
  `join` takes only the service's sessions, an account's or a DM, as `GET /agentwire/sessions/<id>` says: a session of the relay's alone is no Vibe Together session.
  The server joins with the token the request carried, so the relay's presence shows the account, as `verified` next to the name.

## Running and testing

- `just dev` serves at `http://127.0.0.1:8792/mcp`; `VIBETOGETHER_MCP_ADDRESS` changes the address,
  and `VIBETOGETHER_MCP_HOSTS`, separated by commas, the hosts it accepts, by default only loopback ones.
  A session's address, or its last part alone, is on the relay at `AGENTWIRE_RELAY`, by default the public one;
  for a local relay, run `just agentwire::dev` and set `AGENTWIRE_RELAY=http://127.0.0.1:8790`.
  `VIBETOGETHER_MCP_ACCOUNTS`, the account service's URL, turns signing in on, with `VIBETOGETHER_MCP_RESOURCE`, the server's public URL, for the challenge.
- It speaks agentwire through the `agentwire` crate, agentwire's Rust participant library.
- `just ci` runs its own checks.
  The tests in `tests/` run a relay in-process, from the `agentwire-relay` crate.
- With Claude Code: `claude -p --mcp-config <file>`, the file naming the server as `{"type":"http","url":"http://127.0.0.1:8792/mcp"}`.
  `-p` declares no tasks, so it takes the blocking path.
- The root flake's `nixosModules.mcp` runs it as a NixOS service, on 127.0.0.1, with the hosts, the relay, and the account service as options.
  It is meant for lwirth-cloud (`~/dev/dotcloud`), behind Caddy at `vibetogether.agentics.lwirth.com/mcp`, which serves the rest of that host as the static page.

Provenance: agent-autonomous
