// Deterministic BIP39 mnemonic -> Arweave RSA-4096 JWK.
//
// Matches arweave-mnemonic-keys (human-crypto-keys, PRIMEINC, pkcs1-pem), but
// calls getKeyPairFromSeed directly: human-crypto-keys' own
// getKeyPairFromMnemonic does `new Uint8Array(seedBuffer.buffer)`, which on
// modern Node returns the whole shared Buffer pool instead of the 64 seed
// bytes, making its output non-deterministic. Passing the seed ourselves fixes
// that.
//
// Verified against the arweave-mnemonic-keys published test vector:
//   "jewel cave spy act loyal solid night manual joy select mystery unhappy"
//     -> qe741op_rt-iwBazAqJipTc15X8INlDCoPz6S40RBdg

import { createHash, createPrivateKey } from "node:crypto";
import { mnemonicToSeed } from "bip39";
import pkg from "human-crypto-keys";

const { getKeyPairFromSeed } = pkg;

/** Arweave address = base64url(SHA-256(raw RSA modulus)) */
export function jwkToAddress(jwk) {
	const modulus = Buffer.from(jwk.n, "base64url");
	return createHash("sha256").update(modulus).digest("base64url");
}

export async function mnemonicToJwk(mnemonic) {
	const seedBuffer = await mnemonicToSeed(mnemonic);
	// Copy the 64 seed bytes; do NOT hand over seedBuffer.buffer (pooled).
	const seed = Uint8Array.from(seedBuffer);

	const { privateKey } = await getKeyPairFromSeed(
		seed,
		{ id: "rsa", modulusLength: 4096 },
		{ privateKeyFormat: "pkcs1-pem" },
	);

	const jwk = createPrivateKey(privateKey).export({ format: "jwk" });
	// Arweave keyfiles carry only the raw RSA parameters.
	for (const field of ["alg", "key_ops", "ext"]) delete jwk[field];
	return jwk;
}
