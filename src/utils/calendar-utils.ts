import { siteConfig } from "../config";

/**
 * Locale-aware bits of the sidebar calendar.
 *
 * These live in a plain module rather than inside Calendar.svelte on purpose:
 * esbuild marks `new Intl.DateTimeFormat(...)` as side-effect free, and once the
 * Svelte compiler moves that code into the component's init function the
 * annotation ends up in a position Rollup cannot interpret, which it warns
 * about on every build. It also means the formatters are built once rather than
 * per mount.
 */
const locale = (siteConfig.lang || "en").replace("_", "-");

const monthTitleFormatter = new Intl.DateTimeFormat(locale, {
	year: "numeric",
	month: "long",
	timeZone: "UTC",
});

const weekdayFormatter = new Intl.DateTimeFormat(locale, {
	weekday: "short",
	timeZone: "UTC",
});

/** Sunday through Saturday, in the site's language. */
// 2023-01-01 was a Sunday, so this walks exactly one week
export const weekdayNames: string[] = Array.from({ length: 7 }, (_, i) =>
	weekdayFormatter.format(new Date(Date.UTC(2023, 0, 1 + i))),
);

/** e.g. "July 2026" or "2026年7月". `month` is 0 - 11. */
export function formatMonthTitle(year: number, month: number): string {
	return monthTitleFormatter.format(new Date(Date.UTC(year, month, 1)));
}

/**
 * Day numbers for a month grid, padded with leading nulls so the 1st lands
 * under its weekday. `month` is 0 - 11.
 */
export function buildMonthCells(
	year: number,
	month: number,
): (number | null)[] {
	const leading = new Date(year, month, 1).getDay();
	const days = new Date(year, month + 1, 0).getDate();
	return [
		...Array<number | null>(leading).fill(null),
		...Array.from({ length: days }, (_, i) => i + 1),
	];
}

/** Weekday of a given date, 0 = Sunday. `month` is 0 - 11. */
export function weekdayOf(year: number, month: number, day: number): number {
	return new Date(year, month, day).getDay();
}

/** Same month and year, shifted by `delta` months. `month` is 0 - 11. */
export function shiftMonthBy(
	year: number,
	month: number,
	delta: number,
): { year: number; month: number } {
	const shifted = new Date(year, month + delta, 1);
	return { year: shifted.getFullYear(), month: shifted.getMonth() };
}

const now = new Date();

export const todayYear: number = now.getFullYear();
export const todayMonth: number = now.getMonth();
export const todayDate: number = now.getDate();
