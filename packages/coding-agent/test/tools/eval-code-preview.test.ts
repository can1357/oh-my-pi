import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalToolDetails } from "@oh-my-pi/pi-coding-agent/eval/types";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { evalToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { previewWindowRows } from "@oh-my-pi/pi-coding-agent/tools/render-utils";

/**
 * Defends the bounded code-window contract for eval cells: collapsed views cap
 * the cell source to a viewport-sized TAIL window (the end stays visible, the
 * head is elided behind an "earlier lines" marker) in BOTH the pending preview
 * and the final result, so a long cell neither floods the transcript nor snaps
 * open when the result lands. Only ctrl+o (expanded) uncaps.
 */
describe("eval renderer: viewport tail window for cell code", () => {
	let theme: Theme;
	const total = previewWindowRows() + 5;
	const code = Array.from({ length: total }, (_, i) => `value_${i} = ${i}`).join("\n");
	const firstLine = "value_0 = 0";
	const lastLine = `value_${total - 1} = ${total - 1}`;

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

	function renderResult(expanded: boolean): string {
		const details: EvalToolDetails = {
			language: "python",
			languages: ["python"],
			cells: [{ index: 0, code, language: "python", output: "", status: "complete", statusEvents: [] }],
		};
		const component = evalToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded, isPartial: false, spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(120).join("\n"));
	}

	it("caps collapsed result code to the tail window with an earlier-lines marker", () => {
		const rendered = renderResult(false);
		expect(rendered).toContain(lastLine);
		expect(rendered).toContain("earlier line");
		expect(rendered).not.toContain(firstLine);
	});

	it("shows the full source when expanded", () => {
		const rendered = renderResult(true);
		expect(rendered).toContain(firstLine);
		expect(rendered).toContain(lastLine);
		expect(rendered).not.toContain("earlier line");
	});

	it("bounds the pending preview to the same live tail window", () => {
		const component = evalToolRenderer.renderCall(
			{ language: "py", code },
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		// Newest streamed line stays visible; earliest lines are elided above it.
		expect(rendered).toContain(lastLine);
		expect(rendered).toContain("earlier line");
		expect(rendered).not.toContain(firstLine);
	});
});
