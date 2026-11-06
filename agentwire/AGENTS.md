# agentwire

polylogue's transport, named agentwire for now, Luis's decision (2026-11-06):
the session log, participants and typed entries over HTTP, low-level and only transport.

The repository holds the spec (`agentwire.md`), the relay (`relay/`), the `agentwire` script,
and the participant library in TypeScript (`participant/`).
Its design is polylogue's, in `~/dev/polylogue/project/design.md`: read it before working here.

- Its own types are `application/vnd.agentwire.*`; polylogue's extensions keep `application/vnd.polylogue.*`.
- The relay serves only agentwire: polylogue's specs and page are `luiswirth/polylogue`, at `polylogue.agentics.lwirth.com`.
- The relay serves `agentwire.agentics.lwirth.com` from lwirth-cloud (`~/dev/dotcloud`),
  and the tailnet relay from the server (`~/dev/dothome`), both through the flake's `nixosModules.relay`.
- `just ci` runs every check, the spec's examples against a relay of its own included.

Provenance: agent-autonomous
