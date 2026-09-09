import { describe, expect, it } from "bun:test";
import {
	DAY_MAP,
	extractDateFromText,
	extractTemporal,
	MONTH_MAP,
	NAMED_TIMES,
	parseNlDate,
} from "@oh-my-pi/pi-mnemopi/core/temporal-parser";

const REF = new Date("2026-05-20T15:30:00Z"); // Wednesday

function iso(value: Date): string {
	return value.toISOString().slice(0, 10);
}

describe("temporal parser", () => {
	it("exports day, month, and named-time constants", () => {
		expect(DAY_MAP.monday).toBe(0);
		expect(DAY_MAP.sun).toBe(6);
		expect(MONTH_MAP.may).toBe(5);
		expect(MONTH_MAP.dec).toBe(12);
		expect(NAMED_TIMES.morning).toEqual([6, 12]);
		expect(NAMED_TIMES.night).toEqual([21, 6]);
	});

	it("extracts ISO absolute dates", () => {
		const result = extractTemporal("Meeting was on 2026-05-15", REF);
		expect(result.event_date).toBe("2026-05-15");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-15", "week-20-2026", "friday"]);
		expect(result.primary_signal).toBe("2026-05-15");
	});

	it("rejects invalid ISO dates and falls through", () => {
		const result = extractTemporal("Bad leap day 2026-02-29", REF);
		expect(result.event_date).toBeNull();
		expect(result.event_date_precision).toBe("unknown");
		expect(result.temporal_tags).toEqual([]);
	});

	it("parses slash dates with Python's US/EU heuristic", () => {
		expect(extractTemporal("US date 05/20/2026", REF).event_date).toBe("2026-05-20");
		expect(extractTemporal("EU date 20/05/2026", REF).event_date).toBe("2026-05-20");
		expect(extractTemporal("Short year 5/20/26", REF).event_date).toBe("2026-05-20");
		expect(extractTemporal("Impossible 31/02/2026", REF).event_date).toBeNull();
	});

	it("parses named month dates using the reference year when omitted", () => {
		expect(extractTemporal("Shipped May 20, 2026", REF).event_date).toBe("2026-05-20");
		expect(extractTemporal("Shipped May 20th", REF).event_date).toBe("2026-05-20");
		expect(extractTemporal("Shipped Sep 7", REF).event_date).toBe("2026-09-07");
		expect(extractTemporal("Invalid Feb 30", REF).event_date).toBeNull();
	});

	it("extracts relative dates deterministically", () => {
		let result = extractTemporal("I had a meeting today", REF);
		expect(result.event_date).toBe("2026-05-20");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-20", "wednesday"]);

		result = extractTemporal("I had a meeting yesterday", REF);
		expect(result.event_date).toBe("2026-05-19");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-19", "tuesday", "yesterday"]);

		result = extractTemporal("I have a meeting tomorrow", REF);
		expect(result.event_date).toBe("2026-05-21");
		expect(result.temporal_tags).toEqual(["2026-05-21", "thursday", "tomorrow"]);
	});

	it("preserves Python's match order for day before yesterday", () => {
		const result = extractTemporal("day before yesterday", REF);
		expect(result.event_date).toBe("2026-05-19");
		expect(result.temporal_tags).toContain("yesterday");
	});

	it("extracts qualified day references", () => {
		let result = extractTemporal("Discussed this last Monday", REF);
		expect(result.event_date).toBe("2026-05-11");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-11", "week-20-2026", "monday", "last"]);

		result = extractTemporal("Discussed this Monday", REF);
		expect(result.event_date).toBe("2026-05-18");
		expect(result.temporal_tags).toEqual(["2026-05-18", "week-21-2026", "monday", "this"]);

		result = extractTemporal("Discussed next Monday", REF);
		expect(result.event_date).toBe("2026-05-25");
		expect(result.temporal_tags).toEqual(["2026-05-25", "week-22-2026", "monday", "next"]);
	});

	it("extracts bare day references as this-most-recent day", () => {
		let result = extractTemporal("on Monday we discussed the API", REF);
		expect(result.event_date).toBe("2026-05-18");
		expect(result.temporal_tags).toEqual(["2026-05-18", "week-21-2026", "monday"]);

		result = extractTemporal("on Wednesday we discussed the API", REF);
		expect(result.event_date).toBe("2026-05-20");
		expect(result.temporal_tags).toEqual(["2026-05-20", "week-21-2026", "wednesday"]);
	});

	it("extracts week, month, and year references", () => {
		expect(extractTemporal("this week", REF)).toMatchObject({
			event_date: "2026-05-20",
			event_date_precision: "week",
			temporal_tags: ["week-21-2026", "this-week"],
		});
		expect(extractTemporal("last week", REF)).toMatchObject({
			event_date: "2026-05-13",
			event_date_precision: "week",
			temporal_tags: ["week-20-2026", "last-week"],
		});
		expect(extractTemporal("next week", REF)).toMatchObject({
			event_date: "2026-05-27",
			event_date_precision: "week",
			temporal_tags: ["week-22-2026", "next-week"],
		});
		expect(extractTemporal("last month", REF)).toMatchObject({
			event_date: "2026-04-01",
			event_date_precision: "month",
			temporal_tags: ["2026-04", "last-month"],
		});
		expect(extractTemporal("next month", REF)).toMatchObject({
			event_date: "2026-06-01",
			event_date_precision: "month",
			temporal_tags: ["2026-06", "next-month"],
		});
		expect(extractTemporal("last year", REF)).toMatchObject({
			event_date: "2025-01-01",
			event_date_precision: "year",
			temporal_tags: ["2025", "last-year"],
		});
		expect(extractTemporal("next year", REF)).toMatchObject({
			event_date: "2027-01-01",
			event_date_precision: "year",
			temporal_tags: ["2027", "next-year"],
		});
	});

	it("handles month and year boundaries", () => {
		expect(extractTemporal("last month", new Date("2026-01-15T00:00:00Z")).event_date).toBe("2025-12-01");
		expect(extractTemporal("next month", new Date("2026-12-15T00:00:00Z")).event_date).toBe("2027-01-01");
	});

	it("extracts past intervals", () => {
		let result = extractTemporal("We deployed 2 days ago", REF);
		expect(result.event_date).toBe("2026-05-18");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-18", "2-days-ago"]);

		result = extractTemporal("We deployed 3 hours ago", REF);
		expect(result.event_date).toBe("2026-05-20");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-20", "3-hours-ago"]);

		result = extractTemporal("We deployed 2 weeks back", REF);
		expect(result.event_date).toBe("2026-05-06");
		expect(result.event_date_precision).toBe("week");
		expect(result.temporal_tags).toEqual(["2026-05-06", "2-weeks-ago"]);
	});

	it("extracts future intervals", () => {
		let result = extractTemporal("in 3 weeks", REF);
		expect(result.event_date).toBe("2026-06-10");
		expect(result.event_date_precision).toBe("week");
		expect(result.temporal_tags).toEqual(["2026-06-10", "in-3-weeks"]);

		result = extractTemporal("in 2 months", REF);
		expect(result.event_date).toBe("2026-07-19");
		expect(result.event_date_precision).toBe("week");
		expect(result.temporal_tags).toEqual(["2026-07-19", "in-2-months"]);
	});

	it("extracts named times with and without dates", () => {
		let result = extractTemporal("Had coffee this morning", REF);
		expect(result.event_date).toBeNull();
		expect(result.event_date_precision).toBe("unknown");
		expect(result.temporal_tags).toEqual(["morning"]);
		expect(result.primary_signal).toBe("morning");

		result = extractTemporal("Yesterday evening we met", REF);
		expect(result.event_date).toBe("2026-05-19");
		expect(result.temporal_tags).toEqual(["2026-05-19", "tuesday", "yesterday", "evening"]);
	});

	it("extracts vague references", () => {
		let result = extractTemporal("recently updated the server", REF);
		expect(result.event_date).toBe("2026-05-20");
		expect(result.event_date_precision).toBe("relative");
		expect(result.temporal_tags).toEqual(["recently"]);

		result = extractTemporal("a while ago we changed the server", REF);
		expect(result.event_date).toBe("2026-05-20");
		expect(result.event_date_precision).toBe("relative");
		expect(result.temporal_tags).toEqual(["vague"]);
	});

	it("returns unknown when no temporal reference exists", () => {
		const result = extractTemporal("The database password is hunter2", REF);
		expect(result.event_date).toBeNull();
		expect(result.event_date_precision).toBe("unknown");
		expect(result.temporal_tags).toEqual([]);
		expect(result.primary_signal).toBeNull();
	});

	it("parses natural-language dates directly", () => {
		let result = parseNlDate("2026-05-15", REF);
		expect(result).not.toBeNull();
		expect(result?.[0].getUTCFullYear()).toBe(2026);
		expect(result?.[1]).toBe("day");
		expect(result?.[2]).toContain("2026-05-15");

		result = parseNlDate("yesterday", REF);
		expect(result).not.toBeNull();
		expect(result === null ? null : iso(result[0])).toBe("2026-05-19");

		expect(parseNlDate("not a date at all", REF)).toBeNull();
	});

	it("extracts temporal tags for parsed dates", () => {
		const result = extractTemporal("Last Monday we discussed the API design", REF);
		expect(result.temporal_tags.length).toBeGreaterThan(0);
		expect(result.temporal_tags).toContain("monday");
	});

	it("uses the first date expression when multiple are present", () => {
		const result = extractTemporal("Deployed v2 on 2026-01-15 and v3 yesterday", REF);
		expect(result.event_date).toBe("2026-01-15");
		expect(result.primary_signal).toBe("2026-01-15");
	});

	it("extracts just the date string", () => {
		expect(extractDateFromText("Deployed yesterday", REF)).toBe("2026-05-19");
		expect(extractDateFromText("No date here", REF)).toBeNull();
	});

	it("treats date-only and timezone-less string references as UTC", () => {
		expect(extractTemporal("yesterday", "2026-05-20").event_date).toBe("2026-05-19");
		expect(extractTemporal("yesterday", "2026-05-20T02:00:00").event_date).toBe("2026-05-19");
		expect(extractTemporal("yesterday", "2026-05-20T02:00:00Z").event_date).toBe("2026-05-19");
	});
});
