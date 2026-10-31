import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config.ts";

const valid = {
  DATABASE_URL: "postgres://immich_sync:pw@localhost:5432/immich_sync",
  SECRET_KEY: "x".repeat(32),
};

describe("loadConfig", () => {
  test("valid environment, defaults applied", () => {
    expect(loadConfig(valid)).toEqual({
      host: "127.0.0.1",
      port: 8080,
      databaseUrl: valid.DATABASE_URL,
      secretKey: valid.SECRET_KEY,
      staticDir: null,
      cookieSecure: "auto",
      trustProxy: false,
    });
  });

  test("TRUST_PROXY defaults to false and must be true or false", () => {
    expect(loadConfig({ ...valid, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(() => loadConfig({ ...valid, TRUST_PROXY: "yes" })).toThrow(ConfigError);
  });

  test("HOST overrides the loopback default", () => {
    expect(loadConfig({ ...valid, HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  test("every problem is reported at once", () => {
    try {
      loadConfig({ SECRET_KEY: "short", PORT: "99999" });
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).problems).toHaveLength(3);
    }
  });

  test("ADMIN_PASSWORD in the environment is ignored and never read", () => {
    const config = loadConfig({ ...valid, ADMIN_PASSWORD: "legacy" });
    expect(JSON.stringify(config)).not.toContain("legacy");
    expect(Object.keys(config)).not.toContain("adminPassword");
  });

  test("a non-postgres URL is refused", () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: "mysql://x" })).toThrow("postgres://");
  });
});
