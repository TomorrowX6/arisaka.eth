const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ITERATIONS = 600_000;

function decode(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid envelope");
	const bytes = Uint8Array.from(
		atob(value.replaceAll("-", "+").replaceAll("_", "/")),
		(character) => character.charCodeAt(0),
	);
	return bytes;
}

export async function decryptTerminalText(
	envelope: string,
	password: string,
): Promise<string> {
	if (envelope.length > 16_384 || !password || password.length > 1_024) {
		throw new Error("Invalid envelope");
	}
	const parts = envelope.trim().split(".");
	if (parts.length !== 5 || parts[0] !== "v1" || parts[1] !== String(ITERATIONS)) {
		throw new Error("Invalid envelope");
	}
	const salt = decode(parts[2]);
	const iv = decode(parts[3]);
	const ciphertext = decode(parts[4]);
	if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) {
		throw new Error("Invalid envelope");
	}
	const material = await crypto.subtle.importKey(
		"raw",
		encoder.encode(password),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	const key = await crypto.subtle.deriveKey(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["decrypt"],
	);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv, tagLength: 128 },
		key,
		ciphertext,
	);
	return decoder.decode(plaintext);
}

export function terminalEntrance(text: string): string | null {
	const value = text.trim();
	return /^\/[a-z0-9]{20}\/$/.test(value) ? value : null;
}
