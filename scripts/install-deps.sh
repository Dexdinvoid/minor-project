#!/usr/bin/env bash
# Installs every dependency at the CURRENT stable version, pinned exactly (-E).
# Rule (ARCHITECTURE_AND_TECH_STACK.md): never hand-write versions; never take a release younger than 14 days
# (pnpm-workspace.yaml sets minimumReleaseAge, needs pnpm >= 10.16). Review the lockfile diff before committing.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v pnpm >/dev/null || { echo "install pnpm first: corepack enable && corepack prepare pnpm@latest --activate"; exit 1; }
pnpm -v

# --- root tooling ---
pnpm add -wDE typescript vitest eslint prettier husky lint-staged tsx dotenv \
  typescript-eslint @eslint/js @types/node

# --- packages ---
pnpm --filter @sc/shared add -E zod
pnpm --filter @sc/crypto add -E libsodium-wrappers-sumo @noble/hashes
pnpm --filter @sc/crypto add -DE @types/libsodium-wrappers-sumo fast-check
pnpm --filter @sc/ipfs add -E multiformats kubo-rpc-client
pnpm --filter @sc/ledger add -E ethers
pnpm --filter @sc/relay add -E fastify @fastify/helmet @fastify/cors @fastify/rate-limit ws better-sqlite3 zod dotenv
pnpm --filter @sc/relay add -DE @types/ws @types/better-sqlite3
pnpm --filter @sc/batcher add -E fastify @fastify/helmet @fastify/cors @fastify/rate-limit better-sqlite3 merkletreejs ethers dotenv
pnpm --filter @sc/batcher add -DE @types/better-sqlite3
pnpm --filter @sc/auditor add -E ethers
pnpm --filter @sc/client add -E react react-dom zustand dexie ethers
pnpm --filter @sc/client add -DE vite @vitejs/plugin-react tailwindcss @tailwindcss/vite @types/react @types/react-dom jsdom @playwright/test
pnpm --filter @sc/contracts add -DE hardhat @nomicfoundation/hardhat-toolbox @openzeppelin/contracts merkletreejs dotenv ethers ts-node typescript @types/node chai mocha

pnpm husky init >/dev/null 2>&1 || true
echo
echo "Done. Next: pnpm typecheck && pnpm test   (see README.md)"
