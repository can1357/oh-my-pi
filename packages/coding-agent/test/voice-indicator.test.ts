import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { VoiceIndicatorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/voice-indicator";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("VoiceIndicatorComponent", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("renders a compact listening presence without spanning the terminal", () => {
		const indicator = new VoiceIndicatorComponent("recording");
		const lines = indicator.render(30);
		const plain = lines.map(line => Bun.stripANSI(line));

		expect(lines).toHaveLength(9);
		expect(plain.join("\n")).toContain("Listening");
		expect(plain.join("\n")).toContain("speak naturally");
		expect(lines.every(line => visibleWidth(line) === 30)).toBe(true);
		expect(plain.slice(0, 7).join("")).toMatch(/[\u2800-\u28ff]/u);
	});

	it("animates in place and changes personality while transcribing", () => {
		const indicator = new VoiceIndicatorComponent("recording");
		const initial = indicator.render(30).map(line => Bun.stripANSI(line));
		for (let frame = 0; frame < 8; frame++) indicator.advance();
		const animated = indicator.render(30).map(line => Bun.stripANSI(line));
		expect(animated).not.toEqual(initial);
		const initialLabelColumn = initial.find(line => line.includes("Listening"))?.indexOf("Listening");
		const animatedLabelColumn = animated.find(line => line.includes("Listening"))?.indexOf("Listening");
		expect(animatedLabelColumn).toBe(initialLabelColumn);

		indicator.setState("transcribing");
		const transcribing = indicator.render(30).map(line => Bun.stripANSI(line));
		expect(transcribing.join("\n")).toContain("Thinking");
		expect(transcribing.join("\n")).toContain("turning voice into words");
	});
});
