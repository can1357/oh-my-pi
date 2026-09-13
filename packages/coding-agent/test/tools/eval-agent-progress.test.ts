import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalStatusEvent, EvalToolDetails } from "@oh-my-pi/pi-coding-agent/eval/types";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { evalToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { thinkingLevelGlyph } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { visibleWidth } from "@oh-my-pi/pi-tui";

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

	afterEach(() => {
		settings.clearOverride("task.showResolvedModelBadge");
	});

	function render(statusEvents: EvalStatusEvent[], status: "running" | "complete" = "running"): string[] {
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
			{ expanded: false, isPartial: status === "running", spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(120).join("\n")).split("\n");
	}

	/** Index of the box's closing border (bottom-right corner glyph). */
	function boxBottomIndex(lines: readonly string[]): number {
		return lines.findIndex(line => line.includes(theme.boxRound.bottomRight));
	}

	it("draws a running subagent below the box with its current tool and intent", () => {
		settings.override("task.showResolvedModelBadge", true);
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
			resolvedModel: "p/model:high:high",
			resolvedModelIdentity: "p/model:high",
			resolvedThinkingLevel: ThinkingLevel.High,
			advisor: true,
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
		expect(below).toContain(
			`${thinkingLevelGlyph(ThinkingLevel.High, theme)} p/model:high ${theme.icon.advisor} 0-Scout`,
		);
		expect(below.split("p/model:high").length - 1).toBe(1);
		expect(below).not.toContain("p/model:high:high");
		// Agent progress is NOT folded into the box's Status section.
		expect(inside).not.toContain("0-Scout");
		expect(inside).not.toContain("Reading config");
	});

	it("keeps full stats on a completed subagent below the box", () => {
		settings.override("task.showResolvedModelBadge", true);
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
			model: "p/model:low:high",
			resolvedModelIdentity: "p/model:low",
			resolvedThinkingLevel: ThinkingLevel.High,
			advisor: false,
		};

		const lines = render([event], "complete");
		const bottom = boxBottomIndex(lines);
		const idLine = lines.findIndex(line => line.includes("0-Scout"));
		expect(idLine).toBeGreaterThan(bottom);

		const below = lines.slice(bottom + 1).join("\n");
		// Cost stat survives the completed snapshot.
		expect(below).toContain("$0.06");
		expect(below).toContain(`${thinkingLevelGlyph(ThinkingLevel.High, theme)} p/model:low 0-Scout`);
		expect(below.split("p/model:low").length - 1).toBe(1);
		expect(below).not.toContain("p/model:low:high");
		expect(below).not.toContain(theme.icon.advisor);
	});

	it("preserves legacy model fields without inferring thinking levels from their suffixes", () => {
		settings.override("task.showResolvedModelBadge", true);
		const lines = render([
			{
				op: "agent",
				id: "LegacyModel",
				status: "running",
				model: "p/model:high",
				resolvedModel: "p/unused:max",
			},
			{
				op: "agent",
				id: "LegacyResolved",
				status: "completed",
				resolvedModel: "p/model:max",
			},
			{
				op: "agent",
				id: "LiteralAuto",
				status: "completed",
				resolvedModelIdentity: "p/model:auto",
				resolvedThinkingLevel: "invalid",
			},
		]);
		const below = lines.slice(boxBottomIndex(lines) + 1).join("\n");

		expect(below).toContain("p/model:high LegacyModel");
		expect(below).toContain("p/model:max LegacyResolved");
		expect(below).toContain("p/model:auto LiteralAuto");
		expect(below).not.toContain("p/unused");
		expect(below).not.toContain(thinkingLevelGlyph(ThinkingLevel.High, theme));
		expect(below).not.toContain(thinkingLevelGlyph(ThinkingLevel.Max, theme));
	});

	it("hides the entire agent badge when disabled without hiding live tool activity", () => {
		settings.override("task.showResolvedModelBadge", false);
		const lines = render([
			{
				op: "agent",
				id: "0-Scout",
				agent: "task",
				status: "running",
				model: "p/model:high",
				advisor: true,
				currentTool: "read",
				lastIntent: "Reading config",
			},
		]);
		const below = lines.slice(boxBottomIndex(lines) + 1).join("\n");
		expect(below).toContain("0-Scout");
		expect(below).toContain("Reading config");
		expect(below).not.toContain("p/model");
		expect(below).not.toContain(thinkingLevelGlyph(ThinkingLevel.High, theme));
		expect(below).not.toContain(theme.icon.advisor);
	});

	it("renders one line per subagent for a parallel fan-out", () => {
		const events: EvalStatusEvent[] = [
			{ op: "agent", id: "0-Alpha", agent: "task", status: "running", lastIntent: "scanning" },
			{ op: "agent", id: "1-Beta", agent: "task", status: "completed", toolCount: 3, durationMs: 900 },
			{ op: "agent", id: "2-Gamma", agent: "task", status: "running", currentTool: "search" },
		];

		const lines = render(events);
		const below = lines.slice(boxBottomIndex(lines) + 1).join("\n");
		expect(below).toContain("0-Alpha");
		expect(below).toContain("1-Beta");
		expect(below).toContain("2-Gamma");
	});

	it("renders model-bearing events before settings initialization", async () => {
		resetSettingsForTest();
		try {
			const lines = render([
				{
					op: "agent",
					id: "ColdStart",
					status: "failed",
					resolvedModelIdentity: "provider/model",
					advisor: true,
				},
			]);
			const text = lines.slice(boxBottomIndex(lines) + 1).join("\n");
			expect(text).toContain("ColdStart");
			expect(text).toContain("failed");
			expect(text).not.toContain("provider/model");
			expect(text).not.toContain(theme.icon.advisor);
		} finally {
			await Settings.init({ inMemory: true });
		}
	});

	it("reserves failure status for oversized IDs even when badges are disabled", () => {
		settings.override("task.showResolvedModelBadge", false);
		const lines = render([
			{
				op: "agent",
				id: `LongWorker${"界".repeat(100)}`,
				status: "failed",
				resolvedModelIdentity: "provider/model",
				advisor: true,
			},
		]);
		const row = lines.slice(boxBottomIndex(lines) + 1).find(line => line.includes("LongWorker"))!;
		expect(row).toContain("failed");
		expect(row).not.toContain("provider/model");
		expect(visibleWidth(row)).toBeLessThanOrEqual(120);
	});

	it("keeps agent identities and failure status within the viewport across resizes", () => {
		settings.override("task.showResolvedModelBadge", true);
		const model = "openai-codex/gpt-6-astra";
		const intent = "Reading renderer and framework boundaries";
		const statusEvents: EvalStatusEvent[] = [
			{
				op: "agent",
				id: "ArchitectureScout",
				status: "failed",
				resolvedModelIdentity: model,
				resolvedThinkingLevel: ThinkingLevel.High,
				advisor: true,
				toolCount: 7,
				contextTokens: 8000,
				contextWindow: 200000,
				cost: 0.06,
				durationMs: 1500,
			},
			{
				op: "agent",
				id: "ResearchScout",
				status: "running",
				resolvedModelIdentity: model,
				currentTool: "read",
				lastIntent: intent,
			},
			{
				op: "agent",
				id: "CancelledScout",
				status: "aborted",
				resolvedModelIdentity: `${model}/${"extended-identity-".repeat(8)}end`,
				cost: 0.09,
			},
		];
		const details: EvalToolDetails = {
			language: "python",
			languages: ["python"],
			cells: [
				{
					index: 0,
					code: "results = parallel([...])",
					language: "python",
					output: "",
					status: "running",
					statusEvents,
				},
			],
		};
		const component = evalToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			theme,
		);

		for (const width of [40, 120, 40]) {
			const lines = component.render(width);
			const bottom = boxBottomIndex(lines);
			expect(bottom).toBeGreaterThanOrEqual(0);
			const below = lines.slice(bottom + 1);
			for (const line of below) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const text = Bun.stripANSI(below.join("\n"));
			expect(Bun.stripANSI(below[0])).toContain("ArchitectureScout");
			expect(Bun.stripANSI(below[0])).toContain("failed");
			expect(text).toContain("ResearchScout");
			expect(text).toContain("CancelledScout");
			expect(text).toContain("aborted");
			expect(text).toContain("read");
			if (width === 120) {
				expect(text).toContain(model);
				expect(text).toContain("$0.06");
				expect(text).toContain("$0.09");
				expect(text).toContain(intent);
			}
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
