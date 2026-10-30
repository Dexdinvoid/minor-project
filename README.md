# Verifiable Private Messaging

End-to-end encrypted chat (X3DH + Double Ratchet) where ciphertext lives on IPFS and a tamper-evident,
Merkle-anchored proof of each signed message lives on an EVM chain. Specs are in [`docs/`](docs/).

> **Read this first: verification status.** This repository was written in an environment with **no network**,
> so most third-party packages could not be installed. What was and was not actually executed:
>
> | Part | Status |
> |---|---|
> | `shared`, `crypto`, `ipfs` client, `ledger` Flow F | **75 tests executed and passing**, but against stand-ins (Node `crypto` for libsodium, a BigInt Keccak checked against the known empty-input vector, a minimal vitest/fast-check). Strict `tsc` passes on this code. The real libsodium, noble and vitest were **not** exercised. |
> | `contracts` | Written, **never compiled** (no solc, no Hardhat). |
> | `relay`, `batcher` | Written against documented Fastify / ws / better-sqlite3 / merkletreejs APIs. **Never run or typechecked.** Tests are written but unexecuted. |
> | `client` (React UI, messenger, vault) | **Never built or run.** |
> | `tools/auditor`, `tools/eval`, `tests/integration` | `eval` crypto/Merkle part ran offline (numbers are not representative). Auditor and integration test **unrun**. |
>
> Expect a first round of compile/test fixes after `install-deps.sh`. Treat the crypto as **not audited**.

## Quick start

```bash
corepack enable
./scripts/install-deps.sh          # installs current stable versions, pinned exactly
cp .env.example .env               # set KUBO_IMAGE (exact tag), BATCHER_PRIVATE_KEY after step 3
pnpm typecheck && pnpm test        # unit tests for every package
pnpm test:contracts                # Hardhat tests + gas report

# local stack
pnpm stack:up                                   # Kubo (loopback only)
pnpm --filter @sc/contracts node                # terminal 2: local chain; copy an account key into BATCHER_PRIVATE_KEY
pnpm --filter @sc/contracts deploy:local        # prints contract addresses -> .env and packages/client/.env
pnpm --filter @sc/relay dev                     # terminal 3
BATCH_MAX_AGE_MS=5000 pnpm --filter @sc/batcher dev   # terminal 4 (fast anchoring for demos)
pnpm dev:client                                 # http://localhost:5173
pnpm test:integration                           # full pipeline against the running stack
pnpm auditor proof-1.json                       # independent verification of an exported proof
pnpm eval                                       # writes metrics.csv
```

Use two browser profiles, create two identities, paste each ID into the other, tick **Verifiable mode**, send, then **Verify**.

## Layout

```
packages/shared    types, constants (TAGS), encoding, zod schemas
packages/crypto    identity, X3DH, Double Ratchet, AEAD, commitments, Merkle, key wrapping
packages/ipfs      CID recomputation, browser IpfsClient, Kubo pin store (node only)
packages/ledger    ethers wrappers, bundle resolver, Flow F (all six outcomes)
packages/relay     Fastify + ws store-and-forward inbox, pin gateway, SQLite
packages/batcher   leaf intake, Merkle batching, serialised anchoring, proofs, dev faucet
packages/client    React + Vite + Tailwind v4 (ClickHouse tokens), Dexie, Zustand, services layer
contracts          KeyRegistry, AnchorRegistry, Hardhat tests, deploy script
tools/auditor      CLI proof verifier   tools/eval  metrics harness
docs/              the five specs + DECISIONS.md + BUGLOG.md
```

## Security notes

* Secrets exist only in `client/services/vault.ts` memory and passphrase-wrapped (Argon2id) in IndexedDB; ratchet state is encrypted at rest. Message plaintext in IndexedDB is not (D-012).
* Verifiable mode signs messages, which removes deniability. The UI says so.
* Metadata (who talks to whom, timing, size) is visible to relay and batcher by design.
* Never expose the Kubo RPC port. `docker-compose.yml` binds it to loopback.
* Open decisions that need your call: see **CONFIRM** rows in [`docs/DECISIONS.md`](docs/DECISIONS.md).
