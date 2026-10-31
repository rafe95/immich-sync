import { expect, test } from "bun:test";
import { createUserBody, isAdmin, isSetupPath, lastLoginText, loginBody, newUserProblems, setupProblems, usernameProblem } from "./users.ts";

test("username rules", () => {
  expect(usernameProblem("al")).not.toBeNull();
  expect(usernameProblem("a".repeat(65))).not.toBeNull();
  expect(usernameProblem("bad name")).not.toBeNull();
  expect(usernameProblem("a@b")).not.toBeNull();
  expect(usernameProblem("Al.ice_-9")).toBeNull();
});

test("setup form checks username, password length and confirmation", () => {
  expect(setupProblems({ username: "admin", password: "x".repeat(12), confirm: "x".repeat(12) })).toEqual([]);
  expect(setupProblems({ username: "a", password: "short", confirm: "other" })).toHaveLength(3);
  expect(setupProblems({ username: "admin", password: "x".repeat(257), confirm: "x".repeat(257) })).toHaveLength(1);
});

test("new user form needs a valid role", () => {
  expect(newUserProblems({ username: "bob", password: "x".repeat(12), role: "user" })).toEqual([]);
  expect(newUserProblems({ username: "bob", password: "x".repeat(12), role: "root" as never })).toHaveLength(1);
});

test("role checks and request bodies", () => {
  expect(isAdmin({ id: "1", username: "a", role: "admin" })).toBe(true);
  expect(isAdmin({ id: "2", username: "b", role: "user" })).toBe(false);
  expect(isAdmin(null)).toBe(false);
  expect(loginBody(" bob ", " pw ")).toEqual({ username: "bob", password: " pw " });
  expect(createUserBody({ username: "bob ", password: "p", role: "user" })).toEqual({ username: "bob", password: "p", role: "user" });
});

test("setup path detection and last-login text", () => {
  expect(isSetupPath("/setup")).toBe(true);
  expect(isSetupPath("/setup/")).toBe(true);
  expect(isSetupPath("/")).toBe(false);
  expect(isSetupPath("/setupx")).toBe(false);
  expect(lastLoginText(null)).toBe("Never");
  expect(lastLoginText("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:30:00Z"))).toBe("30 min ago");
});
