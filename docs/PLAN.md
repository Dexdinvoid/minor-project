# Verifiable Private Messaging - Execution Plan

This plan follows the guidelines strictly outlined in `SYSTEM_DESIGN.md`, `ARCHITECTURE_AND_TECH_STACK.md`, and `AGENT_WORKFLOW.md`. It covers all 10 milestones required to build and evaluate the system.

---

## MILESTONE 0 PLAN (Scaffolding)
**Files to create/change:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.eslintrc.json`, `docker-compose.yml`, `packages/shared/package.json`, `packages/shared/src/types.ts`, `packages/shared/src/constants.ts`
**Public interfaces (TS signatures):** `B64`, `Hex`, `KeyBundle`, `RatchetHeader`, `BlobEnvelope`, `PointerPayload`, `RelayEnvelope`, `ProofPackage`
**Tests to write (from acceptance column):** Verify `pnpm build` passes and `docker compose up -d` starts successfully.
**Dependencies needed (name, why):** `typescript`, `eslint`, `prettier` (linting/formatting), `zod` (validation).
**Risks / unknowns:** Aligning workspace configurations properly so packages share settings.
**Out of scope:** Business logic and UI.

## MILESTONE 1 PLAN (Crypto Package)
**Files to create/change:** `packages/crypto/package.json`, `packages/crypto/src/*.ts`, `packages/crypto/test/*.test.ts`
**Public interfaces (TS signatures):** X3DH key derivation, Double Ratchet setup, AEAD encrypt/decrypt, Merkle commitment functions.
**Tests to write (from acceptance column):** Ed25519 to X25519 conversion; X3DH shared secret matches; Double Ratchet (1000 messages, out-of-order, skipped keys, tamper rejection); Commitment and Merkle verify/fail.
**Dependencies needed (name, why):** `libsodium-wrappers` (primitives), `@noble/hashes` (HKDF/SHA256), `fast-check` (property testing).
**Risks / unknowns:** Double Ratchet implementation edge cases.
**Out of scope:** Network and storage.

## MILESTONE 2 PLAN (Contracts)
**Files to create/change:** `contracts/KeyRegistry.sol`, `contracts/AnchorRegistry.sol`, `contracts/test/*.ts`, `contracts/hardhat.config.ts`
**Public interfaces (TS signatures):** Solidity ABIs (`publish`, `anchor`, `verifyLeaf`).
**Tests to write (from acceptance column):** Publish/update only by owner; version increments; anchor stores root; verifyLeaf validation; gas report output.
**Dependencies needed (name, why):** `hardhat`, `@openzeppelin/contracts` (MerkleProof), `hardhat-gas-reporter`.
**Risks / unknowns:** Merkle pair sorting in Solidity matching JS logic exactly.
**Out of scope:** Client integration.

## MILESTONE 3 PLAN (IPFS & Ledger Adapters)
**Files to create/change:** `packages/ipfs/src/ipfsClient.ts`, `packages/ledger/src/ledgerClient.ts`
**Public interfaces (TS signatures):** IPFS `add`/`cat`; Ledger read/write contract wrappers.
**Tests to write (from acceptance column):** IPFS add then cat returns exact bytes, local CID matches; Contract read/write passes via script.
**Dependencies needed (name, why):** `kubo-rpc-client`, `multiformats`, `ipfs-unixfs-importer` (IPFS); `ethers` v6, `merkletreejs` (Ledger).
**Risks / unknowns:** CID v0 vs v1 mismatch.
**Out of scope:** UI and services.

## MILESTONE 4 PLAN (Relay & Pin Gateway)
**Files to create/change:** `packages/relay/src/server.ts`, `packages/relay/src/db.ts`
**Public interfaces (TS signatures):** `PUT /inbox`, `POST /inbox/:id/messages`, `GET /ws`, `POST /blob`, `GET /blob/:cid`
**Tests to write (from acceptance column):** Offline delivery on reconnect; TTL cleanup; size rejections; auth tests (wrong key, replayed challenge, expired, rate limit); POST /blob returns CID, local match.
**Dependencies needed (name, why):** `fastify`, `ws`, `better-sqlite3`, `@fastify/rate-limit`, `pino`.
**Risks / unknowns:** WebSocket challenge-response races.
**Out of scope:** End-to-end client integration.

## MILESTONE 5 PLAN (Batcher)
**Files to create/change:** `packages/batcher/src/server.ts`, `packages/batcher/src/queue.ts`, `packages/batcher/src/tree.ts`, `packages/batcher/src/anchor.ts`
**Public interfaces (TS signatures):** `POST /leaf`, `GET /proof/:leaf`, `GET /health`
**Tests to write (from acceptance column):** Reject bad sig/replay; flush at 64 leaves or 60s; proof validation against root; SQLite restart recovery.
**Dependencies needed (name, why):** `fastify`, `better-sqlite3`, `ethers` (contract calls).
**Risks / unknowns:** Handling transaction reverts on EVM.
**Out of scope:** End-to-end client flows.

## MILESTONE 6 PLAN (Client: Core App)
**Files to create/change:** `packages/client/src/*` (React UI, Zustand stores, Dexie DB, Services)
**Public interfaces (TS signatures):** Client UI components and background services.
**Tests to write (from acceptance column):** Two browser profiles chat E2E on local stack; refresh retains session.
**Dependencies needed (name, why):** `react`, `vite`, `zustand`, `react-router`, `dexie`, `tailwindcss`, `qrcode`, `playwright` (E2E).
**Risks / unknowns:** Complex state machine race conditions in Double Ratchet logic inside browser.
**Out of scope:** Verify UI and Proof export.

## MILESTONE 7 PLAN (Client: Verification)
**Files to create/change:** `packages/client/src/VerifyUI.tsx`, `packages/client/src/ProofExport.ts`
**Public interfaces (TS signatures):** Proof validation logic (Flow F) and auditor CLI.
**Tests to write (from acceptance column):** All 6 Flow F outcomes reachable (invalid sig, pending, invalid proof, altered content, verified); Auditor CLI verification.
**Dependencies needed (name, why):** None additional.
**Risks / unknowns:** Accurately mapping error states to the ClickHouse dark-mode UI.
**Out of scope:** Metrics gathering.

## MILESTONE 8 PLAN (Evaluation Harness)
**Files to create/change:** `tools/eval/index.ts`
**Public interfaces (TS signatures):** Scripts to load test and log metrics.
**Tests to write (from acceptance column):** Script runs N messages and generates `metrics.csv`.
**Dependencies needed (name, why):** Standard Node.js `fs` or `csv-writer`.
**Risks / unknowns:** Accurately measuring network latency locally vs real-world.
**Out of scope:** Deployment to testnet.

## MILESTONE 9 PLAN (Sepolia Deployment)
**Files to create/change:** Deployment scripts and `.env` configs.
**Public interfaces (TS signatures):** N/A
**Tests to write (from acceptance column):** All E2E tests pass against Sepolia testnet.
**Dependencies needed (name, why):** None additional.
**Risks / unknowns:** Faucet limits, public testnet latency.
**Out of scope:** Mainnet launch.
