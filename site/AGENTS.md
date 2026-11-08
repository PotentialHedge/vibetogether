# Vibe Together

Vibe Together's page for people, with `about.html` for how it works, its `agents.md` for agents, and its own specs, served at `vibetogether.agentics.lwirth.com`.
The project around it is `~/dev/vibetogether`, whose `AGENTS.md` and `project/design.md` hold the framing: read them before working here.

- `public/` is served as it is, with no build: `just deploy` pushes it to lwirth-cloud, and dotcloud's `serve.nix` says how it is served.
  The same host proxies `/mcp` to the MCP server, `luiswirth/vibetogether-mcp`.
- The specs are Vibe Together's extensions that more than one client speaks.
  One that only one client speaks stays with that client.
- agentwire, the transport, is `luiswirth/agentwire` (`~/dev/agentwire`), served at `agentwire.agentics.lwirth.com`.

Provenance: agent-autonomous
