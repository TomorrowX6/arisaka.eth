/**
 * One-command permaweb release:
 *   build -> incremental upload to Arweave -> manifest -> update ENS contenthash
 *
 *   pnpm deploy:perma
 *   pnpm deploy:perma -- --dry-run    plan only, never spends credits or gas
 *   pnpm deploy:perma -- --skip-ens   upload only, leave ENS untouched
 *   pnpm deploy:perma -- --force      ignore the cache and re-upload everything
 *
 * Who pays for uploads, in priority order:
 *   1. An Arweave keyfile (ARWEAVE_WALLET_FILE, default ./wallet.json) — signs
 *      as that wallet and spends its own credits. Simplest, no approval needed.
 *   2. DEPLOY_EVM_PRIVATE_KEY, optionally combined with TURBO_PAID_BY to spend
 *      credits shared to it by another wallet.
 *
 * Updating ENS always needs DEPLOY_EVM_PRIVATE_KEY (it sends a mainnet tx).
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

import { TurboFactory } from "@ardrive/turbo-sdk";
import { encode } from "@ensdomains/content-hash";
import * as dotenv from "dotenv";
import { MANIFEST_TYPE, buildManifest, contentTypeOf, createCacheWriter, hashText, loadCache as readCache, pendingFiles } from "./lib/permaweb-cache.mjs";
import { type Hex, createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { namehash, normalize } from "viem/ens";

// Base config, plus any extra env file passed with --env-file (useful when the
// EVM key already lives somewhere else and should not be copied around).
dotenv.config({ path: ".env.permaweb" });
{
	const flagIndex = process.argv.indexOf("--env-file");
	if (flagIndex !== -1) {
		const extraPath = process.argv[flagIndex + 1];
		if (!extraPath) {
			console.error("--env-file requires a path argument.");
			process.exit(1);
		}
		if (!existsSync(extraPath)) {
			console.error(`Env file not found: ${extraPath}`);
			process.exit(1);
		}
		dotenv.config({ path: extraPath });
	}
}

const CACHE_FILE = ".permaweb-cache.json";
const CONCURRENCY = 5;

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const skipEns = argv.includes("--skip-ens");
const force = argv.includes("--force");

type CacheEntry = { id: string; size: number; contentType: string };
type DeploymentCache = { version: 1; objects: Record<string, CacheEntry> };

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing environment variable: ${name}`);
	return value;
}

function getPrivateKey(): Hex {
	// ETH_PRIVATE_KEY is accepted so an existing wallet env file can be reused as-is.
	const value = (process.env.DEPLOY_EVM_PRIVATE_KEY ?? process.env.ETH_PRIVATE_KEY)?.trim();
	if (!value)
		throw new Error(
			"Missing EVM key for the ENS update: set DEPLOY_EVM_PRIVATE_KEY (or ETH_PRIVATE_KEY), " +
				"or pass --skip-ens to upload without touching ENS.",
		);
	const prefixed = value.startsWith("0x") ? value : `0x${value}`;
	if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed))
		throw new Error("The EVM private key must be 64 hex characters, optionally 0x-prefixed");
	return prefixed as Hex;
}

async function walkDirectory(current: string, root: string): Promise<string[]> {
	const entries = await fs.readdir(current, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const absolute = path.join(current, entry.name);
		if (entry.isDirectory()) files.push(...(await walkDirectory(absolute, root)));
		else if (entry.isFile())
			files.push(path.relative(root, absolute).split(path.sep).join("/"));
	}
	return files.sort();
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

async function loadCache(): Promise<DeploymentCache> {
	return readCache(CACHE_FILE, force);
}

const saveCache = createCacheWriter(CACHE_FILE);

/** Run fn over items with at most `limit` in flight, preserving failures. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (cursor < items.length) await fn(items[cursor++]);
		}),
	);
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/**
 * Pick the upload signer. An Arweave keyfile wins when present: it spends its
 * own credits, so no credit-share approval is involved.
 */
function createUploadClient() {
	const walletFile = process.env.ARWEAVE_WALLET_FILE?.trim() || "wallet.json";
	if (existsSync(walletFile)) {
		const jwk = JSON.parse(readFileSync(walletFile, "utf8"));
		return {
			turbo: TurboFactory.authenticated({ privateKey: jwk }),
			description: `Arweave keyfile (${walletFile})`,
			usesApproval: false,
		};
	}
	return {
		turbo: TurboFactory.authenticated({ privateKey: getPrivateKey(), token: "ethereum" }),
		description: "Ethereum key (MetaMask)",
		usesApproval: true,
	};
}

async function uploadWebsite(): Promise<string> {
	const paidBy = process.env.TURBO_PAID_BY?.trim() || undefined;
	const appName = process.env.APP_NAME?.trim() || "arisaka-blog";
	const buildDirectory = path.resolve(process.env.BUILD_DIR?.trim() || "dist");

	if (!existsSync(buildDirectory))
		throw new Error(`Build directory does not exist: ${buildDirectory}`);
	if (!existsSync(path.join(buildDirectory, "index.html")))
		throw new Error(`Missing website entry file: ${buildDirectory}/index.html`);

	const cache = await loadCache();
	const relativeFiles = await walkDirectory(buildDirectory, buildDirectory);

	// Hash everything first so the plan can be reported before spending anything.
	type Planned = { relativePath: string; absolute: string; size: number; contentType: string; objectKey: string };
	const planned: Planned[] = [];
	for (const relativePath of relativeFiles) {
		const absolute = path.join(buildDirectory, ...relativePath.split("/"));
		const { size } = await fs.stat(absolute);
		const contentType = contentTypeOf(relativePath);
		const digest = await sha256File(absolute);
		planned.push({ relativePath, absolute, size, contentType, objectKey: `file:${digest}:${contentType}` });
	}

	// arweave.net's gateway cannot resolve a manifest path that contains a
	// literal space: the file uploads and is listed in the manifest, yet every
	// request for it falls through to the 404 fallback. Refuse before spending
	// anything rather than paying to publish files nobody can fetch.
	const unservable = planned.filter((f) => f.relativePath.includes(" "));
	if (unservable.length > 0)
		throw new Error(
			`${unservable.length} file(s) have a space in their path, which arweave.net cannot serve. ` +
				"Rename them (spaces -> underscores) and rebuild:\n" +
				unservable.map((f) => `  ${f.relativePath}`).join("\n"),
		);

	const pending: Planned[] = pendingFiles(planned, cache);
	const cachedCount = planned.filter((file) => cache.objects[file.objectKey]).length;
	const duplicateCount = planned.length - cachedCount - pending.length;
	const pendingBytes = pending.reduce((sum, f) => sum + f.size, 0);
	const totalBytes = planned.reduce((sum, f) => sum + f.size, 0);

	console.log(`${planned.length} files in ${buildDirectory} (${mb(totalBytes)})`);
	console.log(`  reuse  : ${cachedCount} cached + ${duplicateCount} duplicate paths (${mb(totalBytes - pendingBytes)} skipped)`);
	console.log(`  upload : ${pending.length} distinct new or changed objects (${mb(pendingBytes)})`);
	const walletFile = process.env.ARWEAVE_WALLET_FILE?.trim() || "wallet.json";
	console.log(
		`  payer  : ${existsSync(walletFile) ? `Arweave keyfile (${walletFile})` : (paidBy ?? "deploy wallet itself")}`,
	);

	if (dryRun) {
		for (const f of pending) console.log(`         + ${f.relativePath} (${mb(f.size)})`);
		if (pending.length === 0) {
			const manifestKey = `manifest:${hashText(JSON.stringify(buildManifest(planned, cache)))}:${MANIFEST_TYPE}`;
			const existing = cache.objects[manifestKey];
			console.log(existing ? `  manifest: reuse ${existing.id}` : "  manifest: new (file paths or aliases changed)");
		} else console.log("  manifest: generated after the pending uploads");
		console.log("\n--dry-run: nothing uploaded.");
		process.exit(0);
	}

	const { turbo, description, usesApproval } = createUploadClient();
	const effectivePaidBy = usesApproval ? paidBy : undefined;

	const { winc, effectiveBalance, receivedApprovals } = await turbo.getBalance();
	console.log(`\nUpload signer  : ${description}`);
	console.log(`Own balance    : ${(Number(winc) / 1e12).toFixed(6)} credits`);
	if (usesApproval)
		console.log(`Effective      : ${(Number(effectiveBalance) / 1e12).toFixed(6)} credits (incl. shared)`);
	if (effectivePaidBy && receivedApprovals.length === 0)
		console.warn(
			`\nWARNING: TURBO_PAID_BY is set to ${effectivePaidBy} but this wallet has received no ` +
				"credit-share approvals. The paying wallet must grant one first, or uploads will be rejected.\n",
		);
	if (paidBy && !usesApproval)
		console.log("TURBO_PAID_BY ignored — the keyfile pays for its own uploads.");

	const baseTags = [{ name: "App-Name", value: appName }];
	const errors: { file: string; message: string }[] = [];
	let done = 0;

	if (pending.length > 0) {
		console.log("");
		await pool(pending, CONCURRENCY, async (file) => {
			try {
				const response = await turbo.uploadFile({
					fileStreamFactory: () => createReadStream(file.absolute),
					fileSizeFactory: () => file.size,
					dataItemOpts: {
						...(effectivePaidBy ? { paidBy: [effectivePaidBy] } : {}),
						tags: [{ name: "Content-Type", value: file.contentType }, ...baseTags],
					},
				});
				cache.objects[file.objectKey] = { id: response.id, size: file.size, contentType: file.contentType };
				// Persist immediately so a mid-run failure never re-charges for this file.
				await saveCache(cache);
				console.log(`  [${++done}/${pending.length}] ${file.relativePath}`);
			} catch (error) {
				errors.push({ file: file.relativePath, message: (error as Error).message });
				console.error(`  [${++done}/${pending.length}] FAILED ${file.relativePath}: ${(error as Error).message}`);
			}
		});
	}

	if (errors.length > 0)
		throw new Error(
			`${errors.length} file(s) failed to upload — manifest NOT created. ` +
				"Successful uploads are cached; re-run to retry only the failures.",
		);

	const manifestJson = JSON.stringify(buildManifest(planned, cache));
	const manifestContentType = MANIFEST_TYPE;
	const manifestKey = `manifest:${hashText(manifestJson)}:${manifestContentType}`;

	let manifestEntry = cache.objects[manifestKey];
	if (manifestEntry) {
		console.log(`\nReusing unchanged manifest: ${manifestEntry.id}`);
	} else {
		console.log("\nUploading new Arweave manifest");
		const response = await turbo.upload({
			data: manifestJson,
			dataItemOpts: {
				...(effectivePaidBy ? { paidBy: [effectivePaidBy] } : {}),
				tags: [
					{ name: "Content-Type", value: manifestContentType },
					...baseTags,
					{ name: "App-Version", value: process.env.GITHUB_SHA?.trim() || new Date().toISOString() },
				],
			},
		});
		manifestEntry = { id: response.id, size: Buffer.byteLength(manifestJson), contentType: manifestContentType };
		cache.objects[manifestKey] = manifestEntry;
		await saveCache(cache);
	}

	return manifestEntry.id;
}

async function updateEnsContentHash(manifestTransactionId: string): Promise<void> {
	const rpcUrl = requireEnv("ETH_RPC_URL");
	const ensName = process.env.ENS_NAME?.trim() || "arisaka.eth";
	const normalizedName = normalize(ensName);
	const account = privateKeyToAccount(getPrivateKey());

	const publicClient = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
	const walletClient = createWalletClient({ account, chain: mainnet, transport: http(rpcUrl) });

	const chainId = await publicClient.getChainId();
	if (chainId !== 1) throw new Error(`ETH_RPC_URL is not Ethereum Mainnet; returned chain ID ${chainId}`);

	const resolverAddress = await publicClient.getEnsResolver({ name: normalizedName });
	const resolverAbi = parseAbi([
		"function supportsInterface(bytes4 interfaceID) view returns (bool)",
		"function contenthash(bytes32 node) view returns (bytes)",
		"function setContenthash(bytes32 node, bytes hash)",
	]);

	const supportsContentHash = await publicClient.readContract({
		address: resolverAddress,
		abi: resolverAbi,
		functionName: "supportsInterface",
		args: ["0xbc1c58d1"],
	});
	if (!supportsContentHash)
		throw new Error(`Resolver ${resolverAddress} does not support ENS contenthash`);

	const node = namehash(normalizedName);
	// @ensdomains/content-hash returns hex without the 0x prefix.
	const encodedContentHash = `0x${encode("arweave", manifestTransactionId)}` as Hex;

	const currentContentHash = await publicClient.readContract({
		address: resolverAddress,
		abi: resolverAbi,
		functionName: "contenthash",
		args: [node],
	});

	if (currentContentHash.toLowerCase() === encodedContentHash.toLowerCase()) {
		console.log(`ENS contenthash already points at ar://${manifestTransactionId} — no transaction sent.`);
		return;
	}

	console.log(`\nUpdating ${ensName}`);
	console.log(`  resolver : ${resolverAddress}`);
	console.log(`  signer   : ${account.address}`);
	console.log(`  new value: ar://${manifestTransactionId}`);

	let request: Parameters<typeof walletClient.writeContract>[0];
	try {
		({ request } = await publicClient.simulateContract({
			account,
			address: resolverAddress,
			abi: resolverAbi,
			functionName: "setContenthash",
			args: [node, encodedContentHash],
		}));
	} catch (error) {
		throw new Error(
			`ENS update simulation failed — the deploy wallet ${account.address} is probably not authorised to edit ${ensName}.`,
			{ cause: error },
		);
	}

	const hash = await walletClient.writeContract(request);
	console.log(`  tx sent  : ${hash}`);
	const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
	if (receipt.status !== "success") throw new Error(`ENS transaction reverted: ${hash}`);
	console.log(`  confirmed in block ${receipt.blockNumber}`);
}

async function main(): Promise<void> {
	const manifestTransactionId = await uploadWebsite();
	const ensName = process.env.ENS_NAME?.trim() || "arisaka.eth";

	console.log("");
	console.log("=".repeat(64));
	console.log(`Manifest TX ID : ${manifestTransactionId}`);
	console.log(`Preview        : https://turbo-gateway.com/${manifestTransactionId}`);

	if (skipEns) {
		console.log("\n--skip-ens: set this as the ENS Content Hash yourself:");
		console.log(`  ar://${manifestTransactionId}`);
	} else {
		await updateEnsContentHash(manifestTransactionId);
		console.log(`\nLive at        : https://${ensName}.limo`);
	}
	console.log("=".repeat(64));
}

main().catch((error: unknown) => {
	console.error(`\n${error instanceof Error ? error.message : String(error)}`);
	if (error instanceof Error && error.cause) console.error(error.cause);
	process.exitCode = 1;
});
