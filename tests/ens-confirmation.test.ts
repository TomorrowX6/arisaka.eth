import assert from "node:assert/strict";
import test from "node:test";
import {
	confirmEnsUpdate,
	ensTargetIsCurrent,
	requireNoPendingTransactions,
} from "../scripts/lib/ens-confirmation.mjs";

const hash = `0x${"ab".repeat(32)}`;
const expectedContentHash = "0x90b2ca05abcd";
const readRequest = {
	address: "0xresolver",
	functionName: "contenthash",
	args: ["0xnode"],
};
const unavailable = async () => {
	throw new Error("RPC unavailable or transaction not found");
};
const reader = (overrides = {}) => ({
	getChainId: async () => 1,
	getBlockNumber: async () => 100n,
	readContract: async () => "0x00",
	getTransactionReceipt: unavailable,
	getTransactionCount: async () => 0,
	...overrides,
});
function timer() {
	let time = 0;
	return {
		now: () => time,
		sleep: async (ms: number) => {
			time += ms;
		},
	};
}
const options = { readRequest, expectedContentHash, hash };

test("a retry sees the already-updated ENS record even when the primary RPC lags", async () => {
	const stale = reader({ getBlockNumber: async () => 99n });
	const current = reader({
		readContract: async (request: { blockNumber: bigint }) => {
			assert.equal(request.blockNumber, 100n);
			return expectedContentHash.toUpperCase();
		},
	});
	assert.equal(
		await ensTargetIsCurrent({ ...options, clients: [stale, current] }),
		true,
	);
});

test("an old matching record cannot override a newer different record", async () => {
	const stale = reader({
		getBlockNumber: async () => 99n,
		readContract: async () => expectedContentHash,
	});
	assert.equal(
		await ensTargetIsCurrent({ ...options, clients: [stale, reader()] }),
		false,
	);
});

test("unavailable or conflicting readers cannot authorize another ENS write", async () => {
	await assert.rejects(
		ensTargetIsCurrent({
			...options,
			clients: [reader({ readContract: unavailable })],
		}),
		/Cannot read ENS/,
	);
	await assert.rejects(
		ensTargetIsCurrent({
			...options,
			clients: [
				reader(),
				reader({ readContract: async () => expectedContentHash }),
			],
		}),
		/RPCs disagree/,
	);
	await assert.rejects(
		ensTargetIsCurrent({
			...options,
			clients: [
				reader({
					getChainId: async () => 11155111,
					readContract: async () => expectedContentHash,
				}),
			],
		}),
		/Mainnet/,
	);
});

test("confirmation can arrive after the old three-minute timeout", async () => {
	const clock = timer();
	const client = reader({
		getBlockNumber: async () => (clock.now() >= 240_000 ? 101n : 100n),
		readContract: async () =>
			clock.now() >= 240_000 ? expectedContentHash : "0x00",
		getTransactionReceipt: async () => {
			if (clock.now() < 240_000) return unavailable();
			return { status: "success", blockNumber: 101n, transactionHash: hash };
		},
	});
	const result = await confirmEnsUpdate({
		...options,
		clients: [client],
		...clock,
		pollingIntervalMs: 60_000,
	});
	assert.equal(clock.now(), 240_000);
	assert.equal(result.via, "receipt");
	assert.equal(result.receipt.transactionHash, hash);
});

test("a healthy fallback confirms a receipt while the primary RPC is unavailable", async () => {
	const receipt = {
		status: "success",
		blockNumber: 100n,
		transactionHash: hash,
	};
	const result = await confirmEnsUpdate({
		...options,
		clients: [
			reader({ getChainId: unavailable }),
			reader({
				readContract: async () => expectedContentHash,
				getTransactionReceipt: async () => receipt,
			}),
		],
	});
	assert.deepEqual(result, { via: "receipt", receipt });
});

test("an applied replacement update succeeds even if the original receipt remains missing", async () => {
	const result = await confirmEnsUpdate({
		...options,
		clients: [
			reader({ getBlockNumber: async () => 99n }),
			reader({ readContract: async () => expectedContentHash }),
		],
	});
	assert.deepEqual(result, { via: "record" });
});

test("a reverted transaction remains a failure even if another update set the target", async () => {
	await assert.rejects(
		confirmEnsUpdate({
			...options,
			clients: [
				reader({
					readContract: async () => expectedContentHash,
					getTransactionReceipt: async () => ({
						status: "reverted",
						blockNumber: 100n,
					}),
				}),
			],
		}),
		/ENS transaction reverted/,
	);
});

test("a mined transaction does not hide a newer conflicting ENS update", async () => {
	await assert.rejects(
		confirmEnsUpdate({
			...options,
			clients: [
				reader({
					getTransactionReceipt: async () => ({
						status: "success",
						blockNumber: 99n,
					}),
				}),
			],
		}),
		/latest contenthash differs/,
	);
});

test("pending transactions time out explicitly and keep the existing transaction hash", async () => {
	const clock = timer();
	await assert.rejects(
		confirmEnsUpdate({
			...options,
			clients: [reader()],
			...clock,
			timeoutMs: 20,
			pollingIntervalMs: 5,
		}),
		(error: Error) =>
			error.message.includes(hash) && error.message.includes("remain cached"),
	);
	assert.equal(clock.now(), 20);
});

test("a receipt or matching record on another chain cannot confirm a Mainnet deployment", async () => {
	const clock = timer();
	await assert.rejects(
		confirmEnsUpdate({
			...options,
			...clock,
			timeoutMs: 10,
			pollingIntervalMs: 5,
			clients: [
				reader({
					getChainId: async () => 11155111,
					readContract: async () => expectedContentHash,
					getTransactionReceipt: async () => ({
						status: "success",
						blockNumber: 100n,
					}),
				}),
			],
		}),
		/Unable to confirm ENS transaction/,
	);
});

test("rerunning while the wallet still has pending transactions cannot send another update", async () => {
	const address = "0xdeploywallet";
	await assert.rejects(
		requireNoPendingTransactions(
			reader({
				getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
					blockTag === "pending" ? 42 : 41,
			}),
			address,
		),
		/has an unconfirmed transaction/,
	);
	await assert.doesNotReject(
		requireNoPendingTransactions(
			reader({ getTransactionCount: async () => 42 }),
			address,
		),
	);
	await assert.rejects(
		requireNoPendingTransactions(
			reader({ getTransactionCount: unavailable }),
			address,
		),
		/RPC unavailable/,
	);
});
