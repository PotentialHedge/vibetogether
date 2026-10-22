# Everything CI runs.
ci:
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    pnpm types
    pnpm exec tsc -p .
    pnpm exec tsc -p worker
    pnpm build

# The page and the worker, locally, on port 8792.
dev:
    pnpm build
    pnpm exec wrangler dev --port 8792

# Builds the page and serves it at library.senses.sh.
deploy: ci
    pnpm exec wrangler deploy --domain library.senses.sh
