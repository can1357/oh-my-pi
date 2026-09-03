import { describe, expect, it } from "bun:test";
import { loadTheme } from "../../../src/modes/theme/loader";

describe("Birch card contrast", () => {
	it("renders user and custom cards with explicit dark foregrounds", async () => {
		const birch = await loadTheme("birch", { mode: "truecolor" });
		const darkInk = "\x1b[38;2;40;40;32m";

		expect(birch.fg("userMessageText", "user")).toBe(`${darkInk}user\x1b[39m`);
		expect(birch.fg("customMessageText", "custom")).toBe(`${darkInk}custom\x1b[39m`);
	});
});
