import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { evalToolRenderer } from "@oh-my-pi/pi-tui/tools/eval";

describe("eval renderer: display-only streaming formatting", () => {
	let theme: Theme;
	const source = "if (ready) {run();finish();}";

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		setThemeInstance(theme);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("preserves percent command package identifiers instead of formatting them as JavaScript operators", () => {
		const command = "%bun add csv-parse@5";
		const rendered = Bun.stripANSI(
			evalToolRenderer
				.renderCall({ language: "js", code: command }, { expanded: true, isPartial: true }, theme)
				.render(120)
				.join("\n"),
		);
		expect(rendered).toContain(command);
	});

	it("expands compact source in both pending and completed previews", () => {
		const pending = Bun.stripANSI(
			evalToolRenderer
				.renderCall({ language: "js", code: source }, { expanded: true, isPartial: true }, theme)
				.render(120)
				.join("\n"),
		);
		const details: EvalToolDetails = {
			language: "js",
			languages: ["js"],
			cells: [{ index: 0, code: source, language: "js", output: "", status: "complete" }],
		};
		const completed = Bun.stripANSI(
			evalToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "" }], details },
					{ expanded: true, isPartial: false },
					theme,
				)
				.render(120)
				.join("\n"),
		);

		for (const rendered of [pending, completed]) {
			expect(rendered).toContain("run();");
			expect(rendered).toContain("finish();");
			expect(rendered).not.toContain("run();finish();");
		}
	});
});
