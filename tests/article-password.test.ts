import assert from "node:assert/strict";
import test from "node:test";
import { resolveArticlePassword } from "../src/utils/article-password.server";

const lookup =
	(environment: Readonly<Record<string, string | undefined>>) =>
	(name: string) =>
		environment[name];

test("does not resolve credentials for a plain post", () => {
	assert.equal(
		resolveArticlePassword(
			{ encrypted: false, password: "unused", passwordEnv: "UNUSED_SECRET" },
			"plain-post",
			lookup({}),
		),
		undefined,
	);
});

test("resolves exactly one inline or private environment password", () => {
	assert.equal(
		resolveArticlePassword(
			{ encrypted: true, password: "inline secret" },
			"inline-post",
			lookup({}),
		),
		"inline secret",
	);
	let requestedName: string | undefined;
	assert.equal(
		resolveArticlePassword(
			{ encrypted: true, passwordEnv: "ARTICLE_PASSWORD" },
			"environment-post",
			(name) => {
				requestedName = name;
				return name === "ARTICLE_PASSWORD"
					? "  environment secret  "
					: undefined;
			},
		),
		"  environment secret  ",
	);
	assert.equal(requestedName, "ARTICLE_PASSWORD");
});

test("fails closed for missing, ambiguous, or public credentials", () => {
	assert.throws(() =>
		resolveArticlePassword({ encrypted: true }, "missing-post", lookup({})),
	);
	assert.throws(() =>
		resolveArticlePassword(
			{ encrypted: true, password: "inline", passwordEnv: "ARTICLE_PASSWORD" },
			"ambiguous-post",
			lookup({ ARTICLE_PASSWORD: "environment" }),
		),
	);
	assert.throws(() =>
		resolveArticlePassword(
			{ encrypted: true, passwordEnv: "ARTICLE_PASSWORD" },
			"missing-environment-post",
			lookup({}),
		),
	);
	assert.throws(() =>
		resolveArticlePassword(
			{ encrypted: true, passwordEnv: "PUBLIC_ARTICLE_PASSWORD" },
			"public-environment-post",
			lookup({ PUBLIC_ARTICLE_PASSWORD: "unsafe" }),
		),
	);
	assert.throws(() =>
		resolveArticlePassword(
			{ encrypted: true, passwordEnv: "lowercase-name" },
			"invalid-environment-post",
			lookup({ "lowercase-name": "unsafe" }),
		),
	);
});
