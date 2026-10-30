import _sodium from 'libsodium-wrappers-sumo';

type Sodium = typeof _sodium;
let ready: Sodium | null = null;

/** Pitfall C1: await this once at app / test start before any other call. */
export async function initCrypto(): Promise<void> {
  await _sodium.ready;
  ready = _sodium;
}

export function sodium(): Sodium {
  if (!ready) throw new Error('crypto not initialised: await initCrypto() first');
  return ready;
}

export class AuthError extends Error {
  constructor(message = 'authentication failed') {
    super(message);
    this.name = 'AuthError';
  }
}

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function randomBytes(n: number): Uint8Array {
  return sodium().randombytes_buf(n); // never Math.random (pitfall C10)
}

/** Constant-time equality for secrets (pitfall C11). */
export function secretEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return sodium().memcmp(a, b);
}

export function wipe(...bufs: (Uint8Array | null | undefined)[]): void {
  for (const b of bufs) if (b) sodium().memzero(b);
}
