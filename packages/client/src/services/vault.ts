import { Wallet } from 'ethers';
import {
  aeadDecrypt, aeadEncrypt, buildBundle, deriveStorageKey, generateEd25519, generateX25519, randomBytes,
  unwrapSecret, wrapSecret, wipe, type KeyPair,
} from '@sc/crypto';
import { fromB64, fromUtf8, toB64, utf8, type Hex, type KeyBundle } from '@sc/shared';
import { appDb } from './db';

interface SecretBlob {
  ed: string;
  spk: string;
  wallet: string; // 0x private key for the ledger wallet (pays gas for publishBundle)
  storage: string; // random root key for at-rest encryption of sessions
}

/**
 * Keeps secret keys in memory only, outside React / Zustand state (pitfall U3).
 * Everything on disk is either public or wrapped by the passphrase.
 */
export class Vault {
  ed!: KeyPair;
  spk!: KeyPair;
  walletKey = '';
  private storageKey!: Uint8Array;
  userId!: Hex;
  bundle!: KeyBundle;
  name = '';
  unlocked = false;

  static async exists(): Promise<boolean> {
    return (await appDb.identity.get('me')) !== undefined;
  }

  /** Create a brand-new identity and persist it wrapped. Returns the bundle JSON bytes to publish. */
  async create(name: string, passphrase: string): Promise<{ bundleBytes: Uint8Array }> {
    const ed = generateEd25519();
    const spk = generateX25519();
    const bundle = buildBundle(ed, spk);
    const wallet = Wallet.createRandom();
    const storage = randomBytes(32);
    const blob: SecretBlob = { ed: toB64(ed.privateKey), spk: toB64(spk.privateKey), wallet: wallet.privateKey, storage: toB64(storage) };
    const wrapped = wrapSecret(passphrase, utf8(JSON.stringify(blob)));
    await appDb.identity.put({ id: 'me', name, userId: bundle.userId, bundle, wrapped });
    this.load(name, bundle, ed.privateKey, spk.privateKey, wallet.privateKey, storage);
    return { bundleBytes: utf8(JSON.stringify(bundle)) };
  }

  /** Throws AuthError on a wrong passphrase. */
  async unlock(passphrase: string): Promise<void> {
    const row = await appDb.identity.get('me');
    if (!row) throw new Error('no identity');
    const raw = unwrapSecret(passphrase, row.wrapped);
    const blob = JSON.parse(fromUtf8(raw)) as SecretBlob;
    wipe(raw);
    this.load(row.name, row.bundle, fromB64(blob.ed), fromB64(blob.spk), blob.wallet, fromB64(blob.storage));
  }

  private load(name: string, bundle: KeyBundle, edSk: Uint8Array, spkSk: Uint8Array, walletKey: string, storage: Uint8Array) {
    this.name = name;
    this.bundle = bundle;
    this.userId = bundle.userId;
    this.ed = { privateKey: edSk, publicKey: fromB64(bundle.identityKeyEd25519) };
    this.spk = { privateKey: spkSk, publicKey: fromB64(bundle.signedPrekeyX25519) };
    this.walletKey = walletKey;
    this.storageKey = storage;
    this.unlocked = true;
  }

  lock(): void {
    if (!this.unlocked) return;
    wipe(this.ed.privateKey, this.spk.privateKey, this.storageKey);
    this.walletKey = '';
    this.unlocked = false;
  }

  /** Encrypt per-conversation secrets (ratchet state + inbox private key) for IndexedDB. */
  seal(convoId: string, json: string): { nonce: string; ct: string } {
    const k = deriveStorageKey(this.storageKey, `session:${convoId}`);
    const { nonce, ciphertext } = aeadEncrypt(k, utf8(json), utf8(convoId));
    wipe(k);
    return { nonce: toB64(nonce), ct: toB64(ciphertext) };
  }

  open(convoId: string, enc: { nonce: string; ct: string }): string {
    const k = deriveStorageKey(this.storageKey, `session:${convoId}`);
    try {
      return fromUtf8(aeadDecrypt(k, fromB64(enc.nonce), fromB64(enc.ct), utf8(convoId)));
    } finally {
      wipe(k);
    }
  }
}
