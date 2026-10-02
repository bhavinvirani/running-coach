import { createHash } from "node:crypto";

/**
 * A stable signed 64-bit key for pg_advisory_*lock, from a namespace and an id. SHA-256 keeps unrelated
 * namespaces from colliding in practice; the value is a decimal string so it travels as a bigint parameter.
 */
export function advisoryLockKey(namespace: string, id: string): string {
  const digest = createHash("sha256").update(`${namespace}\u0000${id}`).digest();
  return digest.readBigInt64BE(0).toString();
}
