// Incremental deploy of dist/ to Arweave via ArDrive Turbo.
//
// Only files whose content changed since the last deploy are uploaded; the rest
// reuse their transaction IDs from .deploy-cache.json. The path manifest is
// rebuilt and re-uploaded every time (a few KB, inside the free tier), so the
// resulting site is always complete even though most files were skipped.
//
// Usage:
//   pnpm deploy                     build, then incremental upload
//   pnpm deploy --force             ignore the cache and re-upload everything
//   pnpm deploy --dry-run           report what would upload, without spending
//   pnpm deploy --env-file <path>   read secrets from an env file elsewhere
//
// Wallet (either one, checked in this order — NEVER commit secrets):
//   1. ETH_PRIVATE_KEY in .env or environment — the MetaMask account used on
//      app.ardrive.io (MetaMask: account menu → Account details → Show private key)
//   2. Arweave keyfile JSON at ARWEAVE_WALLET_FILE or ./wallet.json

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { TurboFactory } from "@ardrive/turbo-sdk";

// Content-Type by extension. Anything not listed is served as a binary
// download, so add an entry when the build starts emitting a new asset type.
const MIME = {
	".html": "text/html",
	".css": "text/css",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".json": "application/json",
	".xml": "application/xml",
	".txt": "text/plain",
	".asc": "text/plain",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".eot": "application/vnd.ms-fontobject",
	".wasm": "application/wasm",
	".webmanifest": "application/manifest+json",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".pdf": "application/pdf",
	// Live2D model data
	".moc3": "application/octet-stream",
	".model3": "application/json",
	// Pagefind search index shards
	".pagefind": "application/octet-stream",
	".pf_meta": "application/octet-stream",
	".pf_index": "application/octet-stream",
	".pf_fragment": "application/octet-stream",
};
const contentTypeOf = (file) =>
	MIME[path.extname(file).toLowerCase()] || "application/octet-stream";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distPath = path.join(root, "dist");
const cachePath = path.join(root, ".deploy-cache.json");
const CACHE_VERSION = 1;
const CONCURRENCY = 5;

const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");

// Minimal .env loader (no dependency); real environment variables win.
// Defaults to ./.env; override with `--env-file <path>` or ENV_FILE.
const envFlagIndex = process.argv.indexOf("--env-file");
const envFile =
	(envFlagIndex !== -1 ? process.argv[envFlagIndex + 1] : undefined) ??
	process.env.ENV_FILE ??
	path.join(root, ".env");
if (envFlagIndex !== -1 && !process.argv[envFlagIndex + 1]) {
	console.error("--env-file requires a path argument.");
	process.exit(1);
}
if (existsSync(envFile)) {
	for (const line of readFileSync(envFile, "utf-8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
		if (m && !(m[1] in process.env))
			process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
} else if (envFlagIndex !== -1) {
	console.error(`Env file not found: ${envFile}`);
	process.exit(1);
}

if (!existsSync(distPath) || !existsSync(path.join(distPath, "index.html"))) {
	console.error("dist/ is missing or has no index.html — run `pnpm build` first.");
	process.exit(1);
}

/** Recursively list files as { abs, rel, size }; rel always uses forward slashes. */
async function walk(dir, base = dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(abs, base)));
		else if (entry.isFile())
			out.push({
				abs,
				rel: path.relative(base, abs).split(path.sep).join("/"),
				size: statSync(abs).size,
			});
	}
	return out;
}

function sha256(file) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(file)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolve(hash.digest("hex")))
			.on("error", reject);
	});
}

/** Run fn over items with at most `limit` in flight. */
async function pool(items, limit, fn) {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const index = cursor++;
			await fn(items[index], index);
		}
	});
	await Promise.all(workers);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

// ---------------------------------------------------------------- cache

let cache = { version: CACHE_VERSION, byHash: {} };
if (!force && existsSync(cachePath)) {
	try {
		const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
		if (parsed.version === CACHE_VERSION && parsed.byHash) cache = parsed;
		else console.log("Cache version mismatch — starting fresh.");
	} catch {
		console.log("Cache unreadable — starting fresh.");
	}
}

const files = await walk(distPath);
if (files.length === 0) {
	console.error("dist/ contains no files.");
	process.exit(1);
}

for (const file of files) file.hash = await sha256(file.abs);

const cached = files.filter((f) => cache.byHash[f.hash]);
const pending = files.filter((f) => !cache.byHash[f.hash]);
const pendingBytes = pending.reduce((sum, f) => sum + f.size, 0);

console.log(
	`${files.length} files in dist (${mb(files.reduce((s, f) => s + f.size, 0))})`,
);
console.log(`  reuse  : ${cached.length} unchanged (${mb(files.reduce((s, f) => s + f.size, 0) - pendingBytes)} skipped)`);
console.log(`  upload : ${pending.length} new or changed (${mb(pendingBytes)})`);

if (dryRun) {
	for (const f of pending) console.log(`         + ${f.rel} (${mb(f.size)})`);
	console.log("\n--dry-run: nothing uploaded.");
	process.exit(0);
}

// ---------------------------------------------------------------- wallet

let turbo;
const ethKey = process.env.ETH_PRIVATE_KEY;
const walletPath = process.env.ARWEAVE_WALLET_FILE || path.join(root, "wallet.json");
if (ethKey) {
	if (!/^(0x)?[0-9a-fA-F]{64}$/.test(ethKey)) {
		console.error("ETH_PRIVATE_KEY does not look like a 64-hex-char Ethereum private key.");
		process.exit(1);
	}
	turbo = TurboFactory.authenticated({
		privateKey: ethKey.startsWith("0x") ? ethKey : `0x${ethKey}`,
		token: "ethereum",
	});
	console.log("\nSigner: Ethereum key (MetaMask)");
} else if (existsSync(walletPath)) {
	turbo = TurboFactory.authenticated({
		privateKey: JSON.parse(readFileSync(walletPath, "utf-8")),
	});
	console.log("\nSigner: Arweave keyfile");
} else {
	console.error(
		"No wallet configured. Do ONE of the following:\n" +
			"  A) MetaMask (you log in to app.ardrive.io with it):\n" +
			"     create a .env file in the project root containing:\n" +
			"       ETH_PRIVATE_KEY=0x...(MetaMask → Account details → Show private key)\n" +
			"  B) Arweave keyfile: save it as wallet.json, or point ARWEAVE_WALLET_FILE to it.",
	);
	process.exit(1);
}

const { winc: balance } = await turbo.getBalance();
console.log(`Balance: ${(Number(balance) / 1e12).toFixed(6)} credits`);

// ---------------------------------------------------------------- upload

const errors = [];
let spentWinc = 0n;
let done = 0;

if (pending.length > 0) {
	console.log("");
	await pool(pending, CONCURRENCY, async (file) => {
		const contentType = contentTypeOf(file.abs);
		try {
			const res = await turbo.uploadFile({
				fileStreamFactory: () => createReadStream(file.abs),
				fileSizeFactory: () => file.size,
				dataItemOpts: { tags: [{ name: "Content-Type", value: contentType }] },
			});
			cache.byHash[file.hash] = res.id;
			spentWinc += BigInt(res.winc ?? 0);
			console.log(`  [${++done}/${pending.length}] ${file.rel}`);
		} catch (e) {
			errors.push({ file: file.rel, message: e.message });
			console.error(`  [${++done}/${pending.length}] FAILED ${file.rel}: ${e.message}`);
		}
	});
	// Persist whatever succeeded, so a retry does not re-pay for those files
	writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

if (errors.length > 0) {
	console.error(`\n${errors.length} file(s) failed to upload. Manifest NOT created.`);
	console.error("Successful uploads were cached — re-run `pnpm deploy` to retry only the failures.");
	process.exit(1);
}

// ---------------------------------------------------------------- manifest

const paths = {};
for (const file of files) paths[file.rel] = { id: cache.byHash[file.hash] };

// Mirrors @ardrive/turbo-sdk generateManifest()
const indexPath = paths["index.html"] ? "index.html" : Object.keys(paths)[0];
const manifest = {
	manifest: "arweave/paths",
	version: "0.2.0",
	index: { path: indexPath },
	paths,
	fallback: { id: (paths["404.html"] ?? paths[indexPath]).id },
};

const manifestBuffer = Buffer.from(JSON.stringify(manifest));
const manifestRes = await turbo.uploadFile({
	fileStreamFactory: () => Readable.from(manifestBuffer),
	fileSizeFactory: () => manifestBuffer.byteLength,
	dataItemOpts: {
		tags: [{ name: "Content-Type", value: "application/x.arweave-manifest+json" }],
	},
});
spentWinc += BigInt(manifestRes.winc ?? 0);

writeFileSync(cachePath, JSON.stringify(cache, null, 2));

const txid = manifestRes.id;
console.log("");
console.log("=".repeat(64));
console.log(`Uploaded ${pending.length} file(s), reused ${cached.length}, ${mb(pendingBytes)} sent`);
console.log(`Spent          : ${(Number(spentWinc) / 1e12).toFixed(6)} credits`);
console.log(`Manifest TX ID : ${txid}`);
console.log("");
console.log("Set this as the ENS Content Hash at app.ens.domains/arisaka.eth:");
console.log(`  ar://${txid}`);
console.log("");
console.log(`Live after ENS : https://arisaka.eth.limo`);
console.log("=".repeat(64));
