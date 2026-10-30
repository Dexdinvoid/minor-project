import { beforeAll, describe, expect, it } from 'vitest';
import { bytesEqual, fromB64, toB64 } from '@sc/shared';
import { BundleRejected, generateIdentity, initCrypto, x3dhInitiate, x3dhRespond } from '../src';

beforeAll(initCrypto);

describe('X3DH', () => {
  it('both sides derive the same shared secret', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const init = x3dhInitiate(alice.ed, bob.bundle);
    const resp = x3dhRespond(bob.ed, bob.spk, init.header);
    expect(init.sk).toHaveLength(32);
    expect(bytesEqual(init.sk, resp.sk)).toBe(true);
    expect(bytesEqual(resp.peerIdentityKey, alice.ed.publicKey)).toBe(true);
  });

  it('each run uses a fresh ephemeral key, so secrets differ', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const a = x3dhInitiate(alice.ed, bob.bundle);
    const b = x3dhInitiate(alice.ed, bob.bundle);
    expect(bytesEqual(a.sk, b.sk)).toBe(false);
  });

  it('a third party claiming Alice\'s identity cannot derive her secret', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const mallory = generateIdentity();
    const init = x3dhInitiate(alice.ed, bob.bundle);
    const forgedHeader = { ...init.header, ikA: toB64(mallory.ed.publicKey) };
    const resp = x3dhRespond(bob.ed, bob.spk, forgedHeader);
    expect(bytesEqual(init.sk, resp.sk)).toBe(false);
  });

  it('aborts on an invalid bundle (Flow B: KEY MISMATCH)', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const evil = generateIdentity();
    expect(() => x3dhInitiate(alice.ed, { ...bob.bundle, signedPrekeyX25519: evil.bundle.signedPrekeyX25519 })).toThrow(
      BundleRejected,
    );
  });

  it('responder rejects an unknown signed prekey', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const other = generateIdentity();
    const init = x3dhInitiate(alice.ed, bob.bundle);
    expect(() => x3dhRespond(bob.ed, bob.spk, { ...init.header, spkUsed: toB64(other.spk.publicKey) })).toThrow();
    expect(fromB64(init.header.ek)).toHaveLength(32);
  });
});
