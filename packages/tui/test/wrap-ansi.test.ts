import { describe, expect, it } from "bun:test";
import { visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui/utils";

describe("wrapTextWithAnsi", () => {
	describe("underline styling", () => {
		it("should not apply underline style before the styled text", () => {
			const underlineOn = "\x1b[4m";
			const underlineOff = "\x1b[24m";
			const url = "https://example.com/very/long/path/that/will/wrap";
			const text = `read this thread ${underlineOn}${url}${underlineOff}`;

			const wrapped = wrapTextWithAnsi(text, 40);

			// First line should NOT contain underline code - it's just "read this thread"
			expect(wrapped[0]).toBe("read this thread");

			// Second line should start with underline, have URL content
			expect(wrapped[1].startsWith(underlineOn)).toStrictEqual(true);
			expect(wrapped[1].includes("https://")).toBe(true);
		});

		it("should not have whitespace before underline reset code", () => {
			const underlineOn = "\x1b[4m";
			const underlineOff = "\x1b[24m";
			const textWithUnderlinedTrailingSpace = `${underlineOn}underlined text here ${underlineOff}more`;

			const wrapped = wrapTextWithAnsi(textWithUnderlinedTrailingSpace, 18);

			expect(wrapped[0].includes(` ${underlineOff}`)).toBe(false);
		});

		it("should not bleed underline to padding - each line should end with reset for underline only", () => {
			const underlineOn = "\x1b[4m";
			const underlineOff = "\x1b[24m";
			const url = "https://example.com/very/long/path/that/will/definitely/wrap";
			const text = `prefix ${underlineOn}${url}${underlineOff} suffix`;

			const wrapped = wrapTextWithAnsi(text, 30);

			// Middle lines (with underlined content) should end with underline-off, not full reset
			// Line 1 and 2 contain underlined URL parts
			for (let i = 1; i < wrapped.length - 1; i++) {
				const line = wrapped[i];
				if (line.includes(underlineOn)) {
					// Should end with underline off, NOT full reset
					expect(line.endsWith(underlineOff)).toBe(true);
					expect(line.endsWith("\x1b[0m")).toBe(false);
				}
			}
		});
	});

	describe("background color preservation", () => {
		it("should preserve background color across wrapped lines without full reset", () => {
			const bgBlue = "\x1b[44m";
			const reset = "\x1b[0m";
			const text = `${bgBlue}hello world this is blue background text${reset}`;

			const wrapped = wrapTextWithAnsi(text, 15);

			// Each line should have background color
			for (const line of wrapped) {
				expect(line.includes(bgBlue)).toBe(true);
			}

			// Middle lines should NOT end with full reset (kills background for padding)
			for (let i = 0; i < wrapped.length - 1; i++) {
				expect(wrapped[i].endsWith("\x1b[0m")).toBe(false);
			}
		});

		it("should reset underline but preserve background when wrapping underlined text inside background", () => {
			const underlineOn = "\x1b[4m";
			const underlineOff = "\x1b[24m";
			const reset = "\x1b[0m";

			const text = `\x1b[41mprefix ${underlineOn}UNDERLINED_CONTENT_THAT_WRAPS${underlineOff} suffix${reset}`;

			const wrapped = wrapTextWithAnsi(text, 20);

			// All lines should have background color 41 (either as \x1b[41m or combined like \x1b[4;41m)
			for (const line of wrapped) {
				const hasBgColor = line.includes("[41m") || line.includes(";41m") || line.includes("[41;");
				expect(hasBgColor).toBe(true);
			}

			// Lines with underlined content should use underline-off at end, not full reset
			for (let i = 0; i < wrapped.length - 1; i++) {
				const line = wrapped[i];
				// If this line has underline on, it should end with underline off (not full reset)
				if (
					(line.includes("[4m") || line.includes("[4;") || line.includes(";4m")) &&
					!line.includes(underlineOff)
				) {
					expect(line.endsWith(underlineOff)).toBe(true);
					expect(line.endsWith("\x1b[0m")).toBe(false);
				}
			}
		});
	});

	describe("strikethrough styling", () => {
		it("disables strikethrough at wrapped line ends while preserving fg/bg colors", () => {
			const strikeOn = "\x1b[9m";
			const strikeOff = "\x1b[29m";
			const fgRed = "\x1b[38;5;196m";
			const bgGray = "\x1b[48;5;236m";
			const reset = "\x1b[0m";
			const text = `${fgRed}${bgGray}${strikeOn}strikethrough content that wraps across lines${strikeOff}${reset}`;

			const wrapped = wrapTextWithAnsi(text, 16);
			expect(wrapped.length).toBeGreaterThan(1);

			for (let i = 0; i < wrapped.length - 1; i++) {
				const line = wrapped[i];
				if (line.includes(strikeOn) || line.includes(";9") || line.includes("[9;")) {
					expect(line.endsWith(strikeOff)).toBe(true);
					expect(line.endsWith("\x1b[0m")).toBe(false);
				}
			}

			for (let i = 1; i < wrapped.length; i++) {
				const line = wrapped[i];
				expect(line.includes("38;5;196")).toBe(true);
				expect(line.includes("48;5;236")).toBe(true);
			}
		});
	});
	describe("basic wrapping", () => {
		it("should wrap plain text correctly", () => {
			const text = "hello world this is a test";
			const wrapped = wrapTextWithAnsi(text, 10);

			expect(wrapped.length > 1).toBe(true);
			for (const line of wrapped) {
				expect(visibleWidth(line) <= 10).toBe(true);
			}
		});

		it("should truncate trailing whitespace that exceeds width", () => {
			const twoSpacesWrappedToWidth1 = wrapTextWithAnsi("  ", 1);
			expect(visibleWidth(twoSpacesWrappedToWidth1[0]) <= 1).toBe(true);
		});

		it("should preserve color codes across wraps", () => {
			const red = "\x1b[31m";
			const reset = "\x1b[0m";
			const text = `${red}hello world this is red${reset}`;

			const wrapped = wrapTextWithAnsi(text, 10);

			// Each continuation line should start with red code
			for (let i = 1; i < wrapped.length; i++) {
				expect(wrapped[i].startsWith(red)).toBe(true);
			}

			// Middle lines should not end with full reset
			for (let i = 0; i < wrapped.length - 1; i++) {
				expect(wrapped[i].endsWith("\x1b[0m")).toBe(false);
			}
		});
	});
});
