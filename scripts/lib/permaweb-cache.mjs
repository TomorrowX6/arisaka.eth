import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { lookup, contentType as withCharset } from "mime-types";

export const MANIFEST_TYPE = "application/x.arweave-manifest+json";
export const hashText = (text) =>
	createHash("sha256").update(text).digest("hex");

export function contentTypeOf(filename) {
	const mime = lookup(filename);
	return (mime && withCharset(mime)) || mime || "application/octet-stream";
}

export function validateCache(value) {
	if (
		!value ||
		value.version !== 1 ||
		!value.objects ||
		typeof value.objects !== "object" ||
		Array.isArray(value.objects)
	) {
		throw new Error("Invalid upload cache format");
	}
	for (const [key, entry] of Object.entries(value.objects)) {
		if (
			!/^(file|manifest):[a-f0-9]{64}:.+$/u.test(key) ||
			!entry ||
			typeof entry.id !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/u.test(entry.id) ||
			!Number.isSafeInteger(entry.size) ||
			entry.size < 0 ||
			typeof entry.contentType !== "string" ||
			!entry.contentType ||
			/[\r\n]/u.test(entry.contentType) ||
			!key.endsWith(`:${entry.contentType}`)
		) {
			throw new Error(`Invalid upload cache entry: ${key}`);
		}
	}
	return value;
}

export async function loadCache(filename, force = false) {
	if (force) return { version: 1, objects: {} };
	try {
		return validateCache(JSON.parse(await fs.readFile(filename, "utf8")));
	} catch (error) {
		if (error.code === "ENOENT") return { version: 1, objects: {} };
		throw new Error(
			`Cannot read ${filename}; restore the cache before uploading, or explicitly use --force.`,
			{ cause: error },
		);
	}
}

// Uploads run concurrently, but snapshots must reach disk in order. Rename
// replaces a complete JSON file atomically, keeping the last good copy on error.
export function createCacheWriter(filename) {
	const target = path.resolve(filename);
	let tail = Promise.resolve();
	return (cache) => {
		const snapshot = `${JSON.stringify(cache, null, 2)}\n`;
		const write = tail.then(async () => {
			const temporary = `${target}.${randomUUID()}.tmp`;
			try {
				await fs.writeFile(temporary, snapshot, "utf8");
				await fs.rename(temporary, target);
			} finally {
				await fs.rm(temporary, { force: true });
			}
		});
		tail = write.catch(() => {});
		return write;
	};
}

export function pendingFiles(planned, cache) {
	const unique = new Map();
	for (const file of planned) {
		if (!cache.objects[file.objectKey] && !unique.has(file.objectKey))
			unique.set(file.objectKey, file);
	}
	return [...unique.values()];
}

export function buildManifest(planned, cache) {
	const paths = Object.create(null);
	for (const file of [...planned].sort((a, b) =>
		a.relativePath < b.relativePath
			? -1
			: a.relativePath > b.relativePath
				? 1
				: 0,
	)) {
		const entry = cache.objects[file.objectKey];
		if (!entry)
			throw new Error(`Missing uploaded transaction: ${file.relativePath}`);
		paths[file.relativePath] = { id: entry.id };
	}
	if (!paths["index.html"])
		throw new Error("Missing website entry: index.html");
	for (const [pathname, entry] of Object.entries(paths)) {
		if (!pathname.endsWith("/index.html")) continue;
		const directory = pathname.slice(0, -"/index.html".length);
		paths[directory] ??= entry;
		paths[`${directory}/`] ??= entry;
	}
	return {
		manifest: "arweave/paths",
		version: "0.2.0",
		index: { path: "index.html" },
		paths,
		fallback: { id: (paths["404.html"] ?? paths["index.html"]).id },
	};
}

export async function fingerprintResponse(response) {
	if (!response.ok || !response.body)
		throw new Error(`Cannot verify uploaded object: HTTP ${response.status}`);
	const contentType = response.headers.get("content-type")?.trim();
	if (!contentType)
		throw new Error("Cannot verify uploaded object without Content-Type");
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.byteLength;
		hash.update(chunk);
	}
	return { digest: hash.digest("hex"), size, contentType };
}

// Record the remote bytes under THEIR hash, never a local file's unverified
// hash. This also repairs an old path-only recovery entry pointing at this ID.
export function recordVerifiedFile(cache, local, remote, id) {
	const remoteKey = `file:${remote.digest}:${remote.contentType}`;
	const localKey = `file:${local.digest}:${local.contentType}`;
	if (remoteKey !== localKey && cache.objects[localKey]?.id === id)
		delete cache.objects[localKey];
	cache.objects[remoteKey] = {
		id,
		size: remote.size,
		contentType: remote.contentType,
	};
	return remoteKey === localKey && remote.size === local.size;
}

export function mergeCaches(older, newer) {
	validateCache(older);
	validateCache(newer);
	return { version: 1, objects: { ...older.objects, ...newer.objects } };
}
