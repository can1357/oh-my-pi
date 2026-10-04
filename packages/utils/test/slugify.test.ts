import { describe, expect, it } from "bun:test";
import { slugify } from "@oh-my-pi/pi-utils";

describe("slugify", () => {
	it("lowercases ASCII and collapses non-alphanumeric runs into single dashes", () => {
		expect(slugify("Review_42 / API! v2")).toBe("review-42-api-v2");
	});

	it("trims edge dashes without transliterating non-ASCII characters", () => {
		expect(slugify(" -- Café / résumé -- ")).toBe("caf-r-sum");
	});

	it("returns empty when no ASCII letters or digits survive", () => {
		expect(slugify("東京😀")).toBe("");
		expect(slugify("--- !!!")).toBe("");
		expect(slugify("")).toBe("");
	});

	it("truncates the normalized slug at maxLength", () => {
		expect(slugify("  ABC / DEFG  ", { maxLength: 6 })).toBe("abc-de");
	});

	it("re-trims a trailing dash introduced by truncation", () => {
		expect(slugify("  ABC / DEFG  ", { maxLength: 4 })).toBe("abc");
	});

	it("returns empty for a zero-length limit", () => {
		expect(slugify("Hello world", { maxLength: 0 })).toBe("");
	});

	it("keeps the normalized slug unbounded when maxLength is absent", () => {
		expect(slugify("A".repeat(64), {})).toBe("a".repeat(64));
	});
});
