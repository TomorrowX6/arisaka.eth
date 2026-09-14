export const ANIME_QUOTE_CACHE_SIZE = 39;
export const ANIME_QUOTE_STORAGE_KEY = "live2d:anime-quotes";

type Quote = {
	id: string;
	text: string;
	source: string;
	weight: number;
	emotion: string;
};

type QuoteDataset = { version: string; quotes: readonly Quote[] };
type QuoteState = {
	version: string;
	cache: string[];
	remaining: string[];
	last: string | null;
};

// Only the 39 active IDs and draw progress are persisted, never the full corpus.
export class AnimeQuoteRotation {
	private readonly byId: Map<string, Quote>;
	private cache: string[] = [];
	private remaining: string[] = [];
	private last: string | null = null;

	constructor(
		private readonly dataset: QuoteDataset,
		state?: unknown,
		private readonly random: () => number = Math.random,
	) {
		this.byId = new Map(dataset.quotes.map((quote) => [quote.id, quote]));
		if (this.byId.size < ANIME_QUOTE_CACHE_SIZE * 2) {
			throw new Error("The quote corpus must support two distinct 39-quote caches.");
		}
		if (this.isValidState(state)) {
			this.cache = [...state.cache];
			this.remaining = [...state.remaining];
			this.last = state.last;
		} else {
			this.refill();
		}
	}

	next(): { id: string; text: string; emotion: string } {
		if (!this.remaining.length) this.refill();
		const id = this.remaining.shift();
		const quote = id ? this.byId.get(id) : undefined;
		if (!quote) throw new Error("The quote cache contains an unknown ID.");
		this.last = quote.id;
		return { id: quote.id, text: `「${quote.text}」——《${quote.source}》`, emotion: quote.emotion };
	}

	snapshot(): QuoteState {
		return {
			version: this.dataset.version,
			cache: [...this.cache],
			remaining: [...this.remaining],
			last: this.last,
		};
	}

	private refill() {
		const previous = new Set(this.cache);
		// Exponential keys give weighted sampling without replacement. Excluding
		// the whole previous cache also prevents repeats at the round boundary.
		this.cache = this.dataset.quotes
			.filter((quote) => !previous.has(quote.id))
			.map((quote) => ({ id: quote.id, score: -Math.log(1 - this.random()) / quote.weight }))
			.sort((a, b) => a.score - b.score)
			.slice(0, ANIME_QUOTE_CACHE_SIZE)
			.map((quote) => quote.id);
		this.remaining = [...this.cache];
	}

	private isValidState(value: unknown): value is QuoteState {
		if (!value || typeof value !== "object") return false;
		const state = value as Partial<QuoteState>;
		const { cache, remaining, last } = state;
		if (state.version !== this.dataset.version || !Array.isArray(cache) ||
			cache.length !== ANIME_QUOTE_CACHE_SIZE || new Set(cache).size !== cache.length ||
			!cache.every((id) => typeof id === "string" && this.byId.has(id)) ||
			!Array.isArray(remaining) || remaining.length > cache.length) return false;
		const consumed = cache.length - remaining.length;
		return remaining.every((id, index) => id === cache[consumed + index]) &&
			last === (consumed ? cache[consumed - 1] : null);
	}
}
