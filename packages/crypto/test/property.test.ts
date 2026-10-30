import { beforeAll, describe, it } from 'vitest';
import fc from 'fast-check';
import { fromUtf8, toB64, utf8, type RelayEnvelope } from '@sc/shared';
import {
  AuthError, generateIdentity, initCrypto, initInitiator, initResponder, openBlob, openEnvelope, sealMessage,
  sealPointer, x3dhInitiate, x3dhRespond,
} from '../src';

beforeAll(initCrypto);

function session() {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const init = x3dhInitiate(alice.ed, bob.bundle);
  const resp = x3dhRespond(bob.ed, bob.spk, init.header);
  return { a: initInitiator(init.sk, init.theirSpk), b: initResponder(resp.sk, bob.spk) };
}

function env(m: ReturnType<typeof sealMessage>): RelayEnvelope {
  const p = sealPointer(m.pointerKey, m.header, {
    cid: 'bafkreiexamplecidexamplecidexamplecidexamplecidexample', salt: toB64(new Uint8Array(32)), sig: '', seq: 0, ts: 0,
  });
  return { inboxId: ('0x' + '11'.repeat(32)) as `0x${string}`, header: m.header, nonce: p.nonce, sealedPointer: p.sealedPointer };
}

describe('property tests', () => {
  it('round trip for arbitrary unicode plaintext', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (text) => {
        const { a, b } = session();
        const m = sealMessage(a, utf8(text));
        const o = openEnvelope(b, env(m));
        return fromUtf8(openBlob(o.encKey, m.blob, m.header)) === text;
      }),
      { numRuns: 25 },
    );
  });

  it('flipping any single bit of the ciphertext is detected', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), fc.nat(), fc.integer({ min: 0, max: 7 }), (text, pos, bit) => {
        const { a, b } = session();
        const m = sealMessage(a, utf8(text));
        const o = openEnvelope(b, env(m));
        const ct = Buffer.from(m.blob.ciphertext, 'base64url');
        ct[pos % ct.length] = ct[pos % ct.length]! ^ (1 << bit);
        try {
          openBlob(o.encKey, { ...m.blob, ciphertext: ct.toString('base64url') }, m.header);
          return false;
        } catch (e) {
          return e instanceof AuthError;
        }
      }),
      { numRuns: 25 },
    );
  });
});
