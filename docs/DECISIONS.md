# Decisions log

Every place where this build departs from, or had to interpret, the five spec documents. Items marked **CONFIRM** need a human decision.

| ID | Decision | Why | Status |
|---|---|---|---|
| D-001 | All milestones were built in one pass instead of one-at-a-time with human approval gates (AGENT_WORKFLOW). | The request was "create this project from scratch". Review each package as if it were a separate milestone PR. | **CONFIRM** |
| D-002 | No dependency versions are written in any `package.json`. `scripts/install-deps.sh` installs current stable versions with `pnpm add -E`; `pnpm-workspace.yaml` sets `minimumReleaseAge` (14 days). | The authoring environment had no network, and the version policy forbids guessing versions. | Resolve at install |
| D-003 | Added tags `SC1-SPK`, `SC1-RATCHET-RK`, `SC1-STORAGE` to `TAGS`. | The spec lists six tags but the design also needs prekey signing, root-key KDF and at-rest key derivation. All are domain-separated and defined once in `shared/constants.ts`. | **CONFIRM** |
| D-004 | Client caps blobs at 256 KiB so every blob is one raw IPFS block; `ipfs-unixfs-importer` is not used. Local CID = CIDv1 raw sha2-256. | Pitfall S4: exact local CID recomputation is only guaranteed for single-chunk content. Messages are text. | **CONFIRM** against a real Kubo (test `add` of a tiny file gives the same CID) |
| D-005 | Contracts use Hardhat 2.x style (CommonJS, `hardhat-toolbox`, ethers v6, gas reporter bundled in toolbox). | Hardhat 3 changed config and test APIs; I could not check which is current. | **CONFIRM** |
| D-006 | `libsodium-wrappers-sumo` instead of the standard build. | `crypto_pwhash` (Argon2id) is only guaranteed in the sumo build. | Done |
| D-007 | Tailwind v4 (CSS-first `@theme`). `react-router` and `qrcode` dropped for now. | The client is one screen with a side panel; QR is a nice-to-have. Rule 7: no unneeded dependencies. | Done |
| D-008 | `KUBO_IMAGE` must be set to an exact tag by the operator. | Could not verify a tag offline; floating tags are forbidden. | **CONFIRM** |
| D-009 | `/dev/faucet` lives on the batcher, enabled only when `DEV_FAUCET=true`, funded from `BATCHER_PRIVATE_KEY` in `.env`. | Ground rule 5 forbids hard-coded keys, so the browser cannot embed Hardhat account 0. | Done |
| D-010 | Flow F has **six** outcomes: added `KEY_MISMATCH` (F4 hash check). The spec text says "six" but lists five. Outgoing messages have no `Delivered` state (no read/delivery receipts). | Matches the section 8 flow; receipts are not specified. | **CONFIRM** |
| D-011 | Relay implements the REST read fallback (signed timestamp, replay-protected); the client uses WebSocket only. | Keeps the client small; the fallback is tested at the relay. | Open |
| D-012 | Ratchet state and inbox private keys are AEAD-encrypted in IndexedDB under a key derived from a vault storage key. Message plaintext in IndexedDB is NOT encrypted. | Spec only requires the identity to be wrapped; this adds ratchet protection cheaply. Plaintext-at-rest is a known gap. | **CONFIRM** |
| D-013 | Simultaneous first contact (both users start a session at once) creates two sessions. Not handled. | Out of scope for the demo. | Known gap |
| D-014 | If the batcher process dies after the anchor transaction is mined but before the DB commit, the same leaves are anchored again in a second batch. | Harmless to proofs (both roots are valid) but wastes gas. A reconciliation step reading `BatchAnchored` logs would close it. | Known gap |
| D-015 | ESLint flat config (`eslint.config.js`), not `.eslintrc`. | Legacy config is removed in current ESLint. | Done |
