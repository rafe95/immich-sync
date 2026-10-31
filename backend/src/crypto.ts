/**
 * Encryption of API keys at rest: AES-256-GCM with a key derived from SECRET_KEY via HKDF-SHA256.
 * Stored format (bytea): [version byte 0x01][12-byte IV][ciphertext + 16-byte GCM tag].
 * The version byte lets a later format (or key rotation) be introduced without ambiguity.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const INFO = "immich-sync api-key encryption v1";

export class DecryptError extends Error {
  constructor() {
    // Deliberately generic: never include key material or ciphertext details.
    super("Stored secret could not be decrypted (wrong SECRET_KEY or corrupted data).");
    this.name = "DecryptError";
  }
}

function deriveKey(secretKey: string): Buffer {
  if (!secretKey) throw new Error("SECRET_KEY is required for encryption.");
  return Buffer.from(hkdfSync("sha256", secretKey, "immich-sync", INFO, 32));
}

export function encryptSecret(plaintext: string, secretKey: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secretKey), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, body, cipher.getAuthTag()]);
}

export function decryptSecret(blob: Uint8Array, secretKey: string): string {
  const data = Buffer.from(blob);
  if (data.length < 1 + IV_LENGTH + TAG_LENGTH || data[0] !== VERSION) throw new DecryptError();
  const iv = data.subarray(1, 1 + IV_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const body = data.subarray(1 + IV_LENGTH, data.length - TAG_LENGTH);
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secretKey), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptError();
  }
}
