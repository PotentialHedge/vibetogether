# Each part's own recipes, run as `just <part>::<recipe>` here, or as
# `just <recipe>` in its directory.
mod accounts
mod library
mod mcp
mod messagent "bridges/messagent"
mod ui
mod website

# Everything CI runs: the checks the parts share, then each part's own.
ci:
    nix fmt -- --ci
    just agentwire-pins
    pnpm install --frozen-lockfile
    biome check
    cargo clippy --workspace --all-targets -- -D warnings
    RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps
    just accounts::ci
    just library::ci
    just mcp::ci
    just messagent::ci
    just ui::ci
    just website::ci
    # The packages as they deploy, whose sources differ from cargo's and pnpm's.
    nix build --no-link .#vibetogether-mcp .#vibetogether-accounts .#messagent

# Cargo, pnpm and the flake pin agentwire at one commit.
agentwire-pins:
    #!/usr/bin/env bash
    set -euo pipefail
    rev=$(jq -r .nodes.agentwire.locked.rev flake.lock)
    grep -q "PotentialHedge/agentwire?rev=$rev#$rev" Cargo.lock || { echo "Cargo.lock pins another agentwire than flake.lock ($rev)"; exit 1; }
    grep -q "PotentialHedge/agentwire/tar.gz/$rev" pnpm-lock.yaml || { echo "pnpm-lock.yaml pins another agentwire than flake.lock ($rev)"; exit 1; }
