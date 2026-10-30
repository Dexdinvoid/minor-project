import { bytesEqual, concat, fromB64, toB64, TAGS, type KeyBundle, type RelayEnvelope } from '@sc/shared';
import { hkdfSha256 } from './hash';
import { edPkToX, edSkToX, generateX25519, verifyBundle } from './identity';
import { sodium, wipe, type KeyPair } from './sodium';

export type X3dhHeader = NonNullable<RelayEnvelope['x3dh']>;

const dh = (sk: Uint8Array, pk: Uint8Array): Uint8Array => sodium().crypto_scalarmult(sk, pk);
const ZERO32 = new Uint8Array(32);

function deriveSk(dh1: Uint8Array, dh2: Uint8Array, dh3: Uint8Array): Uint8Array {
  return hkdfSha256(concat(dh1, dh2, dh3), ZERO32, TAGS.X3DH, 32);
}

export class BundleRejected extends Error {
  constructor(public reason: string) {
    super(`key bundle rejected: ${reason}`);
    this.name = 'BundleRejected';
  }
}

/** Alice: X3DH without one-time prekeys (documented simplification). */
export function x3dhInitiate(
  myEd: KeyPair, theirBundle: KeyBundle,
): { sk: Uint8Array; header: X3dhHeader; theirSpk: Uint8Array } {
  const check = verifyBundle(theirBundle);
  if (!check.ok) throw new BundleRejected(check.reason);
  const ikAx = edSkToX(myEd.privateKey);
  const ikBx = edPkToX(fromB64(theirBundle.identityKeyEd25519));
  const spkB = fromB64(theirBundle.signedPrekeyX25519);
  const ek = generateX25519();
  const dh1 = dh(ikAx, spkB);
  const dh2 = dh(ek.privateKey, ikBx);
  const dh3 = dh(ek.privateKey, spkB);
  const sk = deriveSk(dh1, dh2, dh3);
  wipe(ikAx, dh1, dh2, dh3, ek.privateKey);
  return {
    sk,
    header: { ikA: toB64(myEd.publicKey), ek: toB64(ek.publicKey), spkUsed: toB64(spkB) },
    theirSpk: spkB,
  };
}

/** Bob: recompute the same three DHs. */
export function x3dhRespond(
  myEd: KeyPair, mySpk: KeyPair, header: X3dhHeader,
): { sk: Uint8Array; peerIdentityKey: Uint8Array } {
  if (!bytesEqual(fromB64(header.spkUsed), mySpk.publicKey)) throw new Error('unknown signed prekey');
  const ikAEd = fromB64(header.ikA);
  const ikAx = edPkToX(ikAEd);
  const ek = fromB64(header.ek);
  const ikBx = edSkToX(myEd.privateKey);
  const dh1 = dh(mySpk.privateKey, ikAx);
  const dh2 = dh(ikBx, ek);
  const dh3 = dh(mySpk.privateKey, ek);
  const sk = deriveSk(dh1, dh2, dh3);
  wipe(ikBx, dh1, dh2, dh3);
  return { sk, peerIdentityKey: ikAEd };
}
