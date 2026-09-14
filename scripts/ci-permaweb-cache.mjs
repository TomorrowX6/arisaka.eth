/** Sync the permanent upload cache without rewriting the checked-out source. */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	createCacheWriter,
	loadCache,
	mergeCaches,
	validateCache,
} from "./lib/permaweb-cache.mjs";

const CACHE_FILE = ".permaweb-cache.json";

function git(cwd, ...args) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 16 * 1024 * 1024,
		timeout: 60_000,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	}).trim();
}

function latestCache(cwd, branch) {
	git(cwd, "check-ref-format", `refs/heads/${branch}`);
	git(cwd, "fetch", "--no-tags", "origin", `refs/heads/${branch}`);
	const revision = git(cwd, "rev-parse", "FETCH_HEAD");
	const exists = git(cwd, "ls-tree", "--name-only", revision, "--", CACHE_FILE);
	const cache = exists
		? validateCache(JSON.parse(git(cwd, "show", `${revision}:${CACHE_FILE}`)))
		: { version: 1, objects: {} };
	return { revision, cache };
}

async function removeTemporaryWorktree(cwd, worktree, attached) {
	const absolute = path.resolve(worktree);
	if (
		path.dirname(absolute) !== path.resolve(tmpdir()) ||
		!path.basename(absolute).startsWith("arisaka-permaweb-cache-")
	) {
		throw new Error("Refusing to remove an unexpected worktree path");
	}
	if (attached) git(cwd, "worktree", "remove", "--force", "--", absolute);
	else await fs.rmdir(absolute);
}

export async function restoreLatestCache({ cwd = process.cwd(), branch }) {
	const filename = path.join(cwd, CACHE_FILE);
	const local = await loadCache(filename);
	const { cache: remote } = latestCache(cwd, branch);
	const merged = mergeCaches(local, remote);
	await createCacheWriter(filename)(merged);
	return Object.keys(merged.objects).length;
}

export async function persistCache({ cwd = process.cwd(), branch }) {
	const snapshot = await loadCache(path.join(cwd, CACHE_FILE));
	// A new source commit may land while uploads are in flight. Base each attempt
	// on the latest branch, merge only upload records, and retry a rejected push.
	for (let attempt = 1; attempt <= 3; attempt++) {
		const { revision, cache: remote } = latestCache(cwd, branch);
		const merged = mergeCaches(remote, snapshot);
		if (
			Object.entries(merged.objects).every(
				([key, value]) =>
					JSON.stringify(remote.objects[key]) === JSON.stringify(value),
			)
		)
			return "unchanged";

		const worktree = await fs.mkdtemp(
			path.join(tmpdir(), "arisaka-permaweb-cache-"),
		);
		let attached = false;
		try {
			git(cwd, "worktree", "add", "--detach", worktree, revision);
			attached = true;
			await createCacheWriter(path.join(worktree, CACHE_FILE))(merged);
			git(worktree, "add", "--", CACHE_FILE);
			git(
				worktree,
				"-c",
				"user.name=github-actions[bot]",
				"-c",
				"user.email=41898282+github-actions[bot]@users.noreply.github.com",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-m",
				"chore: update permaweb upload cache [skip ci]",
			);
			try {
				git(worktree, "push", "origin", `HEAD:refs/heads/${branch}`);
				return "committed";
			} catch (error) {
				if (attempt === 3) throw error;
				console.warn(
					`Cache push rejected; refreshing the branch (attempt ${attempt + 1}/3).`,
				);
			}
		} finally {
			// Only remove the temporary worktree created above, including after a
			// failed commit. Never reset or clean the deployment's source checkout.
			await removeTemporaryWorktree(cwd, worktree, attached);
		}
	}
}

async function main() {
	const [mode, branch, ...extra] = process.argv.slice(2);
	if (!branch || extra.length || !["restore", "persist"].includes(mode)) {
		throw new Error(
			"Usage: node scripts/ci-permaweb-cache.mjs <restore|persist> <branch>",
		);
	}
	if (mode === "restore")
		console.log(
			`Restored ${await restoreLatestCache({ branch })} upload records from the latest branch.`,
		);
	else console.log(`Upload cache ${await persistCache({ branch })}.`);
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
