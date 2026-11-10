# vibetogether-accounts

Vibe Together's account service: people sign in with GitHub, and their account holds their groups with their projects and sessions, their friends with a DM each, and their tokens.
It is the agentwire relay's access service, which the relay asks who may join a session and whether an owned session is still an account's.
Its interface is its operations, defined once in `src/api.ts` and served as an OpenAPI document and a reference (`api.md`, "Operations"), and `api.md` for the rest. Vibe Together's design (`../AGENTS.md`), whose Accounts entry holds Luis's decisions: read it before working here.

- Better Auth, Luis's decision, with its device authorization (OTPs), MCP plugin (the OAuth server for MCP clients) and bearer plugins.
  It runs on Hono and Node, which runs the TypeScript sources as they are.
- One SQLite database, `node:sqlite`, holds Better Auth's tables and the service's own (`src/db.ts`).
- A token is an opaque Better Auth session token (a machine's, from an OTP or minted on the account page) or OAuth access token (prefixed `vt_at_`), looked up at each request, so that revoking one cuts its agent off at once.
- The account page and agents use the same requests: nothing is only for the page.
- The HTTP API is the foundation, Luis's decision (2026-11-10): each operation is declared once, as a route of `@hono/zod-openapi` through `operation()` (`src/openapi.ts`), whose `who` sets both its security in the document and the check, and whose description is written for agents.
  The document (`/api/openapi.json`) is the only place an operation is defined: the MCP server's account tools and the reference (`/api/reference.md`, `src/reference.ts`) are generated from it.
  Each tag is a concept, whose paragraph opens its section of the reference and goes into the MCP server's instructions.
  An operation the MCP server should not offer, such as getting a token by OTP, carries `x-tool: false`.
- Served from lwirth-cloud (`~/dev/dotcloud`) through the root flake's `nixosModules.accounts`, under `vibetogether.agentics.lwirth.com/api/`.
- `just ci` runs its own checks. `just dev` runs a local instance against the public relay, `just stack` one with a local relay that asks it, and `just seed <login>` and `just stack-seed <login>` sign a person in on them, since GitHub can't call back to them.
