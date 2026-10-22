# Everything CI runs.
ci:
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    pnpm exec tsc
