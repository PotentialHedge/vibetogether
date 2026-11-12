# Vibe Together

People, agents and programs in any harness, talking with each other in one session.

The project is developed in the collective Potential Hedge (Luis Wirth, Benedict Armstrong, Tristan Gabl), as its flagship.
Its design is private to the collective, in `PotentialHedge/collective` under `projects/vibetogether/` (`~/dev/collective/projects/vibetogether`):
`design.md` holds it: read it before working on anything.

The parts, one directory each:

- `backend/`: the backend, one process for the whole API, accounts and sessions alike; the transport is its own, with no relay.
- `mcp/`: the MCP server through which an agent joins a session, made from the backend's OpenAPI document and mounted by the backend.
- `website/`: Vibe Together's website, its `agents.md`, and its own specs.
- `library/`: the library at `library.potentialhedge.com`, of what is built on Vibe Together, and its `agents.md` for builders.

Vibe Together stays harness-agnostic, Luis's decision.
An extension's spec lives with the client that introduced it, until a second client speaks it;
then it moves into `website/`, and the website serves it, Luis's decision (2026-11-06).

The stack:

- TypeScript for everything, Luis's decision: the backend, the MCP server and the UI.
- One Nix flake for every package, NixOS module, the shell and the formatter.
- One pnpm workspace: the parts depend on each other by path.
- Hono, Better Auth and `node:sqlite` on Node for the backend.
- Vite, React and shadcn for the UI; every web client builds with relative paths, so it runs on any host, at a domain's root or under a path, Luis's decision.

`just ci` runs every check: the shared ones, then each part's own (`just <part>::ci`).
Each part's own recipes run as `just <part>::<recipe>`, or as `just <recipe>` in its directory.

Deploying:

- lwirth-cloud (`~/dev/dotcloud`) hosts everything public, Luis's decision (2026-11-04).
  Its flake takes this one as an input for the backend, `nixosModules.backend`, built from the backend's and the MCP server's sources alone.
- Each web client deploys with its `just deploy`, which pushes its build to lwirth-cloud with rsync, Luis's decision (2026-11-04); dotcloud's `serve.nix` says how each is served.
  It builds the checkout it runs in, so a deploy from main ships everyone's changes on main to that client: check `git log` since the last deploy first.

Work on Vibe Together is paired: Luis guides it deliberately.
Every agent working on Vibe Together takes part in its session on Vibe Together, `work` in the project `vibetogether` of Potential Hedge (`s_N-ulGSlHvDRWFeMU`), so the collective and its agents see what each did, Luis's decision (2026-11-12).
Record every explicit decision as it is made, where it holds.
Prose needs no review by Luis, the site's text and `agents.md` included, Luis's decision (2026-11-10): "no gate on prose/text".
