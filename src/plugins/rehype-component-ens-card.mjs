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

	const nAvatar = h("div", { class: "gc-avatar", "data-card-field": "avatar" });

	const nTitle = h("div", { class: "gc-titlebar" }, [
		h("div", { class: "gc-titlebar-left" }, [
			h("div", { class: "gc-owner" }, [
				nAvatar,
				h("div", { class: "gc-repo" }, name),
			]),
		]),
		h("div", { class: "ens-logo" }),
	]);

	const nDescription = h("div", { class: "gc-description", "data-card-field": "description" }, "Waiting for enstate.rs...");
	const nAddress = h("div", { class: "ec-address", "data-card-field": "address" }, "0x0000...0000");
	const nNetwork = h("div", { class: "ec-network" }, "Ethereum");

	const nScript = h(
		"script",
		{ type: "text/javascript", defer: true },
		`
      (() => {
        const card = document.currentScript?.closest('a.card-ens');
        if (!card) return;
        const field = (name) => card.querySelector('[data-card-field="' + name + '"]');

        fetch('https://enstate.rs/n/${name}', { referrerPolicy: "no-referrer" }).then(response => response.json()).then(data => {
          const descriptionEl = field('description');
          if (descriptionEl) descriptionEl.innerText = data.records?.description || "Ethereum Name Service";
          const addressEl = field('address');
          if (addressEl) addressEl.innerText = data.address ? data.address.slice(0, 6) + '...' + data.address.slice(-4) : "No address";
          const avatarEl = field('avatar');
          if (avatarEl && data.avatar) {
            avatarEl.style.backgroundImage = 'url(' + data.avatar + ')';
            avatarEl.style.backgroundColor = 'transparent';
          }
          card.classList.remove("fetch-waiting");
        }).catch(() => {
          card.classList.remove("fetch-waiting");
          card.classList.add("fetch-error");
        });
      })();
    `,
	);

	return h(
		"a",
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
