import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config";

// AES-256-GCM with MASTER_KEY. Ciphertext format: "v1:" + base64url(iv | ciphertext | tag).
// The user id is the additional authenticated data, so a value copied to another user's row fails to decrypt.
// The version prefix lets a later key rotation add "v2" while v1 values still decrypt.

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";
const keys: Record<string, Buffer> = { [VERSION]: Buffer.from(config.MASTER_KEY, "base64") };

/** Any decrypt failure: wrong user, tampered or truncated value, unknown key version. No partial output. */
export class DecryptError extends Error {
  constructor() {
    super("Could not decrypt the value");
    this.name = "DecryptError";
  }
}

export function encrypt(plaintext: string, userId: string): string {
  const key = keys[VERSION];
  if (!key) throw new Error(`No key for ${VERSION}`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(userId, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const payload = Buffer.concat([iv, body, cipher.getAuthTag()]);
  return `${VERSION}:${payload.toString("base64url")}`;
}

export function decrypt(ciphertext: string, userId: string): string {
  const separator = ciphertext.indexOf(":");
  const key = separator > 0 ? keys[ciphertext.slice(0, separator)] : undefined;
  if (!key) throw new DecryptError();
  const payload = Buffer.from(ciphertext.slice(separator + 1), "base64url");
  if (payload.length < IV_BYTES + TAG_BYTES) throw new DecryptError();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, payload.subarray(0, IV_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(userId, "utf8"));
    decipher.setAuthTag(payload.subarray(payload.length - TAG_BYTES));
    const body = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptError();
  }
}
