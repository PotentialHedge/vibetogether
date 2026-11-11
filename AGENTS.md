# Vibe Together

People, agents and programs in any harness, talking with each other in one session.

The project is developed in the collective Potential Hedge (Luis Wirth, Benedict Armstrong, Tristan Gabl), as its flagship.
Its design is private to the collective, in `PotentialHedge/collective` under `projects/vibetogether/` (`~/dev/collective/projects/vibetogether`):
`design.md` holds it: read it before working on anything.

The transport, agentwire, is Vibe Together's transport and nothing else, in a repository of its own, `PotentialHedge/agentwire` (`~/dev/agentwire`): its spec, the relay and the participant library.
Cargo, pnpm and the flake pin it at one commit, which `just ci` checks: bump all three together.

The parts, one directory each:

- `accounts/`: the account service, which is also the relay's access service.
- `mcp/`: the MCP server through which an agent joins a session.
- `website/`: Vibe Together's website, its `agents.md`, and its own specs.

Vibe Together stays harness-agnostic, Luis's decision.
An extension's spec lives with the client that introduced it, until a second client speaks it;
then it moves into `website/`, and the website serves it, Luis's decision (2026-11-06).
The relay serves only agentwire.

The stack:

- One Nix flake for every package, NixOS module, the shell and the formatter.
- One Cargo workspace and one pnpm workspace: the parts depend on each other by path, and on agentwire by its pinned commit.
- Vite, React and shadcn for the UI; every web client builds with relative paths, so it runs on any host, at a domain's root or under a path, Luis's decision.
- Rust and WebAssembly for heavy compute in the browser.
- One definition of every type, as Hivemind's UI rewrite generates TypeScript from Rust with ts-rs.

`just ci` runs every check: the shared ones, then each part's own (`just <part>::ci`).
Each part's own recipes run as `just <part>::<recipe>`, or as `just <recipe>` in its directory.

Deploying:

- lwirth-cloud (`~/dev/dotcloud`) hosts everything public, Luis's decision (2026-11-04).
  Its flake takes this one as an input for the MCP server, and the account service, and agentwire's for the relay; each Nix package is built from its own part's sources alone, so a change to another part restarts nothing, unless it changes the Cargo lockfile or a manifest.
- Each web client deploys with its `just deploy`, which pushes its build to lwirth-cloud with rsync, Luis's decision (2026-11-04); dotcloud's `serve.nix` says how each is served.
  It builds the checkout it runs in, so a deploy from main ships everyone's changes on main to that client: check `git log` since the last deploy first.

Work on Vibe Together is paired: Luis guides it deliberately.
Record every explicit decision as it is made, where it holds.
Prose needs no review by Luis, the site's text and `agents.md` included, Luis's decision (2026-11-10): "no gate on prose/text".
