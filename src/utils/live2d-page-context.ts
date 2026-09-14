export type PublicPageContext = { title: string; path: string; text: string };
export type PageSnapshot = { page: PublicPageContext | null; key: string; protected: boolean };

// Read only the public main content already rendered in this page. Never fetch
// URLs, inspect browser storage, or read an encrypted article (even after unlock).
export function readPublicPage(): PageSnapshot {
	const path = window.location.pathname.slice(0, 500);
	const main = document.querySelector("main");
	if (!main) return { page: null, key: path, protected: false };
	if (main.querySelector("[data-encrypted-article], [data-decrypted-article]")) {
		return { page: null, key: path, protected: true };
	}
	const source = main.querySelector(".custom-md") ?? main;
	const content = source.cloneNode(true) as HTMLElement;
	for (const node of content.querySelectorAll(
		"script, style, noscript, template, nav, aside, footer, form, input, textarea, button, " +
		"[contenteditable], [hidden], [aria-hidden='true'], [data-pagefind-ignore], " +
		"[data-encrypted-article], [data-decrypted-article], .waline-wrapper, #waline, #comments, " +
		".anchor, .copy-button, svg, canvas, iframe, video, audio",
	)) node.remove();
	// Preserve block boundaries instead of merging adjacent headings and paragraphs.
	for (const node of content.querySelectorAll("h1,h2,h3,h4,p,li,pre,article,section,br")) node.append("\n");
	const text = (content.textContent ?? "").replace(/[\t\r ]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 4000);
	const title = (main.querySelector('[data-pagefind-meta="title"], h1')?.textContent?.trim() || document.title).slice(0, 160);
	if (!text) return { page: null, key: path, protected: false };
	const page = { title, path, text };
	return { page, key: JSON.stringify(page), protected: false };
}
