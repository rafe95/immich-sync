import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../src/config.ts";

const valid = {
  DATABASE_URL: "postgres://immich_sync:pw@localhost:5432/immich_sync",
  ADMIN_PASSWORD: "admin",
  SECRET_KEY: "x".repeat(32),
};

describe("loadConfig", () => {
  test("valid environment, defaults applied", () => {
    expect(loadConfig(valid)).toEqual({
      host: "127.0.0.1",
      port: 8080,
      databaseUrl: valid.DATABASE_URL,
      adminPassword: "admin",
      secretKey: valid.SECRET_KEY,
      staticDir: null,
      cookieSecure: "auto",
    });
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
      expect((err as ConfigError).problems).toHaveLength(4);
    }
  });

  test("a non-postgres URL is refused", () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: "mysql://x" })).toThrow("postgres://");
  });
});
