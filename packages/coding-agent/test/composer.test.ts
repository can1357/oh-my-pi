/**
 * Composer (intent-first layout) contracts:
 * - Ask mode's toolset is a fail-closed subset of the read approval tier.
 * - Mode cycling honors plan availability.
 * - CTA labels follow the active work mode (Ask=Send, Build/Plan=Run).
 * - The execution rail keeps the primary action visible, and swaps to
 *   queue/stop semantics while a turn is streaming (cancellation exists).
 * - Context chips collapse into a "+N more" summary instead of overflowing.
 * - The mode bar marks the selected mode with a non-color signal and hides
 *   unavailable modes.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@pk-nerdsaver-ai/pi-tui";
import {
	buildChipsRow,
	buildRailRow,
	COMPOSER_WORK_MODES,
	ComposerModeBar,
	computeAskModeTools,
	getComposerWorkModeDef,
	nextComposerWorkMode,
} from "../src/modes/components/composer";
import { initTheme } from "../src/modes/theme/theme";
import { READ_ONLY_TOOL_NAMES } from "../src/task";

beforeAll(async () => {
	await initTheme();
});

describe("Ask mode tool restriction", () => {
	it("keeps only explicitly observational tools and drops mutation/delegation tools", () => {
		const active = [
			"read",
			"search",
			"find",
			"web_search",
			"ast_grep",
			"inspect_image",
			"recall",
			"reflect",
			"todo",
			"job",
			"irc",
			"yield",
			"resolve",
			"report_finding",
			"search_tool_bm25",
			"retain",
			"memory_edit",
			"checkpoint",
			"rewind",
			"edit",
			"bash",
			"mcp__foo_bar",
		];
		expect(computeAskModeTools(active)).toEqual([
			"read",
			"search",
			"find",
			"web_search",
			"ast_grep",
			"inspect_image",
			"recall",
			"reflect",
		]);
	});

	it("only ever yields tools from the read approval tier", () => {
		const everything = [...READ_ONLY_TOOL_NAMES, "edit", "bash", "eval", "browser", "ssh"];
		for (const tool of computeAskModeTools(everything)) {
			expect(READ_ONLY_TOOL_NAMES.has(tool)).toBe(true);
		}
	});
});

describe("Work-mode cycling and CTA labels", () => {
	it("cycles ask → build → plan → ask when plan mode is available", () => {
		expect(nextComposerWorkMode("ask", true)).toBe("build");
		expect(nextComposerWorkMode("build", true)).toBe("plan");
		expect(nextComposerWorkMode("plan", true)).toBe("ask");
	});

	it("skips plan when plan mode is disabled", () => {
		expect(nextComposerWorkMode("build", false)).toBe("ask");
		expect(nextComposerWorkMode("ask", false)).toBe("build");
	});

	it("labels the primary action Send for Ask and Run for Build/Plan", () => {
		expect(getComposerWorkModeDef("ask").cta).toBe("Send");
		expect(getComposerWorkModeDef("build").cta).toBe("Run");
		expect(getComposerWorkModeDef("plan").cta).toBe("Run");
	});
});

describe("Execution rail", () => {
	const idle = { modeLabel: "Build", cta: "Run", streaming: false, hasInput: true, queuedCount: 0 };

	it("right-aligns the CTA and never exceeds the width", () => {
		const row = buildRailRow(idle, 60);
		const plain = stripVTControlCharacters(row);
		expect(plain.endsWith("Run ⏎")).toBe(true);
		expect(plain).toContain("◆ Build");
		expect(visibleWidth(plain)).toBeLessThanOrEqual(60);
	});

	it("keeps the primary action visible on narrow widths by trimming the left side", () => {
		const plain = stripVTControlCharacters(buildRailRow(idle, 14));
		expect(plain).toContain("Run ⏎");
		expect(visibleWidth(plain)).toBeLessThanOrEqual(14);
	});

	it("swaps to queue/stop semantics while streaming (cancellation is supported)", () => {
		const plain = stripVTControlCharacters(
			buildRailRow({ ...idle, streaming: true, queuedCount: 2, stopKeyHint: "esc" }, 60),
		);
		expect(plain).toContain("esc stop");
		expect(plain).toContain("queue (2)");
		expect(plain).not.toContain("Run ⏎");
	});
	it("labels a focused-session rail without promising Ask protection", () => {
		const plain = stripVTControlCharacters(
			buildRailRow({ ...idle, modeLabel: "Focused", cta: "Send", streaming: true, queuedCount: 1 }, 60),
		);
		expect(plain).toContain("◆ Focused");
		expect(plain).toContain("queue (1)");
		expect(plain).not.toContain("◆ Ask");
	});
});

describe("Context chips", () => {
	it("renders every chip when they fit", () => {
		const plain = stripVTControlCharacters(
			buildChipsRow(
				[
					{ label: "ompk/main", kind: "auto" },
					{ label: "2 images", kind: "attached" },
				],
				60,
			) ?? "",
		);
		expect(plain).toBe("[ompk/main] [2 images]");
	});

	it("collapses overflow into a +N more summary within the width budget", () => {
		const chips = Array.from({ length: 6 }, (_, i) => ({ label: `chip-number-${i}`, kind: "auto" as const }));
		const row = buildChipsRow(chips, 40);
		const plain = stripVTControlCharacters(row ?? "");
		expect(plain).toMatch(/\+\d+ more$/);
		expect(visibleWidth(plain)).toBeLessThanOrEqual(40);
	});

	it("returns nothing for an empty chip set", () => {
		expect(buildChipsRow([], 40)).toBeUndefined();
	});
});

describe("Mode bar", () => {
	function makeBar(selected: "ask" | "build" | "plan", planAvailable = true, enabled = true) {
		return new ComposerModeBar({
			isEnabled: () => enabled,
			getSelectedMode: () => selected,
			isModeAvailable: mode => (mode === "plan" ? planAvailable : true),
			getCycleKeyHint: () => "alt+shift+m",
		});
	}

	it("marks the selected mode with the ◆ marker (non-color signal) and shows all available modes", () => {
		const plain = makeBar("build")
			.render(100)
			.map(line => stripVTControlCharacters(line))
			.join("\n");
		expect(plain).toContain("◆ Build");
		expect(plain).not.toContain("◆ Ask");
		for (const mode of COMPOSER_WORK_MODES) {
			expect(plain).toContain(mode.label);
		}
	});

	it("hides unavailable modes instead of presenting fake capabilities", () => {
		const plain = makeBar("build", false)
			.render(100)
			.map(line => stripVTControlCharacters(line))
			.join("\n");
		expect(plain).not.toContain("Plan");
	});

	it("renders nothing when the intent layout is disabled", () => {
		expect(makeBar("build", true, false).render(100)).toEqual([]);
	});
	it("reports wrapped mode-bar rows for narrow layouts", () => {
		const bar = makeBar("build");
		expect(bar.rowCount(20)).toBeGreaterThanOrEqual(1);
		expect(bar.rowCount(20)).toBe(bar.render(20).length);
	});

	it("never exceeds the render width", () => {
		for (const width of [20, 40, 100]) {
			for (const line of makeBar("plan").render(width)) {
				expect(visibleWidth(stripVTControlCharacters(line))).toBeLessThanOrEqual(width);
			}
		}
	});
});
