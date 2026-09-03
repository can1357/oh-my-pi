import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { thinkToolRenderer } from "../../src/tools/think";

beforeAll(async () => {
	await initTheme();
});

describe("thinkToolRenderer", () => {
	it("renders thoughts with thinkingText color and italic style", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const callComponent = thinkToolRenderer.renderCall(
			{ thoughts: "Cache the parsed config, then check invalidation." },
			{ expanded: true, isPartial: false },
			uiTheme,
		);

		expect(callComponent).toBeDefined();
		const lines = callComponent.render(100);
		const fullText = lines.join("\n");

		expect(fullText).toContain("Cache the parsed config, then check invalidation.");
		expect(fullText).toContain(uiTheme.fg("thinkingText", "Cache the parsed config, then check invalidation."));
	});

	it("has inline set to true", () => {
		expect(thinkToolRenderer.inline).toBe(true);
	});

	it("returns undefined for renderResult", () => {
		expect(thinkToolRenderer.renderResult()).toBeUndefined();
	});

	it("handles empty or missing thoughts gracefully", async () => {
		const theme = await getThemeByName("dark");
		const uiTheme = theme!;

		const emptyCall = thinkToolRenderer.renderCall({}, { expanded: true, isPartial: false }, uiTheme);
		expect(emptyCall).toBeDefined();
		expect(emptyCall.render(100)).toEqual([]);
	});
});
