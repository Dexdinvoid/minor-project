import {
  TAGS, bytesEqual, canonicalBytes, concat, fromB64, fromHex, toB64, toHex, utf8,
  type Hex, type KeyBundle,
} from '@sc/shared';
import { keccakHex, keccak256 } from './hash';
import { sodium, type KeyPair } from './sodium';

export interface Identity {
  ed: KeyPair; // Ed25519, privateKey is libsodium's 64-byte form
  spk: KeyPair; // X25519 signed prekey
  bundle: KeyBundle;
}

export const userIdOf = (edPublicKey: Uint8Array): Hex => keccakHex(edPublicKey);

/** Ed25519 -> X25519 conversions (single identity key; ground rule 2). */
export const edPkToX = (pk: Uint8Array): Uint8Array => sodium().crypto_sign_ed25519_pk_to_curve25519(pk);
export const edSkToX = (sk: Uint8Array): Uint8Array => sodium().crypto_sign_ed25519_sk_to_curve25519(sk);

export function generateX25519(): KeyPair {
  const kp = sodium().crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export function generateEd25519(): KeyPair {
  const kp = sodium().crypto_sign_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export const spkSigMessage = (spkPub: Uint8Array): Uint8Array => concat(utf8(TAGS.SPK), spkPub);

export function buildBundle(ed: KeyPair, spk: KeyPair, now = Date.now()): KeyBundle {
  const sig = sodium().crypto_sign_detached(spkSigMessage(spk.publicKey), ed.privateKey);
  return {
    v: 1,
    userId: userIdOf(ed.publicKey),
    identityKeyEd25519: toB64(ed.publicKey),
    signedPrekeyX25519: toB64(spk.publicKey),
    signedPrekeySig: toB64(sig),
    createdAt: now,
  };
}

export function generateIdentity(now = Date.now()): Identity {
  const ed = generateEd25519();
  const spk = generateX25519();
  return { ed, spk, bundle: buildBundle(ed, spk, now) };
}

export const bundleBytes = (b: KeyBundle): Uint8Array => canonicalBytes(b);
export const bundleHash = (b: KeyBundle): Hex => toHex(keccak256(bundleBytes(b)));

export type BundleCheck = { ok: true } | { ok: false; reason: 'USERID_MISMATCH' | 'BAD_SPK_SIGNATURE' | 'MALFORMED' };

/** Flow B steps B6-B7: identity key hashes to userId and the prekey signature is valid. */
export function verifyBundle(b: KeyBundle): BundleCheck {
  try {
    const ik = fromB64(b.identityKeyEd25519);
    const spk = fromB64(b.signedPrekeyX25519);
    const sig = fromB64(b.signedPrekeySig);
    if (ik.length !== 32 || spk.length !== 32 || sig.length !== 64) return { ok: false, reason: 'MALFORMED' };
    if (!bytesEqual(fromHex(b.userId), keccak256(ik))) return { ok: false, reason: 'USERID_MISMATCH' };
    if (!sodium().crypto_sign_verify_detached(sig, spkSigMessage(spk), ik)) {
      return { ok: false, reason: 'BAD_SPK_SIGNATURE' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
}

/** convoId = keccak256(sorted(userIdA, userIdB)). Hex strings are lowercase so lexicographic sort is stable. */
export function convoIdOf(a: Hex, b: Hex): Hex {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccakHex(concat(fromHex(x), fromHex(y)));
}

/** First-contact inbox: keccak256("SC1-FIRST" ++ userId). Authenticates with the identity key. */
export const firstInboxId = (userId: Hex): Hex => keccakHex(concat(utf8(TAGS.FIRST), fromHex(userId)));

/** Random per-conversation inbox: inboxId = keccak256(inboxPub). */
export const inboxIdOf = (inboxPub: Uint8Array): Hex => keccakHex(inboxPub);
export const generateInboxKeys = generateEd25519;
