# Bug log

| ID | Where | Symptom | Cause | Fix / test |
|---|---|---|---|---|
| B-001 | `crypto/test/ratchet.test.ts` | Strict-mode type error on untyped arrays. | Implicit `any[]`. | Typed the arrays. |
| B-002 | Review of `client/messenger.ts` | New incoming session was saved before its inbox was registered, so a relay outage would drop the first message. | Ordering. | Register first; on failure return without ACK so the relay redelivers. |
| B-003 | Review of `client/messenger.ts` | `pollProofs` queried an unindexed Dexie column. | Copy error. | Filter in memory. |
