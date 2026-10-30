import { afterEach, describe, expect, it } from "bun:test";
import { format, formatDistanceToNow } from "../src/dates";

const realDateNow = Date.now;

afterEach(() => {
	Date.now = realDateNow;
});

describe("format", () => {
	it("matches date-fns v4 goldens for every supported token", () => {
		const date = new Date(2024, 6, 9, 12, 5, 7);
		const goldens = [
			["yyyy", "2024"],
			["yy", "24"],
			["MMMM", "July"],
			["MMM", "Jul"],
			["MM", "07"],
			["M", "7"],
			["dd", "09"],
			["d", "9"],
			["EEEE", "Tuesday"],
			["EEE", "Tue"],
			["HH", "12"],
			["H", "12"],
			["hh", "12"],
			["h", "12"],
			["mm", "05"],
			["m", "5"],
			["ss", "07"],
			["s", "7"],
			["a", "PM"],
		] as const;

		for (const [pattern, expected] of goldens) expect(format(date, pattern)).toBe(expected);
	});

	it("matches the used patterns at single-digit dates, year boundaries, midnight, and noon", () => {
		const goldens = [
			[new Date(2024, 0, 1, 0, 5, 7), "MMM d", "Jan 1"],
			[new Date(2024, 0, 1, 0, 5, 7), "HH:mm", "00:05"],
			[new Date(2024, 6, 9, 12, 15, 19), "MMM d", "Jul 9"],
			[new Date(2024, 6, 9, 12, 15, 19), "HH:mm", "12:15"],
			[new Date(1999, 11, 31, 23, 59, 59), "MMM d", "Dec 31"],
			[new Date(1999, 11, 31, 23, 59, 59), "HH:mm", "23:59"],
		] as const;

		for (const [date, pattern, expected] of goldens) expect(format(date, pattern)).toBe(expected);
	});

	it("matches date-fns quoted literal and quote escaping behavior", () => {
		const date = new Date(2024, 0, 1, 0, 5, 7);
		expect(format(date, "'Today at' h:mm a")).toBe("Today at 12:05 AM");
		expect(format(date, "''yyyy''")).toBe("'2024'");
		expect(format(date, "'o''clock' h")).toBe("o'clock 12");
	});
});

describe("formatDistanceToNow", () => {
	it("matches date-fns v4 goldens across every requested threshold", () => {
		const now = new Date(2024, 6, 1, 12, 0, 0);
		Date.now = () => now.getTime();
		const goldens = [
			[0, "less than a minute"],
			[29, "less than a minute"],
			[30, "1 minute"],
			[45, "1 minute"],
			[89, "1 minute"],
			[90, "2 minutes"],
			[44 * 60 + 29, "44 minutes"],
			[44 * 60 + 30, "about 1 hour"],
			[45 * 60, "about 1 hour"],
			[89 * 60 + 30, "about 2 hours"],
			[90 * 60, "about 2 hours"],
			[24 * 60 * 60 - 31, "about 24 hours"],
			[24 * 60 * 60 - 30, "1 day"],
			[24 * 60 * 60, "1 day"],
			[30 * 24 * 60 * 60, "about 1 month"],
			[45 * 24 * 60 * 60, "about 2 months"],
			[60 * 24 * 60 * 60, "2 months"],
			[365 * 24 * 60 * 60, "12 months"],
		] as const;

		for (const [seconds, expected] of goldens) {
			const date = new Date(now.getTime() - seconds * 1_000);
			expect(formatDistanceToNow(date)).toBe(expected);
			expect(formatDistanceToNow(date, { addSuffix: true })).toBe(`${expected} ago`);
		}
	});

	it("matches future suffixes and year-range wording", () => {
		const now = new Date(2024, 6, 1, 12, 0, 0);
		Date.now = () => now.getTime();
		expect(formatDistanceToNow(new Date(now.getTime() + 45_000), { addSuffix: true })).toBe("in 1 minute");

		const about = new Date(now);
		about.setFullYear(about.getFullYear() - 1);
		expect(formatDistanceToNow(about)).toBe("about 1 year");

		const over = new Date(now);
		over.setFullYear(over.getFullYear() - 1);
		over.setMonth(over.getMonth() - 3);
		expect(formatDistanceToNow(over)).toBe("over 1 year");

		const almost = new Date(now);
		almost.setFullYear(almost.getFullYear() - 1);
		almost.setMonth(almost.getMonth() - 9);
		expect(formatDistanceToNow(almost)).toBe("almost 2 years");
	});

	it("localizes complete relative phrases without mixing English units into Korean", () => {
		const modulePath = new URL("../src/dates.ts", import.meta.url).href;
		const i18nPath = new URL("../src/i18n.ts", import.meta.url).href;
		const script = `import {initializeI18n} from ${JSON.stringify(i18nPath)};
import {formatDistanceToNow} from ${JSON.stringify(modulePath)};
await initializeI18n();
const now = new Date(2024,6,1,12);
Date.now = () => now.getTime();
const seconds = [0,30,90,44*60+29,45*60,120*60,86400,2*86400,30*86400,60*86400];
const past = seconds.map(value=>formatDistanceToNow(now.getTime()-value*1000,{addSuffix:true}));
const future = formatDistanceToNow(now.getTime()+300000,{addSuffix:true});
const years = [0,3,9].map(months=>{
	const date=new Date(now);date.setFullYear(date.getFullYear()-1);date.setMonth(date.getMonth()-months);
	return formatDistanceToNow(date,{addSuffix:true});
});
console.log(JSON.stringify({past,future,years}));`;
		const outputs = ["en", "ko"].map(language => {
			const child = Bun.spawnSync([process.execPath, "-e", script], {
				env: { ...process.env, OMP_LANG: language, OMP_LOCALE_DIR: undefined, PI_COMPILED: undefined },
			});
			expect(child.exitCode, child.stderr.toString()).toBe(0);
			return JSON.parse(child.stdout.toString());
		});
		expect(outputs[0]).toEqual({
			past: [
				"less than a minute ago",
				"1 minute ago",
				"2 minutes ago",
				"44 minutes ago",
				"about 1 hour ago",
				"about 2 hours ago",
				"1 day ago",
				"2 days ago",
				"about 1 month ago",
				"2 months ago",
			],
			future: "in 5 minutes",
			years: ["about 1 year ago", "over 1 year ago", "almost 2 years ago"],
		});
		expect(outputs[1]).toEqual({
			past: [
				"1분 미만 전",
				"1분 전",
				"2분 전",
				"44분 전",
				"1시간 정도 전",
				"2시간 정도 전",
				"1일 전",
				"2일 전",
				"1개월 정도 전",
				"2개월 전",
			],
			future: "5분 후",
			years: ["1년 정도 전", "1년 이상 전", "2년 가까이 전"],
		});
	});
});
