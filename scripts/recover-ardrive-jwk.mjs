/**
 * Recover the ArDrive Ethereum-derived Arweave keyfile (JWK) locally.
 *
 *   node scripts/recover-ardrive-jwk.mjs
 *
 * Requires two secrets, read from the environment (never from argv, so they do
 * not land in shell history):
 *
 *   ETH_PRIVATE_KEY   the MetaMask account used to sign in to ArDrive
 *   ARDRIVE_PASSWORD  the password entered when that ArDrive wallet was created
 *
 * Optional:
 *   EXPECTED_AR_ADDRESS  the Arweave address that must be reproduced
 *                        (defaults to the address holding the credits)
 *   OUT_FILE             where to write the keyfile on success (default wallet.json)
 *
 * The derivation is:
 *   "1:<eth address>:<password>"  ->  SHA-256  ->  hex text
 *     ->  personal_sign with the ETH key
 *     ->  SHA-256  ->  first 16 bytes
 *     ->  BIP39 12-word mnemonic
 *     ->  deterministic RSA-4096  ->  Arweave JWK
 *
 * Several details of that chain are ambiguous (address casing, whether the
 * signature is hashed as bytes or as its hex text), so every combination is
 * tried and each candidate is checked against EXPECTED_AR_ADDRESS. Nothing is
 * written unless an address matches exactly. Secrets are never printed.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { entropyToMnemonic } from "bip39";
import { privateKeyToAccount } from "viem/accounts";
import { jwkToAddress, mnemonicToJwk } from "./lib/mnemonic-to-jwk.mjs";

const EXPECTED = (process.env.EXPECTED_AR_ADDRESS || "GIUxkB51Pye3CpBm3dGYV5wTBTMNRSJs2hsrFU8J5Fc").trim();
const OUT_FILE = (process.env.OUT_FILE || "wallet.json").trim();

const privateKeyRaw = process.env.ETH_PRIVATE_KEY?.trim();
const password = process.env.ARDRIVE_PASSWORD;

if (!privateKeyRaw || !password) {
	console.error(
		"Set both secrets in the environment first, for example (PowerShell):\n" +
			'  $env:ETH_PRIVATE_KEY = "0x..."\n' +
			'  $env:ARDRIVE_PASSWORD = "your ArDrive password"\n' +
			"  node scripts/recover-ardrive-jwk.mjs\n\n" +
			"Close the shell afterwards so the values do not linger.",
	);
	process.exit(1);
}
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKeyRaw)) {
	console.error("ETH_PRIVATE_KEY must be 64 hex characters, optionally 0x-prefixed.");
	process.exit(1);
}

const privateKey = privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`;
const account = privateKeyToAccount(privateKey);

const sha256 = (data) => createHash("sha256").update(data).digest();

console.log(`Signing account : ${account.address}`);
console.log(`Target address  : ${EXPECTED}`);
console.log("");

/**
 * Message variants. ArDrive builds "<chainId>:<address>:<password>", but the
 * address casing is not pinned down, so try both forms.
 */
const messageVariants = [
	{ label: "address lowercase", address: account.address.toLowerCase() },
	{ label: "address checksummed", address: account.address },
];

/** How the signature is fed into the second hash. */
const digestVariants = [
	{ label: "signature as bytes", toDigestInput: (sig) => Buffer.from(sig.slice(2), "hex") },
	{ label: "signature as hex text", toDigestInput: (sig) => Buffer.from(sig, "utf8") },
	{ label: "signature as hex text, no 0x", toDigestInput: (sig) => Buffer.from(sig.slice(2), "utf8") },
];

let attempt = 0;
const total = messageVariants.length * digestVariants.length;

for (const messageVariant of messageVariants) {
	const preimage = `1:${messageVariant.address}:${password}`;
	// The signed message is the SHA-256 of the preimage rendered as hex text.
	const signedMessage = sha256(preimage).toString("hex");
	const signature = await account.signMessage({ message: signedMessage });

	for (const digestVariant of digestVariants) {
		attempt += 1;
		const label = `${messageVariant.label} + ${digestVariant.label}`;
		process.stdout.write(`[${attempt}/${total}] ${label} ... deriving RSA-4096 (~45s) `);

		const entropy = sha256(digestVariant.toDigestInput(signature)).subarray(0, 16);
		const mnemonic = entropyToMnemonic(entropy.toString("hex"));

		const started = Date.now();
		let address;
		try {
			address = jwkToAddress(await mnemonicToJwk(mnemonic));
		} catch (error) {
			console.log(`failed: ${error.message}`);
			continue;
		}
		const seconds = ((Date.now() - started) / 1000).toFixed(0);

		if (address === EXPECTED) {
			// Re-derive so the matching key, not a stale one, is what gets written.
			const jwk = await mnemonicToJwk(mnemonic);
			writeFileSync(OUT_FILE, JSON.stringify(jwk));
			console.log(`MATCH (${seconds}s)`);
			console.log("");
			console.log("=".repeat(64));
			console.log(`Recovered ${EXPECTED}`);
			console.log(`Keyfile written to ${OUT_FILE}`);
			console.log("");
			console.log("This file is the full private key for that wallet. It is gitignored;");
			console.log("keep it off shared drives and out of any backup you do not control.");
			console.log("=".repeat(64));
			process.exit(0);
		}

		console.log(`no match (${seconds}s) -> ${address.slice(0, 12)}...`);
	}
}

console.log("");
console.log("No variant reproduced the target address. Nothing was written.");
console.log("");
console.log("Most likely causes, in order:");
console.log("  1. The ArDrive password differs from the one used when the wallet was created.");
console.log("  2. A different MetaMask account was used to sign in to ArDrive.");
console.log("  3. ArDrive's mnemonic->RSA step differs from the arweave-mnemonic-keys algorithm used here.");
console.log("");
console.log("Causes 1 and 2 are worth retrying with different inputs; cause 3 is not fixable from here.");
process.exit(1);
