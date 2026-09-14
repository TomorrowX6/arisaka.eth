import { setTimeout as pause } from "node:timers/promises";

export const ENS_CONFIRMATION_TIMEOUT_MS = 10 * 60_000;

async function observeEns(clients, readRequest, hash) {
	const observations = await Promise.allSettled(
		clients.map(async (client) => {
			const [chainId, blockNumber] = await Promise.all([
				client.getChainId(),
				client.getBlockNumber({ cacheTime: 0 }),
			]);
			if (chainId !== 1)
				throw new Error("ENS confirmation requires Ethereum Mainnet");
			const [record, receipt] = await Promise.allSettled([
				client.readContract({ ...readRequest, blockNumber }),
				hash ? client.getTransactionReceipt({ hash }) : Promise.resolve(null),
			]);
			return {
				blockNumber,
				contenthash: record.status === "fulfilled" ? record.value : undefined,
				receipt: receipt.status === "fulfilled" ? receipt.value : undefined,
			};
		}),
	);
	return observations
		.filter((result) => result.status === "fulfilled")
		.map((result) => result.value);
}

const matches = (actual, expected) =>
	typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase();

// Compare records at explicit block heights so a lagging RPC cannot make an old
// target look current after it has been replaced by a newer deployment.
function newestRecords(observations) {
	const newest = observations.reduce(
		(height, entry) =>
			entry.blockNumber > height ? entry.blockNumber : height,
		-1n,
	);
	return observations.filter(
		(entry) =>
			entry.blockNumber === newest && typeof entry.contenthash === "string",
	);
}

// Check every configured reader before sending: the write RPC can lag behind a
// transaction already confirmed elsewhere, especially after a workflow retry.
export async function ensTargetIsCurrent({
	clients,
	readRequest,
	expectedContentHash,
}) {
	const observations = await observeEns(clients, readRequest);
	const latest = newestRecords(observations);
	if (!latest.length) {
		throw new Error(
			"Cannot read ENS contenthash from a Mainnet RPC; no transaction was sent.",
		);
	}
	const matching = latest.filter((entry) =>
		matches(entry.contenthash, expectedContentHash),
	);
	if (matching.length && matching.length !== latest.length) {
		throw new Error(
			"Mainnet RPCs disagree about the latest ENS contenthash; no transaction was sent.",
		);
	}
	return matching.length === latest.length;
}

export async function requireNoPendingTransactions(client, address) {
	const [confirmed, pending] = await Promise.all([
		client.getTransactionCount({ address, blockTag: "latest" }),
		client.getTransactionCount({ address, blockTag: "pending" }),
	]);
	if (pending > confirmed) {
		throw new Error(
			`Deploy wallet ${address} has an unconfirmed transaction; wait for it before sending another ENS update.`,
		);
	}
}

// Readers never sign or rebroadcast. A receipt proves inclusion; observing the
// desired record also handles an equivalent replacement transaction whose hash
// differs from the original. Unavailable and non-Mainnet readers cannot succeed.
export async function confirmEnsUpdate({
	clients,
	readRequest,
	expectedContentHash,
	hash,
	timeoutMs = ENS_CONFIRMATION_TIMEOUT_MS,
	pollingIntervalMs = 5_000,
	now = Date.now,
	sleep = pause,
	onPending = () => {},
}) {
	const started = now();
	while (true) {
		const observations = await observeEns(clients, readRequest, hash);
		const reverted = observations.find(
			(entry) => entry.receipt?.status === "reverted",
		);
		if (reverted) throw new Error(`ENS transaction reverted: ${hash}`);
		const confirmed = observations.find(
			(entry) => entry.receipt?.status === "success",
		);
		const latest = newestRecords(observations);
		if (confirmed) {
			if (
				latest.some(
					(entry) =>
						entry.blockNumber >= confirmed.receipt.blockNumber &&
						!matches(entry.contenthash, expectedContentHash),
				)
			) {
				throw new Error(
					`ENS transaction ${hash} was mined, but the latest contenthash differs from the requested manifest.`,
				);
			}
			return { via: "receipt", receipt: confirmed.receipt };
		}
		if (
			latest.length &&
			latest.every((entry) => matches(entry.contenthash, expectedContentHash))
		)
			return { via: "record" };
		const remaining = timeoutMs - (now() - started);
		if (remaining <= 0) {
			throw new Error(
				`Unable to confirm ENS transaction ${hash} within ${timeoutMs / 1000}s. It may still confirm; uploaded files and the manifest remain cached.`,
			);
		}
		onPending({ elapsedMs: now() - started, hash });
		await sleep(Math.min(pollingIntervalMs, remaining));
	}
}
