import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import {
	persistCache,
	restoreLatestCache,
} from "../scripts/ci-permaweb-cache.mjs";
import {
	buildManifest,
	contentTypeOf,
	createCacheWriter,
	fingerprintResponse,
	hashText,
	loadCache,
	MANIFEST_TYPE,
	mergeCaches,
	pendingFiles,
	validateCache,
} from "../scripts/lib/permaweb-cache.mjs";
import { restoreFromManifest } from "../scripts/sync-cache-from-manifest.mjs";

type Entry = { id: string; size: number; contentType: string };
type Cache = { version: 1; objects: Record<string, Entry> };
const empty = (): Cache => ({ version: 1, objects: {} });
const txid = (seed: string) =>
	createHash("sha256").update(seed).digest("base64url");
const file = (
	relativePath: string,
	body: string,
	contentType = contentTypeOf(relativePath),
) => ({
	relativePath,
	body,
	size: Buffer.byteLength(body),
	contentType,
	objectKey: `file:${hashText(body)}:${contentType}`,
});
function record(
	cache: Cache,
	item: ReturnType<typeof file>,
	id = txid(item.objectKey),
) {
	cache.objects[item.objectKey] = {
		id,
		size: item.size,
		contentType: item.contentType,
	};
}
function uploaded(items: ReturnType<typeof file>[]) {
	const cache = empty();
	for (const item of items) record(cache, item);
	return cache;
}
async function temporary(t: TestContext) {
	const directory = await fs.mkdtemp(
		path.join(tmpdir(), "arisaka-permaweb-test-"),
	);
	t.after(async () => {
		const absolute = path.resolve(directory);
		assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
		assert.ok(path.basename(absolute).startsWith("arisaka-permaweb-test-"));
		await fs.rm(absolute, { recursive: true, force: true });
	});
	return directory;
}
async function writeFiles(directory: string, items: ReturnType<typeof file>[]) {
	for (const item of items) {
		const filename = path.join(directory, item.relativePath);
		await fs.mkdir(path.dirname(filename), { recursive: true });
		await fs.writeFile(filename, item.body);
	}
}

test("an unchanged build reuses every object and the exact manifest", () => {
	const items = [
		file("index.html", "home"),
		file("guide/index.html", "guide"),
		file("404.html", "missing"),
	];
	const cache = uploaded(items);
	const first = JSON.stringify(buildManifest(items, cache));
	const manifestKey = `manifest:${hashText(first)}:${MANIFEST_TYPE}`;
	cache.objects[manifestKey] = {
		id: txid(first),
		size: Buffer.byteLength(first),
		contentType: MANIFEST_TYPE,
	};
	assert.deepEqual(pendingFiles(items, cache), []);
	const second = JSON.stringify(buildManifest(items.toReversed(), cache));
	assert.equal(second, first);
	assert.equal(
		cache.objects[`manifest:${hashText(second)}:${MANIFEST_TYPE}`].id,
		txid(first),
	);
});

test("editing one file uploads only that new content", () => {
	const original = [
		file("index.html", "home"),
		file("guide/index.html", "before"),
		file("style.css", "body{}"),
	];
	const cache = uploaded(original);
	const edited = file("guide/index.html", "after");
	assert.deepEqual(pendingFiles([original[0], edited, original[2]], cache), [
		edited,
	]);
	assert.throws(
		() => buildManifest([original[0], edited], cache),
		/Missing uploaded transaction/,
	);
});

test("identical fresh bytes and MIME upload once for several manifest paths", () => {
	const items = [
		file("index.html", "same"),
		file("copy/index.html", "same"),
		file("another.html", "same"),
	];
	const cache = empty();
	const pending = pendingFiles(items, cache);
	assert.equal(pending.length, 1);
	record(cache, pending[0]);
	const manifest = buildManifest(items, cache);
	assert.equal(Object.keys(manifest.paths).length, 5);
	assert.equal(
		new Set(Object.values(manifest.paths).map((entry: Entry) => entry.id)).size,
		1,
	);
});

test("identical bytes with different MIME types remain separate uploads", () => {
	const items = [file("index.html", "same"), file("same.txt", "same")];
	assert.equal(pendingFiles(items, empty()).length, 2);
	assert.equal(pendingFiles(items, uploaded([items[0]])).length, 1);
	assert.equal(contentTypeOf("MODULE.JS"), "text/javascript; charset=utf-8");
	assert.equal(contentTypeOf("module.wasm"), "application/wasm");
	assert.equal(contentTypeOf("unknown.pf_index"), "application/octet-stream");
});

test("renames reuse content while deletions and old aliases leave the new manifest", () => {
	const before = [
		file("index.html", "home"),
		file("old/index.html", "article"),
		file("deleted.txt", "deleted"),
	];
	const cache = uploaded(before);
	const renamed = file("new/index.html", "article");
	const after = [before[0], renamed];
	assert.deepEqual(pendingFiles(after, cache), []);
	const manifest = buildManifest(after, cache);
	assert.deepEqual(Object.keys(manifest.paths), [
		"index.html",
		"new/index.html",
		"new",
		"new/",
	]);
	assert.equal(
		manifest.paths["new/"].id,
		cache.objects[before[1].objectKey].id,
	);
	assert.equal(manifest.fallback.id, cache.objects[before[0].objectKey].id);
	assert.ok(cache.objects[before[2].objectKey]);
	assert.throws(() => buildManifest([renamed], cache), /Missing website entry/);
});

test("a partial upload resumes with only the failed objects", async (t) => {
	const directory = await temporary(t);
	const filename = path.join(directory, "cache.json");
	const items = [
		file("index.html", "home"),
		file("first.txt", "first"),
		file("second.txt", "second"),
	];
	await createCacheWriter(filename)(uploaded([items[0], items[2]]));
	const restored = await loadCache(filename);
	assert.deepEqual(pendingFiles(items, restored), [items[1]]);
	record(restored, items[1]);
	await createCacheWriter(filename)(restored);
	assert.deepEqual(pendingFiles(items, await loadCache(filename)), []);
});

test("concurrent cache saves remain valid JSON and retain every success", async (t) => {
	const directory = await temporary(t);
	const filename = path.join(directory, "cache.json");
	const save = createCacheWriter(filename);
	const cache = empty();
	await save(cache);
	const items = Array.from({ length: 40 }, (_, index) =>
		file(`${index}.txt`, `content ${index}`),
	);
	let complete = false;
	const writes = Promise.all(
		items.map(async (item) => {
			record(cache, item);
			await save(cache);
		}),
	).finally(() => {
		complete = true;
	});
	while (!complete) {
		validateCache(JSON.parse(await fs.readFile(filename, "utf8")));
		await setTimeout(1);
	}
	await writes;
	assert.deepEqual(await loadCache(filename), cache);
	assert.deepEqual(await fs.readdir(directory), ["cache.json"]);
});

test("a failed atomic replacement preserves the previous cache and permits retry", async (t) => {
	const directory = await temporary(t);
	const filename = path.join(directory, "cache.json");
	const save = createCacheWriter(filename);
	const before = uploaded([file("index.html", "home")]);
	await save(before);
	const after = mergeCaches(
		before,
		uploaded([file("new.txt", "new")]),
	) as Cache;
	const failure = t.mock.method(fs, "rename", async () => {
		throw new Error("simulated disk error");
	});
	await assert.rejects(save(after), /simulated disk error/);
	failure.mock.restore();
	assert.deepEqual(await loadCache(filename), before);
	await save(after);
	assert.deepEqual(await loadCache(filename), after);
	assert.deepEqual(await fs.readdir(directory), ["cache.json"]);
});

test("unreadable or malformed cache never silently becomes a full paid upload", async (t) => {
	const directory = await temporary(t);
	const filename = path.join(directory, "cache.json");
	assert.deepEqual(await loadCache(filename), empty());
	await fs.writeFile(filename, '{"version":1,"objects":');
	await assert.rejects(
		loadCache(filename),
		/restore the cache before uploading/,
	);
	assert.deepEqual(await loadCache(filename, true), empty());
	assert.equal(await fs.readFile(filename, "utf8"), '{"version":1,"objects":');
	const item = file("index.html", "home");
	const valid = uploaded([item]);
	for (const invalid of [
		{ version: 2, objects: {} },
		{ version: 1, objects: [] },
		...[
			{ id: "invalid" },
			{ id: 123 },
			{ size: -1 },
			{ size: 0.5 },
			{ contentType: "wrong/type" },
			{ contentType: "text/html\r\nBad: header" },
		].map((change) => ({
			version: 1,
			objects: {
				[item.objectKey]: { ...valid.objects[item.objectKey], ...change },
			},
		})),
	])
		assert.throws(() => validateCache(invalid), /Invalid upload cache/);
});

test("remote verification hashes streamed bytes and requires successful typed responses", async () => {
	const chunks = [Buffer.from("hello "), Buffer.from("世界")];
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	const response = new Response(stream, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
	assert.deepEqual(await fingerprintResponse(response), {
		digest: hashText("hello 世界"),
		size: Buffer.byteLength("hello 世界"),
		contentType: "text/plain; charset=utf-8",
	});
	await assert.rejects(
		fingerprintResponse(new Response("missing", { status: 404 })),
		/HTTP 404/,
	);
	await assert.rejects(
		fingerprintResponse(new Response(new Uint8Array([1, 2]))),
		/without Content-Type/,
	);
});

test("recovery never maps changed local bytes or MIME to an old path's transaction", async (t) => {
	const directory = await temporary(t);
	const buildDirectory = path.join(directory, "dist");
	const cacheFile = path.join(directory, "cache.json");
	const local = [
		file("index.html", "new home"),
		file("guide/index.html", "guide"),
		file("typed.js", "same bytes"),
		file("new-name.txt", "moved"),
		file("brand-new.txt", "brand new"),
	];
	await writeFiles(buildDirectory, local);
	const remote = [
		file("index.html", "old home"),
		local[1],
		file("typed.js", "same bytes", "text/plain"),
		file("old-name.txt", "moved"),
	];
	const published = uploaded(remote);
	const manifestText = JSON.stringify(buildManifest(remote, published));
	const manifestId = txid(manifestText);
	const poisoned = uploaded([file("history.txt", "historical valid upload")]);
	record(poisoned, local[0], published.objects[remote[0].objectKey].id);
	record(poisoned, local[2], published.objects[remote[2].objectKey].id);
	const deletedPoison = file("removed.html", "no longer on disk");
	record(poisoned, deletedPoison, published.objects[remote[0].objectKey].id);
	await createCacheWriter(cacheFile)(poisoned);
	const requests: string[] = [];
	const fetchImpl = async (url: string) => {
		requests.push(url);
		const id = new URL(url).pathname.slice("/raw/".length);
		if (id === manifestId)
			return new Response(manifestText, {
				headers: { "Content-Type": MANIFEST_TYPE },
			});
		const item = remote.find(
			(item) => published.objects[item.objectKey].id === id,
		);
		assert.ok(item);
		return new Response(item.body, {
			headers: { "Content-Type": item.contentType },
		});
	};
	const result = await restoreFromManifest({
		manifestId,
		buildDirectory,
		cacheFile,
		fetchImpl,
	});
	assert.equal(result.verified, 4);
	assert.equal(result.matched, 1);
	assert.deepEqual(result.changed, ["index.html", "typed.js"]);
	assert.deepEqual(result.missing, ["brand-new.txt", "new-name.txt"]);
	assert.equal(
		requests.length,
		5,
		"directory aliases must share one remote fetch",
	);
	const recovered = await loadCache(cacheFile);
	assert.deepEqual(
		pendingFiles(local, recovered).map(
			(item: ReturnType<typeof file>) => item.relativePath,
		),
		["index.html", "typed.js", "brand-new.txt"],
	);
	assert.ok(
		recovered.objects[file("history.txt", "historical valid upload").objectKey],
	);
	assert.equal(recovered.objects[deletedPoison.objectKey], undefined);
	assert.equal(
		recovered.objects[remote[0].objectKey].id,
		published.objects[remote[0].objectKey].id,
	);
});

test("an unchanged recovered site reuses its manifest and falls back to the second gateway", async (t) => {
	const directory = await temporary(t);
	const buildDirectory = path.join(directory, "dist");
	const cacheFile = path.join(directory, "cache.json");
	const items = [file("index.html", "home"), file("guide/index.html", "guide")];
	await writeFiles(buildDirectory, items);
	const published = uploaded(items);
	const manifestText = JSON.stringify(buildManifest(items, published));
	const manifestId = txid(manifestText);
	const gateways = new Set<string>();
	await restoreFromManifest({
		manifestId,
		buildDirectory,
		cacheFile,
		fetchImpl: async (url: string) => {
			const parsed = new URL(url);
			gateways.add(parsed.origin);
			if (parsed.hostname === "turbo-gateway.com")
				throw new Error("gateway unavailable");
			const id = parsed.pathname.slice("/raw/".length);
			if (id === manifestId)
				return new Response(manifestText, {
					headers: { "Content-Type": MANIFEST_TYPE },
				});
			const item = items.find(
				(item) => published.objects[item.objectKey].id === id,
			);
			assert.ok(item);
			return new Response(item.body, {
				headers: { "Content-Type": item.contentType },
			});
		},
	});
	const recovered = await loadCache(cacheFile);
	assert.deepEqual(pendingFiles(items, recovered), []);
	const nextManifest = JSON.stringify(buildManifest(items, recovered));
	assert.equal(nextManifest, manifestText);
	assert.equal(
		recovered.objects[`manifest:${hashText(nextManifest)}:${MANIFEST_TYPE}`].id,
		manifestId,
	);
	assert.equal(gateways.size, 2);
});

test("failed remote recovery leaves the original cache byte-for-byte intact", async (t) => {
	const directory = await temporary(t);
	const buildDirectory = path.join(directory, "dist");
	const cacheFile = path.join(directory, "cache.json");
	const items = [file("index.html", "home"), file("guide/index.html", "guide")];
	await writeFiles(buildDirectory, items);
	const published = uploaded(items);
	await createCacheWriter(cacheFile)(
		uploaded([file("history.txt", "keep this")]),
	);
	const before = await fs.readFile(cacheFile, "utf8");
	const manifestText = JSON.stringify(buildManifest(items, published));
	const manifestId = txid(manifestText);
	await assert.rejects(
		restoreFromManifest({
			manifestId,
			buildDirectory,
			cacheFile,
			fetchImpl: async (url: string) => {
				const id = new URL(url).pathname.slice("/raw/".length);
				if (id === manifestId)
					return new Response(manifestText, {
						headers: { "Content-Type": MANIFEST_TYPE },
					});
				if (id === published.objects[items[0].objectKey].id)
					return new Response(items[0].body, {
						headers: { "Content-Type": items[0].contentType },
					});
				return new Response("unavailable", { status: 503 });
			},
		}),
		/Recovery failed; cache was not changed/,
	);
	assert.equal(await fs.readFile(cacheFile, "utf8"), before);
	assert.deepEqual((await fs.readdir(directory)).sort(), [
		"cache.json",
		"dist",
	]);
});

test("recovery rejects a manifest served with the wrong MIME before saving its ID", async (t) => {
	const directory = await temporary(t);
	const cacheFile = path.join(directory, "cache.json");
	const items = [file("index.html", "home")];
	await writeFiles(directory, items);
	const manifestText = JSON.stringify(buildManifest(items, uploaded(items)));
	await assert.rejects(
		restoreFromManifest({
			manifestId: txid(manifestText),
			buildDirectory: directory,
			cacheFile,
			fetchImpl: async () =>
				new Response(manifestText, {
					headers: { "Content-Type": "application/json" },
				}),
		}),
		(error: AggregateError) =>
			error.errors.every((failure: Error) =>
				failure.message.includes("manifest Content-Type"),
			),
	);
	await assert.rejects(fs.access(cacheFile), { code: "ENOENT" });
});

test("cache merges retain successes from both deployments and prefer newer records", () => {
	const item = file("index.html", "home");
	const older = uploaded([item, file("old.txt", "old")]);
	const newer = uploaded([item, file("new.txt", "new")]);
	record(newer, item, txid("new transaction, same data"));
	const merged = mergeCaches(older, newer);
	assert.equal(Object.keys(merged.objects).length, 3);
	assert.equal(
		merged.objects[item.objectKey].id,
		newer.objects[item.objectKey].id,
	);
	assert.notEqual(
		older.objects[item.objectKey].id,
		newer.objects[item.objectKey].id,
	);
});

test("CI restores queued uploads and retries cache-only commits over a moving source branch", async (t) => {
	const directory = await temporary(t);
	const origin = path.join(directory, "origin.git");
	const author = path.join(directory, "author");
	const deploy = path.join(directory, "deploy");
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		}).trim();
	const commit = (cwd: string, message: string) => {
		git(cwd, "add", ".");
		git(
			cwd,
			"-c",
			"user.name=Cache Test",
			"-c",
			"user.email=cache-test@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			message,
		);
	};
	git(directory, "init", "--bare", origin);
	git(directory, "init", "--initial-branch=main", author);
	git(author, "remote", "add", "origin", origin);
	await fs.writeFile(path.join(author, "source.txt"), "source one");
	const initial = uploaded([file("index.html", "first")]);
	await createCacheWriter(path.join(author, ".permaweb-cache.json"))(initial);
	commit(author, "initial source and cache");
	git(author, "push", "origin", "main");
	git(directory, "clone", "--branch", "main", origin, deploy);
	git(deploy, "checkout", "--detach");
	const deployedRevision = git(deploy, "rev-parse", "HEAD");
	await fs.writeFile(
		path.join(deploy, "untracked.txt"),
		"preserve local files",
	);

	const priorDeploy = mergeCaches(
		initial,
		uploaded([file("previous.txt", "preceding upload")]),
	);
	await createCacheWriter(path.join(author, ".permaweb-cache.json"))(
		priorDeploy,
	);
	await fs.writeFile(path.join(author, "source.txt"), "source two");
	commit(author, "preceding deployment finished after this run was queued");
	git(author, "push", "origin", "main");
	assert.equal(await restoreLatestCache({ cwd: deploy, branch: "main" }), 2);
	assert.equal(git(deploy, "rev-parse", "HEAD"), deployedRevision);
	assert.equal(
		await fs.readFile(path.join(deploy, "source.txt"), "utf8"),
		"source one",
	);

	const localSuccess = mergeCaches(
		priorDeploy,
		uploaded([file("new.txt", "this upload succeeded")]),
	);
	await createCacheWriter(path.join(deploy, ".permaweb-cache.json"))(
		localSuccess,
	);
	const anotherSuccess = mergeCaches(
		priorDeploy,
		uploaded([file("remote.txt", "another recorded upload")]),
	);
	await createCacheWriter(path.join(author, ".permaweb-cache.json"))(
		anotherSuccess,
	);
	await fs.writeFile(path.join(author, "source.txt"), "source three");
	commit(author, "source advances while deployment is in flight");
	git(author, "push", "origin", "main");
	const latestSource = git(author, "rev-parse", "HEAD");
	await fs.writeFile(
		path.join(origin, "hooks", "pre-receive"),
		"#!/bin/sh\nif [ ! -f cache-push-retried ]; then\n  : > cache-push-retried\n  echo 'simulate one rejected push' >&2\n  exit 1\nfi\n",
		{ mode: 0o755 },
	);

	assert.equal(
		await persistCache({ cwd: deploy, branch: "main" }),
		"committed",
	);
	git(deploy, "fetch", "origin", "main");
	assert.equal(git(deploy, "rev-parse", "FETCH_HEAD^"), latestSource);
	assert.equal(
		git(
			deploy,
			"diff-tree",
			"--no-commit-id",
			"--name-only",
			"-r",
			"FETCH_HEAD",
		),
		".permaweb-cache.json",
	);
	assert.equal(git(deploy, "show", "FETCH_HEAD:source.txt"), "source three");
	const final = JSON.parse(
		git(deploy, "show", "FETCH_HEAD:.permaweb-cache.json"),
	);
	assert.equal(Object.keys(final.objects).length, 4);
	for (const cache of [localSuccess, anotherSuccess]) {
		for (const [key, value] of Object.entries(cache.objects))
			assert.deepEqual(final.objects[key], value);
	}
	assert.equal(git(deploy, "rev-parse", "HEAD"), deployedRevision);
	assert.equal(
		await fs.readFile(path.join(deploy, "untracked.txt"), "utf8"),
		"preserve local files",
	);
	assert.equal(
		await fs.readFile(path.join(deploy, "source.txt"), "utf8"),
		"source one",
	);
	assert.equal(
		await persistCache({ cwd: deploy, branch: "main" }),
		"unchanged",
	);
	assert.equal(
		git(deploy, "worktree", "list", "--porcelain").split("worktree ").length -
			1,
		1,
	);
});
