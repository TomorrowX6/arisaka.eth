/**
 * Grant (or revoke) a deploy wallet permission to edit one ENS name's records.
 *
 *   npx tsx scripts/grant-ens-delegate.ts <delegate-address>
 *   npx tsx scripts/grant-ens-delegate.ts <delegate-address> --revoke
 *
 * This calls approve(node, delegate, true) on the resolver, which authorises the
 * delegate for THIS NAME ONLY. It does not transfer ownership and gives no
 * access to funds, other names, or anything else in the owner's wallet — so the
 * delegate's key is safe to put in CI secrets while the owner key never leaves
 * your machine.
 *
 * Signs with OWNER_PRIVATE_KEY (or ETH_PRIVATE_KEY) from the environment or an
 * env file passed with --env-file.
 */

import { existsSync } from "node:fs";
import * as dotenv from "dotenv";
import { type Hex, createPublicClient, createWalletClient, http, isAddress, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { namehash, normalize } from "viem/ens";

const argv = process.argv.slice(2);
const revoke = argv.includes("--revoke");

const envIndex = argv.indexOf("--env-file");
if (envIndex !== -1) {
	const envPath = argv[envIndex + 1];
	if (!envPath || !existsSync(envPath)) {
		console.error(`--env-file requires an existing path (got: ${envPath ?? "nothing"})`);
		process.exit(1);
	}
	dotenv.config({ path: envPath });
}
dotenv.config({ path: ".env.permaweb" });

const delegate = argv.find((a) => a.startsWith("0x") && a.length === 42);
if (!delegate || !isAddress(delegate)) {
	console.error("Usage: npx tsx scripts/grant-ens-delegate.ts <delegate-address> [--revoke] [--env-file <path>]");
	process.exit(1);
}

const rawKey = (process.env.OWNER_PRIVATE_KEY ?? process.env.ETH_PRIVATE_KEY)?.trim();
if (!rawKey) {
	console.error("Set OWNER_PRIVATE_KEY (or ETH_PRIVATE_KEY) — the wallet that owns the name.");
	process.exit(1);
}
const ownerKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;

const ensName = process.env.ENS_NAME?.trim() || "arisaka.eth";
const rpcUrl = process.env.ETH_RPC_URL?.trim() || "https://ethereum-rpc.publicnode.com";

const account = privateKeyToAccount(ownerKey);
const publicClient = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: mainnet, transport: http(rpcUrl) });

const normalized = normalize(ensName);
const node = namehash(normalized);
const resolverAddress = await publicClient.getEnsResolver({ name: normalized });

const abi = parseAbi([
	"function approve(bytes32 node, address delegate, bool approved)",
	"function isApprovedFor(address owner, bytes32 node, address delegate) view returns (bool)",
]);

const already = await publicClient.readContract({
	address: resolverAddress,
	abi,
	functionName: "isApprovedFor",
	args: [account.address, node, delegate],
});

console.log(`name     : ${ensName}`);
console.log(`resolver : ${resolverAddress}`);
console.log(`owner    : ${account.address}`);
console.log(`delegate : ${delegate}`);
console.log(`current  : ${already ? "approved" : "not approved"}`);

if (already === !revoke) {
	console.log(`\nAlready ${revoke ? "revoked" : "approved"} — no transaction sent.`);
	process.exit(0);
}

const { request } = await publicClient.simulateContract({
	account,
	address: resolverAddress,
	abi,
	functionName: "approve",
	args: [node, delegate, !revoke],
});

const hash = await walletClient.writeContract(request);
console.log(`\ntx sent  : ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
if (receipt.status !== "success") {
	console.error(`Transaction reverted: ${hash}`);
	process.exit(1);
}
console.log(`confirmed in block ${receipt.blockNumber}`);
console.log(`\n${delegate} can now ${revoke ? "NO LONGER edit" : "edit"} ${ensName} records.`);
