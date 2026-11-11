# agentwire

Vibe Together's transport, named agentwire for now, Luis's decision (2026-11-06):
the session log, participants and typed entries over HTTP, low-level and only transport.

The repository holds the spec (`agentwire.md`), the relay (`relay/`), the `agentwire` script,
and the participant library in TypeScript and in Rust (`participant/`).
The Rust crate, `agentwire`, holds the types of what goes over the wire, which the relay shares, and with its default `client` feature, the client.
Its design is Vibe Together's (`../AGENTS.md`): read it before working here.

- Its own types are `application/vnd.agentwire.<entry>`, and its extensions' `application/vnd.agentwire.<extension>.<entry>`, Vibe Together's included.
- The relay serves only agentwire: Vibe Together's specs and page are `../website`, at `vibetogether.agentics.lwirth.com`.
- The relay serves `agentwire.agentics.lwirth.com` from lwirth-cloud (`~/dev/dotcloud`), through the root flake's `nixosModules.relay`.
- The relay reads the spec and the script from files at each request (`AGENTWIRE_FILES`, the module's `/etc/agentwire-relay`), so a new wording reaches it by a switch that restarts nothing; its own page is still compiled in.
- With an access service (`AGENTWIRE_ACCESS`, the module's `access`), the relay asks it who may be in an owned session and whether it still exists, and which account a token is, as the spec's "Access" says; Vibe Together's accounts service is one. A session that isn't owned depends on it only for a participant with a token. Without one, nothing changes.
- The relay limits what one client adds and how many receives it keeps waiting (`relay/limits.rs`). A client is the account the access service vouches for the participant acting, where it vouches for one, Luis's decision (2026-11-10): "count by account." Otherwise it is the peer's address, or from its own machine the one the proxy names last in `X-Forwarded-For`; a local request that names none or a loopback address isn't limited. The MCP server reaches the relay directly (`AGENTWIRE_RELAY_ADDRESS`, the module's `relayAddress`), since Caddy would drop its `X-Forwarded-For`, and names its caller in each request of an agent's. With `AGENTWIRE_MIN_FREE` (the module's `minFree`, 5 GiB by default) it refuses whatever adds once its disk has less free.
- The relay logs each request to stderr: its method, its path with session addresses and secrets left out, its query's keys, its status and time; never a header.
- `just ci` runs its own checks, the spec's examples against a relay of its own included.

Provenance: agent-autonomous
