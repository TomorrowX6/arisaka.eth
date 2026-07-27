/// <reference types="mdast" />
import { h } from "hastscript";

/**
 * Groups a hex fingerprint into blocks of four, the way Tuta prints it.
 *
 * @param {string} value - The raw hex string.
 * @returns {string} The grouped fingerprint.
 */
function groupFingerprint(value) {
	const hex = value.replace(/\s+/g, "");
	return (hex.match(/.{1,4}/g) ?? [hex]).join(" ");
}

/**
 * Creates a Tuta identity card, mirroring the verification details Tuta shows
 * for a mailbox so readers can check they are writing to the right person.
 *
 * @param {Object} properties - The properties of the component.
 * @param {string} properties.email - The Tuta address.
 * @param {string} properties.fingerprint - The identity key fingerprint (hex).
 * @param {string} [properties.algo] - Key algorithm label. Defaults to "Ed25519".
 * @param {string} [properties.version] - Identity version label. Defaults to "v0".
 * @param {import('mdast').RootContent[]} children - The children elements of the component.
 * @returns {import('mdast').Parent} The created Tuta Card component.
 */
export function TutaCardComponent(properties, children) {
	if (Array.isArray(children) && children.length !== 0)
		return h("div", { class: "hidden" }, [
			'Invalid directive. ("tuta" directive must be leaf type "::tuta{email="name@tuta.com" fingerprint="..."}")',
		]);

	if (!properties.email || !properties.email.includes("@"))
		return h(
			"div",
			{ class: "hidden" },
			'Invalid Tuta card. ("email" attribute must be like "name@tuta.com")',
		);

	if (!properties.fingerprint)
		return h(
			"div",
			{ class: "hidden" },
			'Invalid Tuta card. ("fingerprint" attribute is required)',
		);

	const email = properties.email;
	const algo = properties.algo || "Ed25519";
	const version = properties.version || "v0";
	const fingerprint = properties.fingerprint.replace(/\s+/g, "");

	// The card is a plain container rather than one big link: the fingerprint
	// needs its own click target, and nesting a button inside an anchor is not
	// valid markup.
	const nTitle = h("div", { class: "gc-titlebar" }, [
		h("div", { class: "gc-titlebar-left" }, [
			h("div", { class: "gc-owner" }, [
				h("a", { class: "gc-repo no-styling", href: `mailto:${email}` }, email),
			]),
		]),
		h("div", { class: "tuta-titlebar-right" }, [
			h("button", {
				type: "button",
				class: "tuta-copy",
				"data-copy": fingerprint,
				"aria-label": "Copy fingerprint",
				title: "Copy fingerprint",
			}),
			h("div", { class: "tuta-logo" }),
		]),
	]);

	const nFingerprint = h(
		"button",
		{
			type: "button",
			class: "gc-description pgp-fingerprint tuta-fingerprint",
			"data-copy": fingerprint,
			"aria-label": "Copy fingerprint",
			title: "Copy fingerprint",
		},
		groupFingerprint(fingerprint),
	);

	const infoItems = [
		h("div", { class: "tuta-version" }, `${version}, via ${algo}`),
	];

	return h("div", { class: "card-tuta" }, [
		nTitle,
		nFingerprint,
		h("div", { class: "gc-infobar" }, infoItems),
	]);
}
