import { env, exports } from "cloudflare:workers";
import { evictDurableObject, listDurableObjectIds, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import answers from "../.private/answers.json";

afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await reset(); });

function browser() {
  const cookies = new Map<string, string>();
  const cookie = () => [...cookies].map(([key, value]) => key + "=" + value).join("; ");
  return {
    cookie,
    stub(profile = "default") {
      const name = "afterglow_session" + (profile === "default" ? "" : "_" + profile);
      return env.GAME_SESSIONS.getByName(cookies.get(name)!.split(".")[0]);
    },
    async request(path: string, data?: unknown, profile = "default", savedCookie = cookie()) {
      const response = await exports.default.fetch(new Request("https://archive.example" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          Cookie: savedCookie, Origin: "https://archive.example", "X-Desktop-Profile": profile,
          ...(data === undefined ? {} : { "Content-Type": "application/json", "X-Afterglow": "1" }),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      }));
      for (const header of response.headers.getSetCookie()) {
        const [name, value] = header.split(";")[0].split("=");
        if (value) cookies.set(name, value); else cookies.delete(name);
      }
      return response;
    },
    async start(profile = "default") {
      const response = await this.request("/api/start", { entry: answers.entryToken }, profile);
      expect(response.status).toBe(200);
      return response.json<{ player: string; stage: number }>();
    },
  };
}

async function expectEmpty(stub: DurableObjectStub) {
  await runInDurableObject(stub, async (_instance, context) => {
    expect((await context.storage.list()).size).toBe(0);
    expect(context.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray()).toEqual([]);
    expect(await context.storage.getAlarm()).toBeNull();
  });
}

describe("bounded desktop session storage", () => {
  test("concurrent start and restart requests share an eight-profile quota", async () => {
    const before = (await listDurableObjectIds(env.GAME_SESSIONS)).length;
    const player = browser();
    await player.start();
    const anchor = player.cookie();
    const profiles = Array.from({ length: 14 }, () => crypto.randomUUID());
    const responses = await Promise.all(profiles.map((profile, index) =>
      player.request(index % 2 ? "/api/restart" : "/api/start", {}, profile, anchor)));
    expect(responses.filter(response => response.status === 200)).toHaveLength(7);
    expect(responses.filter(response => response.status === 429)).toHaveLength(7);
    for (const response of responses.filter(response => response.status === 429)) {
      expect(response.headers.has("Set-Cookie")).toBe(false);
    }
    expect(await listDurableObjectIds(env.GAME_SESSIONS)).toHaveLength(before + 8);
    await evictDurableObject(player.stub());
    expect((await player.request("/api/start", {}, crypto.randomUUID(), anchor)).status).toBe(429);
  });

  test("repeated starts recover the registered profile when only its anchor cookie is sent", async () => {
    const before = (await listDurableObjectIds(env.GAME_SESSIONS)).length;
    const player = browser();
    await player.start();
    const anchor = player.cookie();
    const profile = crypto.randomUUID();
    const first = await (await player.request("/api/start", {}, profile, anchor)).json<{ player: string }>();
    for (let attempt = 0; attempt < 3; attempt++) {
      const resumed = await (await player.request("/api/start", {}, profile, anchor)).json<{ player: string }>();
      expect(resumed.player).toBe(first.player);
    }
    expect(await listDurableObjectIds(env.GAME_SESSIONS)).toHaveLength(before + 2);
  });

  test("restarting the anchor preserves its quota and invalidates its old cookie", async () => {
    const player = browser();
    await player.start();
    for (let count = 1; count < 8; count++) await player.start(crypto.randomUUID());
    const oldCookie = player.cookie().split("; ")[0];
    const old = player.stub();
    expect((await player.request("/api/restart", {})).status).toBe(200);
    expect((await player.request("/api/start", {}, crypto.randomUUID())).status).toBe(429);
    expect((await player.request("/api/start", {}, crypto.randomUUID(), oldCookie)).status).toBe(403);
    expect((await player.request("/api/cases/1", undefined, "default", oldCookie)).status).toBe(401);
    await expectEmpty(old);
  });

  test("restarting a profile deletes its complete previous save without recreating it on replay", async () => {
    const player = browser();
    await player.start();
    const profile = crypto.randomUUID();
    const first = await player.start(profile);
    await player.request("/api/answer", { stage: 1, code: answers.codes[0] }, profile);
    const oldCookie = player.cookie();
    const old = player.stub(profile);
    const restarted = await (await player.request("/api/restart", {}, profile)).json<{ player: string; stage: number }>();
    expect(restarted.stage).toBe(1);
    expect(restarted.player).not.toBe(first.player);
    await expectEmpty(old);
    await evictDurableObject(old);
    expect((await player.request("/api/cases/1", undefined, profile, oldCookie)).status).toBe(401);
    await expectEmpty(old);
    expect((await player.request("/api/cases/1")).status).toBe(200);
  });

  test("a first non-default profile consumes a slot alongside the default anchor", async () => {
    const before = (await listDurableObjectIds(env.GAME_SESSIONS)).length;
    const player = browser();
    await player.start(crypto.randomUUID());
    for (let count = 2; count < 8; count++) await player.start(crypto.randomUUID());
    expect((await player.request("/api/start", {}, crypto.randomUUID())).status).toBe(429);
    expect(await listDurableObjectIds(env.GAME_SESSIONS)).toHaveLength(before + 8);
  });

  test("abandoned saves have a persisted expiry and are fully removed by their alarm", async () => {
    const player = browser();
    await player.start();
    const stub = player.stub();
    const expiry = await runInDurableObject(stub, (_instance, context) => context.storage.getAlarm());
    expect(expiry).toBeGreaterThan(Date.now());
    expect(expiry).toBeLessThanOrEqual(Date.now() + 180 * 24 * 60 * 60 * 1000);
    await evictDurableObject(stub);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(expiry! + 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expectEmpty(stub);
    expect((await player.request("/api/cases/1")).status).toBe(401);
    expect((await player.request("/api/start", {})).status).toBe(403);
    await expectEmpty(stub);
  });

  test("deleting a profile frees its quota only after removing the stored save", async () => {
    const player = browser();
    await player.start();
    const profile = crypto.randomUUID();
    await player.start(profile);
    const old = player.stub(profile);
    const oldCookie = player.cookie().split("; ").find(value => value.startsWith("afterglow_session_" + profile + "="))!;
    for (let count = 2; count < 8; count++) await player.start(crypto.randomUUID());
    expect((await player.request("/api/start", {}, crypto.randomUUID())).status).toBe(429);
    const removed = await player.request("/api/profile/delete", { profile });
    expect(removed.status).toBe(200);
    expect(removed.headers.get("Set-Cookie")).toContain("Max-Age=0");
    await expectEmpty(old);
    expect((await player.request("/api/start", {}, crypto.randomUUID())).status).toBe(200);
    expect((await player.request("/api/start", {}, crypto.randomUUID())).status).toBe(429);
    expect((await player.request("/api/start", {}, profile, oldCookie)).status).toBe(403);
    await expectEmpty(old);
  });

  test("removing the default profile cannot mint a new owner or reset its quota", async () => {
    const player = browser();
    await player.start();
    const active = crypto.randomUUID();
    await player.start(active);
    for (let count = 2; count < 8; count++) await player.start(crypto.randomUUID());
    expect((await player.request("/api/profile/delete", { profile: "default" }, active)).status).toBe(200);
    expect((await player.request("/api/start", {}, crypto.randomUUID())).status).toBe(200);
    expect((await player.request("/api/start", {}, crypto.randomUUID())).status).toBe(429);
    expect((await player.request("/api/cases/1", undefined, active)).status).toBe(200);
  });

  test("a pending restart resumes after retiring the save and evicting the owner", async () => {
    const player = browser();
    await player.start();
    const old = player.stub();
    const ownerId = player.cookie().split("=")[1].split(".")[1];
    const owner = env.DESKTOP_PROFILES.getByName(ownerId);
    await runInDurableObject(owner, (_instance, context) => {
      // Snapshot of a crash after reserving the replacement but before the
      // successful response reaches the browser. The old cookie is all it has.
      const desktop = context.storage.kv.get<{ expiresAt: number; profiles: Record<string, { id: string; ready: boolean; previous?: string }> }>("desktop")!;
      desktop.profiles.default = { id: "ab".repeat(32), previous: desktop.profiles.default.id, ready: false };
      context.storage.kv.put("desktop", desktop);
    });
    await old.retire();
    await expectEmpty(old);
    await evictDurableObject(owner);
    const retried = await player.request("/api/restart", {});
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ started: true, stage: 1 });
    await expectEmpty(old);
    expect((await player.request("/api/cases/1")).status).toBe(200);
  });

  test("owner expiry removes the registry and all profiles without waiting for their alarms", async () => {
    const player = browser();
    await player.start();
    const primary = player.stub();
    const profile = crypto.randomUUID();
    await player.start(profile);
    const secondary = player.stub(profile);
    const ownerId = player.cookie().split("=")[1].split(".")[1];
    const owner = env.DESKTOP_PROFILES.getByName(ownerId);
    const expiry = await runInDurableObject(owner, (_instance, context) => context.storage.getAlarm());
    await evictDurableObject(owner);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(expiry! + 1000);
    expect(await runDurableObjectAlarm(owner)).toBe(true);
    await expectEmpty(primary);
    await expectEmpty(secondary);
    await expectEmpty(owner);
    expect((await player.request("/api/start", {}, profile)).status).toBe(403);
    await expectEmpty(owner);
  });

  test("a lost restart response recovers the replacement without creating another save", async () => {
    const player = browser();
    await player.start();
    const retainedCookie = player.cookie();
    const old = player.stub();
    const replacement = await (await player.request("/api/restart", {})).json<{ player: string }>();
    const afterRestart = (await listDurableObjectIds(env.GAME_SESSIONS)).length;
    const ownerId = retainedCookie.split("=")[1].split(".")[1];
    await evictDurableObject(env.DESKTOP_PROFILES.getByName(ownerId));
    // Simulate the browser never receiving the first Set-Cookie header.
    expect(await (await player.request("/api/session", undefined, "default", retainedCookie)).json()).toMatchObject({ started: false, canStart: true });
    expect((await player.request("/api/cases/1", undefined, "default", retainedCookie)).status).toBe(401);
    for (const path of ["/api/restart", "/api/start"]) {
      const retry = await player.request(path, {}, "default", retainedCookie);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ player: replacement.player, stage: 1 });
    }
    expect(await listDurableObjectIds(env.GAME_SESSIONS)).toHaveLength(afterRestart);
    await expectEmpty(old);
  });
});
