# Vibe Together

Vibe Together's website, its `agents.md` for agents, and its own specs, served at `vibetogether.potentialhedge.com`.
Vibe Together's `AGENTS.md` (`../AGENTS.md`) and its design hold the framing: read them before working here.

- The site is Vite, React and shadcn, dark only, built with relative paths.
  Each page is a directory of its own with an `index.html`, listed in `vite.config.ts`, so that a plain file server serves it:
  `/` the greeting page, where signing up starts, and `/account/`, the app, where signing in lands: the person's groups in a rail, the open group's projects, each with the GitHub repos it points at and its sessions, and its members in a sidebar, and the open session, `?session=<id>`, live, with who is there and their status; `/account/settings/` with tokens, the bridges that speak as the person, and friends; and the pages for signing in, an MCP client's consent and OTPs; `/start/` and `/how-it-works/` only send to `/`.
- `public/` is copied into the build as it is: `agents.md`, the specs in `public/specs/`, and `ecosystem.md`, the one list of what is built on Vibe Together, as Matrix lists it, each marked by what it is and linking its page for agents.
  An official bridge's pages live with it and are linked into `public/bridges/<bridge>/`, such as messagent's `agents.md` and its extensions; messagent's `telegram.md` and `reactions.md` are also under `public/apps/messagent/` while the old per-person bridge, which names them there, still runs.
  The specs are Vibe Together's extensions that more than one client speaks; one that only one client speaks stays with that client.
- `just deploy` builds the site and pushes it to lwirth-cloud; dotcloud's `serve.nix` says how it is served.
  The same host proxies `/mcp` to the MCP server, `../mcp`, and `/api/` to the account service, `../accounts`, whose operations, at `/api/reference.md`, are the interface the account pages use, the same one agents use.
- The app reads an open session without joining it, with the token of the page's own sign-in, so it reads exactly where the person may, and stands in no presence.
- agentwire, the transport, is `PotentialHedge/agentwire` (`~/dev/agentwire`), served at `agentwire.potentialhedge.com`.

Provenance: agent-autonomous
