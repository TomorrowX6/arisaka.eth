// Runs the local Worker with secrets supplied over stdin. Nothing is written
// to .env, command arguments, logs, or the browser bundle.
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { watch } from "node:fs";

let miniflare;
let secrets;
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16_384) throw new Error("Invalid configuration");
  }
  secrets = JSON.parse(input);
  input = "";
  if (!["DEEPSEEK_API_KEY", "IP_HASH_SECRET"].every((name) => typeof secrets[name] === "string" && secrets[name])) {
    throw new Error("Missing local secrets");
  }
  const options = () => convertV4MiniflareOptions({
    host: "127.0.0.1",
    port: 8787,
    log: new Log(LogLevel.NONE),
    logRequests: false,
    telemetry: { enabled: false },
    workers: [{
      // Miniflare has no Cloudflare edge to supply the trusted client IP.
      // This adapter exists only on loopback and never enters the deploy bundle.
      name: "local-edge",
      compatibilityDate: "2026-09-13",
      modules: true,
      script: `export default { fetch(request, env) {
        const headers = new Headers(request.headers);
        headers.set("CF-Connecting-IP", "127.0.0.1");
        return env.CHAT.fetch(new Request(request, { headers }));
      } };`,
      serviceBindings: { CHAT: "arisaka-live2d-chat-local" },
    }, {
      name: "arisaka-live2d-chat-local",
      modules: true,
      scriptPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
      compatibilityDate: "2026-09-13",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        ...secrets,
        ALLOWED_ORIGINS: "http://127.0.0.1:4321,http://localhost:4321",
      },
      durableObjects: { CHAT_QUOTA: { className: "ChatQuota", useSQLite: true } },
    }],
  });
  miniflare = new Miniflare(options());
  await miniflare.ready;
  console.log("Local chat Worker ready: http://127.0.0.1:8787");
  if (process.argv.includes("--check")) await miniflare.dispose();
  else {
    let reloadTimer;
    const watcher = watch(fileURLToPath(new URL("../dist/", import.meta.url)), (_event, filename) => {
      if (filename !== "index.js") return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        void miniflare.setOptions(options()).then(() => console.log("Local chat Worker reloaded.")).catch(() => console.error("Local Worker reload failed; rebuild and retry."));
      }, 500);
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, async () => { watcher.close(); clearTimeout(reloadTimer); await miniflare.dispose(); process.exit(0); });
    }
  }
} catch (error) {
  console.error("Local chat Worker failed to start. Check the build, bindings, and port 8787.");
  let detail = error instanceof Error ? error.message : "Unknown startup error";
  for (const value of Object.values(secrets ?? {})) if (typeof value === "string" && value) detail = detail.replaceAll(value, "[redacted]");
  console.error(detail.slice(0,1000));
  await miniflare?.dispose();
  process.exitCode = 1;
}
