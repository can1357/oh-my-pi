import { describe, expect, it } from "bun:test";
import { renderAsciiBar } from "@oh-my-pi/pi-coding-agent/modes/view-model/chrome/format";

describe("renderAsciiBar", () => {
	it("preserves the visible progress-bar contract", () => {
		expect(renderAsciiBar(0.5, 4)).toBe("[██░░] 50%");
	});

	it("clamps the fraction and draws a dotted placeholder without a label when unknown", () => {
		expect(renderAsciiBar(1.7, 4)).toBe("[████] 100%");
		expect(renderAsciiBar(-1, 4)).toBe("[░░░░] 0%");
		expect(renderAsciiBar(undefined, 4)).toBe("[····]");
		expect(renderAsciiBar(Number.NaN, 4)).toBe("[····]");
	});
});
