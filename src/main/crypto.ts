import { argon2id } from 'hash-wasm';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export interface KdfParams {
  algorithm: 'argon2id';
  salt: string; // base64
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export const DEFAULT_KDF = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 };

const NONCE_LEN = 12;
const TAG_LEN = 16;

export function newKdfParams(): KdfParams {
  return { algorithm: 'argon2id', salt: randomBytes(16).toString('base64'), ...DEFAULT_KDF };
}

/** Stretch the master password into a 256-bit key. Deliberately slow. */
export async function deriveKey(password: string, params: KdfParams): Promise<Buffer> {
  const out = await argon2id({
    password: password.normalize('NFC'),
    salt: Buffer.from(params.salt, 'base64'),
    memorySize: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: 'binary',
  });
  return Buffer.from(out);
}

/** Independent per-purpose keys from the data key, so one key never does two jobs. */
export function subkey(dataKey: Buffer, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', dataKey, Buffer.alloc(0), `minbrowser:${label}`, 32));
}

/** AES-256-GCM. Output layout: nonce(12) | ciphertext | tag(16). */
export function seal(key: Buffer, plaintext: Uint8Array, aad: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/** Throws if the key is wrong or the data was tampered with. */
export function open(key: Buffer, sealed: Uint8Array, aad: Buffer): Buffer {
  if (sealed.length < NONCE_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, NONCE_LEN));
  decipher.setAAD(aad);
  decipher.setAuthTag(buf.subarray(buf.length - TAG_LEN));
  return Buffer.concat([decipher.update(buf.subarray(NONCE_LEN, buf.length - TAG_LEN)), decipher.final()]);
}

export function randomKey(): Buffer {
  return randomBytes(32);
}
