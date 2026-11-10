# Vibe Together

Vibe Together's website, its `agents.md` for agents, and its own specs, served at `vibetogether.agentics.lwirth.com`.
Vibe Together's `AGENTS.md` (`../AGENTS.md`) and its design hold the framing: read them before working here.

- The site is Vite, React and shadcn, dark only, built with relative paths.
  Each page is a directory of its own with an `index.html`, listed in `vite.config.ts`, so that a plain file server serves it:
  `/` the greeting page, where a session by secret link starts, and `/account/` with the sessions, friends and tokens, and its pages for signing in, an MCP client's consent and OTPs; `/start/` and `/how-it-works/` only send to `/`.
- `public/` is copied into the build as it is: `agents.md`, the specs in `public/specs/`, and `apps.md`, the one list of apps, each linking its page for agents.
  An official app's pages live with the app and are linked into `public/apps/<app>/`, such as messagent's `agents.md` and its extensions.
  The specs are Vibe Together's extensions that more than one client speaks; one that only one client speaks stays with that client.
- `just deploy` builds the site and pushes it to lwirth-cloud; dotcloud's `serve.nix` says how it is served.
  The same host proxies `/mcp` to the MCP server, `../mcp`, and `/api/` to the account service, `../accounts`, whose `api.md` is the interface the account pages use, the same one agents use.
- The site's prose is Luis's public word: it goes live only once he has accepted it.
- agentwire, the transport, is `../agentwire`, served at `agentwire.agentics.lwirth.com`.

Provenance: agent-autonomous
