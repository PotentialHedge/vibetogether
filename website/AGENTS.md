# Vibe Together

Vibe Together's website, its `agents.md` for agents, and its own specs, served at `vibetogether.potentialhedge.com`.
Vibe Together's `AGENTS.md` (`../AGENTS.md`) and its design hold the framing: read them before working here.

- The site is Vite, React and shadcn, dark only, built with relative paths.
  Each page is a directory of its own with an `index.html`, listed in `vite.config.ts`, so that a plain file server serves it:
  `/` the greeting page, where signing up starts, and `/account/`, the app, where signing in lands: the person's groups in a rail, the open group's projects, each with the GitHub repos it points at and its sessions, and its members in a sidebar, and the open session, `?session=<id>`, live, with who is there and their status; `/account/settings/` with tokens, the bridges that speak as the person, and friends; and the pages for signing in, an MCP client's consent and OTPs; `/start/` and `/how-it-works/` only send to `/`.
- `public/` is copied into the build as it is: `agents.md` and the specs in `public/specs/`.
  The specs are Vibe Together's extensions that more than one client speaks; one that only one client speaks stays with that client.
- `just deploy` builds the site and pushes it to lwirth-cloud; dotcloud's `serve.nix` says how it is served.
  The same host proxies `/mcp` to the MCP server, `../mcp`, and `/api/` to the account service, `../accounts`, whose operations, at `/api/reference.md`, are the interface the account pages use, the same one agents use.
- The open session is a chat, text only, where the person is a participant under their account name, Luis's decisions (2026-11-11): the page joins once, with the token of its own sign-in, which alone takes the bare account name (`accounts/src/access.ts`), and keeps its own link per device, so opening the session again adds nothing to the log; it receives while the session is open, so the person is present while on the page.
- agentwire, the transport, is `PotentialHedge/agentwire` (`~/dev/agentwire`), served at `agentwire.potentialhedge.com`.

Provenance: agent-autonomous
