import { describe, expect, test } from "bun:test";
import { compareVersions, parseVersion, versionMismatchWarning, versionStatus } from "../src/version.ts";
import { validateInstanceInput } from "../src/instance.ts";

describe("versions", () => {
  test("parse and compare", () => {
    expect(parseVersion("v3.2.4")).toEqual({ major: 3, minor: 2, patch: 4 });
    expect(parseVersion("3.3.3")).toEqual({ major: 3, minor: 3, patch: 3 });
    expect(parseVersion("nope")).toBeNull();
    expect(compareVersions(parseVersion("3.2.4")!, parseVersion("3.3.0")!)).toBeLessThan(0);
  });

  test("support range is v3.3 and newer", () => {
    expect(versionStatus(parseVersion("3.2.4")!)).toBe("unsupported");
    expect(versionStatus(parseVersion("3.3.0")!)).toBe("supported");
    expect(versionStatus(parseVersion("3.3.4")!)).toBe("supported");
    expect(versionStatus(parseVersion("3.4.0")!)).toBe("untested");
  });

  test("a mismatch between source and target is reported, equal versions are not", () => {
    expect(versionMismatchWarning(parseVersion("3.3.0")!, parseVersion("3.3.3")!)).toBe(
      "Source and target run different Immich versions (source v3.3.0, target v3.3.3).",
    );
    expect(versionMismatchWarning(parseVersion("3.3.3")!, parseVersion("3.3.3")!)).toBeNull();
  });
});

describe("instance input", () => {
  test("valid input has no problems", () => {
    expect(validateInstanceInput({ alias: "cclab", apiUrl: "https://immich.example.com/api", apiKey: "k" })).toEqual([]);
  });

  test("bad alias, missing /api and empty key are each reported", () => {
    const problems = validateInstanceInput({ alias: "../x", apiUrl: "https://immich.example.com", apiKey: " " });
    expect(problems).toHaveLength(3);
  });
});
