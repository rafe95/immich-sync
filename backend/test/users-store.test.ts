import { describe, expect, test } from "bun:test";
import { LastAdminError, memoryUserStore } from "../src/auth/users.ts";

describe("user deletion admin guards (memory)", () => {
  test("deleting admins do not count towards the last-admin guard; retries still work", async () => {
    const users = memoryUserStore();
    const a = await users.create("admin-a", "h", "admin");
    const b = await users.create("admin-b", "h", "admin");
    await users.markDeleting(b.id, new Date());
    await expect(users.markDeleting(a.id, new Date())).rejects.toBeInstanceOf(LastAdminError);
    await expect(users.delete(a.id)).rejects.toBeInstanceOf(LastAdminError);
    await expect(users.update(a.id, { role: "user" })).rejects.toBeInstanceOf(LastAdminError);
    expect((await users.get(a.id))?.deletingAt).toBeNull();
    expect((await users.markDeleting(b.id, new Date()))?.deletingAt).not.toBeNull();
    expect(await users.delete(b.id)).toBe(true);
    expect((await users.get(a.id))?.role).toBe("admin");
  });

  test("concurrent deletion lockouts leave one usable admin", async () => {
    const users = memoryUserStore();
    const a = await users.create("concurrent-a", "h", "admin");
    const b = await users.create("concurrent-b", "h", "admin");
    const results = await Promise.allSettled([users.markDeleting(a.id, new Date()), users.markDeleting(b.id, new Date())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.any(LastAdminError) });
    expect((await users.list()).filter((u) => u.role === "admin" && !u.deletingAt)).toHaveLength(1);
  });
});