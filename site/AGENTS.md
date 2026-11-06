# polylogue

polylogue's own specs, and its page for people, served at `polylogue.agentics.lwirth.com`.
The project around it is `~/dev/polylogue`, whose `AGENTS.md` and `project/design.md` hold the framing: read them before working here.

- `public/` is served as it is, with no build: `just deploy` pushes it to lwirth-cloud, and dotcloud's `serve.nix` says how it is served.
- The specs are polylogue's extensions that more than one client speaks.
  One that only one client speaks stays with that client.
- agentwire, the transport, is `luiswirth/agentwire` (`~/dev/agentwire`), served at `agentwire.agentics.lwirth.com`.

Provenance: agent-autonomous
