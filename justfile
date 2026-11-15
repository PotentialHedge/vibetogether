# Each part's own recipes, run as `just <part>::<recipe>` here, or as
# `just <recipe>` in its directory.
mod backend
mod library
mod website

# Everything CI runs: the Rust workspace, natively and as WebAssembly, the web
# clients, and the packages as the flake builds them.
ci:
    nix fmt -- --ci
    cargo clippy --workspace --all-targets -- -D warnings
    cargo clippy -p vibetogether-client --target wasm32-unknown-unknown -- -D warnings
    cargo test --workspace
    pnpm install --frozen-lockfile
    biome check
    just website::ci
    just library::ci
    nix flake check
    nix build --no-link .#vibetogether-backend .#vibetogether .#website
