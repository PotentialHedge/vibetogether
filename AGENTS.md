# Vibe Together

People, agents and programs in any harness, talking with each other in one session.

The project is developed in the collective Potential Hedge (Luis Wirth, Benedict Armstrong, Tristan Gabl), as its flagship.
Its design is private to the collective, in `PotentialHedge/collective` under `projects/vibetogether/` (`~/dev/collective/projects/vibetogether`):
`design.md` holds it: read it before working on anything.

The parts, one directory each:

- `protocol/`: the protocol, `vibetogether-protocol`: the HTTP API's types and the rules both sides share, defined once; later its encryption.
- `backend/`: the backend, `vibetogether-backend`: one process for the whole API, accounts and sessions alike; the transport is its own, with no relay.
- `client/`: the client library, `vibetogether-client`, the only way to call the API: for Rust natively, and for the website as WebAssembly with its bindings (`client/src/web.rs`).
- `inbox/`: the agent's inbox, `vibetogether-inbox`: Vibe Together's delivery on the agent's machine, a plain folder, part of the core, Luis's decision (2026-11-15); its own `AGENTS.md` holds its decisions.
- `cli/`: the command line, `vibetogether`, over the client library: one command per operation, `--help` its documentation, and `vibetogether inbox` for the inbox, with the delivery into it.
- `harnesses/`: what wires each harness to the inbox, such as Claude Code's hooks and pi's extension.
- `website/`: Vibe Together's website, its `agents.md`, and its own specs.
- `library/`: the library at `library.potentialhedge.com`, of what is built on Vibe Together, and its `agents.md` for builders.

Every client of ours builds on the client library, the delivery into an agent's inbox included; an agent may also call the HTTP API directly, such as from a sandbox where nothing can be installed.
Vibe Together stays harness-agnostic, Luis's decision.
An extension's spec lives with the client that introduced it, until a second client speaks it;
then it moves into `website/`, and the website serves it, Luis's decision (2026-11-06).

The stack:

- Rust for everything but the UI, TypeScript for the UI alone, Luis's decision (2026-11-15): "let's do it one more time, properly."
  One Cargo workspace on the canonical crates: tokio, axum, sqlx with SQLite and its migrations, reqwest, clap, wasm-bindgen with tsify for the types the website sees.
- One Nix flake for every package (crane), the NixOS module, the shell and the formatter.
- One pnpm workspace for the web clients.
- Vite, React and shadcn for the UI; every web client builds with relative paths, so it runs on any host, at a domain's root or under a path, Luis's decision.

`just ci` runs every check: the workspace's clippy and tests, natively and for WebAssembly, the web clients', `nix flake check` and every package's build.
Each part's own recipes run as `just <part>::<recipe>`, or as `just <recipe>` in its directory.

Deploying:

- lwirth-cloud (`~/dev/dotcloud`) hosts everything public, Luis's decision (2026-11-04).
  Its flake takes this one as an input for the backend, `nixosModules.backend`.
- Each web client deploys with its `just deploy`, which pushes its build to lwirth-cloud with rsync, Luis's decision (2026-11-04); dotcloud's `serve.nix` says how each is served.
  The website's is the flake's package, so it builds the checkout's committed state: a deploy from main ships everyone's changes on main, so check `git log` since the last deploy first.
- What is ready deploys at once, once a security review by a fresh agent passes, Luis's decision (2026-11-12).

Luis leads Vibe Together and decides on it alone, Luis's decision (2026-11-15): "VT is my project. i'm the lead."
Work on Vibe Together is paired: Luis guides it deliberately.
Every agent working on Vibe Together takes part in its session on Vibe Together, `work` in the project `vibetogether` of Potential Hedge (`s_N-ulGSlHvDRWFeMU`), so the collective and its agents see what each did, Luis's decision (2026-11-12).
Record every explicit decision as it is made, where it holds.
Prose needs no review by Luis, the site's text and `agents.md` included, Luis's decision (2026-11-10): "no gate on prose/text".
