import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { byText, flush, render, settle, type as typeInto, useDom } from "../test/dom.ts";
import type { Instance } from "./lib/api.ts";
import type { JobRecord } from "./lib/jobs.ts";

useDom();

// The Svelte Flow canvas needs layout measurements a test DOM cannot give, so the pipeline is replaced by a stub.
// The API client is replaced as well: nothing here talks to a server.
const calls: { createJob: unknown[]; updateJob: unknown[] } = { createJob: [], updateJob: [] };
let failNext: Error | null = null;
const saved = (body: Record<string, unknown>): JobRecord => ({ id: "j1", hasMove: false, schedule: null, createdAt: "", updatedAt: "", ...body }) as unknown as JobRecord;

mock.module("./flow/JobPipeline.svelte", () => ({ default: () => {} }));

// The real shared api client is kept (so other test files see an unmodified module); its job calls are swapped for fakes.
const realApi = { createJob: null as unknown, updateJob: null as unknown };

const inst = (id: string, alias: string, isDefault = false): Instance =>
  ({ id, alias, apiUrl: `http://${alias}`, note: null, isDefault, lastCheck: null, lastCheckedAt: null, createdAt: "", updatedAt: "" });
const instances = [inst("a", "Home", true), inst("b", "Backup")];

const existing: JobRecord = {
  id: "j1",
  name: "Nightly",
  hasMove: false,
  schedule: null,
  createdAt: "",
  updatedAt: "",
  steps: [{ operation: "copy", sourceId: "a", targetId: "b", options: { kind: "all", metadata: true }, onFailure: "continue", onError: "stop" }],
};

const editor = async () => (await import("./JobEditor.svelte")).default;
const nameInput = (root: HTMLElement) => root.querySelector<HTMLInputElement>("#job-name")!;
const form = (root: HTMLElement) => root.querySelector("form")!;
const submit = (root: HTMLElement) => form(root).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

beforeEach(async () => {
  const { api } = await import("./lib/session.svelte.ts");
  realApi.createJob ??= api.createJob;
  realApi.updateJob ??= api.updateJob;
  Object.assign(api, {
    createJob: async (body: Record<string, unknown>) => {
      calls.createJob.push(body);
      if (failNext) throw failNext;
      return saved(body);
    },
    updateJob: async (id: string, body: Record<string, unknown>) => {
      calls.updateJob.push([id, body]);
      if (failNext) throw failNext;
      return saved({ ...body, id });
    },
  });
  calls.createJob = [];
  calls.updateJob = [];
  failNext = null;
});

afterAll(async () => {
  const { api } = await import("./lib/session.svelte.ts");
  Object.assign(api, realApi);
});

describe("JobEditor", () => {
  test("a new job has an empty name, a Create button and no Dry run / Run now", async () => {
    const root = render(await editor(), { job: null, instances, onsaved: () => {}, oncancel: () => {}, onstart: () => {} });
    expect(form(root).getAttribute("aria-label")).toBe("New job");
    expect(nameInput(root).value).toBe("");
    expect(byText(root, "button", "Create job").getAttribute("type")).toBe("submit");
    expect(() => byText(root, "button", "Dry run")).toThrow();
    expect(() => byText(root, "button", "Run now")).toThrow();
  });

  test("an unchanged saved job offers enabled Dry run and Run now", async () => {
    const starts: Array<[string, boolean]> = [];
    const root = render(await editor(), { job: existing, instances, onsaved: () => {}, oncancel: () => {}, onstart: (j: JobRecord, dry: boolean) => starts.push([j.id, dry]) });
    expect(nameInput(root).value).toBe("Nightly");
    const dry = byText(root, "button", "Dry run") as HTMLButtonElement;
    const run = byText(root, "button", "Run now") as HTMLButtonElement;
    expect(dry.disabled).toBe(false);
    expect(run.disabled).toBe(false);
    dry.click();
    run.click();
    expect(starts).toEqual([["j1", true], ["j1", false]]);
    expect(byText(root, "button", "Save job")).toBeTruthy();
  });

  test("editing the name disables Dry run and Run now with a hint, and undoing re-enables them", async () => {
    const root = render(await editor(), { job: existing, instances, onsaved: () => {}, oncancel: () => {}, onstart: () => {} });
    typeInto(nameInput(root), "Nightly 2");
    const dry = byText(root, "button", "Dry run") as HTMLButtonElement;
    const run = byText(root, "button", "Run now") as HTMLButtonElement;
    expect(dry.disabled).toBe(true);
    expect(run.disabled).toBe(true);
    expect(run.title).toBe("Save your changes first");
    typeInto(nameInput(root), "Nightly");
    expect(dry.disabled).toBe(false);
    expect(run.disabled).toBe(false);
  });

  test("adding a step from the palette marks the form dirty", async () => {
    const root = render(await editor(), { job: existing, instances, onsaved: () => {}, oncancel: () => {}, onstart: () => {} });
    byText(root, "button", "Move").click();
    flush();
    expect((byText(root, "button", "Run now") as HTMLButtonElement).disabled).toBe(true);
  });

  test("without onstart there are no run buttons", async () => {
    const root = render(await editor(), { job: existing, instances, onsaved: () => {}, oncancel: () => {} });
    expect(() => byText(root, "button", "Run now")).toThrow();
  });

  test("Cancel calls oncancel", async () => {
    let cancelled = 0;
    const root = render(await editor(), { job: null, instances, onsaved: () => {}, oncancel: () => cancelled++ });
    byText(root, "button", "Cancel").click();
    expect(cancelled).toBe(1);
  });

  test("saving an existing job calls updateJob and reports the result", async () => {
    const results: JobRecord[] = [];
    const root = render(await editor(), { job: existing, instances, onsaved: (j: JobRecord) => results.push(j), oncancel: () => {} });
    typeInto(nameInput(root), "Renamed");
    submit(root);
    await settle();
    expect(calls.createJob).toEqual([]);
    expect(calls.updateJob.length).toBe(1);
    expect((calls.updateJob[0] as [string, { name: string }])[0]).toBe("j1");
    expect((calls.updateJob[0] as [string, { name: string }])[1].name).toBe("Renamed");
    expect(results.map((j) => j.name)).toEqual(["Renamed"]);
  });

  test("creating a job with a source and target calls createJob", async () => {
    const results: JobRecord[] = [];
    const root = render(await editor(), { job: null, instances, onsaved: (j: JobRecord) => results.push(j), oncancel: () => {} });
    typeInto(nameInput(root), "Fresh");
    // Pick the target on the (real) step panel; the source defaults to the default instance.
    const selects = [...root.querySelectorAll("select")];
    const target = selects.find((s) => [...s.options].some((o) => o.value === "b") && !s.value);
    expect(target).toBeTruthy();
    target!.value = "b";
    target!.dispatchEvent(new Event("change", { bubbles: true }));
    flush();
    submit(root);
    await settle();
    expect(errorsOf(root)).toEqual([]);
    expect(calls.createJob.length).toBe(1);
    expect((calls.createJob[0] as { name: string }).name).toBe("Fresh");
    expect(results.length).toBe(1);
  });

  test("an incomplete new job shows validation errors and does not call the API", async () => {
    const root = render(await editor(), { job: null, instances, onsaved: () => {}, oncancel: () => {} });
    typeInto(nameInput(root), "No target");
    submit(root);
    await settle();
    expect(calls.createJob).toEqual([]);
    expect(errorsOf(root).join(" ")).toContain("choose a target");
  });

  test("an API failure is shown and the form stays editable", async () => {
    const root = render(await editor(), { job: existing, instances, onsaved: () => {}, oncancel: () => {} });
    failNext = new Error("server said no");
    typeInto(nameInput(root), "x");
    submit(root);
    await settle();
    expect(errorsOf(root)).toEqual(["server said no"]);
    expect((byText(root, "button", "Save job") as HTMLButtonElement).disabled).toBe(false);
  });
});

const errorsOf = (root: HTMLElement) => [...root.querySelectorAll("[role=alert] li")].map((l) => l.textContent!.trim());
