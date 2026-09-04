import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { VoiceIndicatorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/voice-indicator";
import { initTheme } from "../src/modes/theme/theme";

describe("VoiceIndicatorComponent", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("renders a stable multi-line frame for recording", () => {
		const indicator = new VoiceIndicatorComponent("recording");
		const lines = indicator.render(40);
		expect(lines.length).toBeGreaterThan(2);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(40);
		}
		const plain = lines.map(line => Bun.stripANSI(line)).join("\n");
		expect(plain).toContain("Listening");
		expect(plain).toMatch(/[\u2800-\u28ff]/u);
	});

	it("never exceeds the supplied width, including narrow terminals", () => {
		const indicator = new VoiceIndicatorComponent("recording");
		for (const width of [10, 19, 24, 40]) {
			const lines = indicator.render(width);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(width);
			}
		}
	});

	it("advances animation frames without changing width", () => {
		const indicator = new VoiceIndicatorComponent("recording");
		const first = indicator.render(32);
		indicator.advance();
		const second = indicator.render(32);
		expect(second).toHaveLength(first.length);
		for (const line of second) {
			expect(visibleWidth(line)).toBe(32);
		}
	});
});
