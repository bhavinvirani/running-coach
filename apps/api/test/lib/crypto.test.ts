import { describe, expect, it } from "vitest";
import { DecryptError, decrypt, encrypt } from "../../src/lib/crypto";

const USER_A = "4f1c2a8e-0000-4000-8000-000000000001";
const USER_B = "4f1c2a8e-0000-4000-8000-000000000002";
const SECRET = '{"di_token":"fixture-token","di_refresh_token":"fixture-refresh"}';

function flipByte(ciphertext: string, index: number): string {
  const payload = Buffer.from(ciphertext.slice(3), "base64url");
  payload[index] = (payload[index] ?? 0) ^ 0xff;
  return `v1:${payload.toString("base64url")}`;
}

describe("encrypt / decrypt", () => {
  it("round-trips for the same user", () => {
    expect(decrypt(encrypt(SECRET, USER_A), USER_A)).toBe(SECRET);
  });

  it("prefixes v1: and uses a fresh IV, so equal inputs never give equal ciphertexts", () => {
    const first = encrypt(SECRET, USER_A);
    const second = encrypt(SECRET, USER_A);

    expect(first.startsWith("v1:")).toBe(true);
    expect(first.slice(3)).toMatch(/^[\w-]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("fixture");
  });

  it("fails for another user's id, because the user id is authenticated data", () => {
    expect(() => decrypt(encrypt(SECRET, USER_A), USER_B)).toThrow(DecryptError);
  });

  it("fails closed on a tampered IV, body or tag", () => {
    const ciphertext = encrypt(SECRET, USER_A);
    const length = Buffer.from(ciphertext.slice(3), "base64url").length;

    for (const index of [0, 20, length - 1]) {
      expect(() => decrypt(flipByte(ciphertext, index), USER_A)).toThrow(DecryptError);
    }
  });

  it("fails closed on a missing or unknown version prefix and on truncated input", () => {
    const ciphertext = encrypt(SECRET, USER_A);

    expect(() => decrypt(ciphertext.slice(3), USER_A)).toThrow(DecryptError);
    expect(() => decrypt(`v2:${ciphertext.slice(3)}`, USER_A)).toThrow(DecryptError);
    expect(() => decrypt("v1:AAAA", USER_A)).toThrow(DecryptError);
    expect(() => decrypt("", USER_A)).toThrow(DecryptError);
  });
});
