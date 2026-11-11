# vibetogether-backend

Vibe Together's backend: one Node process that serves the whole API, accounts and sessions alike, and the MCP server.
People sign in with GitHub; an account holds its groups with their projects and sessions, its friends with a DM each, and its logins.
Its interface is its operations, defined once in the code and served as an OpenAPI document and a reference, and `api.md` for the rest. Vibe Together's design (`../AGENTS.md`): read it before working here.

- Hono on Node, which runs the TypeScript sources as they are.
- Better Auth, Luis's decision, with its device authorization (OTPs), MCP plugin (the OAuth server for MCP clients) and bearer plugins.
  Its session table is named `login`: a sign-in in a browser, or a machine's token, with the machine in `machine`.
- One SQLite database, `node:sqlite`, holds Better Auth's tables and the backend's own (`src/db.ts`).
  No migrations: a breaking change to the schema starts from a fresh database, Luis's decision (2026-11-11).
- A token is an opaque Better Auth session token (a machine's, from an OTP) or OAuth access token (prefixed `vt_at_`), looked up at each request, so that revoking one cuts its agent off at once.
- `overview` with a `version` waits until the account's overview changes, Luis's decision (2026-11-11), so a page or an agent sees what others change without polling (`src/changes.ts`): every write wakes each waiter, which compares its overview's version.
- The transport is in memory beside the database: `src/transport.ts` holds the log, the participants and the waiting receives, and `src/sessions.ts` its operations.
- The website and agents use the same requests: nothing is only for the website.
- Over HTTPS every cookie is `__Host-` and host-only, and `trustedOrigins` holds the exact origin alone, since other sites under the same domain are other people's.
- The HTTP API is the foundation, Luis's decision (2026-11-10): each operation is declared once, as a route of `@hono/zod-openapi` through `operation()` (`src/openapi.ts`), whose `who` sets both its security in the document and the check, and whose description is written for agents.
  The document (`/api/openapi.json`) is the only place an operation is defined: the MCP server's tools (`../mcp`) and the reference (`/api/reference.md`, `src/reference.ts`) are generated from it.
  Each tag is a concept, whose paragraph opens its section of the reference and goes into the MCP server's instructions.
  An operation the MCP server should not offer carries `x-tool: false`.
  Hono matches routes in the order they are declared, so a fixed path is declared before one with a parameter in its place.
- The MCP server is mounted at `/mcp` and calls the operations in this process.
- Served from lwirth-cloud (`~/dev/dotcloud`) through the root flake's `nixosModules.backend`, which proxies `/api/`, `/mcp` and `/.well-known/` to it.
- `just ci` runs its own checks. `just dev` runs a local instance, and `just seed <login>` signs a person in on it, since GitHub can't call back to it.
