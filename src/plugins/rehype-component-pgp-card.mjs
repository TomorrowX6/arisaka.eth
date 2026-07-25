/// <reference types="mdast" />
import { h } from "hastscript";

/**
 * Creates a PGP Key Card component.
 *
 * @param {Object} properties - The properties of the component.
 * @param {string} properties.fingerprint - The PGP key fingerprint.
 * @param {string} [properties.key] - URL of the ASCII-armored public key file. Defaults to "/pubkey.asc".
 * @param {string} [properties.algo] - Key algorithm label, e.g. "Ed25519". Optional.
 * @param {import('mdast').RootContent[]} children - The children elements of the component.
 * @returns {import('mdast').Parent} The created PGP Card component.
 */
export function PgpCardComponent(properties, children) {
	if (Array.isArray(children) && children.length !== 0)
		return h("div", { class: "hidden" }, [
			'Invalid directive. ("pgp" directive must be leaf type "::pgp{fingerprint="XXXX ..."}")',
		]);

	if (!properties.fingerprint)
		return h(
			"div",
			{ class: "hidden" },
			'Invalid PGP card. ("fingerprint" attributte is required)',
		);

	const fingerprint = properties.fingerprint;
	const keyUrl = properties.key || "/pubkey.asc";
	const fileName = keyUrl.split("/").pop();

	const nTitle = h("div", { class: "gc-titlebar" }, [
		h("div", { class: "gc-titlebar-left" }, [
			h("div", { class: "gc-owner" }, [
				h("div", { class: "gc-repo" }, "PGP Public Key"),
			]),
		]),
		h("div", { class: "pgp-logo" }),
	]);

	const nFingerprint = h(
		"div",
		{ class: "gc-description pgp-fingerprint" },
		fingerprint,
	);

	const infoItems = [];
	if (properties.algo)
		infoItems.push(h("div", { class: "pgp-algo" }, properties.algo));
	infoItems.push(h("div", { class: "pgp-download" }, fileName));

	return h(
		"a",
		{
			class: "card-pgp no-styling",
			href: keyUrl,
			target: "_blank",
		},
		[nTitle, nFingerprint, h("div", { class: "gc-infobar" }, infoItems)],
	);
}
