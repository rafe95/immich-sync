import { describe, expect, test } from "bun:test";
import { createRecoveryTokens, logSafeUsername, RECOVERY_TTL_MS } from "../src/auth/recovery.ts";

function setup() {
  let t = new Date("2026-11-18T10:00:00Z");
  const tokens = createRecoveryTokens({ now: () => t });
  return { tokens, advance: (ms: number) => (t = new Date(t.getTime() + ms)) };
}

function issued(r: ReturnType<ReturnType<typeof createRecoveryTokens>["issue"]>) {
  if (!r.issued) throw new Error("expected a new token");
  return r;
}

describe("recovery token store", () => {
  test("issue then consume returns the userId once", () => {
    const { tokens } = setup();
    const { token } = issued(tokens.issue("u1"));
    expect(tokens.consume(token)).toBe("u1");
    expect(tokens.consume(token)).toBeNull();
  });

  test("consume trims whitespace", () => {
    const { tokens } = setup();
    const { token } = issued(tokens.issue("u1"));
    expect(tokens.consume(`  ${token}\n`)).toBe("u1");
  });

  test("a second issue while active does not replace the token", () => {
    const { tokens } = setup();
    const first = issued(tokens.issue("u1"));
    expect(tokens.issue("u1")).toEqual({ issued: false, activeUntil: first.expiresAt });
    expect(tokens.consume(first.token)).toBe("u1");
  });

  test("tokens expire after the lifetime and a new one can then be issued", () => {
    const { tokens, advance } = setup();
    const first = issued(tokens.issue("u1"));
    expect(first.expiresAt.getTime() - new Date("2026-11-18T10:00:00Z").getTime()).toBe(RECOVERY_TTL_MS);
    advance(RECOVERY_TTL_MS);
    expect(tokens.consume(first.token)).toBeNull();
    const second = issued(tokens.issue("u1"));
    expect(second.token).not.toBe(first.token);
  });

  test("clear makes a pending token unusable", () => {
    const { tokens } = setup();
    const { token } = issued(tokens.issue("u1"));
    tokens.clear("u1");
    expect(tokens.consume(token)).toBeNull();
  });

  test("unknown or empty tokens are refused", () => {
    const { tokens } = setup();
    issued(tokens.issue("u1"));
    expect(tokens.consume("not-a-token")).toBeNull();
    expect(tokens.consume("")).toBeNull();
    expect(tokens.consume("   ")).toBeNull();
  });

  test("tokens are per user", () => {
    const { tokens } = setup();
    const a = issued(tokens.issue("u1"));
    const b = issued(tokens.issue("u2"));
    expect(tokens.consume(b.token)).toBe("u2");
    expect(tokens.consume(a.token)).toBe("u1");
  });

  test("logSafeUsername strips control characters, lowercases and truncates", () => {
    const safe = logSafeUsername("Ada\n[recovery] x\r\u0000");
    expect(safe).not.toMatch(/[\n\r\u0000]/);
    expect(safe).toBe(safe.toLowerCase());
    expect(safe.startsWith("ada")).toBe(true);
    expect(logSafeUsername("a".repeat(100)).length).toBe(64);
  });

  test("logSafeUsername removes Unicode line separators, format characters and quotes", () => {
    expect(logSafeUsername('a\u2028b\u2029c\u200bd"e\u0085f')).toBe("abcdef");
  });
});
