import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { byText, flush, render, settle, useDom } from "../test/dom.ts";

useDom();

const Users = (await import("./Users.svelte")).default;
const Settings = (await import("./Settings.svelte")).default;
const Login = (await import("./Login.svelte")).default;
const Setup = (await import("./Setup.svelte")).default;

type Call = { method: string; url: string };
let calls: Call[] = [];
let routes: Record<string, unknown> = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    calls.push({ method, url });
    const key = `${method} ${url}`;
    if (!(key in routes)) throw new Error(`unexpected fetch ${key}`);
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const users = [
  { id: "1", username: "ada", role: "admin", lastLoginAt: null, deletingAt: null },
  { id: "2", username: "bob", role: "user", lastLoginAt: null, deletingAt: null },
];

async function mountUsers() {
  const { session } = await import("./lib/session.svelte.ts");
  session.user = { id: "1", username: "ada", role: "admin" };
    const root = render(Users, {});
  await settle();
  return root;
}

describe("Users screen", () => {
  test("lists accounts in a table and shows counted deletion confirmation before deleting", async () => {
    routes = { "GET /api/users": { users }, "GET /api/users/2/data": { instances: 2, jobs: 3, runs: 4 } };
    const root = await mountUsers();
    const rows = [...root.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("(you)");
    expect(root.querySelectorAll("th[scope=col]")).toHaveLength(4);

    byText(rows[1] as HTMLElement, "button", "Delete").click();
    await settle();
    const status = root.querySelector("[role=status]");
    expect(status?.textContent).toContain("2 instances, 3 jobs");
    expect(status?.textContent).toContain("4 runs");
    // Nothing is deleted until the explicit confirmation.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(byText(root, "button", "Confirm delete").hasAttribute("disabled")).toBe(false);

    byText(root, "button", "Cancel").click();
    await settle();
    expect(root.textContent).not.toContain("Confirm delete");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("Confirm delete is disabled until the counts have loaded", async () => {
    routes = { "GET /api/users": { users }, "GET /api/users/2/data": { instances: 0, jobs: 0, runs: 0 } };
    const root = await mountUsers();
    byText(root.querySelectorAll("tbody tr")[1] as HTMLElement, "button", "Delete").click();
    flush();
    expect(byText(root, "button", "Confirm delete").hasAttribute("disabled")).toBe(true);
    await settle();
    expect(byText(root, "button", "Confirm delete").hasAttribute("disabled")).toBe(false);
  });
});

describe("Settings screen", () => {
  test("administrators see change password, run history and appearance cards", async () => {
    routes = { "GET /api/settings/retention": { days: 90 } };
    const { session } = await import("./lib/session.svelte.ts");
    session.user = { id: "1", username: "ada", role: "admin" };
    const root = render(Settings, {});
    await settle();
    const headings = [...root.querySelectorAll("h2")].map((h) => h.textContent?.trim());
    expect(headings).toEqual(["Change password", "Run history", "Appearance"]);
    expect((root.querySelector("#ret-hint")?.previousElementSibling as HTMLInputElement).value).toBe("90");
    expect(root.querySelector("[role=radiogroup][aria-label='Colour theme']")).toBeTruthy();
  });

  test("ordinary users get no run-history card but keep appearance", async () => {
    routes = {};
    const { session } = await import("./lib/session.svelte.ts");
    session.user = { id: "2", username: "bob", role: "user" };
    const root = render(Settings, {});
    await settle();
    const headings = [...root.querySelectorAll("h2")].map((h) => h.textContent?.trim());
    expect(headings).toEqual(["Change password", "Appearance"]);
    expect(calls).toHaveLength(0);
  });
});

describe("Login and Setup screens", () => {
  test("keep their labelled fields and submit buttons", async () => {
        const login = render(Login, {});
    expect(login.querySelector("h1")?.textContent).toBe("Sign in");
    expect(byText(login, "label span", "Username")).toBeTruthy();
    expect(byText(login, "button", "Sign in").hasAttribute("disabled")).toBe(true);

        const setup = render(Setup, {});
    expect(setup.querySelector("h1")?.textContent).toBe("Set up Immich Sync");
    expect(setup.querySelectorAll("input[type=password]")).toHaveLength(2);
    expect(byText(setup, "button", "Create administrator account")).toBeTruthy();
  });
});
