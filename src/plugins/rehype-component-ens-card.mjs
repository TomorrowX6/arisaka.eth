/// <reference types="mdast" />
import { h } from "hastscript";

/**
 * Creates an ENS Card component.
 *
 * @param {Object} properties - The properties of the component.
 * @param {string} properties.name - The ENS name, e.g. "example.eth".
 * @param {import('mdast').RootContent[]} children - The children elements of the component.
 * @returns {import('mdast').Parent} The created ENS Card component.
 */
export function EnsCardComponent(properties, children) {
	if (Array.isArray(children) && children.length !== 0)
		return h("div", { class: "hidden" }, [
			'Invalid directive. ("ens" directive must be leaf type "::ens{name="example.eth"}")',
		]);

	if (!properties.name || !properties.name.includes("."))
		return h(
			"div",
			{ class: "hidden" },
			'Invalid ENS name. ("name" attributte must be like "example.eth")',
		);

	const name = properties.name;
	const cardUuid = `EC${Math.random().toString(36).slice(-6)}`; // Collisions are not important

	const nAvatar = h(`div#${cardUuid}-avatar`, { class: "gc-avatar" });

	const nTitle = h("div", { class: "gc-titlebar" }, [
		h("div", { class: "gc-titlebar-left" }, [
			h("div", { class: "gc-owner" }, [
				nAvatar,
				h("div", { class: "gc-repo" }, name),
			]),
		]),
		h("div", { class: "ens-logo" }),
	]);

	const nDescription = h(
		`div#${cardUuid}-description`,
		{ class: "gc-description" },
		"Waiting for enstate.rs...",
	);

	const nAddress = h(
		`div#${cardUuid}-address`,
		{ class: "ec-address" },
		"0x0000...0000",
	);
	const nNetwork = h("div", { class: "ec-network" }, "Ethereum");

	const nScript = h(
		`script#${cardUuid}-script`,
		{ type: "text/javascript", defer: true },
		`
      fetch('https://enstate.rs/n/${name}', { referrerPolicy: "no-referrer" }).then(response => response.json()).then(data => {
        document.getElementById('${cardUuid}-description').innerText = data.records?.description || "Ethereum Name Service";
        document.getElementById('${cardUuid}-address').innerText = data.address ? data.address.slice(0, 6) + '...' + data.address.slice(-4) : "No address";
        if (data.avatar) {
          const avatarEl = document.getElementById('${cardUuid}-avatar');
          avatarEl.style.backgroundImage = 'url(' + data.avatar + ')';
          avatarEl.style.backgroundColor = 'transparent';
        }
        document.getElementById('${cardUuid}-card').classList.remove("fetch-waiting");
        console.log("[ENS-CARD] Loaded card for ${name} | ${cardUuid}.")
      }).catch(err => {
        const c = document.getElementById('${cardUuid}-card');
        c?.classList.remove("fetch-waiting");
        c?.classList.add("fetch-error");
        const desc = document.getElementById('${cardUuid}-description');
        if (desc) desc.innerText = "Ethereum Name Service";
        const addr = document.getElementById('${cardUuid}-address');
        if (addr) addr.innerText = "${name}";
        console.warn("[ENS-CARD] (Error) Loading card for ${name} | ${cardUuid}.")
      })
    `,
	);

	return h(
		`a#${cardUuid}-card`,
		{
			class: "card-ens fetch-waiting no-styling",
			href: `https://app.ens.domains/${name}`,
			target: "_blank",
			name,
		},
		[
			nTitle,
			nDescription,
			h("div", { class: "gc-infobar" }, [nAddress, nNetwork]),
			nScript,
		],
	);
}
