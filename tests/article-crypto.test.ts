import assert from "node:assert/strict";
import test from "node:test";
import {
	ARTICLE_SCRYPT_PARAMETERS,
	decryptArticleContent,
	encryptArticleContent,
	parseArticleEncryptionEnvelope,
	serializeArticleEncryptionEnvelope,
	type ArticleEncryptionEnvelope,
} from "../src/utils/article-crypto";

const password = "正しい horse battery staple 🔐";
const slug = "private/秘密-notes";
const plaintext =
	'<section><h2 id="secret-heading">SECRET_BODY_CANARY 秘密</h2></section>';

let firstEnvelope: Promise<ArticleEncryptionEnvelope> | undefined;
let secondEnvelope: Promise<ArticleEncryptionEnvelope> | undefined;

function getFirstEnvelope(): Promise<ArticleEncryptionEnvelope> {
	firstEnvelope ??= encryptArticleContent(plaintext, password, slug);
	return firstEnvelope;
}

function getSecondEnvelope(): Promise<ArticleEncryptionEnvelope> {
	secondEnvelope ??= encryptArticleContent(plaintext, password, slug);
	return secondEnvelope;
}

function cloneEnvelope(
	envelope: ArticleEncryptionEnvelope,
): ArticleEncryptionEnvelope {
	return structuredClone(envelope);
}

function flipFirstByte(value: string): string {
	const bytes = Buffer.from(value, "base64");
	bytes[0] ^= 1;
	return bytes.toString("base64");
}

test("encrypts through a random scrypt KEK and per-build wrapped DEK", async () => {
	const first = await getFirstEnvelope();
	const second = await getSecondEnvelope();
	const serialized = serializeArticleEncryptionEnvelope(first);

	assert.deepEqual(
		{
			name: first.kdf.name,
			N: first.kdf.N,
			r: first.kdf.r,
			p: first.kdf.p,
			dkLen: first.kdf.dkLen,
		},
		ARTICLE_SCRYPT_PARAMETERS,
	);
	assert.equal(Buffer.from(first.kdf.salt, "base64").length, 16);
	assert.equal(Buffer.from(first.keyWrap.iv, "base64").length, 12);
	assert.equal(Buffer.from(first.keyWrap.wrappedDek, "base64").length, 48);
	assert.equal(Buffer.from(first.content.iv, "base64").length, 12);
	assert.notEqual(first.kdf.salt, second.kdf.salt);
	assert.notEqual(first.keyWrap.wrappedDek, second.keyWrap.wrappedDek);
	assert.notEqual(first.content.ciphertext, second.content.ciphertext);
	assert.equal(serialized.includes(password), false);
	assert.equal(serialized.includes("SECRET_BODY_CANARY"), false);
	assert.equal(await decryptArticleContent(first, password, slug), plaintext);
});

test("rejects a wrong password and a swapped slug", async () => {
	const envelope = await getFirstEnvelope();
	await assert.rejects(() =>
		decryptArticleContent(envelope, "wrong password", slug),
	);
	await assert.rejects(() =>
		decryptArticleContent(envelope, password, "another-post"),
	);
});

test("authenticates both the wrapped DEK and article ciphertext", async () => {
	const envelope = await getFirstEnvelope();
	const damagedWrappedKey = cloneEnvelope(envelope);
	damagedWrappedKey.keyWrap.wrappedDek = flipFirstByte(
		damagedWrappedKey.keyWrap.wrappedDek,
	);
	await assert.rejects(() =>
		decryptArticleContent(damagedWrappedKey, password, slug),
	);

	const damagedContent = cloneEnvelope(envelope);
	damagedContent.content.ciphertext = flipFirstByte(
		damagedContent.content.ciphertext,
	);
	await assert.rejects(() =>
		decryptArticleContent(damagedContent, password, slug),
	);
});

test("strictly rejects malformed or attacker-controlled envelope headers", async () => {
	const envelope = await getFirstEnvelope();
	const excessiveKdf = cloneEnvelope(envelope) as unknown as Record<
		string,
		unknown
	>;
	(excessiveKdf.kdf as Record<string, unknown>).N = 2 ** 22;
	assert.throws(() =>
		parseArticleEncryptionEnvelope(JSON.stringify(excessiveKdf)),
	);

	const malformedSalt = cloneEnvelope(envelope);
	malformedSalt.kdf.salt = "not/base64";
	assert.throws(() =>
		parseArticleEncryptionEnvelope(JSON.stringify(malformedSalt)),
	);

	const extraHeader = {
		...cloneEnvelope(envelope),
		passwordVerifier: "unsafe",
	};
	assert.throws(() =>
		parseArticleEncryptionEnvelope(JSON.stringify(extraHeader)),
	);
	assert.throws(() => parseArticleEncryptionEnvelope("not json"));
});
