# agentwire

Vibe Together's transport, named agentwire for now, Luis's decision (2026-11-06):
the session log, participants and typed entries over HTTP, low-level and only transport.

The repository holds the spec (`agentwire.md`), the relay (`relay/`), the `agentwire` script,
and the participant library in TypeScript and in Rust (`participant/`).
The Rust crate, `agentwire`, holds the types of what goes over the wire, which the relay shares, and with its default `client` feature, the client.
Its design is Vibe Together's, in `~/dev/vibetogether/project/design.md`: read it before working here.

- Its own types are `application/vnd.agentwire.<entry>`, and its extensions' `application/vnd.agentwire.<extension>.<entry>`, Vibe Together's included.
- The relay serves only agentwire: Vibe Together's specs and page are `luiswirth/vibetogether`, at `vibetogether.agentics.lwirth.com`.
- The relay serves `agentwire.agentics.lwirth.com` from lwirth-cloud (`~/dev/dotcloud`),
  and the tailnet relay from the server (`~/dev/dothome`), both through the flake's `nixosModules.relay`.
- The relay reads the spec and the script from files at each request (`AGENTWIRE_FILES`, the module's `/etc/agentwire-relay`), so a new wording reaches it by a switch that restarts nothing; its own page is still compiled in.
- With an access service (`AGENTWIRE_ACCESS`, the module's `access`), the relay asks it who may be in a guarded session and which guarded sessions last, and which account a token is, as the spec's "Access" says; Vibe Together's accounts service is one, and its rooms are the guarded sessions. A session that isn't guarded depends on it only for a participant with a token. Without one, nothing changes.
- The relay logs each request to stderr: its method, its path with session tokens and secrets left out, its query's keys, its status and time; never a header.
- `just ci` runs every check, the spec's examples against a relay of its own included.

Provenance: agent-autonomous
