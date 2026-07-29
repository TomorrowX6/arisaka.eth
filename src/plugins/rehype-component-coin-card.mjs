/// <reference types="mdast" />
import { h } from "hastscript";

/**
 * Creates a Coin Card component for the CTF challenge coin.
 *
 * Deliberately vector-only: the SVG pair is ~12 kB, while the GLB models are
 * 5.6 MB each and every file in the build is written to Arweave permanently.
 * The 3D versions live off-site, behind the marketplace link.
 *
 * @param {Object} properties - The properties of the component.
 * @param {string} properties.collection - OpenSea collection slug, e.g. "arisaka-eth".
 * @param {string} properties.contract - ERC-721 contract address.
 * @param {string} [properties.name] - Display name of the coin.
 * @param {string} [properties.edition] - Mintage, e.g. "3".
 * @param {import('mdast').RootContent[]} children - The children elements of the component.
 * @returns {import('mdast').Parent} The created Coin Card component.
 */
export function CoinCardComponent(properties, children) {
	if (Array.isArray(children) && children.length !== 0)
		return h("div", { class: "hidden" }, [
			'Invalid directive. ("coin" directive must be leaf type "::coin{collection="slug"}")',
		]);

	if (!properties.collection || properties.collection.includes("/"))
		return h(
			"div",
			{ class: "hidden" },
			'Invalid collection. ("collection" attribute must be an OpenSea slug like "arisaka-eth")',
		);

	if (!/^0x[0-9a-fA-F]{40}$/.test(properties.contract || ""))
		return h(
			"div",
			{ class: "hidden" },
			'Invalid contract. ("contract" attribute must be a 0x-prefixed 20-byte address)',
		);

	const collection = properties.collection;
	const contract = properties.contract;
	const name = properties.name || "CTF Challenge Coin";
	const edition = properties.edition || "3";
	const cardUuid = `CC${Math.random().toString(36).slice(-6)}`;

	const nCoin = h("div", { class: "coin-stage" }, [
		h("div", { class: "coin-flip" }, [
			h("img", {
				class: "coin-face coin-obverse",
				src: "/coin/obverse.svg",
				alt: `${name} obverse`,
				width: 240,
				height: 240,
				loading: "lazy",
				decoding: "async",
			}),
			h("img", {
				class: "coin-face coin-reverse",
				src: "/coin/reverse.svg",
				alt: "",
				"aria-hidden": "true",
				width: 240,
				height: 240,
				loading: "lazy",
				decoding: "async",
			}),
		]),
	]);

	const nTitle = h("div", { class: "gc-titlebar" }, [
		h("div", { class: "gc-titlebar-left" }, [
			h("div", { class: "gc-repo" }, name),
		]),
		h("div", { class: "coin-logo" }),
	]);

	const nDescription = h("div", { class: "gc-description" }, [
		"ERC721 ",
		h("span", { class: "coin-address" }, contract),
	]);

	const nBody = h("div", { class: "coin-body" }, [
		nTitle,
		nDescription,
		h("div", { class: "gc-infobar" }, [
			h("div", { class: "coin-edition" }, `限量 ${edition} 枚`),
			h("div", { class: "coin-market" }, "OpenSea"),
		]),
	]);

	return h(
		`a#${cardUuid}-card`,
		{
			class: "card-coin no-styling",
			href: `https://opensea.io/collection/${collection}`,
			target: "_blank",
			rel: "noopener noreferrer",
		},
		[nCoin, nBody],
	);
}
