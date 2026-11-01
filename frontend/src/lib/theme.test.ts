import { expect, test } from "bun:test";
import { colorScheme, parsePref } from "./theme.ts";

test("parsePref falls back to system", () => {
  expect(parsePref("dark")).toBe("dark");
  expect(parsePref("light")).toBe("light");
  expect(parsePref("purple")).toBe("system");
  expect(parsePref(null)).toBe("system");
});

test("colorScheme keeps both schemes for system", () => {
  expect(colorScheme("system")).toBe("light dark");
  expect(colorScheme("dark")).toBe("dark");
});
