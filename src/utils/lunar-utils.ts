/**
 * Chinese lunisolar calendar, derived from astronomical formulae
 * (Meeus, *Astronomical Algorithms*) rather than a hard-coded date table, so it
 * keeps working for any year instead of expiring at the end of a fixed range.
 *
 * Dates are handled as China-local day numbers: the integer Julian Day Number
 * of the UTC+8 calendar day, which makes "which day did this instant fall on"
 * a simple floor.
 */

const DEG = Math.PI / 180;
const SYNODIC_MONTH = 29.530588853;
const CHINA_OFFSET = 8 / 24;
// Julian Ephemeris Day of new moon k = 0 (2000-01-06)
const NEW_MOON_EPOCH = 2451550.09766;

export type GregorianDate = { year: number; month: number; day: number };

export type LunarMonth = {
	lunarYear: number;
	/** 1 - 12 */
	index: number;
	leap: boolean;
	/** China-local day number of the first day of the month */
	start: number;
};

function mod360(degrees: number): number {
	return degrees - 360 * Math.floor(degrees / 360);
}

/** Signed difference between two angles, in (-180, 180]. */
function angleDiff(a: number, b: number): number {
	return mod360(a - b + 180) - 180;
}

/** Julian Day at 00:00 UT of a Gregorian date. */
function gregorianToJD(
	year: number,
	month: number,
	day: number,
): number {
	let y = year;
	let m = month;
	if (m <= 2) {
		y -= 1;
		m += 12;
	}
	const a = Math.floor(y / 100);
	const b = 2 - a + Math.floor(a / 4);
	return (
		Math.floor(365.25 * (y + 4716)) +
		Math.floor(30.6001 * (m + 1)) +
		day +
		b -
		1524.5
	);
}

/** Gregorian date of a China-local day number. */
export function dayNumberToGregorian(dayNumber: number): GregorianDate {
	const z = dayNumber;
	let a = z;
	if (z >= 2299161) {
		const alpha = Math.floor((z - 1867216.25) / 36524.25);
		a = z + 1 + alpha - Math.floor(alpha / 4);
	}
	const b = a + 1524;
	const c = Math.floor((b - 122.1) / 365.25);
	const d = Math.floor(365.25 * c);
	const e = Math.floor((b - d) / 30.6001);
	const day = b - d - Math.floor(30.6001 * e);
	const month = e < 14 ? e - 1 : e - 13;
	const year = month > 2 ? c - 4716 : c - 4715;
	return { year, month, day };
}

/**
 * Difference between Terrestrial Time and UT, in seconds
 * (Espenak & Meeus polynomial fits).
 */
function deltaTSeconds(year: number): number {
	let t: number;
	if (year < 1920) {
		t = year - 1900;
		return (
			-2.79 +
			1.494119 * t -
			0.0598939 * t ** 2 +
			0.0061966 * t ** 3 -
			0.000197 * t ** 4
		);
	}
	if (year < 1941) {
		t = year - 1920;
		return 21.2 + 0.84493 * t - 0.0761 * t ** 2 + 0.0020936 * t ** 3;
	}
	if (year < 1961) {
		t = year - 1950;
		return 29.07 + 0.407 * t - t ** 2 / 233 + t ** 3 / 2547;
	}
	if (year < 1986) {
		t = year - 1975;
		return 45.45 + 1.067 * t - t ** 2 / 260 - t ** 3 / 718;
	}
	if (year < 2005) {
		t = year - 2000;
		return (
			63.86 +
			0.3345 * t -
			0.060374 * t ** 2 +
			0.0017275 * t ** 3 +
			0.000651814 * t ** 4 +
			0.00002373599 * t ** 5
		);
	}
	if (year < 2050) {
		t = year - 2000;
		return 62.92 + 0.32217 * t + 0.005589 * t ** 2;
	}
	if (year < 2150) {
		return -20 + 32 * ((year - 1820) / 100) ** 2 - 0.5628 * (2150 - year);
	}
	return -20 + 32 * ((year - 1820) / 100) ** 2;
}

function deltaTDaysAtJD(jd: number): number {
	return deltaTSeconds(2000 + (jd - 2451545) / 365.25) / 86400;
}

/** Julian Ephemeris Day of the k-th new moon (k = 0 → 2000-01-06). */
function newMoonJDE(k: number): number {
	const t = k / 1236.85;
	const t2 = t * t;
	const t3 = t2 * t;
	const t4 = t3 * t;

	let jde =
		NEW_MOON_EPOCH +
		SYNODIC_MONTH * k +
		0.00015437 * t2 -
		0.00000015 * t3 +
		0.00000000073 * t4;

	const e = 1 - 0.002516 * t - 0.0000074 * t2;
	// sun's mean anomaly
	const m = (2.5534 + 29.1053567 * k - 0.0000014 * t2 - 0.00000011 * t3) * DEG;
	// moon's mean anomaly
	const mp =
		(201.5643 +
			385.81693528 * k +
			0.0107582 * t2 +
			0.00001238 * t3 -
			0.000000058 * t4) *
		DEG;
	// moon's argument of latitude
	const f =
		(160.7108 +
			390.67050284 * k -
			0.0016118 * t2 -
			0.00000227 * t3 +
			0.000000011 * t4) *
		DEG;
	// longitude of the ascending node
	const omega =
		(124.7746 - 1.56375588 * k + 0.0020672 * t2 + 0.00000215 * t3) * DEG;

	jde +=
		-0.4072 * Math.sin(mp) +
		0.17241 * e * Math.sin(m) +
		0.01608 * Math.sin(2 * mp) +
		0.01039 * Math.sin(2 * f) +
		0.00739 * e * Math.sin(mp - m) -
		0.00514 * e * Math.sin(mp + m) +
		0.00208 * e * e * Math.sin(2 * m) -
		0.00111 * Math.sin(mp - 2 * f) -
		0.00057 * Math.sin(mp + 2 * f) +
		0.00056 * e * Math.sin(2 * mp + m) -
		0.00042 * Math.sin(3 * mp) +
		0.00042 * e * Math.sin(m + 2 * f) +
		0.00038 * e * Math.sin(m - 2 * f) -
		0.00024 * e * Math.sin(2 * mp - m) -
		0.00017 * Math.sin(omega) -
		0.00007 * Math.sin(mp + 2 * m) +
		0.00004 * Math.sin(2 * mp - 2 * f) +
		0.00004 * Math.sin(3 * m) +
		0.00003 * Math.sin(mp + m - 2 * f) +
		0.00003 * Math.sin(2 * mp + 2 * f) -
		0.00003 * Math.sin(mp + m + 2 * f) +
		0.00003 * Math.sin(mp - m + 2 * f) -
		0.00002 * Math.sin(mp - m - 2 * f) -
		0.00002 * Math.sin(3 * mp + m) +
		0.00002 * Math.sin(4 * mp);

	// planetary perturbations
	const a = [
		[299.77 + 0.107408 * k - 0.009173 * t2, 0.000325],
		[251.88 + 0.016321 * k, 0.000165],
		[251.83 + 26.651886 * k, 0.000164],
		[349.42 + 36.412478 * k, 0.000126],
		[84.66 + 18.206239 * k, 0.00011],
		[141.74 + 53.303771 * k, 0.000062],
		[207.14 + 2.453732 * k, 0.00006],
		[154.84 + 7.30686 * k, 0.000056],
		[34.52 + 27.261239 * k, 0.000047],
		[207.19 + 0.121824 * k, 0.000042],
		[291.34 + 1.844379 * k, 0.00004],
		[161.72 + 24.198154 * k, 0.000037],
		[239.56 + 25.513099 * k, 0.000035],
		[331.55 + 3.592518 * k, 0.000023],
	];
	for (const [angle, amplitude] of a) jde += amplitude * Math.sin(angle * DEG);

	return jde;
}

/** China-local day number on which the k-th new moon falls. */
function newMoonDay(k: number): number {
	const jde = newMoonJDE(k);
	return Math.floor(jde - deltaTDaysAtJD(jde) + 0.5 + CHINA_OFFSET);
}

/** Apparent geocentric longitude of the sun, in degrees. */
function solarLongitude(jde: number): number {
	const t = (jde - 2451545) / 36525;
	const t2 = t * t;
	const l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t2;
	const m = (357.52911 + 35999.05029 * t - 0.0001537 * t2) * DEG;
	const c =
		(1.914602 - 0.004817 * t - 0.000014 * t2) * Math.sin(m) +
		(0.019993 - 0.000101 * t) * Math.sin(2 * m) +
		0.000289 * Math.sin(3 * m);
	const omega = (125.04 - 1934.136 * t) * DEG;
	return mod360(l0 + c - 0.00569 - 0.00478 * Math.sin(omega));
}

/** Solar longitude at the start (China midnight) of a given day. */
function solarLongitudeAtDayStart(dayNumber: number): number {
	const jdUT = dayNumber - 0.5 - CHINA_OFFSET;
	return solarLongitude(jdUT + deltaTDaysAtJD(jdUT));
}

/**
 * Index of the last major solar term (中气, every 30° of solar longitude)
 * that has been passed at the start of the given day.
 */
function majorTermIndex(dayNumber: number): number {
	return Math.floor(solarLongitudeAtDayStart(dayNumber) / 30);
}

/**
 * China-local day number of the moment the sun reaches the given longitude,
 * for the solar term cycle belonging to `year`.
 */
export function solarTermDay(year: number, degrees: number): number {
	// longitude 0° falls near March 20th
	let jde = gregorianToJD(year, 3, 20) + (degrees * 365.2422) / 360;
	for (let i = 0; i < 20; i++) {
		const diff = angleDiff(solarLongitude(jde), degrees);
		if (Math.abs(diff) < 1e-9) break;
		jde -= diff / 0.9856473;
	}
	return Math.floor(jde - deltaTDaysAtJD(jde) + 0.5 + CHINA_OFFSET);
}

/** Index k of the last new moon falling on or before the given day. */
function newMoonIndexBefore(dayNumber: number): number {
	let k = Math.floor((dayNumber - NEW_MOON_EPOCH) / SYNODIC_MONTH);
	while (newMoonDay(k) > dayNumber) k -= 1;
	while (newMoonDay(k + 1) <= dayNumber) k += 1;
	return k;
}

/**
 * Every lunar month from month 11 of lunar year `year - 1` through month 11 of
 * lunar year `year`. The winter solstice always falls in month 11; when that
 * span holds 13 months, the first one without a major solar term is the leap
 * month.
 */
function lunarSequence(year: number): LunarMonth[] {
	const previousSolstice = solarTermDay(year - 1, 270);
	const currentSolstice = solarTermDay(year, 270);
	const firstMonth = newMoonIndexBefore(previousSolstice);
	const count = newMoonIndexBefore(currentSolstice) - firstMonth;

	const starts: number[] = [];
	for (let i = 0; i <= count; i++) starts.push(newMoonDay(firstMonth + i));

	let leapAt = -1;
	if (count === 13) {
		for (let i = 1; i < count; i++) {
			if (majorTermIndex(starts[i]) === majorTermIndex(starts[i + 1])) {
				leapAt = i;
				break;
			}
		}
	}

	const months: LunarMonth[] = [];
	let index = 11;
	let lunarYear = year - 1;
	let previousIndex = 11;
	let previousYear = year - 1;
	for (let i = 0; i <= count; i++) {
		if (i === leapAt) {
			months.push({
				lunarYear: previousYear,
				index: previousIndex,
				leap: true,
				start: starts[i],
			});
			continue;
		}
		months.push({ lunarYear, index, leap: false, start: starts[i] });
		previousIndex = index;
		previousYear = lunarYear;
		index += 1;
		if (index > 12) {
			index = 1;
			lunarYear += 1;
		}
	}
	return months;
}

const monthCache = new Map<number, LunarMonth[]>();

/**
 * Every lunar month that can overlap the given Gregorian year, so that
 * holidays in the twelfth lunar month — which straddles the new year — are
 * covered from both sides.
 */
export function getLunarMonths(gregorianYear: number): LunarMonth[] {
	const cached = monthCache.get(gregorianYear);
	if (cached) return cached;

	const months: LunarMonth[] = [];
	const seen = new Set<number>();
	for (const month of [
		...lunarSequence(gregorianYear),
		...lunarSequence(gregorianYear + 1),
	]) {
		if (seen.has(month.start)) continue;
		seen.add(month.start);
		months.push(month);
	}

	monthCache.set(gregorianYear, months);
	return months;
}
