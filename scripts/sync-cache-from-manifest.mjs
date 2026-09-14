/**
 * Recover upload records from a live manifest without trusting path equality.
 *
 *   node scripts/sync-cache-from-manifest.mjs <manifest-txid> [--force]
 *
 * Download each referenced object once and hash its actual bytes. A changed
 * local file must remain pending; it must never inherit the old path's TX ID.
 * Existing history is retained unless --force explicitly discards it. Nothing
 * is written until all referenced objects have been verified successfully.
 */

import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	contentTypeOf,
	createCacheWriter,
	fingerprintResponse,
	hashText,
	loadCache,
	MANIFEST_TYPE,
	recordVerifiedFile,
	validateCache,
} from "./lib/permaweb-cache.mjs";

const GATEWAYS = ["https://turbo-gateway.com", "https://arweave.net"];
const isTxId = (id) =>
	typeof id === "string" && /^[A-Za-z0-9_-]{43}$/u.test(id);

async function walk(directory, root = directory) {
	const files = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(absolute, root)));
		else if (entry.isFile())
			files.push(path.relative(root, absolute).split(path.sep).join("/"));
	}
	return files.sort();
}

async function fingerprintFile(filename) {
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of createReadStream(filename)) {
		hash.update(chunk);
		size += chunk.byteLength;
	}
	return {
		digest: hash.digest("hex"),
		size,
		contentType: contentTypeOf(filename),
	};
}

async function fetchRaw(id, read, fetchImpl) {
	const failures = [];
	for (const base of GATEWAYS) {
		let response;
		try {
			response = await fetchImpl(`${base}/raw/${id}`, {
				signal: AbortSignal.timeout(30_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await read(response);
		} catch (error) {
			failures.push(new Error(`${base}: ${error.message}`, { cause: error }));
		} finally {
			if (response?.body && !response.body.locked)
				await response.body.cancel().catch(() => {});
		}
	}
	throw new AggregateError(
		failures,
		`Cannot verify Arweave transaction ${id}; cache was not changed.`,
	);
}

function parseManifest(text) {
	const manifest = JSON.parse(text);
	if (
		manifest?.manifest !== "arweave/paths" ||
		!["0.1.0", "0.2.0"].includes(manifest.version) ||
		!manifest.paths ||
		typeof manifest.paths !== "object" ||
		Array.isArray(manifest.paths) ||
		!Object.keys(manifest.paths).length ||
		Object.values(manifest.paths).some((entry) => !isTxId(entry?.id))
	) {
		throw new Error("Invalid arweave/paths manifest");
	}
	return manifest;
}

export async function restoreFromManifest({
	manifestId,
	buildDirectory,
	cacheFile,
	force = false,
	fetchImpl = fetch,
}) {
	if (!isTxId(manifestId))
		throw new Error("Manifest transaction ID must be 43 base64url characters");
	const cache = await loadCache(cacheFile, force);
	const files = await walk(buildDirectory);
	const { manifest, manifestText } = await fetchRaw(
		manifestId,
		async (response) => {
			if (
				response.headers
					.get("content-type")
					?.split(";")[0]
					.trim()
					.toLowerCase() !== MANIFEST_TYPE
			) {
				throw new Error(
					"Transaction does not have the Arweave manifest Content-Type",
				);
			}
			const manifestText = await response.text();
			return { manifest: parseManifest(manifestText), manifestText };
		},
		fetchImpl,
	);

	// Fetch all IDs, including removed/renamed local paths, so their content can
	// still be reused later. Directory aliases and duplicate files share a fetch.
	const ids = [
		...new Set(Object.values(manifest.paths).map((entry) => entry.id)),
	];
	const fingerprints = new Map();
	let cursor = 0;
	const results = await Promise.allSettled(
		Array.from({ length: Math.min(4, ids.length) }, async () => {
			while (cursor < ids.length) {
				const id = ids[cursor++];
				fingerprints.set(
					id,
					await fetchRaw(id, fingerprintResponse, fetchImpl),
				);
			}
		}),
	);
	const failures = results.filter((result) => result.status === "rejected");
	if (failures.length)
		throw new AggregateError(
			failures.map((result) => result.reason),
			"Recovery failed; cache was not changed.",
		);

	// Repair path-only entries created by older versions of this tool, even if
	// the corresponding local file has since moved or disappeared.
	for (const [key, entry] of Object.entries(cache.objects)) {
		const remote = fingerprints.get(entry.id);
		if (
			key.startsWith("file:") &&
			remote &&
			key !== `file:${remote.digest}:${remote.contentType}`
		)
			delete cache.objects[key];
	}
	for (const [id, remote] of fingerprints)
		recordVerifiedFile(cache, remote, remote, id);

	const missing = [];
	const changed = [];
	let matched = 0;
	for (const relativePath of files) {
		const entry = manifest.paths[relativePath];
		if (!entry) {
			missing.push(relativePath);
			continue;
		}
		const local = await fingerprintFile(
			path.join(buildDirectory, ...relativePath.split("/")),
		);
		if (recordVerifiedFile(cache, local, fingerprints.get(entry.id), entry.id))
			matched++;
		else changed.push(relativePath);
	}

	cache.objects[`manifest:${hashText(manifestText)}:${MANIFEST_TYPE}`] = {
		id: manifestId,
		size: Buffer.byteLength(manifestText),
		contentType: MANIFEST_TYPE,
	};
	await createCacheWriter(cacheFile)(validateCache(cache));
	return {
		files: files.length,
		verified: ids.length,
		matched,
		changed,
		missing,
		entries: Object.keys(cache.objects).length,
	};
}

async function main() {
	const [manifestId, ...flags] = process.argv.slice(2);
	if (!manifestId || flags.some((flag) => flag !== "--force")) {
		throw new Error(
			"Usage: node scripts/sync-cache-from-manifest.mjs <manifest-txid> [--force]",
		);
	}
	const cacheFile = ".permaweb-cache.json";
	const result = await restoreFromManifest({
		manifestId,
		buildDirectory: path.resolve(process.env.BUILD_DIR?.trim() || "dist"),
		cacheFile,
		force: flags.includes("--force"),
	});
	console.log(`local files      : ${result.files}`);
	console.log(`verified objects : ${result.verified}`);
	console.log(`unchanged paths  : ${result.matched}`);
	console.log(
		`changed paths    : ${result.changed.length} (old TX IDs were not assigned to new content)`,
	);
	console.log(`new paths        : ${result.missing.length}`);
	console.log(
		`cache entries    : ${result.entries} (including upload history)`,
	);
	console.log(
		`Wrote ${cacheFile}; run deploy-permaweb.ts --dry-run to inspect the new upload plan.`,
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
