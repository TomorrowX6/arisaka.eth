import assert from "node:assert/strict";
import test from "node:test";
import dataset from "../src/data/anime-quotes.json";
import provenance from "../src/data/anime-quotes.provenance.json";
import { ANIME_QUOTE_CACHE_SIZE, AnimeQuoteRotation } from "../src/utils/live2d-quotes";

function seededRandom(seed: number) {
	let value = seed;
	return () => {
		value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
		return value / 2 ** 32;
	};
}

test("ships over 1,000 distinct attributed short quotes with the requested preferences", () => {
	assert.ok(dataset.quotes.length > 1000);
	assert.equal(provenance.counts.total, dataset.quotes.length);
	assert.equal(provenance.version, dataset.version);
	assert.equal(provenance.revision, dataset.source.revision);
	assert.equal(new Set(dataset.quotes.map((quote) => quote.id)).size, dataset.quotes.length);
	const textKeys = dataset.quotes.map((quote) => quote.text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ""));
	assert.equal(new Set(textKeys).size, dataset.quotes.length);
	for (const quote of dataset.quotes) {
		assert.ok(quote.source.trim());
		assert.ok(quote.text.length >= 4 && quote.text.length <= 60);
		assert.ok(`「${quote.text}」——《${quote.source}》`.length <= 100);
		assert.ok(Number.isFinite(quote.weight) && quote.weight >= 1);
		assert.ok(["idle", "happy", "sad"].includes(quote.emotion));
	}
	for (const theme of ["催泪", "百合", "恋爱", "日常", "治愈", "神作"]) {
		assert.ok(dataset.quotes.some((quote) => quote.themes.includes(theme) && quote.weight > 1), theme);
	}
	// Short Latin titles such as AIR must not classify Fairy gone as a Key work.
	assert.ok(dataset.quotes.filter((quote) => quote.source === "Fairy gone").every((quote) => !quote.themes.includes("催泪")));
});

test("draws every cached quote once, then replaces all 39 IDs", () => {
	const rotation = new AnimeQuoteRotation(dataset, undefined, seededRandom(39));
	const firstCache = rotation.snapshot().cache;
	assert.equal(firstCache.length, ANIME_QUOTE_CACHE_SIZE);
	assert.equal(new Set(firstCache).size, 39);
	const drawn = Array.from({ length: 39 }, () => rotation.next());
	assert.deepEqual(drawn.map((quote) => quote.id), firstCache);
	assert.equal(rotation.snapshot().remaining.length, 0);
	const next = rotation.next();
	const secondCache = rotation.snapshot().cache;
	assert.equal(secondCache.length, 39);
	assert.ok(secondCache.every((id) => !firstCache.includes(id)));
	assert.notEqual(next.id, drawn.at(-1)?.id);
	assert.equal(rotation.snapshot().remaining.length, 38);
	const source = dataset.quotes.find((quote) => quote.id === next.id);
	assert.equal(next.text, `「${source?.text}」——《${source?.source}》`);
});

test("restores the unplayed part of a cache after a page reload", () => {
	const rotation = new AnimeQuoteRotation(dataset, undefined, seededRandom(7));
	const played = new Set(Array.from({ length: 13 }, () => rotation.next().id));
	const saved = JSON.parse(JSON.stringify(rotation.snapshot()));
	const restored = new AnimeQuoteRotation(dataset, saved, () => { throw new Error("Must not refill before consuming the saved cache"); });
	saved.cache.fill("tampered");
	saved.remaining.fill("tampered");
	const rest = Array.from({ length: 26 }, () => restored.next().id);
	assert.equal(new Set(rest).size, 26);
	assert.ok(rest.every((id) => !played.has(id)));
	assert.deepEqual(rest, rotation.snapshot().remaining);
	assert.equal(restored.snapshot().remaining.length, 0);
	assert.ok(JSON.stringify(restored.snapshot()).length < 3000);
});

test("restoring an exhausted cache still excludes that whole round", () => {
	const rotation = new AnimeQuoteRotation(dataset, undefined, seededRandom(9));
	const played = new Set(Array.from({ length: 39 }, () => rotation.next().id));
	const restored = new AnimeQuoteRotation(dataset, rotation.snapshot(), seededRandom(10));
	assert.ok(!played.has(restored.next().id));
	assert.ok(restored.snapshot().cache.every((id) => !played.has(id)));
});

test("discards stale, unknown, duplicate, or inconsistent stored IDs", () => {
	const valid = new AnimeQuoteRotation(dataset, undefined, seededRandom(11));
	valid.next();
	const saved = valid.snapshot();
	const invalid = [
		null, [], "old text cache", {},
		{ ...saved, version: "old-dataset" },
		{ ...saved, cache: saved.cache.slice(0, 20) },
		{ ...saved, cache: Array(39).fill(saved.cache[0]) },
		{ ...saved, cache: ["unknown-id", ...saved.cache.slice(1)] },
		{ ...saved, remaining: saved.remaining.toReversed() },
		{ ...saved, remaining: [...saved.remaining, saved.cache[0]] },
		{ ...saved, last: saved.remaining[0] },
		{ ...saved, last: null },
	];
	for (const state of invalid) {
		const rotation = new AnimeQuoteRotation(dataset, state, seededRandom(12));
		assert.equal(rotation.snapshot().remaining.length, 39);
		assert.equal(rotation.snapshot().last, null);
		assert.equal(new Set(Array.from({ length: 39 }, () => rotation.next().id)).size, 39);
	}
});

test("weighted sampling substantially favors the requested works", () => {
	const preferred = new Set(dataset.quotes.filter((quote) => quote.themes.length).map((quote) => quote.id));
	const weighted = new AnimeQuoteRotation(dataset, undefined, seededRandom(123));
	const uniform = new AnimeQuoteRotation({ ...dataset, quotes: dataset.quotes.map((quote) => ({ ...quote, weight: 1 })) }, undefined, seededRandom(123));
	let weightedCount = 0;
	let uniformCount = 0;
	const samples = 39 * 20;
	for (let index = 0; index < samples; index++) {
		if (preferred.has(weighted.next().id)) weightedCount++;
		if (preferred.has(uniform.next().id)) uniformCount++;
	}
	assert.ok(weightedCount > samples * 0.7);
	assert.ok(weightedCount > uniformCount + samples * 0.25);
});
