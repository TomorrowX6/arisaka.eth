import { catalog, cases, caseCount } from "./cases";
import { createProof, createSession, digest, matchesDigest, readSession, verifyProof } from "./crypto";
import manifest from "./generated/manifest.json";
import { GameSession } from "./session";
export { GameSession };

const publicFiles = new Set([
  "/", "/index.html", "/style.css", "/native.css", "/app.js", "/desktop.js", "/system.js",
  "/ui.js", "/filesystem.js", "/storage.js", "/files.js", "/editor.js", "/console.js", "/viewer.js",
  "/preferences.js", "/settings.js", "/shell.js", "/applications.js", "/utilities.js", "/binary.js", "/calculator.js",
  "/desktop-config.js",
  "/developer-tools.js", "/developer-tools.css", "/profiler.js",
  "/transport.js", "/python-runner.js",
  "/vendor/pyodide/pyodide.mjs", "/vendor/pyodide/pyodide.asm.mjs", "/vendor/pyodide/pyodide.asm.wasm",
  "/vendor/pyodide/python_stdlib.zip", "/vendor/pyodide/pyodide-lock.json", "/vendor/pyodide/LICENSE.txt",
  "/analysis-tools.js", "/media-tools.js", "/crypto-tools.js", "/database.js", "/database-worker.js",
  "/workspace-tools.js", "/workspace-tools.css", "/diff.js",
  "/paint.js", "/pixels.js",
  "/vendor/openpgp.js", "/vendor/openpgp.LICENSE.txt", "/vendor/sqlite.js", "/vendor/sqlite.LICENSE.txt", "/vendor/sql-wasm.wasm",
  "/vendor/pdf.mjs", "/vendor/pdf.worker.mjs", "/vendor/pdf.LICENSE.txt",
  "/wallpapers/attribution.json", "/wallpapers/CC-BY-SA-4.0.txt",
  "/themes.css", "/shell.css", "/utilities.css", "/vendor/codecs.js", "/vendor/codecs.LICENSE.txt",
  "/runner.js", "/widgets.js", "/midi.js", "/mark.svg", "/vendor/jsQR.js", "/vendor/jsQR-LICENSE.txt",
  "/vendor/editor-engine.js", "/vendor/editor-engine.LICENSE.txt", "/icons/COPYING.LIB.txt",
]);
const fileIndex: Record<string, string[]> = manifest.files;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const response = Response.json(value, { status, headers });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function secured(response: Response, runner: false | "javascript" | "python" = false): Response {
  const html = response.headers.get("Content-Type")?.includes("text/html") && response.body;
  const nonce = html ? crypto.randomUUID().replaceAll("-", "") : "";
  if (nonce) {
    response = new HTMLRewriter().on('meta[name="csp-nonce"]', {
      element(element) { element.setAttribute("content", nonce); },
    }).transform(response);
  }
  const headers = new Headers(response.headers);
  if (nonce) {
    headers.set("Cache-Control", "private, no-store");
    headers.delete("Content-Length");
    headers.delete("ETag");
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Content-Security-Policy", runner ? [
    "default-src 'none'", "script-src 'self' blob: 'wasm-unsafe-eval'" + (runner === "python" ? " 'unsafe-eval'" : ""),
    runner === "python" ? "worker-src 'none'" : "worker-src blob:", "connect-src 'none'",
  ].join("; ") : [
    "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'" + (nonce ? " 'nonce-" + nonce + "'" : ""),
    "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'", "worker-src 'self'",
  ].join("; "));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "请使用 JSON 请求。");
  }
  if (request.headers.get("X-Afterglow") !== "1") throw new HttpError(403, "缺少 X-Afterglow 请求标记。");
  const length = Number(request.headers.get("Content-Length") || "0");
  if (!Number.isFinite(length) || length > 8192) throw new HttpError(413, "请求内容过长。");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        throw new HttpError(413, "请求内容过长。");
      }
      chunks.push(part.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) || "{}");
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Object required");
    return result as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "无法读取这份 JSON 请求。");
  }
}

function stageNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > caseCount) {
    throw new HttpError(400, "档案编号无效。");
  }
  return value;
}

function stringValue(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) throw new HttpError(400, "请求字段无效。");
  return value;
}

function rpcReply(result: { ok: boolean; status?: number; retryAt?: number }): Response {
  return json(result, result.ok ? 200 : result.status || 400,
    result.status === 429 && typeof result.retryAt === "number"
      ? { "Retry-After": String(Math.max(1, Math.ceil((result.retryAt - Date.now()) / 1000))) } : {});
}

function terminal(command: string, cwd: string) {
  const files: Record<string, string> = {
    "/archive/.cache/afterimage": manifest.terminalClue + "\n",
  };
  const directories = ["/archive", "/archive/.cache"];
  if (!directories.includes(cwd)) cwd = "/archive";
  const resolve = (value = ".") => {
    const segments = (value.startsWith("/") ? value : cwd + "/" + value).split("/");
    const parts: string[] = [];
    for (const part of segments) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return "/" + parts.join("/");
  };
  const [operation, ...args] = command.trim().split(/\s+/);
  let output = "";
  switch (operation) {
    case "help":
      output = "help\npwd\nls [-a] [path]\ncd [path]\ncat <file>\nclear";
      break;
    case "pwd": output = cwd; break;
    case "cd": {
      const path = args.length ? resolve(args[0]) : "/archive";
      if (directories.includes(path)) cwd = path;
      else output = "cd: 目录不存在";
      break;
    }
    case "ls": {
      const hidden = args.some((arg) => ["-a", "-la", "-al"].includes(arg));
      const path = resolve(args.find((arg) => !arg.startsWith("-")) || ".");
      if (!directories.includes(path)) output = "ls: 目录不存在";
      else {
        const entries = [...directories, ...Object.keys(files)]
          .filter((item) => item.startsWith(path + "/") && !item.slice(path.length + 1).includes("/"))
          .map((item) => item.slice(path.length + 1) + (directories.includes(item) ? "/" : ""))
          .filter((item) => hidden || !item.startsWith("."));
        output = (hidden ? [".", "..", ...entries] : entries).join("   ");
      }
      break;
    }
    case "cat": output = args.length ? files[resolve(args[0])] ?? "cat: 文件不存在" : "用法：cat 文件"; break;
    case "clear": break;
    case "": break;
    default: output = operation + ": command not found";
  }
  return { ok: true, output, cwd };
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/")) {
    if ((request.method !== "GET" && request.method !== "HEAD") || !(publicFiles.has(path) || /^\/icons\/[a-z0-9-]+\.svg$/.test(path) || /^\/wallpapers\/(mountain|flow|scarlet)\.jpg$/.test(path) || /^\/vendor\/pdf-(?:cmaps|fonts|wasm)\/[a-zA-Z0-9_.-]+$/.test(path) || /^\/vendor\/pyodide\/[a-zA-Z0-9_.-]+\.whl$/.test(path))) {
      return json({ error: "不存在" }, 404);
    }
    const asset = await env.ASSETS.fetch(new Request(new URL(path === "/" ? "/index.html" : path, url), request));
    const headers = new Headers(asset.headers);
    headers.set("Cache-Control", "no-cache");
    return new Response(asset.body, { status: asset.status, headers });
  }
  if (!["GET", "POST"].includes(request.method)) throw new HttpError(405, "请求方法不受支持。");
  const origin = request.headers.get("Origin");
  if ((origin && origin !== url.origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    throw new HttpError(403, "请从档案室内发起请求。");
  }
  const data = request.method === "POST" ? await body(request) : {};
  if (path === "/api/health" && request.method === "GET") {
    return json({ ok: true, edition: manifest.version, cases: cases.length });
  }
  if (path === "/api/proof/verify" && request.method === "POST") {
    const completion = await verifyProof(env.SESSION_SECRET, stringValue(data.proof, 2048));
    return completion ? json({ ok: true, completion }) : json({ ok: false, error: "凭证无效" }, 400);
  }
  const profile = request.headers.get("X-Desktop-Profile") || url.searchParams.get("profile") || "default";
  if (profile !== "default" && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(profile)) throw new HttpError(400, "用户编号无效");
  let id = await readSession(request, env.SESSION_SECRET, profile);
  const anchor = profile === "default" ? id : await readSession(request, env.SESSION_SECRET);
  if ((path === "/api/start" || path === "/api/restart") && request.method === "POST") {
    if (!id && !anchor) {
      const entry = typeof data.entry === "string" ? data.entry : "";
      if (!/^[a-z0-9]{20}$/.test(entry)
        || !await matchesDigest("afterglow/entry/v1/" + entry, manifest.entryDigest)) {
        throw new HttpError(403, "未解锁");
      }
    }
    const cookies: string[] = [];
    if (!id || path === "/api/restart") {
      const session = await createSession(env.SESSION_SECRET, url.protocol === "https:", profile);
      id = session.id;
      cookies.push(session.cookie);
    }
    if (profile !== "default" && !anchor) cookies.push((await createSession(env.SESSION_SECRET, url.protocol === "https:")).cookie);
    const state = await env.GAME_SESSIONS.getByName(id).state();
    const headers = new Headers();
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return json({ ...state, player: (await digest(id)).slice(0, 12), catalog }, 200, headers);
  }
  if (path === "/api/session" && request.method === "GET") {
    if (!id) return json({ started: false, canStart: Boolean(anchor), catalog });
    return json({ ...await env.GAME_SESSIONS.getByName(id).state(), player: (await digest(id)).slice(0, 12), catalog });
  }
  if (!id) throw new HttpError(401, "会话已失效");
  const session = env.GAME_SESSIONS.getByName(id);

  const labMatch = /^\/api\/labs\/([1-9][0-9]{0,2})$/.exec(path);
  if (labMatch) {
    return rpcReply(await session.lab(Number(labMatch[1]), request.method === "GET" ? "inspect" : stringValue(data.action, 32), data));
  }

  const caseMatch = /^\/api\/cases\/([1-9][0-9]{0,2})$/.exec(path);
  if (caseMatch && request.method === "GET") {
    const number = Number(caseMatch[1]);
    const access = await session.access(number);
    if (!access.ok) return rpcReply(access);
    const record = cases[number - 1];
    return json({
      ...record, solved: access.solved,
      files: fileIndex[String(number)].map((name) => ({ name, url: "/api/files/" + number + "/" + name + (profile === "default" ? "" : "?profile=" + profile) })),
    });
  }
  const fileMatch = /^\/api\/files\/([1-9][0-9]{0,2})\/([a-zA-Z0-9_.-]+)$/.exec(path);
  if (fileMatch && request.method === "GET") {
    const [, number, name] = fileMatch;
    if (!fileIndex[number]?.includes(name)) throw new HttpError(404, "附件不存在。");
    const access = await session.access(Number(number));
    if (!access.ok) return rpcReply(access);
    const asset = await env.ASSETS.fetch(new Request(new URL("/_puzzles/" + number + "/" + name, url)));
    if (!asset.ok) throw new HttpError(503, "文件读取失败");
    const headers = new Headers(asset.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.set("Content-Disposition", 'inline; filename="' + name + '"');
    headers.delete("ETag");
    return new Response(asset.body, { status: asset.status, headers });
  }
  if (path === "/api/answer" && request.method === "POST") {
    return rpcReply(await session.answer(stageNumber(data.stage), stringValue(data.code, 100).trim()));
  }
  if (path === "/api/terminal" && request.method === "POST") {
    const access = await session.access(1);
    if (!access.ok) return rpcReply(access);
    return json(terminal(stringValue(data.command, 240), stringValue(data.cwd ?? "/archive", 120)));
  }
  if (path === "/api/echo" && request.method === "GET") {
    const access = await session.access(2);
    if (!access.ok) return rpcReply(access);
    const headers = new Headers({ ETag: manifest.etag, "Cache-Control": "private, no-store", "Content-Type": "text/plain; charset=utf-8" });
    const condition = request.headers.get("If-None-Match") || "";
    const matches = condition.split(",").map((value) => value.trim()).some((value) => value === "*" || value.replace(/^W\//, "") === manifest.etag);
    if (matches) {
      headers.set("X-Afterimage", manifest.conditionalClue);
      return new Response(null, { status: 304, headers });
    }
    return new Response("Nothing changed.\n", { headers });
  }
  if (path === "/api/shop" && request.method === "GET") return rpcReply(await session.shop());
  if (path === "/api/shop/quote" && request.method === "POST") {
    if (typeof data.quantity !== "number") throw new HttpError(400, "数量必须是整数。");
    return rpcReply(await session.quote(stringValue(data.item, 32), data.quantity));
  }
  if (path === "/api/shop/checkout" && request.method === "POST") return rpcReply(await session.checkout(stringValue(data.quoteId, 80)));
  if (path === "/api/shop/redeem" && request.method === "POST") return rpcReply(await session.redeem());
  if (path === "/api/shop/reset" && request.method === "POST") return rpcReply(await session.resetShop());
  if (path === "/api/proof" && request.method === "GET") {
    const state = await session.state();
    if (state.outdated || state.stage !== caseCount + 1 || !state.completedAt) throw new HttpError(403, "未通关");
    const completion = {
      format: "afterglow-completion-v1" as const, edition: state.edition, player: (await digest(id)).slice(0, 12),
      completedAt: state.completedAt, elapsedMs: state.completedAt - state.startedAt,
      attempts: state.attempts, cases: caseCount,
    };
    return json({ completion, proof: await createProof(env.SESSION_SECRET, completion) });
  }
  throw new HttpError(404, "不存在");
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      return secured(await route(request, env), path === "/runner.js" ? "javascript" : path === "/python-runner.js" ? "python" : false);
    } catch (error) {
      if (error instanceof HttpError) return secured(json({ ok: false, error: error.message }, error.status));
      console.error({ event: "afterglow_request_failed", errorType: error instanceof Error ? error.name : "Unknown" });
      return secured(json({ ok: false, error: "请求失败，请重试" }, 503));
    }
  },
} satisfies ExportedHandler<Env>;
