import { beforeAll, describe, expect, it } from 'vitest';
import { LIMITS, fromUtf8, toB64, utf8, type RelayEnvelope } from '@sc/shared';
import {
  AuthError, RatchetError, deserializeRatchet, generateIdentity, initCrypto, initInitiator, initResponder,
  openBlob, openEnvelope, ratchetDecryptStep, ratchetEncryptStep, sealMessage, sealPointer, serializeRatchet,
  x3dhInitiate, x3dhRespond, type RatchetState,
} from '../src';

beforeAll(initCrypto);

function pair(): { a: RatchetState; b: RatchetState } {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const init = x3dhInitiate(alice.ed, bob.bundle);
  const resp = x3dhRespond(bob.ed, bob.spk, init.header);
  return { a: initInitiator(init.sk, init.theirSpk), b: initResponder(resp.sk, bob.spk) };
}

const same = (x: Uint8Array, y: Uint8Array) => toB64(x) === toB64(y);

describe('Double Ratchet key schedule', () => {
  it('1000 messages in order, A -> B, all keys match', () => {
    let { a, b } = pair();
    for (let i = 0; i < 1000; i++) {
      const e = ratchetEncryptStep(a);
      const d = ratchetDecryptStep(b, e.header);
      expect(same(e.messageKey, d.messageKey)).toBe(true);
      a = e.state;
      b = d.state;
    }
    expect(b.skipped).toHaveLength(0);
  });

  it('ping-pong across many DH ratchet steps stays in sync', () => {
    let { a, b } = pair();
    // Bob cannot send until he has received.
    expect(() => ratchetEncryptStep(b)).toThrow(RatchetError);
    for (let round = 0; round < 50; round++) {
      const e1 = ratchetEncryptStep(a);
      const d1 = ratchetDecryptStep(b, e1.header);
      expect(same(e1.messageKey, d1.messageKey)).toBe(true);
      a = e1.state; b = d1.state;
      const e2 = ratchetEncryptStep(b);
      const d2 = ratchetDecryptStep(a, e2.header);
      expect(same(e2.messageKey, d2.messageKey)).toBe(true);
      a = d2.state; b = e2.state;
    }
  });

  it('out-of-order delivery within a chain uses skipped keys', () => {
    let { a, b } = pair();
    const sent: ReturnType<typeof ratchetEncryptStep>[] = [];
    for (let i = 0; i < 5; i++) {
      const e = ratchetEncryptStep(a);
      a = e.state;
      sent.push(e);
    }
    for (const i of [3, 0, 4, 1, 2]) {
      const d = ratchetDecryptStep(b, sent[i]!.header);
      expect(same(d.messageKey, sent[i]!.messageKey)).toBe(true);
      b = d.state;
    }
    expect(b.skipped).toHaveLength(0);
  });

  it('out-of-order across a DH ratchet (skipped keys from the previous chain)', () => {
    let { a, b } = pair();
    const m0 = ratchetEncryptStep(a); a = m0.state;
    const m1 = ratchetEncryptStep(a); a = m1.state;
    const m2 = ratchetEncryptStep(a); a = m2.state;
    let d = ratchetDecryptStep(b, m0.header); b = d.state;
    // Bob replies; Alice receives, which makes her ratchet on her next send.
    const r = ratchetEncryptStep(b); b = r.state;
    const rd = ratchetDecryptStep(a, r.header); a = rd.state;
    const m3 = ratchetEncryptStep(a); a = m3.state;
    // m3 (new chain) arrives BEFORE m1, m2 (old chain).
    d = ratchetDecryptStep(b, m3.header);
    expect(same(d.messageKey, m3.messageKey)).toBe(true); b = d.state;
    expect(b.skipped).toHaveLength(2);
    d = ratchetDecryptStep(b, m2.header);
    expect(same(d.messageKey, m2.messageKey)).toBe(true); b = d.state;
    d = ratchetDecryptStep(b, m1.header);
    expect(same(d.messageKey, m1.messageKey)).toBe(true); b = d.state;
    expect(b.skipped).toHaveLength(0);
  });

  it('a replayed message is rejected', () => {
    let { a, b } = pair();
    const e = ratchetEncryptStep(a); a = e.state;
    b = ratchetDecryptStep(b, e.header).state;
    expect(() => ratchetDecryptStep(b, e.header)).toThrow(RatchetError);
  });

  it('refuses to skip more than MAX_SKIP in one jump (memory DoS, pitfall C8)', () => {
    let { a, b } = pair();
    let last = ratchetEncryptStep(a);
    for (let i = 0; i < LIMITS.MAX_SKIP + 5; i++) { a = last.state; last = ratchetEncryptStep(a); }
    expect(() => ratchetDecryptStep(b, last.header)).toThrow(RatchetError);
  });

  it('stored skipped keys are capped; the oldest are dropped', () => {
    let { a, b } = pair();
    // Deliver 1 of every 1001 so each jump skips exactly MAX_SKIP keys; the cap must hold.
    const heads: ReturnType<typeof ratchetEncryptStep>[] = [];
    for (let i = 0; i < 2 * LIMITS.MAX_SKIP + 2; i++) {
      const e = ratchetEncryptStep(a); a = e.state; heads.push(e);
    }
    let d = ratchetDecryptStep(b, heads[LIMITS.MAX_SKIP]!.header); b = d.state;
    d = ratchetDecryptStep(b, heads[2 * LIMITS.MAX_SKIP]!.header); b = d.state;
    expect(b.skipped.length).toBeLessThanOrEqual(LIMITS.MAX_SKIP);
    // The very first keys (n = 0..) were dropped, so message 0 can no longer be decrypted.
    expect(() => ratchetDecryptStep(b, heads[0]!.header)).toThrow(RatchetError);
  });

  it('decrypt step never mutates the input state (pitfall C7)', () => {
    const { a, b } = pair();
    const before = serializeRatchet(b);
    const e = ratchetEncryptStep(a);
    ratchetDecryptStep(b, e.header);
    expect(serializeRatchet(b)).toBe(before);
  });

  it('state serialises and restores (refresh keeps session)', () => {
    let { a, b } = pair();
    const e = ratchetEncryptStep(a); a = e.state;
    b = ratchetDecryptStep(b, e.header).state;
    const restored = deserializeRatchet(serializeRatchet(b));
    const e2 = ratchetEncryptStep(a);
    expect(same(ratchetDecryptStep(restored, e2.header).messageKey, e2.messageKey)).toBe(true);
  });
});

describe('message sealing on top of the ratchet', () => {
  function toEnvelope(m: ReturnType<typeof sealMessage>, inboxId = '0x' + '11'.repeat(32)): RelayEnvelope {
    const p = sealPointer(m.pointerKey, m.header, {
      cid: 'bafkreiexamplecidexamplecidexamplecidexamplecidexample', salt: toB64(new Uint8Array(32)),
      sig: '', seq: 0, ts: 1,
    });
    return { inboxId: inboxId as `0x${string}`, header: m.header, nonce: p.nonce, sealedPointer: p.sealedPointer };
  }

  it('round trip: plaintext survives seal -> envelope -> open', () => {
    const { a, b } = pair();
    const m = sealMessage(a, utf8('hello bob'));
    const opened = openEnvelope(b, toEnvelope(m));
    expect(fromUtf8(openBlob(opened.encKey, m.blob, m.header))).toBe('hello bob');
    expect(opened.pointer.seq).toBe(0);
  });

  it('two encryptions of the same plaintext differ (fresh nonce + new key, pitfall C5)', () => {
    const { a } = pair();
    const m1 = sealMessage(a, utf8('same'));
    const m2 = sealMessage(m1.state, utf8('same'));
    expect(m1.blob.nonce).not.toBe(m2.blob.nonce);
    expect(m1.blob.ciphertext).not.toBe(m2.blob.ciphertext);
  });

  it('tampered ciphertext is rejected', () => {
    const { a, b } = pair();
    const m = sealMessage(a, utf8('secret'));
    const opened = openEnvelope(b, toEnvelope(m));
    const bytes = Buffer.from(m.blob.ciphertext, 'base64url');
    bytes[0] = bytes[0]! ^ 1;
    expect(() => openBlob(opened.encKey, { ...m.blob, ciphertext: bytes.toString('base64url') }, m.header)).toThrow(AuthError);
  });

  it('tampered sealed pointer is rejected and the caller state is not advanced', () => {
    const { a, b } = pair();
    const before = serializeRatchet(b);
    const env = toEnvelope(sealMessage(a, utf8('x')));
    const raw = Buffer.from(env.sealedPointer, 'base64url');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(() => openEnvelope(b, { ...env, sealedPointer: raw.toString('base64url') })).toThrow(AuthError);
    expect(serializeRatchet(b)).toBe(before);
    // The honest message still opens afterwards (a forged one did not desynchronise us).
    expect(openEnvelope(b, env).pointer.ts).toBe(1);
  });

  it('a swapped header on the blob is rejected', () => {
    const { a, b } = pair();
    const m1 = sealMessage(a, utf8('one'));
    const m2 = sealMessage(m1.state, utf8('two'));
    const opened = openEnvelope(b, toEnvelope(m1));
    expect(() => openBlob(opened.encKey, { ...m2.blob }, m1.header)).toThrow(AuthError);
  });

  it('a message under a different session cannot be opened', () => {
    const s1 = pair();
    const s2 = pair();
    expect(() => openEnvelope(s2.b, toEnvelope(sealMessage(s1.a, utf8('x'))))).toThrow(AuthError);
  });
});
