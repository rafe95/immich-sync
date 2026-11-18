import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { byText, flush, render, settle, type, useDom } from "../test/dom.ts";

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

describe("Admin password recovery", () => {
  const message = "If that is an administrator account, a reset token was written to the backend log.";
  const click = (el: HTMLElement) => {
    el.click();
    flush();
  };
  const input = (root: ParentNode, label: string) => byText(root, "label span", label).closest("label")!.querySelector("input")!;

  async function toResetStep() {
    routes["POST /api/auth/recovery"] = { message };
    const root = render(Login, {});
    click(byText(root, "button", "Forgot admin password?"));
    expect(root.querySelector("h1")?.textContent).toBe("Reset admin password");
    type(input(root, "Username"), " ada ");
    click(byText(root, "button", "Send reset token"));
    await settle();
    return root;
  }

  test("the forgot link shows the request step, then the reset step", async () => {
    const root = await toResetStep();
    expect(calls).toEqual([{ method: "POST", url: "/api/auth/recovery" }]);
    expect(root.textContent).toContain(message);
    expect(root.textContent).toContain("docker compose logs app");
    expect(input(root, "Reset token")).toBeTruthy();
    expect(input(root, "New password").getAttribute("autocomplete")).toBe("new-password");
    expect(input(root, "Confirm new password")).toBeTruthy();
  });

  test("a mismatched confirmation is refused in the browser", async () => {
    const root = await toResetStep();
    type(input(root, "Reset token"), "tok");
    type(input(root, "New password"), "a brand new password");
    type(input(root, "Confirm new password"), "a different password");
    click(byText(root, "button", "Set new password"));
    await settle();
    expect(root.querySelector("[role=alert]")?.textContent).toContain("The passwords do not match.");
    expect(calls.some((c) => c.url === "/api/auth/recovery/complete")).toBe(false);
  });

  test("a successful reset signs in", async () => {
    const { session } = await import("./lib/session.svelte.ts");
    session.status = "anonymous" as typeof session.status;
    routes["POST /api/auth/recovery/complete"] = { authenticated: true, csrfToken: "c", user: { id: "1", username: "ada", role: "admin" } };
    const root = await toResetStep();
    type(input(root, "Reset token"), "tok");
    type(input(root, "New password"), "a brand new password");
    type(input(root, "Confirm new password"), "a brand new password");
    click(byText(root, "button", "Set new password"));
    await settle();
    expect(calls.filter((c) => c.url === "/api/auth/recovery/complete")).toHaveLength(1);
    expect(session.status).toBe("authenticated");
    expect(session.user?.username).toBe("ada");
  });

  test("the reset step is reachable directly and back to sign in returns to the login form", async () => {
    const root = render(Login, {});
    click(byText(root, "button", "Forgot admin password?"));
    click(byText(root, "button", "I already have a token"));
    expect(input(root, "Reset token")).toBeTruthy();
    click(byText(root, "button", "Back to sign in"));
    expect(root.querySelector("h1")?.textContent).toBe("Sign in");
  });
});
