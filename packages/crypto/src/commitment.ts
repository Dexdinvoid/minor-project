import { TAGS, concat, utf8 } from '@sc/shared';
import { keccak256 } from './hash';

/** C = keccak256( utf8(cid) ++ salt ) */
export const commitment = (cid: string, salt: Uint8Array): Uint8Array => keccak256(concat(utf8(cid), salt));

/** leaf = keccak256( utf8("SC1-LEAF") ++ C ++ keccak256(sig) ). Preimage is 72 bytes, never a 64-byte inner node. */
export const leafOf = (C: Uint8Array, sig: Uint8Array): Uint8Array =>
  keccak256(concat(utf8(TAGS.LEAF), C, keccak256(sig)));
