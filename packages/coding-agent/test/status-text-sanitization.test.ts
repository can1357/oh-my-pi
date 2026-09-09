import { describe, expect, it } from "bun:test";
import { sanitizeStatusText } from "@oh-my-pi/pi-coding-agent/modes/shared";

describe("sanitizeStatusText", () => {
	it("strips OSC, DCS, PM, APC, and 8-bit CSI escape sequences", () => {
		const input =
			"prefix " +
			"\x1b]8;;https://example.com\x07link\x1b]8;;\x07" +
			" " +
			"\x1bPhidden-dcs\x1b\\" +
			"\x1b^hidden-pm\x1b\\" +
			"\x1b_hidden-apc\x1b\\" +
			"\x9b31mred\x9b0m" +
			" suffix";

		expect(sanitizeStatusText(input)).toBe("prefix link red suffix");
	});
});
