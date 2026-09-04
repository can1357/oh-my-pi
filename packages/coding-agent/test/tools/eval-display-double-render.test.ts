import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import * as pyKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool, evalToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/eval";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
}

function baseResult(overrides: Record<string, unknown> = {}) {
	return {
		output: "",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		displayOutputs: [] as unknown[],
		...overrides,
	};
}

/**
 * Regression for #10778: a single structured `display()` value must render
 * exactly once in the rich TUI (the expandable JSON tree), not twice (a JSON
 * serialization inside the code-cell box *and* the tree). The model-facing
 * `result.content` must still carry the textual `display[N]:` serialization.
 */
describe("eval renderer: structured display() value renders once", () => {
	let theme: Theme;

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

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows the display value in the JSON tree only, not inside the cell box", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { marker: "ZZUNIQUE", exit_code: 0 } }],
			}) as never,
		);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-display-json", {
			language: "js",
			code: "```js\nconst result = await tool.bash({ command: 'printf test' });\ndisplay(result);\n```\n",
		});
		const modelText = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(modelText).toContain("display[1]");
		expect(modelText).toContain('"marker": "ZZUNIQUE"');

		// Render the rich TUI and split around the code-cell box border.
		const component = evalToolRenderer.renderResult(
			{ content: result.content, details: result.details },
			{ expanded: true, isPartial: false, spinnerFrame: 0 },
			theme,
		);
		const rendered = Bun.stripANSI(component.render(120).join("\n")).split("\n");
		const boxBottom = rendered.findIndex(line => line.includes(theme.boxRound.bottomRight));
		expect(boxBottom).toBeGreaterThanOrEqual(0);

		const insideBox = rendered.slice(0, boxBottom + 1);
		const belowBox = rendered.slice(boxBottom + 1);

		// The structured value must appear only once — in the tree below the box.
		expect(insideBox.some(line => line.includes("ZZUNIQUE"))).toBe(false);
		expect(insideBox.some(line => line.includes("display[1]"))).toBe(false);
		expect(belowBox.some(line => line.includes("ZZUNIQUE"))).toBe(true);
		expect(rendered.filter(line => line.includes("ZZUNIQUE")).length).toBe(1);
	});
});
