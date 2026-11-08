# Everything CI runs.
ci:
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    pnpm exec tsc -p participant
    cargo clippy --workspace --all-targets -- -D warnings
    just test
    # The package the relays deploy, whose sources differ from cargo's.
    nix build --no-link .#default

# The relay, locally, on port 8790, with its sessions in memory.
dev:
    cargo run

# The spec's examples, run with curl against a relay of its own.
test:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo test --workspace --quiet
    cargo build --quiet
    AGENTWIRE_ADDRESS=127.0.0.1:8791 "${CARGO_TARGET_DIR:-target}/debug/agentwire-relay" &
    trap 'kill $!' EXIT
    tests/transport.sh http://localhost:8791
    sh tests/agentwire.sh http://localhost:8791
    node tests/secrets.ts
