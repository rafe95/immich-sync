import { describe, expect, test } from "bun:test";
import { DecryptError, decryptSecret, encryptSecret } from "../src/crypto.ts";

const key = "a".repeat(32);

describe("crypto", () => {
  test("round trips and uses a versioned format with a fresh IV", () => {
    const a = encryptSecret("my-immich-key", key);
    const b = encryptSecret("my-immich-key", key);
    expect(a[0]).toBe(1);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from("my-immich-key"))).toBe(false);
    expect(decryptSecret(a, key)).toBe("my-immich-key");
  });

  test("wrong key, tampering, truncation and unknown version fail with a generic error", () => {
    const blob = encryptSecret("secret", key);
    expect(() => decryptSecret(blob, "b".repeat(32))).toThrow(DecryptError);
    const tampered = Buffer.from(blob);
    tampered[20] = tampered[20]! ^ 1;
    expect(() => decryptSecret(tampered, key)).toThrow(DecryptError);
    expect(() => decryptSecret(blob.subarray(0, 10), key)).toThrow(DecryptError);
    const v2 = Buffer.from(blob);
    v2[0] = 2;
    expect(() => decryptSecret(v2, key)).toThrow(DecryptError);
  });

  test("an empty SECRET_KEY is refused", () => {
    expect(() => encryptSecret("x", "")).toThrow();
  });
});
