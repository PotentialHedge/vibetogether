# Everything CI runs.
ci:
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    pnpm exec tsc -p .
    pnpm build

# The page, at localhost:5173.
dev:
    pnpm dev

# Builds the page and serves it at library.agentics.lwirth.com.
deploy: ci
    pnpm exec wrangler deploy --domain library.agentics.lwirth.com
