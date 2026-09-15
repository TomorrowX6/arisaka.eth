import { env, exports } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test } from "vitest";
import answers from "../.private/answers.json";

afterEach(async () => { await reset(); });

function client() {
  const jar = new Map<string, string>();
  const cookie = () => [...jar].map(([name, value]) => name + "=" + value).join("; ");
  return {
    cookie,
    async request(path: string, value?: unknown, headers: Record<string, string> = {}) {
      const response = await exports.default.fetch(new Request("https://archive.example" + path, {
        method: value === undefined ? "GET" : "POST",
        headers: {
          Origin: "https://archive.example",
          ...(cookie() ? { Cookie: cookie() } : {}),
          ...(value === undefined ? {} : { "Content-Type": "application/json", "X-Afterglow": "1" }),
          ...headers,
        },
        body: value === undefined ? undefined : JSON.stringify(value),
      }));
      for (const value of response.headers.getSetCookie()) {
        const item = value.split(";")[0];
        jar.set(item.slice(0, item.indexOf("=")), item.slice(item.indexOf("=") + 1));
      }
      return response;
    },
    async start() { return (await this.request("/api/start", { entry: answers.entryToken })).json<any>(); },
    async advance(to: number) {
      for (let stage = 1; stage < to; stage++) {
        const response = await this.request("/api/answer", { stage, code: answers.codes[stage - 1] });
        expect(response.status).toBe(200);
        const data = await response.json<any>();
        expect(["correct", "already-solved"]).toContain(data.result);
      }
    },
    stub() {
      return env.GAME_SESSIONS.getByName(jar.get("afterglow_session")!.split(".")[0]);
    },
  };
}

describe("private, sequential archive", () => {
  test("health, catalog, and every attachment enforce the complete sequential campaign", async () => {
    const player = client();
    const health = await (await player.request("/api/health")).json<any>();
    expect(health).toEqual({ ok: true, edition: answers.version, cases: 26 });
    const started = await player.start();
    expect(started.total).toBe(health.cases);
    expect(started.catalog).toHaveLength(health.cases);
    expect((await player.request("/api/cases/27")).status).toBe(404);
    for (let stage = 1; stage <= health.cases; stage++) {
      if (stage < health.cases) expect((await player.request("/api/cases/" + (stage + 1))).status).toBe(403);
      const detail = await (await player.request("/api/cases/" + stage)).json<any>();
      expect(detail.id).toBe(stage);
      expect(Object.keys(detail).sort()).toEqual(["files", "id", "solved", "widget"]);
      for (const file of detail.files) {
        const attachment = await player.request(file.url);
        expect(attachment.status).toBe(200);
        expect(attachment.headers.get("Cache-Control")).toContain("no-store");
        expect((await attachment.arrayBuffer()).byteLength).toBeGreaterThan(0);
        expect((await player.request("/_puzzles/" + stage + "/" + file.name)).status).toBe(404);
      }
      expect((await (await player.request("/api/answer", { stage, code: answers.codes[stage - 1] })).json<any>()).result).toBe("correct");
    }
    for (const path of ["/scripts/decoders.mjs", "/scripts/expert/gcm-decoder.mjs", "/test/campaign.test.mjs", "/.private/build-seed", "/.dev.vars.local"]) {
      expect((await player.request(path)).status).toBe(404);
    }
  }, 30000);

  test("desktop profiles keep independent progress and restart only their own save", async () => {
    const browser = client();
    const profile = "f0fef0fe-1234-4321-9876-abcdef012345";
    const headers = { "X-Desktop-Profile": profile };
    const primary = await browser.start();
    await browser.advance(3);
    const fresh = await (await browser.request("/api/session", undefined, headers)).json<any>();
    expect(fresh).toMatchObject({ started: false, canStart: true });
    const secondary = await (await browser.request("/api/start", {}, headers)).json<any>();
    expect(secondary.stage).toBe(1);
    expect(secondary.player).not.toBe(primary.player);
    expect((await browser.request("/api/files/3/afterimage.mid?profile=" + profile)).status).toBe(403);
    expect((await browser.request("/api/files/3/afterimage.mid")).status).toBe(200);
    await browser.request("/api/answer", { stage: 1, code: answers.codes[0] }, headers);
    expect((await (await browser.request("/api/session", undefined, headers)).json<any>()).stage).toBe(2);
    expect((await (await browser.request("/api/session")).json<any>()).stage).toBe(3);
    await browser.request("/api/restart", {}, headers);
    expect((await (await browser.request("/api/session", undefined, headers)).json<any>()).stage).toBe(1);
    expect((await (await browser.request("/api/session")).json<any>()).stage).toBe(3);
  });

  test("profile session signatures cannot be replayed under another profile cookie", async () => {
    const browser = client();
    await browser.start();
    const profile = "abcdef01-1234-4321-9876-abcdef012345";
    const value = browser.cookie().split("=")[1];
    const response = await browser.request("/api/cases/1", undefined, {
      "X-Desktop-Profile": profile,
      Cookie: "afterglow_session_" + profile + "=" + value,
    });
    expect(response.status).toBe(401);
    expect((await browser.request("/api/session", undefined, { "X-Desktop-Profile": "../default" })).status).toBe(400);
    expect((await browser.request("/api/start", {}, { "X-Desktop-Profile": profile, Cookie: "" })).status).toBe(403);
  });

  test("a non-default first profile still requires the entrance and gets a separate anchor cookie", async () => {
    const browser = client();
    const headers = { "X-Desktop-Profile": "aabbccdd-1234-4321-9876-abcdef012345" };
    const response = await browser.request("/api/start", { entry: answers.entryToken }, headers);
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    const secondary = await response.json<any>();
    const primary = await (await browser.request("/api/session")).json<any>();
    expect(primary.player).not.toBe(secondary.player);
    expect(primary.stage).toBe(1);
  });

  test("new sessions require the decrypted terminal entrance, including the restart route", async () => {
    const visitor = client();
    for (const route of ["/api/start", "/api/restart"]) {
      for (const value of [{}, { entry: "0".repeat(20) }, { entry: answers.codes[0] }]) {
        const denied = await visitor.request(route, value);
        expect(denied.status).toBe(403);
        expect(denied.headers.has("Set-Cookie")).toBe(false);
      }
    }
    expect((await (await visitor.request("/api/session")).json<any>()).started).toBe(false);
    expect((await visitor.start()).stage).toBe(1);
    const cookie = visitor.cookie();
    expect((await visitor.request("/api/start", {})).status).toBe(200);
    expect(visitor.cookie()).toBe(cookie);
    expect((await visitor.request("/api/restart", {})).status).toBe(200);
    expect(visitor.cookie()).not.toBe(cookie);
  });

  test("only a started session can read its unlocked artifacts", async () => {
    const player = client();
    expect((await (await player.request("/api/session")).json<any>()).started).toBe(false);
    expect((await player.request("/api/cases/1")).status).toBe(401);
    const startResponse = await player.request("/api/start", { entry: answers.entryToken });
    expect(startResponse.headers.get("Set-Cookie")).toContain("HttpOnly; SameSite=Lax");
    expect(startResponse.headers.get("Set-Cookie")).toContain("Secure");
    expect((await startResponse.json<any>()).stage).toBe(1);
    expect((await player.request("/api/cases/2")).status).toBe(403);
    expect((await player.request("/api/files/3/afterimage.mid")).status).toBe(403);
    expect((await player.request("/_puzzles/1/field-notes.txt")).status).toBe(404);
    expect((await player.request("/_puzzles/9/glass.wasm")).status).toBe(404);
    expect((await player.request("/.private/answers.json")).status).toBe(404);
    expect((await player.request("/src/generated/manifest.json")).status).toBe(404);
    const detail = await (await player.request("/api/cases/1")).json<any>();
    expect(detail).not.toHaveProperty("hints");
    expect(JSON.stringify(detail)).not.toContain(answers.codes[0]);
    await player.advance(3);
    const artifact = await player.request("/api/files/3/afterimage.mid");
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("Cache-Control")).toContain("no-store");
    expect(new TextDecoder().decode((await artifact.arrayBuffer()).slice(0, 4))).toBe("MThd");
  });

  test("concurrent duplicates advance a case exactly once and survive eviction", async () => {
    const player = client();
    await player.start();
    expect((await player.request("/api/answer", { stage: 10, code: answers.codes[9] })).status).toBe(403);
    const responses = await Promise.all(Array.from({ length: 5 }, () =>
      player.request("/api/answer", { stage: 1, code: answers.codes[0] }).then((r) => r.json<any>())));
    expect(responses.filter((r) => r.result === "correct")).toHaveLength(1);
    expect(responses.filter((r) => r.result === "already-solved")).toHaveLength(4);
    await evictDurableObject(player.stub());
    const resumed = await (await player.request("/api/session")).json<any>();
    expect(resumed.stage).toBe(2);
    expect(resumed.attempts).toBe(1);
    expect((await player.request("/api/cases/3")).status).toBe(403);
  });

  test("wrong answers cannot advance; repeated guesses receive a session-local cooldown", async () => {
    const player = client();
    await player.start();
    expect((await player.request("/api/answer", { stage: 1, code: "short" })).status).toBe(400);
    for (let i = 0; i < 5; i++) {
      const result = await (await player.request("/api/answer", { stage: 1, code: "0".repeat(20) })).json<any>();
      expect(result.result).toBe("incorrect");
      expect(result.state.stage).toBe(1);
    }
    const throttled = await player.request("/api/answer", { stage: 1, code: answers.codes[0] });
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("Retry-After"))).toBeGreaterThan(0);
    const other = client();
    await other.start();
    expect((await other.request("/api/answer", { stage: 1, code: answers.codes[0] })).status).toBe(200);
  });

  test("no hint endpoint, hint metadata, or narrative is served", async () => {
    const player = client();
    await player.start();
    expect((await player.request("/api/hint", { stage: 1 })).status).toBe(404);
    const detail = await (await player.request("/api/cases/1")).json<any>();
    expect(Object.keys(detail).sort()).toEqual(["files", "id", "solved", "widget"]);
    const state = await (await player.request("/api/session")).json<any>();
    expect(state).not.toHaveProperty("hints");
    expect(state.catalog).toEqual(Array.from({ length: answers.codes.length }, (_, i) => ({ id: i + 1 })));
    const page = await (await player.request("/")).text();
    expect(page).not.toMatch(/hint-panel|hint-button|未寄出的信|需要一束微光/);
  });

  test("the real conditional HTTP response carries the clue only on a matching request", async () => {
    const player = client();
    await player.start();
    await player.advance(2);
    const first = await player.request("/api/echo");
    expect(first.status).toBe(200);
    expect(first.headers.has("X-Afterimage")).toBe(false);
    const mismatch = await player.request("/api/echo", undefined, { "If-None-Match": '"wrong"' });
    expect(mismatch.status).toBe(200);
    const repeated = await player.request("/api/echo", undefined, { "If-None-Match": first.headers.get("ETag")! });
    expect(repeated.status).toBe(304);
    expect(await repeated.text()).toBe("");
    expect(atob(repeated.headers.get("X-Afterimage")!)).toContain(answers.codes[1]);
  });

  test("toy quotes are session-bound and single-use even under concurrent checkout", async () => {
    const alice = client();
    const bob = client();
    await alice.start();
    await bob.start();
    expect((await alice.request("/api/shop")).status).toBe(403);
    await alice.advance(4);
    await bob.advance(4);
    expect((await alice.request("/api/shop/redeem", {})).status).toBe(409);
    const quote = await (await alice.request("/api/shop/quote", { item: "stand", quantity: -3 })).json<any>();
    expect(quote.cost).toBe(-3);
    expect((await bob.request("/api/shop/checkout", { quoteId: quote.quoteId })).status).toBe(409);
    const checkouts = await Promise.all(Array.from({ length: 3 }, () => alice.request("/api/shop/checkout", { quoteId: quote.quoteId })));
    expect(checkouts.filter((r) => r.status === 200)).toHaveLength(1);
    expect(checkouts.filter((r) => r.status === 409)).toHaveLength(2);
    const wallet = await (await alice.request("/api/shop")).json<any>();
    expect(wallet.cards).toBe(4);
    expect(wallet.stands).toBe(3);
    const note = await (await alice.request("/api/shop/redeem", {})).json<any>();
    expect(note.code).toBe(answers.codes[3]);
    expect(note.cards).toBe(0);
    const repeated = await (await alice.request("/api/shop/redeem", {})).json<any>();
    expect(repeated.cards).toBe(0);
    expect(repeated.stands).toBe(2);
    expect((await (await bob.request("/api/shop")).json<any>()).cards).toBe(1);
    expect((await alice.request("/api/shop/quote", { item: "stand", quantity: -1e20 })).status).toBe(400);
    expect((await alice.request("/api/shop/quote", { item: "stand", quantity: 0.5 })).status).toBe(400);
  });

  test("completion is server-signed, player-bound and verifiable after reload", async () => {
    const player = client();
    await player.start();
    expect((await player.request("/api/proof")).status).toBe(403);
    await player.advance(answers.codes.length + 1);
    await evictDurableObject(player.stub());
    const proof = await (await player.request("/api/proof")).json<any>();
    expect(proof.completion.cases).toBe(answers.codes.length);
    expect(proof.completion.attempts).toBe(answers.codes.length);
    expect(proof.completion.edition).toBe(answers.version);
    const visitor = client();
    const verified = await (await visitor.request("/api/proof/verify", { proof: proof.proof })).json<any>();
    expect(verified.completion).toEqual(proof.completion);
    const parts = proof.proof.split(".");
    const tampered = JSON.parse(atob(parts[0].replaceAll("-", "+").replaceAll("_", "/")));
    tampered.attempts = 999;
    const changed = btoa(JSON.stringify(tampered)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") + "." + parts[1];
    expect((await visitor.request("/api/proof/verify", { proof: changed })).status).toBe(400);
    await visitor.start();
    expect((await visitor.request("/api/proof")).status).toBe(403);
    expect((await (await player.request("/api/session")).json<any>()).stage).toBe(answers.codes.length + 1);
  });

  test("tampered cookies, cross-origin writes and oversized input fail closed", async () => {
    const player = client();
    await player.start();
    const cookie = player.cookie();
    const badCookie = cookie.slice(0, -2) + (cookie.at(-2) === "A" ? "B" : "A") + cookie.at(-1);
    expect((await player.request("/api/cases/1", undefined, { Cookie: badCookie })).status).toBe(401);
    expect((await player.request("/api/start", {}, { Origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await player.request("/api/start", {}, { "X-Afterglow": "" })).status).toBe(403);
    expect((await player.request("/api/start", { large: "a".repeat(10_000) })).status).toBe(413);
    expect((await player.request("/api/start", [])).status).toBe(400);
    const response = await player.request("/api/session");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  test("changing the puzzle edition never silently overwrites an existing run", async () => {
    const player = client();
    await player.start();
    await runInDurableObject(player.stub(), (_instance, context) => {
      context.storage.sql.exec("UPDATE game SET version = '0000000000000000' WHERE id = 1");
    });
    expect((await (await player.request("/api/session")).json<any>()).outdated).toBe(true);
    expect((await player.request("/api/cases/1")).status).toBe(409);
    expect((await player.start()).outdated).toBe(true);
    const oldCookie = player.cookie();
    const fresh = await (await player.request("/api/restart", {})).json<any>();
    expect(fresh.outdated).toBe(false);
    expect(fresh.stage).toBe(1);
    expect(player.cookie()).not.toBe(oldCookie);
  });
});
