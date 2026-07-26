import { siteConfig } from "../config";
import {
	dayNumberToGregorian,
	getLunarMonths,
	solarTermDay,
} from "./lunar-utils";

type HolidayBase = {
	zh: string;
	en: string;
	/** 法定节假日 — rendered more prominently than the rest. */
	statutory?: boolean;
};

type HolidayRule = HolidayBase &
	(
		| { on: "solar"; month: number; day: number }
		// `day: 0` means the last day of the preceding lunar month (除夕)
		| { on: "lunar"; month: number; day: number }
		// solar longitude of a solar term, in degrees
		| { on: "term"; degrees: number }
		// e.g. the 2nd Sunday of May; weekday 0 = Sunday
		| { on: "weekday"; month: number; weekday: number; nth: number }
	);

const HOLIDAYS: HolidayRule[] = [
	// 法定节假日
	{
		on: "solar",
		month: 1,
		day: 1,
		zh: "元旦",
		en: "New Year's Day",
		statutory: true,
	},
	{
		on: "lunar",
		month: 1,
		day: 1,
		zh: "春节",
		en: "Spring Festival",
		statutory: true,
	},
	{
		on: "term",
		degrees: 15,
		zh: "清明节",
		en: "Qingming Festival",
		statutory: true,
	},
	{
		on: "solar",
		month: 5,
		day: 1,
		zh: "劳动节",
		en: "Labour Day",
		statutory: true,
	},
	{
		on: "lunar",
		month: 5,
		day: 5,
		zh: "端午节",
		en: "Dragon Boat Festival",
		statutory: true,
	},
	{
		on: "lunar",
		month: 8,
		day: 15,
		zh: "中秋节",
		en: "Mid-Autumn Festival",
		statutory: true,
	},
	{
		on: "solar",
		month: 10,
		day: 1,
		zh: "国庆节",
		en: "National Day",
		statutory: true,
	},

	// 传统节日
	{ on: "lunar", month: 1, day: 0, zh: "除夕", en: "Chinese New Year's Eve" },
	{ on: "lunar", month: 1, day: 15, zh: "元宵节", en: "Lantern Festival" },
	{
		on: "lunar",
		month: 2,
		day: 2,
		zh: "龙抬头",
		en: "Dragon Head-Raising Day",
	},
	{ on: "lunar", month: 7, day: 7, zh: "七夕", en: "Qixi Festival" },
	{ on: "lunar", month: 7, day: 15, zh: "中元节", en: "Ghost Festival" },
	{ on: "lunar", month: 9, day: 9, zh: "重阳节", en: "Double Ninth Festival" },
	{ on: "lunar", month: 12, day: 8, zh: "腊八节", en: "Laba Festival" },
	{ on: "lunar", month: 12, day: 23, zh: "小年", en: "Minor New Year" },
	{ on: "term", degrees: 270, zh: "冬至", en: "Winter Solstice" },

	// 纪念日与其他节日
	{ on: "solar", month: 2, day: 14, zh: "情人节", en: "Valentine's Day" },
	{ on: "solar", month: 3, day: 8, zh: "妇女节", en: "Women's Day" },
	{ on: "solar", month: 3, day: 12, zh: "植树节", en: "Arbor Day" },
	{ on: "solar", month: 4, day: 1, zh: "愚人节", en: "April Fools' Day" },
	{ on: "solar", month: 5, day: 4, zh: "青年节", en: "Youth Day" },
	{
		on: "weekday",
		month: 5,
		weekday: 0,
		nth: 2,
		zh: "母亲节",
		en: "Mother's Day",
	},
	{ on: "solar", month: 6, day: 1, zh: "儿童节", en: "Children's Day" },
	{
		on: "weekday",
		month: 6,
		weekday: 0,
		nth: 3,
		zh: "父亲节",
		en: "Father's Day",
	},
	{ on: "solar", month: 7, day: 1, zh: "建党节", en: "CPC Founding Day" },
	{ on: "solar", month: 8, day: 1, zh: "建军节", en: "Army Day" },
	{ on: "solar", month: 9, day: 10, zh: "教师节", en: "Teachers' Day" },
	{ on: "solar", month: 10, day: 31, zh: "万圣夜", en: "Halloween" },
	{
		on: "weekday",
		month: 11,
		weekday: 4,
		nth: 4,
		zh: "感恩节",
		en: "Thanksgiving",
	},
	{ on: "solar", month: 12, day: 24, zh: "平安夜", en: "Christmas Eve" },
	{ on: "solar", month: 12, day: 25, zh: "圣诞节", en: "Christmas" },
];

export type Holiday = {
	month: number;
	day: number;
	name: string;
	statutory: boolean;
};

function holidayName(rule: HolidayRule): string {
	return siteConfig.lang?.toLowerCase().startsWith("zh") ? rule.zh : rule.en;
}

/** Day of month of the nth given weekday, e.g. the 4th Thursday of November. */
function nthWeekdayOfMonth(
	year: number,
	month: number,
	weekday: number,
	nth: number,
): number {
	const firstWeekday = new Date(year, month - 1, 1).getDay();
	return 1 + ((weekday - firstWeekday + 7) % 7) + (nth - 1) * 7;
}

function computeYear(year: number): Holiday[] {
	const holidays: Holiday[] = [];
	const add = (month: number, day: number, rule: HolidayRule) => {
		holidays.push({
			month,
			day,
			name: holidayName(rule),
			statutory: rule.statutory === true,
		});
	};

	for (const rule of HOLIDAYS) {
		switch (rule.on) {
			case "solar":
				add(rule.month, rule.day, rule);
				break;
			case "weekday":
				add(
					rule.month,
					nthWeekdayOfMonth(year, rule.month, rule.weekday, rule.nth),
					rule,
				);
				break;
			case "term": {
				const date = dayNumberToGregorian(solarTermDay(year, rule.degrees));
				if (date.year === year) add(date.month, date.day, rule);
				break;
			}
			case "lunar": {
				// A lunar month can land in either Gregorian year, and the twelfth
				// one occasionally produces two matches within the same year, so
				// every candidate is checked rather than just the first.
				for (const lunarMonth of getLunarMonths(year)) {
					if (lunarMonth.leap || lunarMonth.index !== rule.month) continue;
					const date = dayNumberToGregorian(lunarMonth.start + rule.day - 1);
					if (date.year === year) add(date.month, date.day, rule);
				}
				break;
			}
		}
	}

	return holidays.sort((a, b) => a.month - b.month || a.day - b.day);
}

const yearCache = new Map<number, Holiday[]>();

/** Holidays of the given month, in date order. `month` is 1 - 12. */
export function getMonthHolidays(year: number, month: number): Holiday[] {
	let holidays = yearCache.get(year);
	if (!holidays) {
		holidays = computeYear(year);
		yearCache.set(year, holidays);
	}
	return holidays.filter((holiday) => holiday.month === month);
}
