import { scryptAsync } from "@noble/hashes/scrypt";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const PROTOCOL_DOMAIN = "fuwari.article-encryption";
const AES_ALGORITHM = "AES-256-GCM";
const GCM_TAG_LENGTH = 128;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const DEK_LENGTH = 32;
const WRAPPED_DEK_LENGTH = DEK_LENGTH + GCM_TAG_LENGTH / 8;
const MAX_CONTENT_LENGTH = 16 * 1024 * 1024 + GCM_TAG_LENGTH / 8;
const MAX_SCRYPT_MEMORY = 192 * 1024 * 1024;
const BASE64_PATTERN =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const ARTICLE_ENCRYPTION_VERSION = 1 as const;

export const ARTICLE_SCRYPT_PARAMETERS = {
	name: "scrypt",
	N: 2 ** 17,
	r: 8,
	p: 1,
	dkLen: 32,
} as const;

export interface ArticleEncryptionEnvelope {
	v: typeof ARTICLE_ENCRYPTION_VERSION;
	kdf: {
		name: typeof ARTICLE_SCRYPT_PARAMETERS.name;
		salt: string;
		N: typeof ARTICLE_SCRYPT_PARAMETERS.N;
		r: typeof ARTICLE_SCRYPT_PARAMETERS.r;
		p: typeof ARTICLE_SCRYPT_PARAMETERS.p;
		dkLen: typeof ARTICLE_SCRYPT_PARAMETERS.dkLen;
	};
	keyWrap: {
		name: typeof AES_ALGORITHM;
		iv: string;
		wrappedDek: string;
		tagLength: typeof GCM_TAG_LENGTH;
	};
	content: {
		name: typeof AES_ALGORITHM;
		iv: string;
		ciphertext: string;
		tagLength: typeof GCM_TAG_LENGTH;
	};
}

type EnvelopePurpose = "content" | "key-wrap";
type JsonRecord = Record<string, unknown>;

function getWebCrypto(): Crypto {
	if (!globalThis.crypto?.subtle) {
		throw new Error("Web Crypto is required for article encryption");
	}
	return globalThis.crypto;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return new Uint8Array(bytes).buffer as ArrayBuffer;
}

function randomBytes(length: number): Uint8Array {
	return getWebCrypto().getRandomValues(new Uint8Array(length));
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(
			...bytes.subarray(offset, offset + chunkSize),
		);
	}
	return btoa(binary);
}

function base64ToBytes(
	value: string,
	label: string,
	maxLength: number,
): Uint8Array {
	if (
		value.length % 4 !== 0 ||
		!BASE64_PATTERN.test(value) ||
		(value.length / 4) * 3 > maxLength + 2
	) {
		throw new Error(`Invalid ${label}`);
	}

	let binary: string;
	try {
		binary = atob(value);
	} catch {
		throw new Error(`Invalid ${label}`);
	}

	if (binary.length > maxLength) {
		throw new Error(`Invalid ${label}`);
	}

	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}

	if (bytesToBase64(bytes) !== value) {
		throw new Error(`Invalid ${label}`);
	}
	return bytes;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonRecord, keys: string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
}

function assertEnvelope(
	value: unknown,
): asserts value is ArticleEncryptionEnvelope {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["v", "kdf", "keyWrap", "content"])
	) {
		throw new Error("Invalid article encryption envelope");
	}
	if (value.v !== ARTICLE_ENCRYPTION_VERSION) {
		throw new Error("Unsupported article encryption version");
	}

	const { kdf, keyWrap, content } = value;
	if (
		!isRecord(kdf) ||
		!hasOnlyKeys(kdf, ["name", "salt", "N", "r", "p", "dkLen"]) ||
		kdf.name !== ARTICLE_SCRYPT_PARAMETERS.name ||
		kdf.N !== ARTICLE_SCRYPT_PARAMETERS.N ||
		kdf.r !== ARTICLE_SCRYPT_PARAMETERS.r ||
		kdf.p !== ARTICLE_SCRYPT_PARAMETERS.p ||
		kdf.dkLen !== ARTICLE_SCRYPT_PARAMETERS.dkLen ||
		typeof kdf.salt !== "string"
	) {
		throw new Error("Invalid article encryption KDF");
	}
	if (
		!isRecord(keyWrap) ||
		!hasOnlyKeys(keyWrap, ["name", "iv", "wrappedDek", "tagLength"]) ||
		keyWrap.name !== AES_ALGORITHM ||
		keyWrap.tagLength !== GCM_TAG_LENGTH ||
		typeof keyWrap.iv !== "string" ||
		typeof keyWrap.wrappedDek !== "string"
	) {
		throw new Error("Invalid article key wrapper");
	}
	if (
		!isRecord(content) ||
		!hasOnlyKeys(content, ["name", "iv", "ciphertext", "tagLength"]) ||
		content.name !== AES_ALGORITHM ||
		content.tagLength !== GCM_TAG_LENGTH ||
		typeof content.iv !== "string" ||
		typeof content.ciphertext !== "string"
	) {
		throw new Error("Invalid encrypted article content");
	}

	if (
		base64ToBytes(kdf.salt, "scrypt salt", SALT_LENGTH).length !== SALT_LENGTH
	) {
		throw new Error("Invalid scrypt salt length");
	}
	if (
		base64ToBytes(keyWrap.iv, "key-wrap IV", IV_LENGTH).length !== IV_LENGTH
	) {
		throw new Error("Invalid key-wrap IV length");
	}
	if (
		base64ToBytes(keyWrap.wrappedDek, "wrapped DEK", WRAPPED_DEK_LENGTH)
			.length !== WRAPPED_DEK_LENGTH
	) {
		throw new Error("Invalid wrapped DEK length");
	}
	if (base64ToBytes(content.iv, "content IV", IV_LENGTH).length !== IV_LENGTH) {
		throw new Error("Invalid content IV length");
	}
	if (
		base64ToBytes(content.ciphertext, "article ciphertext", MAX_CONTENT_LENGTH)
			.length <
		GCM_TAG_LENGTH / 8
	) {
		throw new Error("Invalid article ciphertext length");
	}
}

function makeAdditionalData(
	envelope: ArticleEncryptionEnvelope,
	slug: string,
	purpose: EnvelopePurpose,
): Uint8Array {
	return encoder.encode(
		[
			PROTOCOL_DOMAIN,
			String(envelope.v),
			slug,
			purpose,
			envelope.kdf.name,
			String(envelope.kdf.N),
			String(envelope.kdf.r),
			String(envelope.kdf.p),
			String(envelope.kdf.dkLen),
			envelope.kdf.salt,
			envelope.keyWrap.name,
			String(envelope.keyWrap.tagLength),
			envelope.content.name,
			String(envelope.content.tagLength),
		].join("\0"),
	);
}

async function deriveKek(
	password: string,
	salt: Uint8Array,
): Promise<Uint8Array> {
	const passwordBytes = encoder.encode(password);
	try {
		return await scryptAsync(passwordBytes, salt, {
			N: ARTICLE_SCRYPT_PARAMETERS.N,
			r: ARTICLE_SCRYPT_PARAMETERS.r,
			p: ARTICLE_SCRYPT_PARAMETERS.p,
			dkLen: ARTICLE_SCRYPT_PARAMETERS.dkLen,
			asyncTick: 16,
			maxmem: MAX_SCRYPT_MEMORY,
		});
	} finally {
		passwordBytes.fill(0);
	}
}

async function aesGcmEncrypt(
	rawKey: Uint8Array,
	iv: Uint8Array,
	plaintext: Uint8Array,
	additionalData: Uint8Array,
): Promise<Uint8Array> {
	const crypto = getWebCrypto();
	const key = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(rawKey),
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt"],
	);
	const result = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: toArrayBuffer(iv),
			additionalData: toArrayBuffer(additionalData),
			tagLength: GCM_TAG_LENGTH,
		},
		key,
		toArrayBuffer(plaintext),
	);
	return new Uint8Array(result);
}

async function aesGcmDecrypt(
	rawKey: Uint8Array,
	iv: Uint8Array,
	ciphertext: Uint8Array,
	additionalData: Uint8Array,
): Promise<Uint8Array> {
	const crypto = getWebCrypto();
	const key = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(rawKey),
		{ name: "AES-GCM", length: 256 },
		false,
		["decrypt"],
	);
	const result = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: toArrayBuffer(iv),
			additionalData: toArrayBuffer(additionalData),
			tagLength: GCM_TAG_LENGTH,
		},
		key,
		toArrayBuffer(ciphertext),
	);
	return new Uint8Array(result);
}

function validateInputs(password: string, slug: string): void {
	if (password.length === 0) {
		throw new Error("Article encryption password cannot be empty");
	}
	if (slug.length === 0 || slug.length > 1024) {
		throw new Error("Article slug is invalid");
	}
}

export async function encryptArticleContent(
	html: string,
	password: string,
	slug: string,
): Promise<ArticleEncryptionEnvelope> {
	validateInputs(password, slug);

	const salt = randomBytes(SALT_LENGTH);
	const wrapIv = randomBytes(IV_LENGTH);
	const contentIv = randomBytes(IV_LENGTH);
	const dek = randomBytes(DEK_LENGTH);
	const plaintext = encoder.encode(html);
	let kek: Uint8Array | undefined;

	const envelope: ArticleEncryptionEnvelope = {
		v: ARTICLE_ENCRYPTION_VERSION,
		kdf: {
			...ARTICLE_SCRYPT_PARAMETERS,
			salt: bytesToBase64(salt),
		},
		keyWrap: {
			name: AES_ALGORITHM,
			iv: bytesToBase64(wrapIv),
			wrappedDek: "",
			tagLength: GCM_TAG_LENGTH,
		},
		content: {
			name: AES_ALGORITHM,
			iv: bytesToBase64(contentIv),
			ciphertext: "",
			tagLength: GCM_TAG_LENGTH,
		},
	};

	try {
		kek = await deriveKek(password, salt);
		const wrappedDek = await aesGcmEncrypt(
			kek,
			wrapIv,
			dek,
			makeAdditionalData(envelope, slug, "key-wrap"),
		);
		const ciphertext = await aesGcmEncrypt(
			dek,
			contentIv,
			plaintext,
			makeAdditionalData(envelope, slug, "content"),
		);
		envelope.keyWrap.wrappedDek = bytesToBase64(wrappedDek);
		envelope.content.ciphertext = bytesToBase64(ciphertext);
		assertEnvelope(envelope);
		return envelope;
	} finally {
		kek?.fill(0);
		dek.fill(0);
		plaintext.fill(0);
	}
}

export async function decryptArticleContent(
	envelope: ArticleEncryptionEnvelope,
	password: string,
	slug: string,
): Promise<string> {
	validateInputs(password, slug);
	assertEnvelope(envelope);

	const salt = base64ToBytes(envelope.kdf.salt, "scrypt salt", SALT_LENGTH);
	const wrapIv = base64ToBytes(envelope.keyWrap.iv, "key-wrap IV", IV_LENGTH);
	const wrappedDek = base64ToBytes(
		envelope.keyWrap.wrappedDek,
		"wrapped DEK",
		WRAPPED_DEK_LENGTH,
	);
	const contentIv = base64ToBytes(envelope.content.iv, "content IV", IV_LENGTH);
	const ciphertext = base64ToBytes(
		envelope.content.ciphertext,
		"article ciphertext",
		MAX_CONTENT_LENGTH,
	);
	let kek: Uint8Array | undefined;
	let dek: Uint8Array | undefined;
	let plaintext: Uint8Array | undefined;

	try {
		kek = await deriveKek(password, salt);
		dek = await aesGcmDecrypt(
			kek,
			wrapIv,
			wrappedDek,
			makeAdditionalData(envelope, slug, "key-wrap"),
		);
		if (dek.length !== DEK_LENGTH) {
			throw new Error("Invalid decrypted article key");
		}
		plaintext = await aesGcmDecrypt(
			dek,
			contentIv,
			ciphertext,
			makeAdditionalData(envelope, slug, "content"),
		);
		return decoder.decode(plaintext);
	} finally {
		kek?.fill(0);
		dek?.fill(0);
		plaintext?.fill(0);
	}
}

export function parseArticleEncryptionEnvelope(
	serialized: string,
): ArticleEncryptionEnvelope {
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new Error("Invalid article encryption envelope");
	}
	assertEnvelope(value);
	return value;
}

export function serializeArticleEncryptionEnvelope(
	envelope: ArticleEncryptionEnvelope,
): string {
	assertEnvelope(envelope);
	return JSON.stringify(envelope);
}
