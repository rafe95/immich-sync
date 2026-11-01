import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { byText, render, settle, useDom } from "../test/dom.ts";

useDom();

// Each screen is replaced by a stub that renders only its name, so these tests cover the shell: the top bar and routing.
// (The screens that embed Svelte Flow canvases cannot be laid out in a test DOM anyway.)
// Svelte components are plain functions of (anchor, props), so a wrapper can hand a fixed name to the real Stub component.
// Setup, Users, Login and Settings are not stubbed: bun mocks are process-wide and AccountScreens.test.ts renders those
// four for real. Here they are recognised by their headings (see `screen`); the fake backend answers their requests with
// failures, which they show as ordinary error states.
for (const name of ["Dashboard", "Jobs", "Run", "History"]) {
  mock.module(`./${name}.svelte`, async () => {
    const Stub = (await import("../test/Stub.svelte")).default as unknown as (anchor: Node, props: object) => void;
    return { default: ($$anchor: Node) => Stub($$anchor, { name }) };
  });
}

type Reply = { status?: number; body: unknown };
let replies: Record<string, Reply> = {};
const realFetch = globalThis.fetch;

function backend(opts: { user?: { id: string; username: string; role: "admin" | "user" } | null; needsSetup?: boolean; health?: Reply }) {
  replies = {
    "/api/setup/status": { body: { needsSetup: opts.needsSetup === true } },
    "/api/auth/me": opts.user ? { body: { user: opts.user, csrfToken: "t" } } : { status: 401, body: { message: "no session" } },
    "/api/health": opts.health ?? { body: { status: "ok", database: true, version: "9.9.9" } },
  };
}

beforeEach(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const r = replies[String(input)];
    if (!r) throw new Error(`unexpected fetch ${String(input)}`);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

async function mountApp() {
  const { session } = await import("./lib/session.svelte.ts");
  session.status = "loading";
  session.needsSetup = false;
  session.user = null;
  const App = (await import("./App.svelte")).default;
  const root = render(App, {});
  await settle();
  return { root, session };
}

const navLabels = (root: HTMLElement) => [...root.querySelectorAll("nav[aria-label=Main] button")].map((b) => b.textContent!.trim());
const current = (root: HTMLElement) => root.querySelector("nav[aria-label=Main] [aria-current=page]")?.textContent?.trim();
const HEADINGS: Record<string, string> = { "Sign in": "Login", "Set up Immich Sync": "Setup", Users: "Users", Settings: "Settings" };
const screen = (root: HTMLElement) => {
  const stub = root.querySelector("[data-screen]")?.getAttribute("data-screen");
  if (stub) return stub;
  const h1 = root.querySelector("main h1, h1.h3, h1.h4")?.textContent?.trim();
  return h1 ? HEADINGS[h1] : undefined;
};

describe("App shell", () => {
  test("an administrator sees all six tabs on a top bar and starts on the dashboard", async () => {
    backend({ user: { id: "1", username: "ada", role: "admin" } });
    const { root } = await mountApp();
    expect(navLabels(root)).toEqual(["Dashboard", "Run", "Jobs", "History", "Users", "Settings"]);
    expect(root.querySelector("header nav[aria-label=Main]")).toBeTruthy();
    expect(current(root)).toBe("Dashboard");
    expect(screen(root)).toBe("Dashboard");
    expect(root.textContent).toContain("ada");
    expect(root.textContent).toContain("Backend and database OK · v9.9.9");
  });

  test("an ordinary user has no Users tab", async () => {
    backend({ user: { id: "2", username: "bob", role: "user" } });
    const { root } = await mountApp();
    expect(navLabels(root)).toEqual(["Dashboard", "Run", "Jobs", "History", "Settings"]);
  });

  test("clicking a tab switches the screen and the current marker", async () => {
    backend({ user: { id: "1", username: "ada", role: "admin" } });
    const { root } = await mountApp();
    for (const label of ["Jobs", "History", "Users", "Settings", "Run"]) {
      byText(root, "nav[aria-label=Main] button", label).click();
      await settle();
      expect(current(root)).toBe(label);
      expect(screen(root)).toBe(label);
    }
  });

  test("a failing backend shows an unreachable badge; a degraded database is flagged", async () => {
    backend({ user: { id: "1", username: "ada", role: "admin" }, health: { status: 500, body: {} } });
    const down = await mountApp();
    expect(down.root.textContent).toContain("Backend unreachable");
  });

  test("a degraded database is flagged", async () => {
    backend({ user: { id: "1", username: "ada", role: "admin" }, health: { status: 503, body: { status: "degraded", database: false, version: "9.9.9" } } });
    const { root } = await mountApp();
    expect(root.textContent).toContain("Database unreachable · v9.9.9");
  });

  test("without a session the login screen replaces the shell", async () => {
    backend({ user: null });
    const { root } = await mountApp();
    expect(screen(root)).toBe("Login");
    expect(root.querySelector("nav")).toBeNull();
  });

  test("first run shows the setup screen", async () => {
    backend({ needsSetup: true });
    const { root } = await mountApp();
    expect(screen(root)).toBe("Setup");
    expect(root.querySelector("nav")).toBeNull();
  });
});
