import { describe, expect, it } from "bun:test";
import { createTurndown } from "@oh-my-pi/pi-coding-agent/utils/turndown";

describe("createTurndown", () => {
	it("keeps underscores inside identifiers literal", () => {
		const markdown = createTurndown().turndown("<p>Set DOCX_NEEDLE_1, my__var and ünï_cödé_2.</p>");
		expect(markdown).toBe("Set DOCX_NEEDLE_1, my__var and ünï_cödé_2.");
	});

	it("still escapes underscores that could open or close emphasis", () => {
		const markdown = createTurndown().turndown("<p>_not emphasis_ and __init__ and trailing_ _leading</p>");
		expect(markdown).toBe("\\_not emphasis\\_ and \\_\\_init\\_\\_ and trailing\\_ \\_leading");
	});

	it("keeps an escaped literal backslash before an intraword underscore", () => {
		expect(createTurndown().turndown("<p>a\\_b</p>")).toBe("a\\\\\\_b");
	});
});
