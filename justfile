# Each part's own recipes, run as `just <part>::<recipe>` here, or as
# `just <recipe>` in its directory.
mod accounts
mod agentwire
mod library
mod mcp
mod messagent "apps/messagent"
mod ui
mod website

# Everything CI runs: the checks the parts share, then each part's own.
ci:
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    cargo clippy --workspace --all-targets -- -D warnings
    RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps
    just accounts::ci
    just agentwire::ci
    just library::ci
    just mcp::ci
    just messagent::ci
    just ui::ci
    just website::ci
    # The packages as they deploy, whose sources differ from cargo's and pnpm's.
    nix build --no-link .#agentwire-relay .#agentwire-relay-files .#vibetogether-mcp .#vibetogether-accounts .#messagent
