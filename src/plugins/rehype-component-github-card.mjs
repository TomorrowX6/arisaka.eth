/// <reference types="mdast" />
import { h } from "hastscript";

/**
 * Creates a GitHub Card component.
 *
 * @param {Object} properties - The properties of the component.
 * @param {string} properties.repo - The GitHub repository in the format "owner/repo".
 * @param {import('mdast').RootContent[]} children - The children elements of the component.
 * @returns {import('mdast').Parent} The created GitHub Card component.
 */
export function GithubCardComponent(properties, children) {
	if (Array.isArray(children) && children.length !== 0)
		return h("div", { class: "hidden" }, [
			'Invalid directive. ("github" directive must be leaf type "::github{repo="owner/repo"}")',
		]);

	if (!properties.repo || !properties.repo.includes("/"))
		return h(
			"div",
			{ class: "hidden" },
			'Invalid repository. ("repo" attributte must be in the format "owner/repo")',
		);

	const repo = properties.repo;

	const nAvatar = h("div", { class: "gc-avatar", "data-card-field": "avatar" });
	const nLanguage = h(
		"span",
		{ class: "gc-language", "data-card-field": "language" },
		"Waiting...",
	);

	const nTitle = h("div", { class: "gc-titlebar" }, [
		h("div", { class: "gc-titlebar-left" }, [
			h("div", { class: "gc-owner" }, [
				nAvatar,
				h("div", { class: "gc-user" }, repo.split("/")[0]),
			]),
			h("div", { class: "gc-divider" }, "/"),
			h("div", { class: "gc-repo" }, repo.split("/")[1]),
		]),
		h("div", { class: "github-logo" }),
	]);

	const nDescription = h(
		"div",
		{ class: "gc-description", "data-card-field": "description" },
		"Waiting for api.github.com...",
	);

	const nStars = h("div", { class: "gc-stars", "data-card-field": "stars" }, "00K");
	const nForks = h("div", { class: "gc-forks", "data-card-field": "forks" }, "0K");
	const nLicense = h("div", { class: "gc-license", "data-card-field": "license" }, "0K");

	const nScript = h(
		"script",
		{ type: "text/javascript", defer: true },
		`
      (() => {
        const card = document.currentScript?.closest('a.card-github');
        if (!card) return;
        const field = (name) => card.querySelector('[data-card-field="' + name + '"]');

        fetch('https://api.github.com/repos/${repo}', { referrerPolicy: "no-referrer" }).then(response => response.json()).then(data => {
          const descriptionEl = field('description');
          if (descriptionEl) descriptionEl.innerText = data.description?.replace(/:[a-zA-Z0-9_]+:/g, '') || "Description not set";
          const languageEl = field('language');
          if (languageEl) languageEl.innerText = data.language;
          const forksEl = field('forks');
          if (forksEl) forksEl.innerText = Intl.NumberFormat('en-us', { notation: "compact", maximumFractionDigits: 1 }).format(data.forks).replaceAll("\u202f", '');
          const starsEl = field('stars');
          if (starsEl) starsEl.innerText = Intl.NumberFormat('en-us', { notation: "compact", maximumFractionDigits: 1 }).format(data.stargazers_count).replaceAll("\u202f", '');
          const avatarEl = field('avatar');
          if (avatarEl) {
            avatarEl.style.backgroundImage = 'url(' + data.owner.avatar_url + ')';
            avatarEl.style.backgroundColor = 'transparent';
          }
          const licenseEl = field('license');
          if (licenseEl) licenseEl.innerText = data.license?.spdx_id || "no-license";
          card.classList.remove("fetch-waiting");
          console.log("[GITHUB-CARD] Loaded card for ${repo}.");
        }).catch(err => {
          card.classList.add("fetch-error");
          console.warn("[GITHUB-CARD] (Error) Loading card for ${repo}.");
        });
      })();
    `,
	);

	return h(
		"a",
		{
			class: "card-github fetch-waiting no-styling",
			href: `https://github.com/${repo}`,
			target: "_blank",
			repo,
		},
		[
			nTitle,
			nDescription,
			h("div", { class: "gc-infobar" }, [nStars, nForks, nLicense, nLanguage]),
			nScript,
		],
	);
}
