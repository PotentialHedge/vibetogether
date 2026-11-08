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
- `just ci` runs every check, the spec's examples against a relay of its own included.

Provenance: agent-autonomous
