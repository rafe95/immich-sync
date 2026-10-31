import { expect, test } from "bun:test";
import { loggedIn, startTestServer } from "./helpers.ts";

test("authenticated deletion keeps its response connection alive beyond Bun's default idle timeout", async () => {
  const t = startTestServer({
    eraser: {
      counts: async () => ({ instances: 0, jobs: 0, runs: 0 }),
      erase: async () => { await Bun.sleep(11_000); },
    },
  });
  try {
    await t.ready;
    const admin = await loggedIn(t.base);
    const created = await admin.call("POST", "/api/users", { username: "slow-delete", password: "a sufficiently long password" });
    expect(created.status).toBe(201);
    const { user } = await created.json();
    const response = await admin.call("DELETE", `/api/users/${user.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
  } finally {
    await t.stop();
  }
}, 20_000);