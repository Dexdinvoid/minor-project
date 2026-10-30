import { beforeAll, describe, expect, it } from 'vitest';
import { fromB64, toB64, bytesEqual, type KeyBundle } from '@sc/shared';
import {
  convoIdOf, edPkToX, edSkToX, firstInboxId, generateIdentity, initCrypto, sodium, userIdOf,
  verifyBundle, bundleHash,
} from '../src';

beforeAll(initCrypto);

describe('identity', () => {
  it('Ed25519 -> X25519 conversion: public and private conversions agree (pitfall C6)', () => {
    const { ed } = generateIdentity();
    const xSk = edSkToX(ed.privateKey);
    const xPk = edPkToX(ed.publicKey);
    expect(bytesEqual(sodium().crypto_scalarmult_base(xSk), xPk)).toBe(true);
  });

  it('a valid bundle verifies and userId = keccak256(identity key)', () => {
    const id = generateIdentity();
    expect(verifyBundle(id.bundle)).toEqual({ ok: true });
    expect(id.bundle.userId).toBe(userIdOf(id.ed.publicKey));
  });

  it('rejects a bundle whose userId does not match the identity key', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const forged: KeyBundle = { ...a.bundle, userId: b.bundle.userId };
    expect(verifyBundle(forged)).toEqual({ ok: false, reason: 'USERID_MISMATCH' });
  });

  it('rejects a bundle with a substituted signed prekey (MITM)', () => {
    const a = generateIdentity();
    const evil = generateIdentity();
    const forged: KeyBundle = { ...a.bundle, signedPrekeyX25519: evil.bundle.signedPrekeyX25519 };
    expect(verifyBundle(forged)).toEqual({ ok: false, reason: 'BAD_SPK_SIGNATURE' });
  });

  it('rejects malformed bundles instead of throwing', () => {
    const a = generateIdentity();
    expect(verifyBundle({ ...a.bundle, identityKeyEd25519: 'abc' }).ok).toBe(false);
    expect(verifyBundle({ ...a.bundle, signedPrekeySig: toB64(new Uint8Array(10)) }).ok).toBe(false);
  });

  it('bundleHash is stable under key re-ordering (canonical JSON)', () => {
    const a = generateIdentity();
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a.bundle).reverse())));
    expect(bundleHash(reordered)).toBe(bundleHash(a.bundle));
  });

  it('convoId is symmetric; first-contact inbox is deterministic per user', () => {
    const a = generateIdentity().bundle.userId;
    const b = generateIdentity().bundle.userId;
    expect(convoIdOf(a, b)).toBe(convoIdOf(b, a));
    expect(firstInboxId(a)).toBe(firstInboxId(a));
    expect(firstInboxId(a)).not.toBe(firstInboxId(b));
    expect(fromB64(generateIdentity().bundle.identityKeyEd25519)).toHaveLength(32);
  });
});
