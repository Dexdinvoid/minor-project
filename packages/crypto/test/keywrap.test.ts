import { beforeAll, describe, expect, it } from 'vitest';
import { bytesEqual } from '@sc/shared';
import { AuthError, initCrypto, randomBytes, sodium, unwrapSecret, wrapSecret } from '../src';

beforeAll(initCrypto);

describe('passphrase wrapping (Argon2id)', () => {
  const params = () => ({ ops: sodium().crypto_pwhash_OPSLIMIT_MIN, mem: sodium().crypto_pwhash_MEMLIMIT_MIN });

  it('round trips with the right passphrase', () => {
    const secret = randomBytes(64);
    const w = wrapSecret('correct horse battery staple', secret, params());
    expect(bytesEqual(unwrapSecret('correct horse battery staple', w), secret)).toBe(true);
  });
  it('wrong passphrase and tampering both fail with AuthError', () => {
    const w = wrapSecret('pw', randomBytes(32), params());
    expect(() => unwrapSecret('PW', w)).toThrow(AuthError);
    const ct = Buffer.from(w.ct, 'base64url');
    ct[0] = ct[0]! ^ 1;
    expect(() => unwrapSecret('pw', { ...w, ct: ct.toString('base64url') })).toThrow(AuthError);
  });
  it('the same secret wrapped twice yields different blobs (random salt + nonce)', () => {
    const s = randomBytes(32);
    expect(wrapSecret('pw', s, params()).ct).not.toBe(wrapSecret('pw', s, params()).ct);
  });
});
