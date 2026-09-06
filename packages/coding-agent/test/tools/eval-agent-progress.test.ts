import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalStatusEvent, EvalToolDetails } from "@oh-my-pi/pi-coding-agent/eval/types";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { evalToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/eval";

/**
 * Defends the contract that `agent()` calls inside an eval cell surface as a
 * live, Task-tool-style progress tree drawn *below* the notebook (code cell
 * box) — not buried inside the box's collapsed "Status" list, and not deferred
 * to the final result.
 */
describe("eval renderer: agent() progress below the cell box", () => {
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

	function render(
		statusEvents: EvalStatusEvent[],
		status: "running" | "complete" = "running",
		expanded = false,
	): string[] {
		const details: EvalToolDetails = {
			language: "python",
			languages: ["python"],
			cells: [
				{
					index: 0,
					title: "Investigate",
					code: "results = parallel([...])",
					language: "python",
					output: "",
					status,
					statusEvents,
				},
			],
		};
		const component = evalToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded, isPartial: status === "running", spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(120).join("\n")).split("\n");
	}

	/** Index of the box's closing border (bottom-right corner glyph). */
	function boxBottomIndex(lines: string[]): number {
		return lines.findIndex(line => line.includes(theme.boxRound.bottomRight));
	}

	it("draws a running subagent below the box with its current tool and intent", () => {
		const event: EvalStatusEvent = {
			op: "agent",
			id: "0-Scout",
			agent: "task",
			status: "running",
			currentTool: "read",
			currentToolArgs: "config.ts",
			lastIntent: "Reading config",
			taskPreview: "investigate the bug",
			toolCount: 4,
			contextTokens: 5000,
			contextWindow: 200000,
			cost: 0.03,
			durationMs: 800,
			model: "p/model",
		};

		const lines = render([event]);
		const bottom = boxBottomIndex(lines);
		expect(bottom).toBeGreaterThanOrEqual(0);

		const idLine = lines.findIndex(line => line.includes("0-Scout"));
		// The subagent id renders strictly *below* the closing box border.
		expect(idLine).toBeGreaterThan(bottom);

		const below = lines.slice(bottom + 1).join("\n");
		const inside = lines.slice(0, bottom + 1).join("\n");
		expect(below).toContain("0-Scout");
		expect(below).toContain("read");
		expect(below).toContain("Reading config");
		// Agent progress is NOT folded into the box's Status section.
		expect(inside).not.toContain("0-Scout");
		expect(inside).not.toContain("Reading config");
	});

	it("keeps full stats on a completed subagent below the box", () => {
		const event: EvalStatusEvent = {
			op: "agent",
			id: "0-Scout",
			agent: "task",
			status: "completed",
			toolCount: 7,
			contextTokens: 8000,
			contextWindow: 200000,
			cost: 0.06,
			durationMs: 1500,
			model: "p/model",
		};

		const lines = render([event], "complete");
		const bottom = boxBottomIndex(lines);
		const idLine = lines.findIndex(line => line.includes("0-Scout"));
		expect(idLine).toBeGreaterThan(bottom);

		const below = lines.slice(bottom + 1).join("\n");
		// Cost stat survives the completed snapshot.
		expect(below).toContain("$0.06");
	});

	it("focuses the live preview on unfinished eval subagents", () => {
		const events: EvalStatusEvent[] = [
			{ op: "agent", id: "0-Alpha", agent: "task", status: "running", lastIntent: "scanning" },
			{ op: "agent", id: "1-Beta", agent: "task", status: "completed", toolCount: 3, durationMs: 900 },
			{ op: "agent", id: "2-Gamma", agent: "task", status: "running", currentTool: "search" },
		];

		const lines = render(events);
		const below = lines.slice(boxBottomIndex(lines) + 1).join("\n");
		expect(below).toContain("0-Alpha");
		expect(below).not.toContain("1-Beta");
		expect(below).toContain("2-Gamma");
		expect(below).toContain("1 done");
	});

	it("shows settled eval subagents when expanded", () => {
		const events: EvalStatusEvent[] = [
			{ op: "agent", id: "0-Alpha", agent: "task", status: "running", lastIntent: "scanning" },
			{ op: "agent", id: "1-Beta", agent: "task", status: "completed", toolCount: 3, durationMs: 900 },
			{ op: "agent", id: "2-Gamma", agent: "task", status: "running", currentTool: "search" },
		];

		const lines = render(events, "running", true);
		const below = lines.slice(boxBottomIndex(lines) + 1).join("\n");
		for (const id of ["0-Alpha", "1-Beta", "2-Gamma"]) {
			expect(below).toContain(id);
		}
	});

	it("still folds non-agent status events into the box Status section", () => {
		const events: EvalStatusEvent[] = [
			{ op: "read", path: "/tmp/file.ts", chars: 1200 },
			{ op: "agent", id: "0-Scout", agent: "task", status: "running", lastIntent: "thinking" },
		];

		const lines = render(events);
		const bottom = boxBottomIndex(lines);
		const inside = lines.slice(0, bottom + 1).join("\n");
		const below = lines.slice(bottom + 1).join("\n");

		// Discrete ops stay inside the box; agent progress renders below it.
		expect(inside).toContain("read");
		expect(inside).toContain("file.ts");
		expect(inside).not.toContain("0-Scout");
		expect(below).toContain("0-Scout");
	});
});
