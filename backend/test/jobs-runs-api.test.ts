import { afterEach, describe, expect, test } from "bun:test";
import { FakeExecutor } from "./fake-executor.ts";
import { loggedIn, startTestServer } from "./helpers.ts";

let stops: Array<() => unknown> = [];
afterEach(() => {
  stops.forEach((s) => s());
  stops = [];
});

async function setup(opts: { heartbeatMs?: number } = {}) {
  const executor = new FakeExecutor();
  const t = startTestServer({ executor, ...opts });
  stops.push(t.stop);
  const client = await loggedIn(t.base);
  const mk = async (alias: string) =>
    (await t.store.create({ alias, apiUrl: `http://${alias}/api`, apiKeyEnc: Buffer.from("x"), note: null, isDefault: false })).id;
  const [A, B, C] = [await mk("A"), await mk("B"), await mk("C")] as [string, string, string];
  const job = (over: Record<string, unknown> = {}) => ({ name: "Nightly", steps: [{ operation: "copy", sourceId: A, targetId: B }], ...over });
  return { ...t, ...client, executor, A, B, C, job };
}

describe("jobs API", () => {
  test("requires a session and CSRF for every route", async () => {
    const t = await setup();
    for (const [method, path] of [["GET", "/api/jobs"], ["POST", "/api/jobs"], ["GET", "/api/runs"], ["POST", "/api/runs"], ["GET", "/api/schedules"], ["GET", `/api/runs/${crypto.randomUUID()}/events`]] as const) {
      expect((await fetch(`${t.base}${path}`, { method, body: method === "POST" ? "{}" : undefined })).status).toBe(401);
    }
    const noCsrf = await fetch(`${t.base}/api/jobs`, { method: "POST", headers: { cookie: t.cookie }, body: JSON.stringify(t.job()) });
    expect(noCsrf.status).toBe(403);
    const put = await fetch(`${t.base}/api/jobs/${crypto.randomUUID()}/schedule`, { method: "PUT", headers: { cookie: t.cookie }, body: "{}" });
    expect(put.status).toBe(403);
    expect(await t.jobStore.list()).toEqual([]);
  });

  test("create, get, list, update (replace steps / rename), delete", async () => {
    const t = await setup();
    const created = await t.call("POST", "/api/jobs", t.job({ steps: [{ operation: "copy", sourceId: t.A, targetId: t.B, options: { kind: "photos" } }, { operation: "sync_metadata", sourceId: t.B, targetId: t.C, onFailure: "stop" }] }));
    expect(created.status).toBe(201);
    const j = await created.json();
    expect(j.steps.map((s: any) => [s.position, s.operation, s.sourceAlias, s.targetAlias])).toEqual([[1, "copy", "A", "B"], [2, "sync_metadata", "B", "C"]]);
    expect(j.steps[0].options).toMatchObject({ range: null, kind: "photos", metadata: true, dryRun: false });
    expect(j).toMatchObject({ hasMove: false, schedule: null });
    expect((await (await t.call("GET", "/api/jobs")).json()).jobs.length).toBe(1);
    expect((await t.call("GET", `/api/jobs/${j.id}`)).status).toBe(200);

    const renamed = await (await t.call("PATCH", `/api/jobs/${j.id}`, { name: "Spread" })).json();
    expect(renamed.name).toBe("Spread");
    expect(renamed.steps.length).toBe(2);
    const reordered = await (await t.call("PATCH", `/api/jobs/${j.id}`, { steps: [...j.steps].reverse().map((s: any) => ({ operation: s.operation, sourceId: s.sourceId, targetId: s.targetId })) })).json();
    expect(reordered.steps.map((s: any) => s.operation)).toEqual(["sync_metadata", "copy"]);

    expect((await t.call("DELETE", `/api/jobs/${j.id}`)).status).toBe(200);
    expect((await t.call("GET", `/api/jobs/${j.id}`)).status).toBe(404);
    expect((await t.call("GET", "/api/jobs/not-a-uuid")).status).toBe(404);
  });

  test("validation: same instance, unknown instance, bad operation/options", async () => {
    const t = await setup();
    const post = (body: unknown) => t.call("POST", "/api/jobs", body);
    expect((await post(t.job({ steps: [{ operation: "copy", sourceId: t.A, targetId: t.A }] }))).status).toBe(400);
    const unknown = await post(t.job({ steps: [{ operation: "copy", sourceId: t.A, targetId: crypto.randomUUID() }] }));
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(await unknown.json())).toContain("does not exist");
    expect((await post(t.job({ steps: [{ operation: "purge", sourceId: t.A, targetId: t.B }] }))).status).toBe(400);
    expect((await post(t.job({ steps: [{ operation: "copy", sourceId: t.A, targetId: t.B, options: { range: { from: "2024-01-01" } } }] }))).status).toBe(400);
    expect((await post({ name: "x" })).status).toBe(400);
    expect((await t.call("PATCH", `/api/jobs/${crypto.randomUUID()}`, { name: "x" })).status).toBe(404);
    expect(await t.jobStore.list()).toEqual([]);
  });

  test("schedule: create, next runs, time zone default, pause, delete; validation", async () => {
    const t = await setup();
    const j = await (await t.call("POST", "/api/jobs", t.job())).json();
    const bad = (body: unknown) => t.call("PUT", `/api/jobs/${j.id}/schedule`, body);
    expect((await bad({ cron: "nope" })).status).toBe(400);
    expect((await bad({ cron: "0 1 * * *", timezone: "Nowhere/Land" })).status).toBe(400);
    expect((await t.call("GET", `/api/jobs/${j.id}/schedule`)).status).toBe(404);

    const res = await bad({ cron: "30 0 * * *" });
    expect(res.status).toBe(201);
    const s = await res.json();
    expect(s).toMatchObject({ cron: "30 0 * * *", timezone: "UTC", enabled: true, catchUp: false, moveConfirmedAt: null });
    expect(s.nextRuns.length).toBe(3);
    const paused = await (await bad({ cron: "30 0 * * *", timezone: "Europe/Lisbon", enabled: false, catchUp: true })).json();
    expect(paused).toMatchObject({ timezone: "Europe/Lisbon", enabled: false, catchUp: true, nextRuns: [] });
    expect((await (await t.call("GET", `/api/jobs/${j.id}`)).json()).schedule.cron).toBe("30 0 * * *");
    expect((await (await t.call("GET", "/api/schedules")).json()).schedules[0]).toMatchObject({ jobName: "Nightly" });
    expect((await t.call("DELETE", `/api/jobs/${j.id}/schedule`)).status).toBe(200);
    expect((await t.call("DELETE", `/api/jobs/${j.id}/schedule`)).status).toBe(404);
    expect((await t.call("PUT", `/api/jobs/${crypto.randomUUID()}/schedule`, { cron: "0 0 * * *" })).status).toBe(404);
  });

  test("a scheduled move needs explicit confirmation, and adding a move later revokes it", async () => {
    const t = await setup();
    const mv = await (await t.call("POST", "/api/jobs", t.job({ steps: [{ operation: "move", sourceId: t.A, targetId: t.B }] }))).json();
    expect(mv.hasMove).toBe(true);
    const put = (id: string, body: Record<string, unknown>) => t.call("PUT", `/api/jobs/${id}/schedule`, { cron: "0 3 * * *", ...body });
    const refused = await put(mv.id, {});
    expect(refused.status).toBe(400);
    expect((await refused.json()).confirmationRequired).toBe(true);
    expect(await t.jobStore.listSchedules()).toEqual([]);
    // a paused schedule may be saved without confirmation, but is not confirmed
    expect((await (await put(mv.id, { enabled: false })).json()).moveConfirmedAt).toBeNull();
    expect((await put(mv.id, {})).status).toBe(400);
    const ok = await (await put(mv.id, { confirmMove: true })).json();
    expect(ok.moveConfirmedAt).not.toBeNull();
    // re-saving keeps the confirmation
    expect((await (await put(mv.id, { cron: "0 4 * * *" })).json()).moveConfirmedAt).toBe(ok.moveConfirmedAt);

    // a confirmed schedule on a copy job: adding a move step revokes it and pauses the schedule
    const cp = await (await t.call("POST", "/api/jobs", t.job())).json();
    await put(cp.id, { confirmMove: true });
    expect((await (await t.call("GET", `/api/jobs/${cp.id}/schedule`)).json()).moveConfirmedAt).toBeNull();
    await put(cp.id, {});
    await t.call("PATCH", `/api/jobs/${cp.id}`, { steps: [{ operation: "move", sourceId: t.A, targetId: t.B }] });
    expect(await (await t.call("GET", `/api/jobs/${cp.id}/schedule`)).json()).toMatchObject({ moveConfirmedAt: null, enabled: false });
  });
});

describe("runs API", () => {
  test("run now returns 202 immediately; the run executes in the backend; history shows it", async () => {
    const t = await setup();
    const j = await (await t.call("POST", "/api/jobs", t.job())).json();
    let release!: () => void;
    t.executor.gates.set(1, new Promise((r) => (release = r)));
    const res = await t.call("POST", `/api/jobs/${j.id}/run`, { dryRun: true });
    expect(res.status).toBe(202);
    const run = await res.json();
    expect(run).toMatchObject({ status: "queued", dryRun: true, trigger: "manual", startedBy: "admin", jobName: "Nightly" });
    await t.executor.hasStarted(1);
    expect((await (await t.call("GET", `/api/runs/${run.id}`)).json()).status).toBe("running");
    release();
    await t.manager.whenIdle();
    const done = await (await t.call("GET", `/api/runs/${run.id}`)).json();
    expect(done.status).toBe("completed");
    expect(done.settings.steps[0].options.dryRun).toBe(true);
    const list = await (await t.call("GET", "/api/runs?limit=1")).json();
    expect(list).toMatchObject({ total: 1, limit: 1, offset: 0 });
    expect(list.runs[0].id).toBe(run.id);
    expect((await t.call("GET", "/api/runs?limit=0")).status).toBe(400);
    expect((await t.call("GET", "/api/runs?status=weird")).status).toBe(400);
    expect((await (await t.call("GET", "/api/runs?status=failed")).json()).total).toBe(0);
    expect((await t.call("POST", `/api/jobs/${crypto.randomUUID()}/run`, {})).status).toBe(404);
    expect((await t.call("POST", `/api/jobs/${j.id}/run`, { dryRun: "yes" })).status).toBe(400);
  });

  test("ad-hoc run, cancel, and the JSON log with ?after= paging", async () => {
    const t = await setup();
    t.executor.gates.set(1, new Promise(() => {}));
    const res = await t.call("POST", "/api/runs", { steps: [{ operation: "copy", sourceId: t.A, targetId: t.B }] });
    expect(res.status).toBe(202);
    const run = await res.json();
    expect(run.jobName).toBe("One-off run");
    await t.executor.hasStarted(1);
    expect((await t.call("POST", `/api/runs/${run.id}/cancel`)).status).toBe(202);
    await t.manager.whenIdle();
    expect((await (await t.call("GET", `/api/runs/${run.id}`)).json()).status).toBe("cancelled");
    expect((await t.call("POST", `/api/runs/${run.id}/cancel`)).status).toBe(409);
    expect((await t.call("POST", `/api/runs/${crypto.randomUUID()}/cancel`)).status).toBe(404);

    const all = (await (await t.call("GET", `/api/runs/${run.id}/log`)).json()).events;
    expect(all.length).toBeGreaterThan(3);
    const tail = (await (await t.call("GET", `/api/runs/${run.id}/log?after=${all[1].id}`)).json()).events;
    expect(tail.map((e: any) => e.id)).toEqual(all.slice(2).map((e: any) => e.id));
    expect((await t.call("GET", `/api/runs/${run.id}/log?after=abc`)).status).toBe(400);
    expect((await t.call("POST", "/api/runs", { steps: [] })).status).toBe(400);
  });

  test("no credentials appear in run payloads", async () => {
    const t = await setup();
    await t.call("POST", "/api/runs", { steps: [{ operation: "copy", sourceId: t.A, targetId: t.B }] });
    await t.manager.whenIdle();
    const text = await (await t.call("GET", "/api/runs")).text();
    expect(text).not.toContain("http://A/api");
    expect(text).not.toContain("apiKey");
  });
});

/** Minimal SSE reader. */
async function readSse(res: Response, until: (frames: Array<{ id?: string; event?: string; data?: string }>) => boolean) {
  const frames: Array<{ id?: string; event?: string; data?: string }> = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (!until(frames)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const f: Record<string, string> = {};
      for (const line of block.split("\n")) {
        const m = /^(id|event|data): ?(.*)$/.exec(line);
        if (m) f[m[1]!] = m[2]!;
      }
      if (f.data !== undefined || f.event) frames.push(f);
    }
  }
  return { frames, reader };
}

describe("run events (SSE)", () => {
  test("replays stored events, resumes after Last-Event-ID, streams live events, ends when the run ends", async () => {
    const t = await setup();
    let release!: () => void;
    t.executor.gates.set(1, new Promise((r) => (release = r)));
    const run = await (await t.call("POST", "/api/runs", { steps: [{ operation: "copy", sourceId: t.A, targetId: t.B }] })).json();
    await t.executor.hasStarted(1);
    await Bun.sleep(20);

    const res = await t.call("GET", `/api/runs/${run.id}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // replay of what exists so far, then release the step so live events arrive
    const first = await readSse(res as unknown as Response, (f) => f.some((x) => x.data?.includes("working 1")));
    const replayed = first.frames.map((f) => JSON.parse(f.data!));
    expect(replayed.some((e) => e.type === "progress")).toBe(true);
    release();
    const rest = await readSse({ body: { getReader: () => first.reader } } as any, (f) => f.some((x) => x.event === "end"));
    const all = [...first.frames, ...rest.frames];
    const ids = all.filter((f) => f.id).map((f) => Number(f.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.parse(all.find((f) => f.event === "end")!.data!)).toEqual({ status: "completed" });
    expect(all.some((f) => f.data?.includes('"type":"summary"'))).toBe(true);

    // resume after a given id (header) and (query) on a finished run: only later events, then end
    const mid = ids[Math.floor(ids.length / 2)]!;
    for (const [path, headers] of [[`/api/runs/${run.id}/events`, { "last-event-id": String(mid) }], [`/api/runs/${run.id}/events?after=${mid}`, {}]] as const) {
      const r = await t.call("GET", path, undefined, headers);
      const s = await readSse(r as unknown as Response, (f) => f.some((x) => x.event === "end"));
      expect(s.frames.filter((f) => f.id).map((f) => Number(f.id))).toEqual(ids.filter((i) => i > mid));
    }
    expect((await t.call("GET", `/api/runs/${run.id}/events?after=x`)).status).toBe(400);
    expect((await t.call("GET", `/api/runs/${crypto.randomUUID()}/events`)).status).toBe(404);
  });

  test("closing the stream does not affect the run, and subscribers are cleaned up", async () => {
    const t = await setup({ heartbeatMs: 20 });
    let release!: () => void;
    t.executor.gates.set(1, new Promise((r) => (release = r)));
    const run = await (await t.call("POST", "/api/runs", { steps: [{ operation: "copy", sourceId: t.A, targetId: t.B }] })).json();
    await t.executor.hasStarted(1);
    const ac = new AbortController();
    const res = await fetch(`${t.base}/api/runs/${run.id}/events`, { headers: { cookie: t.cookie }, signal: ac.signal });
    await readSse(res, (f) => f.length > 0);
    expect(t.manager.hub.subscriberCount(run.id)).toBe(1);
    // heartbeats keep the connection alive without events
    await Bun.sleep(60);
    ac.abort(); // the browser goes away
    await Bun.sleep(100);
    expect(t.manager.hub.subscriberCount(run.id)).toBe(0);
    release();
    await t.manager.whenIdle();
    expect((await t.runStore.getRun(run.id))!.status).toBe("completed");
  });
});
