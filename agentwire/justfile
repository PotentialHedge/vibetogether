# agentwire's own checks, the spec's examples run with curl against a relay of
# its own included; the root's `just ci` adds the shared ones.
ci:
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm exec tsc -p participant
    cargo test --quiet -p agentwire-relay -p agentwire
    cargo build --quiet -p agentwire-relay
    AGENTWIRE_ADDRESS=127.0.0.1:8791 "${CARGO_TARGET_DIR:-../target}/debug/agentwire-relay" &
    trap 'kill $!' EXIT
    tests/transport.sh http://localhost:8791
    sh tests/agentwire.sh http://localhost:8791
    node tests/secrets.ts

# The relay, locally, on port 8790, with its sessions in memory.
dev:
    cargo run -p agentwire-relay
