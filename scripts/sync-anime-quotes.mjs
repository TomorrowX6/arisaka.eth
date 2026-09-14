// SPDX-License-Identifier: AGPL-3.0-only
// Rebuild the attributed quote selection from a pinned Hitokoto snapshot.
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repository = "hitokoto-osc/sentences-bundle";
const revision = "e92f39455e28fb893651ff67c938ee1465f0aa21";
const root = new URL("../", import.meta.url);
const preferences = JSON.parse(await readFile(new URL("src/data/anime-quote-preferences.json", root), "utf8"));
const normalize = (text) => text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
const rules = preferences.priorities.map((rule) => ({ ...rule, sources: rule.sources.map((alias) => {
  const key = normalize(alias);
  // Short Latin names need word boundaries: AIR must not match Fairy gone.
  const word = /^[a-z0-9]{2,4}$/.test(key)
    ? new RegExp(`(?:^|[^a-z0-9])${[...key].join("[\\s\\p{P}]*")}(?:$|[^a-z0-9])`, "iu")
    : null;
  return { key, word };
}) }));
const categories = ["a", "b", "c"];
const downloads = await Promise.all([...categories.map((key) => `sentences/${key}.json`), "LICENSE"].map(async (path) => {
  const response = await fetch(`https://raw.githubusercontent.com/${repository}/${revision}/${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return [path, await response.text()];
}));
const files = new Map(downloads);
const unique = new Map();
const rawCounts = {};
for (const category of categories) {
  const rows = JSON.parse(files.get(`sentences/${category}.json`));
  if (!Array.isArray(rows)) throw new Error(`Invalid category ${category}`);
  rawCounts[category] = rows.length;
  for (const row of rows) {
    if (typeof row.hitokoto !== "string" || typeof row.from !== "string" || !Number.isInteger(row.id)) continue;
    const text = row.hitokoto.trim().replace(/\s+/gu, " ");
    const source = row.from.trim().replace(/\s+/gu, " ");
    if (text.length < 4 || text.length > 60 || !source || source.length > 40 ||
      `「${text}」——《${source}》`.length > 100 || /<[^>]+>|https?:\/\//u.test(text) ||
      /^(原创|网络|未知|其他|无|一言|佚名)$/u.test(source)) continue;
    const sourceKey = normalize(source);
    const matching = rules.filter((rule) => rule.sources.some((alias) => alias.word ? alias.word.test(source.normalize("NFKC")) : sourceKey.includes(alias.key)));
    // Include visual novels and adapted games only when they match the user's
    // preferred works; general game quotes do not fill the anime collection.
    if (category === "c" && !matching.length) continue;
    const themes = matching.map((rule) => rule.theme);
    const weight = 1 + matching.reduce((sum, rule) => sum + rule.weight, 0);
    const emotion = /眼泪|流泪|哭泣|悲伤|寂寞|孤独|再见|离别|失去|遗憾/u.test(text) ? "sad" :
      /笑|幸福|喜欢|爱|温柔|希望|朋友|明天|美好/u.test(text) ? "happy" : "idle";
    const quote = { id: `${category}:${row.id}`, text, source,
      ...(typeof row.from_who === "string" && row.from_who.trim() ? { speaker: row.from_who.trim() } : {}),
      themes, weight, emotion };
    const key = normalize(text);
    const existing = unique.get(key);
    if (key.length >= 3 && (!existing || weight > existing.weight)) unique.set(key, quote);
  }
}
const quotes = [...unique.values()].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id, "en", { numeric: true }));
if (quotes.length < 1001) throw new Error(`Expected over 1,000 distinct short quotes; got ${quotes.length}`);
const version = createHash("sha256").update(JSON.stringify(quotes)).digest("hex").slice(0, 16);
const data = { version, source: { repository, revision, license: "AGPL-3.0-only" }, quotes };
const counts = {
  total: quotes.length,
  preferred: quotes.filter((quote) => quote.themes.length).length,
  sources: new Set(quotes.map((quote) => quote.source)).size,
  themes: Object.fromEntries(rules.map((rule) => [rule.theme, quotes.filter((quote) => quote.themes.includes(rule.theme)).length])),
  categories: Object.fromEntries(categories.map((category) => [category, quotes.filter((quote) => quote.id.startsWith(`${category}:`)).length])),
  rawCounts,
};
await mkdir(new URL("src/data", root), { recursive: true });
await writeFile(new URL("src/data/anime-quotes.json", root), JSON.stringify(data, null, 2) + "\n");
await writeFile(new URL("src/data/anime-quotes.LICENSE", root), files.get("LICENSE"));
await writeFile(new URL("src/data/anime-quotes.provenance.json", root), JSON.stringify({
  repository: `https://github.com/${repository}`, revision, version,
  sourceFiles: categories.map((category) => `https://github.com/${repository}/blob/${revision}/sentences/${category}.json`),
  license: "AGPL-3.0-only", counts,
  selection: "Anime and manga, plus matching visual novels; attributed text of 4–60 characters, deduplicated without truncation. Preference tags are editorial priorities for this blog; source attribution is retained from the community dataset.",
}, null, 2) + "\n");
console.log(JSON.stringify({ output: fileURLToPath(new URL("src/data/anime-quotes.json", root)), version, ...counts }, null, 2));
