<script lang="ts">
import { siteConfig } from "../../config";
import { getMonthHolidays } from "../../utils/holiday-utils";

type DayMark = { names: string[]; statutory: boolean };

const locale = (siteConfig.lang || "en").replace("_", "-");

const today = new Date();
const todayYear = today.getFullYear();
const todayMonth = today.getMonth();
const todayDate = today.getDate();

let viewYear = todayYear;
let viewMonth = todayMonth; // 0 - 11

const titleFormatter = new Intl.DateTimeFormat(locale, {
	year: "numeric",
	month: "long",
	timeZone: "UTC",
});
const weekdayFormatter = new Intl.DateTimeFormat(locale, {
	weekday: "short",
	timeZone: "UTC",
});

// 2023-01-01 was a Sunday, so this walks a full week from Sunday to Saturday
const weekdays = Array.from({ length: 7 }, (_, i) =>
	weekdayFormatter.format(new Date(Date.UTC(2023, 0, 1 + i))),
);

function shiftMonth(delta: number) {
	const shifted = new Date(viewYear, viewMonth + delta, 1);
	viewYear = shifted.getFullYear();
	viewMonth = shifted.getMonth();
}

function isToday(day: number, year: number, month: number): boolean {
	return year === todayYear && month === todayMonth && day === todayDate;
}

function dayClass(
	day: number,
	year: number,
	month: number,
	marks: Map<number, DayMark>,
): string {
	if (isToday(day, year, month))
		return "bg-[var(--primary)] font-bold text-[var(--deep-text)]";
	if (marks.get(day)?.statutory) return "font-bold text-[var(--primary)]";
	const weekday = new Date(year, month, day).getDay();
	return weekday === 0 || weekday === 6 ? "text-30" : "text-75";
}

function dotClass(
	day: number,
	year: number,
	month: number,
	marks: Map<number, DayMark>,
): string {
	if (!marks.has(day)) return "bg-transparent";
	return isToday(day, year, month)
		? "bg-[var(--deep-text)]"
		: "bg-[var(--primary)]";
}

$: title = titleFormatter.format(new Date(Date.UTC(viewYear, viewMonth, 1)));
$: holidays = getMonthHolidays(viewYear, viewMonth + 1);
$: marks = holidays.reduce((map, holiday) => {
	const mark = map.get(holiday.day);
	if (mark) {
		mark.names.push(holiday.name);
		mark.statutory = mark.statutory || holiday.statutory;
	} else {
		map.set(holiday.day, {
			names: [holiday.name],
			statutory: holiday.statutory,
		});
	}
	return map;
}, new Map<number, DayMark>());
$: cells = [
	// leading blanks so the 1st lands under its weekday
	...Array<number | null>(new Date(viewYear, viewMonth, 1).getDay()).fill(null),
	...Array.from(
		{ length: new Date(viewYear, viewMonth + 1, 0).getDate() },
		(_, i) => i + 1,
	),
];
</script>

<div class="pb-1">
    <!-- month switcher -->
    <div class="flex items-center justify-between mb-1">
        <button class="btn-plain w-8 h-8 rounded-lg" aria-label="Previous month" on:click={() => shiftMonth(-1)}>
            <svg class="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="m10.8 12l3.9 3.9q.275.275.275.7t-.275.7t-.7.275t-.7-.275l-4.6-4.6q-.15-.15-.212-.325T8.425 12t.063-.375t.212-.325l4.6-4.6q.275-.275.7-.275t.7.275t.275.7t-.275.7z"/>
            </svg>
        </button>
        <div class="text-sm font-bold text-90">{title}</div>
        <button class="btn-plain w-8 h-8 rounded-lg" aria-label="Next month" on:click={() => shiftMonth(1)}>
            <svg class="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M12.6 12L8.7 8.1q-.275-.275-.275-.7t.275-.7t.7-.275t.7.275l4.6 4.6q.15.15.213.325t.062.375t-.062.375t-.213.325l-4.6 4.6q-.275.275-.7.275t-.7-.275t-.275-.7t.275-.7z"/>
            </svg>
        </button>
    </div>

    <!-- weekday header -->
    <div class="grid grid-cols-7">
        {#each weekdays as weekday}
            <div class="h-7 flex items-center justify-center text-xs text-30">{weekday}</div>
        {/each}
    </div>

    <!-- days -->
    <div class="grid grid-cols-7">
        {#each cells as day}
            {#if day === null}
                <div class="h-8"></div>
            {:else}
                <div class="h-8 flex items-center justify-center">
                    <div class="w-8 h-8 rounded-lg flex flex-col items-center justify-center text-sm transition {dayClass(day, viewYear, viewMonth, marks)}"
                         title={marks.get(day)?.names.join(" · ") ?? null}>
                        <span class="leading-none">{day}</span>
                        <span class="mt-[3px] w-1 h-1 rounded-full transition {dotClass(day, viewYear, viewMonth, marks)}"></span>
                    </div>
                </div>
            {/if}
        {/each}
    </div>

    <!-- holidays of the displayed month -->
    {#if holidays.length > 0}
        <div class="mt-2 pt-2 flex flex-col gap-1 border-t-[1px] border-dashed border-[var(--line-divider)]">
            {#each holidays as holiday}
                <div class="flex items-center gap-2 text-xs">
                    <div class="w-1 h-1 rounded-full shrink-0 {holiday.statutory ? 'bg-[var(--primary)]' : 'bg-[var(--meta-divider)]'}"></div>
                    <span class="text-30 tabular-nums">{holiday.month}/{holiday.day}</span>
                    <span class="truncate {holiday.statutory ? 'text-[var(--primary)]' : 'text-75'}">{holiday.name}</span>
                </div>
            {/each}
        </div>
    {/if}
</div>
