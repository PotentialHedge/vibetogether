# Vibe Together

People, agents and programs in any harness, talking with each other in one session.

The project is developed in the collective Potential Hedge (Luis Wirth, Benedict Armstrong, Tristan Gabl), as its flagship.
Its design is private to the collective, in `PotentialHedge/collective` under `projects/vibetogether/` (`~/dev/collective/projects/vibetogether`):
`design.md` holds the principles and framing, `direction.md` where it goes, and each client's design is in a directory of its own there.
Read the design, and the client's, before working on anything.

The parts, one directory each:

- `agentwire/`: the transport, named agentwire for now, Luis's decision (2026-11-06): its spec, the relay and the participant library.
- `accounts/`: the account service, which is also the relay's access service.
- `mcp/`: the MCP server through which an agent joins a session.
- `ui/`: what every web client shares, so that agentwire carries no React.
- `website/`: Vibe Together's website, its `agents.md`, and its own specs.
- `apps/`: the clients through which people join: `messagent`, the messenger client, and `voice`.

Vibe Together stays harness-agnostic, Luis's decision.
An extension's spec lives with the client that introduced it, until a second client speaks it;
then it moves into `website/`, and the website serves it, Luis's decision (2026-11-06).
The relay serves only agentwire.

The stack:

- One Nix flake for every package, NixOS module, the shell and the formatter.
- One Cargo workspace and one pnpm workspace: the parts depend on each other by path.
- The relay in Rust, on the tokio ecosystem, agnostic to where it runs, Luis's decision.
- Vite, React and shadcn for the UI; every web client builds with relative paths, so it runs on any host, at a domain's root or under a path, Luis's decision.
- Rust and WebAssembly for heavy compute in the browser.
- One definition of every type, as Hivemind's UI rewrite generates TypeScript from Rust with ts-rs.

`just ci` runs every check: the shared ones, then each part's own (`just <part>::ci`).
Each part's own recipes run as `just <part>::<recipe>`, or as `just <recipe>` in its directory.

Deploying:

- lwirth-cloud (`~/dev/dotcloud`) hosts everything public, Luis's decision (2026-11-04).
  Its flake takes this one as an input for the relay, the MCP server and the account service; each Nix package is built from its own part's sources and agentwire's alone, so a change to another part restarts nothing, unless it changes the Cargo lockfile or a manifest.
- Each web client deploys with its `just deploy`, which pushes its build to lwirth-cloud with rsync, Luis's decision (2026-11-04); dotcloud's `serve.nix` says how each is served.
  It builds the checkout it runs in, so a deploy from main ships everyone's changes on main to that client and what it builds from, such as `ui/`: check `git log` since the last deploy first.
- messagent's shared bot runs on lwirth-cloud, through `nixosModules.messagent`; the old per-person bridge still runs on lwirth-server, from `~/dev/dothome`'s input of this flake.
- Every deploy of Vibe Together or its parts of dotcloud passes a security review by `vibetogether-security` first, Luis's decision (2026-11-09): "review before deploy good idea."
  Send it the commits to deploy, and deploy once it has passed them.

Work on Vibe Together is paired: Luis guides it deliberately.
Record every explicit decision as it is made, where it holds.
Prose needs no review by Luis, the site's text and `agents.md` included, Luis's decision (2026-11-10): "no gate on prose/text".
