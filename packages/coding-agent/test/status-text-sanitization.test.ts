import { describe, expect, it } from "bun:test";
import { sanitizeHookStatusText, sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";

const ESCAPE_FIXTURE =
	"prefix " +
	"\x1b]8;;https://example.com\x07link\x1b]8;;\x07" +
	" " +
	"\x1bPhidden-dcs\x1b\\" +
	"\x1b^hidden-pm\x1b\\" +
	"\x1b_hidden-apc\x1b\\" +
	"\x9b31mred\x9b0m" +
	" suffix";

describe("sanitizeStatusText", () => {
	it("strips OSC, DCS, PM, APC, and 8-bit CSI escape sequences", () => {
		expect(sanitizeStatusText(ESCAPE_FIXTURE)).toBe("prefix link red suffix");
	});
});

describe("sanitizeHookStatusText", () => {
	it("keeps SGR styling and closes it with a reset", () => {
		expect(sanitizeHookStatusText("\x1b[32mgreen\x1b[39m \x1b[31mred\x1b[39m")).toBe(
			"\x1b[32mgreen\x1b[39m \x1b[31mred\x1b[39m\x1b[0m",
		);
	});

	it("strips non-SGR escapes inside styled text without leaking payloads", () => {
		const result = sanitizeHookStatusText(
			"\x1b[1m\x1b]8;;https://example.com\x07link\x1b]8;;\x07 \x1b[2J\x1b[Hx\x9b31my\x1bPdcs\x1b\\\x1b[22m",
		);
		expect(result).toBe("\x1b[1mlink xy\x1b[22m\x1b[0m");
		expect(result).not.toContain("example.com");
	});

	it("drops 8-bit sequence payloads between SGR codes", () => {
		const result = sanitizeHookStatusText(
			"\x1b[1m\x9d8;;https://example.com\x9cdocs\x9d8;;\x9c\x1b[22m \x1b[31mfoo\x9b2Jbar\x90dcs\x9c\x1b[39m",
		);
		expect(result).toBe("\x1b[1mdocs\x1b[22m \x1b[31mfoobar\x1b[39m\x1b[0m");
		expect(result).not.toContain("example.com");
	});

	it("matches sanitizeStatusText byte-for-byte for unstyled input", () => {
		for (const input of [ESCAPE_FIXTURE, "  a\tb\r\nc  "]) {
			expect(sanitizeHookStatusText(input)).toBe(sanitizeStatusText(input));
		}
	});

	it("collapses and trims whitespace by visible text regardless of SGR placement", () => {
		expect(sanitizeHookStatusText("\x1b[31m  a \x1b[39m \x1b[32m b  \x1b[39m")).toBe(
			"\x1b[31ma \x1b[39m\x1b[32mb\x1b[39m\x1b[0m",
		);
	});

	it("trims Unicode whitespace at the edges like sanitizeStatusText", () => {
		expect(sanitizeHookStatusText("\x1b[31m\u00a0 a  \u3000 \x1b[39m  b\u00a0\x1b[0m")).toBe(
			"\x1b[31ma \u3000 \x1b[39mb\x1b[0m\x1b[0m",
		);
		expect(sanitizeHookStatusText("\x1b[31m\u00a0\u3000\x1b[0m")).toBe("");
	});

	it("drops lone surrogates instead of fusing them across stripped escapes", () => {
		expect(sanitizeHookStatusText("\x1b[31ma\ud83d\x1b]8;;http://x\x07\ude00b")).toBe("\x1b[31mab\x1b[0m");
		expect(sanitizeHookStatusText("\x1b[31ma\x1b \udc00b")).toBe("\x1b[31ma\x1b[0m");
	});

	it("returns empty for SGR-only or empty input", () => {
		for (const input of ["\x1b[31m\x1b[0m", "\x1b[1m   \x1b[22m", ""]) {
			expect(sanitizeHookStatusText(input)).toBe("");
		}
	});

	it("keeps 256-colour SGR and mid-string resets from animated statuses", () => {
		expect(sanitizeHookStatusText("\x1b[38;5;196m⠠\x1b[38;5;208m⠄\x1b[0m \x1b[2mcaveman level: \x1b[22mFULL")).toBe(
			"\x1b[38;5;196m⠠\x1b[38;5;208m⠄\x1b[0m \x1b[2mcaveman level: \x1b[22mFULL\x1b[0m",
		);
	});
});
