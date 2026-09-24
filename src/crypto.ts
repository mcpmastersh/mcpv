// AES-256-GCM, one fresh 96-bit IV per value, with the value's own address as
// additional authenticated data. Binding the address means a ciphertext can't
// be moved to another key's slot in vault.json (by hand or by a bad merge) and
// still decrypt: swapping two entries turns both into authentication failures
// instead of quietly handing one secret out under the other's name.
//
// Stored form: base64(iv ‖ tag ‖ ciphertext).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function seal(key: Buffer, address: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(address, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** Throws on any tampering, a wrong key, or a ciphertext filed under the wrong address. */
export function open(key: Buffer, address: string, sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(address, "utf8"));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}
