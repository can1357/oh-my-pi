import { describe, expect, it } from "bun:test";
import { createI18n } from "../src";

describe("locale formatters", () => {
	it("formats dates using the active locale and requested timezone", () => {
		const date = new Date("1970-01-02T00:00:00.000Z");
		const formatted = createI18n("en").date(date, {
			day: "numeric",
			month: "long",
			year: "numeric",
			timeZone: "UTC",
		});

		expect(formatted).toContain("1970");
		expect(formatted).toContain("January");
	});

	it("formats relative time in English and Chinese", () => {
		expect(createI18n("en").relativeTime(-2, "day")).toBe("2 days ago");
		expect(createI18n("zh-CN").relativeTime(-2, "day")).toBe("2天前");
	});
});
