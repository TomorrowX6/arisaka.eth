import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decryptTerminalText, terminalEntrance } from "../src/utils/terminal-crypto";

function seal(plaintext: string, password: string): string {
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const key = pbkdf2Sync(password, salt, 600_000, 32, "sha256");
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const content = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	return ["v1", "600000", salt.toString("base64url"), iv.toString("base64url"), content.toString("base64url")].join(".");
}

test("the original terminal artifacts decrypt to the current entrance", async () => {
	const midi = readFileSync(new URL("../public/README/README.mid", import.meta.url));
	const passwords = midi.toString("latin1").match(/[A-Za-z0-9]{20}/g) || [];
	assert.equal(passwords.length, 1);
	const envelope = readFileSync(new URL("../public/README/README.md", import.meta.url), "utf8");
	const plaintext = await decryptTerminalText(envelope, passwords[0]);
	const deployment = JSON.parse(readFileSync(new URL("../src/data/ctf-deployment.json", import.meta.url), "utf8"));
	assert.equal(plaintext, `/${deployment.entrance}/`);
	assert.match(plaintext, /^\/[a-z0-9]{20}\/$/);
	assert.equal(terminalEntrance(plaintext), plaintext);
});

test("wrong passwords and modified ciphertext fail authentication", async () => {
	const envelope = seal("private text", "local-test-password");
	assert.equal(await decryptTerminalText(envelope, "local-test-password"), "private text");
	await assert.rejects(decryptTerminalText(envelope, "wrong-password"));
	const fields = envelope.split(".");
	const ciphertext = Buffer.from(fields[4], "base64url");
	ciphertext[0] ^= 1;
	fields[4] = ciphertext.toString("base64url");
	await assert.rejects(decryptTerminalText(fields.join("."), "local-test-password"));
});

test("invalid envelopes are rejected before key derivation", async () => {
	for (const envelope of [
		"v2.600000.salt.iv.ciphertext",
		"v1.999999999.salt.iv.ciphertext",
		"v1.600000.a.b.c",
		"a".repeat(16_385),
	]) {
		await assert.rejects(decryptTerminalText(envelope, "password"));
	}
});

test("decryption can only create a local entrance link", () => {
	const valid = "/" + "a".repeat(20) + "/";
	assert.equal(terminalEntrance(valid), valid);
	for (const value of [
		"/ctf/",
		"//example.com/" + valid,
		"https://example.com" + valid,
		"javascript:alert(1)",
		valid + "&redirect=https://example.com",
	]) {
		assert.equal(terminalEntrance(value), null);
	}
});
