import { LIMITS, fromB64, toB64, type B64, type RatchetHeader } from '@sc/shared';
import { kdfCk, kdfRk } from './kdf';
import { generateX25519 } from './identity';
import { sodium, wipe, type KeyPair } from './sodium';

/**
 * Double Ratchet (Signal spec) composed from audited primitives. NOT an audited implementation.
 * All step functions are PURE: they work on a copy and return the new state. The caller commits the
 * new state only after the AEAD tag has verified (pitfall C7).
 */
export interface SkippedKey {
  dh: B64;
  n: number;
  mk: Uint8Array;
}

export interface RatchetState {
  dhsPub: Uint8Array;
  dhsSec: Uint8Array;
  dhr: Uint8Array | null;
  rk: Uint8Array;
  cks: Uint8Array | null;
  ckr: Uint8Array | null;
  ns: number;
  nr: number;
  pn: number;
  skipped: SkippedKey[]; // oldest first
}

export class RatchetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RatchetError';
  }
}

const dh = (sk: Uint8Array, pk: Uint8Array): Uint8Array => sodium().crypto_scalarmult(sk, pk);
const copy = (b: Uint8Array | null): Uint8Array | null => (b ? b.slice() : null);

export function cloneState(s: RatchetState): RatchetState {
  return {
    dhsPub: s.dhsPub.slice(),
    dhsSec: s.dhsSec.slice(),
    dhr: copy(s.dhr),
    rk: s.rk.slice(),
    cks: copy(s.cks),
    ckr: copy(s.ckr),
    ns: s.ns,
    nr: s.nr,
    pn: s.pn,
    skipped: s.skipped.map((k) => ({ dh: k.dh, n: k.n, mk: k.mk.slice() })),
  };
}

/** Alice, after X3DH: she knows Bob's signed prekey, which acts as his first ratchet public key. */
export function initInitiator(sk: Uint8Array, theirSpkPub: Uint8Array): RatchetState {
  const dhs = generateX25519();
  const [rk, cks] = kdfRk(sk, dh(dhs.privateKey, theirSpkPub));
  return {
    dhsPub: dhs.publicKey, dhsSec: dhs.privateKey, dhr: theirSpkPub.slice(),
    rk, cks, ckr: null, ns: 0, nr: 0, pn: 0, skipped: [],
  };
}

/** Bob, after X3DH: his signed prekey pair is his first ratchet key pair. He cannot send until he receives. */
export function initResponder(sk: Uint8Array, spk: KeyPair): RatchetState {
  return {
    dhsPub: spk.publicKey.slice(), dhsSec: spk.privateKey.slice(), dhr: null,
    rk: sk.slice(), cks: null, ckr: null, ns: 0, nr: 0, pn: 0, skipped: [],
  };
}

export interface EncryptStep {
  state: RatchetState;
  header: RatchetHeader;
  messageKey: Uint8Array;
}

export function ratchetEncryptStep(prev: RatchetState): EncryptStep {
  if (!prev.cks) throw new RatchetError('no sending chain yet: receive a message first');
  const state = cloneState(prev);
  const [mk, nextCk] = kdfCk(state.cks!);
  const header: RatchetHeader = { dh: toB64(state.dhsPub), pn: state.pn, n: state.ns };
  state.cks = nextCk;
  state.ns += 1;
  return { state, header, messageKey: mk };
}

export interface DecryptStep {
  state: RatchetState;
  messageKey: Uint8Array;
}

function skipMessageKeys(s: RatchetState, until: number): void {
  if (!s.ckr) return;
  if (until - s.nr > LIMITS.MAX_SKIP) throw new RatchetError('too many skipped messages');
  const dhB64 = toB64(s.dhr!);
  while (s.nr < until) {
    const [mk, next] = kdfCk(s.ckr);
    s.skipped.push({ dh: dhB64, n: s.nr, mk });
    s.ckr = next;
    s.nr += 1;
  }
  // Cap memory: drop oldest first (pitfall C8).
  while (s.skipped.length > LIMITS.MAX_SKIP) {
    const dropped = s.skipped.shift();
    wipe(dropped?.mk);
  }
}

function dhRatchet(s: RatchetState, theirNewDh: Uint8Array): void {
  s.pn = s.ns;
  s.ns = 0;
  s.nr = 0;
  s.dhr = theirNewDh;
  const [rk1, ckr] = kdfRk(s.rk, dh(s.dhsSec, s.dhr));
  const next: KeyPair = generateX25519();
  s.dhsPub = next.publicKey;
  s.dhsSec = next.privateKey;
  const [rk2, cks] = kdfRk(rk1, dh(s.dhsSec, s.dhr));
  s.rk = rk2;
  s.ckr = ckr;
  s.cks = cks;
}

/**
 * Derive the message key for an incoming header. Returns a NEW state; the input is untouched.
 * The caller must verify an AEAD tag with the returned key before storing the new state.
 */
export function ratchetDecryptStep(prev: RatchetState, header: RatchetHeader): DecryptStep {
  const theirDh = fromB64(header.dh);
  if (theirDh.length !== 32) throw new RatchetError('bad ratchet key');
  const s = cloneState(prev);

  const idx = s.skipped.findIndex((k) => k.dh === header.dh && k.n === header.n);
  if (idx >= 0) {
    const [hit] = s.skipped.splice(idx, 1);
    return { state: s, messageKey: hit!.mk };
  }

  const sameChain = s.dhr !== null && toB64(s.dhr) === header.dh;
  if (!sameChain) {
    skipMessageKeys(s, header.pn);
    dhRatchet(s, theirDh);
  }
  if (header.n < s.nr) throw new RatchetError('duplicate or already-consumed message');
  skipMessageKeys(s, header.n);
  if (!s.ckr) throw new RatchetError('no receiving chain');
  const [mk, nextCk] = kdfCk(s.ckr);
  s.ckr = nextCk;
  s.nr += 1;
  return { state: s, messageKey: mk };
}

// ---- persistence helpers (the caller encrypts the JSON at rest) ----

interface SerializedRatchet {
  v: 1;
  dhsPub: B64; dhsSec: B64; dhr: B64 | null; rk: B64; cks: B64 | null; ckr: B64 | null;
  ns: number; nr: number; pn: number;
  skipped: { dh: B64; n: number; mk: B64 }[];
}

export function serializeRatchet(s: RatchetState): string {
  const o: SerializedRatchet = {
    v: 1,
    dhsPub: toB64(s.dhsPub), dhsSec: toB64(s.dhsSec),
    dhr: s.dhr ? toB64(s.dhr) : null, rk: toB64(s.rk),
    cks: s.cks ? toB64(s.cks) : null, ckr: s.ckr ? toB64(s.ckr) : null,
    ns: s.ns, nr: s.nr, pn: s.pn,
    skipped: s.skipped.map((k) => ({ dh: k.dh, n: k.n, mk: toB64(k.mk) })),
  };
  return JSON.stringify(o);
}

export function deserializeRatchet(json: string): RatchetState {
  const o = JSON.parse(json) as SerializedRatchet;
  if (o.v !== 1) throw new RatchetError('unsupported ratchet state version');
  return {
    dhsPub: fromB64(o.dhsPub), dhsSec: fromB64(o.dhsSec),
    dhr: o.dhr ? fromB64(o.dhr) : null, rk: fromB64(o.rk),
    cks: o.cks ? fromB64(o.cks) : null, ckr: o.ckr ? fromB64(o.ckr) : null,
    ns: o.ns, nr: o.nr, pn: o.pn,
    skipped: o.skipped.map((k) => ({ dh: k.dh, n: k.n, mk: fromB64(k.mk) })),
  };
}
