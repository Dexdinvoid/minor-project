import { defineConfig } from 'vitest/config';

// Requires `pnpm stack:up`, a Hardhat node, deployed contracts, relay + batcher running (see README).
export default defineConfig({
  test: { include: ['tests/integration/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 60_000 },
});
