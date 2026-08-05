import assert from "node:assert/strict";
import test from "node:test";
import { resolveArticlePassword } from "../src/utils/article-password.server";

test("does not resolve credentials for a plain post", () => {
	assert.equal(
		resolveArticlePassword(
			{ encrypted: false, password: "unused", passwordEnv: "UNUSED_SECRET" },
			"plain-post",
			{},
		),
		undefined,
	);
});

test("resolves exactly one inline or private environment password", () => {
	assert.equal(
		resolveArticlePassword(
			{ encrypted: true, password: "inline secret" },
			"inline-post",
			{},
		),
		"inline secret",
	);
	assert.equal(
		resolveArticlePassword(
			{ encrypted: true, passwordEnv: "ARTICLE_PASSWORD" },
			"environment-post",
			{ ARTICLE_PASSWORD: "  environment secret  " },
		),
		"  environment secret  ",
	);
});

test("fails closed for missing, ambiguous, or public credentials", () => {
	assert.throws(() =>
		resolveArticlePassword({ encrypted: true }, "missing-post", {}),
	);
	assert.throws(() =>
		resolveArticlePassword(
			{ encrypted: true, password: "inline", passwordEnv: "ARTICLE_PASSWORD" },
			"ambiguous-post",
			{ ARTICLE_PASSWORD: "environment" },
		),
	);
	assert.throws(() =>
		resolveArticlePassword(
			{ encrypted: true, passwordEnv: "ARTICLE_PASSWORD" },
			"missing-environment-post",
			{},
		),
	);
	assert.throws(() =>
		resolveArticlePassword(
			{ encrypted: true, passwordEnv: "PUBLIC_ARTICLE_PASSWORD" },
			"public-environment-post",
			{ PUBLIC_ARTICLE_PASSWORD: "unsafe" },
		),
	);
	assert.throws(() =>
		resolveArticlePassword(
			{ encrypted: true, passwordEnv: "lowercase-name" },
			"invalid-environment-post",
			{ "lowercase-name": "unsafe" },
		),
	);
});
