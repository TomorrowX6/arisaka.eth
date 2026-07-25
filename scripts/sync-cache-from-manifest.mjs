/**
 * Rebuild .permaweb-cache.json from a manifest that is already live.
 *
 *   node scripts/sync-cache-from-manifest.mjs <manifest-txid>
 *
 * Use when a deploy happened somewhere whose cache you do not have — e.g. CI
 * uploaded the site before the cache was shared, so the local cache points at a
 * different (equally valid) set of transactions. Rebuilding from the live
 * manifest makes the cache describe what is actually being served, so the next
 * deploy of unchanged content is a true no-op: no uploads, no new manifest, no
 * ENS transaction.
 *
 * Local files are matched to transactions by path; each entry is keyed by the
 * local file's content hash, exactly as the deploy script keys them.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { contentType as charsetFor, lookup as lookupMime } from "mime-types";

const txid = process.argv[2];
if (!txid) {
	console.error("Usage: node scripts/sync-cache-from-manifest.mjs <manifest-txid>");
	process.exit(1);
}

const buildDir = path.resolve(process.env.BUILD_DIR?.trim() || "dist");
const cacheFile = ".permaweb-cache.json";
const MANIFEST_TYPE = "application/x.arweave-manifest+json";

async function walk(dir, root = dir) {
	const out = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(abs, root)));
		else if (entry.isFile()) out.push(path.relative(root, abs).split(path.sep).join("/"));
	}
	return out.sort();
}

const sha256File = (file) =>
	new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(file)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolve(hash.digest("hex")))
			.on("error", reject);
	});

function contentTypeOf(relativePath) {
	const mimeType = lookupMime(relativePath);
	const withCharset = typeof mimeType === "string" ? charsetFor(mimeType) : false;
	return typeof withCharset === "string"
		? withCharset
		: typeof mimeType === "string"
			? mimeType
			: "application/octet-stream";
}

// Turbo serves freshly uploaded data before it reaches arweave.net, so try both.
let manifestText;
for (const base of ["https://turbo-gateway.com", "https://arweave.net"]) {
	const res = await fetch(`${base}/raw/${txid}`);
	if (!res.ok) continue;
	const text = await res.text();
	if (text.trimStart().startsWith("{")) {
		manifestText = text;
		console.log(`fetched manifest from ${base}`);
		break;
	}
}
if (!manifestText) {
	console.error(`Could not fetch manifest ${txid} as JSON from any gateway.`);
	process.exit(1);
}

const manifest = JSON.parse(manifestText);
if (manifest.manifest !== "arweave/paths") {
	console.error("That transaction is not an arweave/paths manifest.");
	process.exit(1);
}

if (!existsSync(buildDir)) {
	console.error(`Build directory missing: ${buildDir} — run \`pnpm build\` first.`);
	process.exit(1);
}

const files = await walk(buildDir);
const objects = {};
const missing = [];

for (const relativePath of files) {
	const entry = manifest.paths[relativePath];
	if (!entry?.id) {
		missing.push(relativePath);
		continue;
	}
	const abs = path.join(buildDir, ...relativePath.split("/"));
	const contentType = contentTypeOf(relativePath);
	const digest = await sha256File(abs);
	objects[`file:${digest}:${contentType}`] = {
		id: entry.id,
		size: (await fs.stat(abs)).size,
		contentType,
	};
}

// Record the manifest itself so an unchanged site does not re-upload it either.
objects[`manifest:${createHash("sha256").update(manifestText).digest("hex")}:${MANIFEST_TYPE}`] = {
	id: txid,
	size: Buffer.byteLength(manifestText),
	contentType: MANIFEST_TYPE,
};

writeFileSync(cacheFile, `${JSON.stringify({ version: 1, objects }, null, 2)}\n`);

console.log(`local files      : ${files.length}`);
console.log(`matched in manifest: ${files.length - missing.length}`);
console.log(`cache entries    : ${Object.keys(objects).length} (files + manifest)`);
if (missing.length > 0) {
	console.log(`\nNot in the manifest (${missing.length}) — these will upload on the next deploy:`);
	for (const m of missing.slice(0, 10)) console.log(`  ${m}`);
	if (missing.length > 10) console.log(`  ... and ${missing.length - 10} more`);
}
console.log(`\nWrote ${cacheFile}`);
