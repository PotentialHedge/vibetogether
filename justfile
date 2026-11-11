# Each part's own recipes, run as `just <part>::<recipe>` here, or as
# `just <recipe>` in its directory.
mod backend
mod library
mod mcp
mod website

# Everything CI runs: the checks the parts share, then each part's own.
ci:
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    just backend::ci
    just library::ci
    just mcp::ci
    just website::ci
    # The package as it deploys, whose sources differ from pnpm's.
    nix build --no-link .#vibetogether-backend
