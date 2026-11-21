import { beforeAll, describe, expect, it } from "bun:test";
import type { ShellVizPreferences, ShellVizPresentation, ShellVizRow } from "@oh-my-pi/pi-wire";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { ShellVisualizer } from "@oh-my-pi/pi-tui/apps/shell-visualizer";
import {
	changeShellVizPreferences,
	SHELL_VIZ_LAYERS,
	SHELL_VIZ_VIEWS,
	shellVizEventAction,
} from "@oh-my-pi/pi-tui/tools/shell-trace";
import { defaultShellVizPreferences } from "@oh-my-pi/pi-tui/tools/shell-viz";
import { renderShellVisualization } from "@oh-my-pi/pi-tui/tools/shell-viz-render";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

function row(node: string, text: string): ShellVizRow {
	return {
		id: String(node),
		depth: 0,
		node,
		state: "ok",
		segments: [{ text, node, style: "cmd", expanded: "full expansion", tip: "inspection detail" }],
		effects: [],
	};
}
function fixture(): ShellVizPresentation {
	const rows = [row("0:0:1", "echo first"), row("0:0:2", "echo second")];
	return {
		preferences: defaultShellVizPreferences(),
		rows,
		original: rows,
		watches: [],
		executing: false,
		output: "",
		timeline: { length: 4, cursor: 4, elapsedNs: 4, durationNs: 4 },
	};
}

let theme: Theme;
beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("Expected dark theme");
	theme = loaded;
	setThemeInstance(theme);
});

describe("shell visualization controls", () => {
	it("toggles Raw and Pseudo independently of layers and selection", () => {
		let prefs: ShellVizPreferences = { ...defaultShellVizPreferences(), selectedNode: "0:0:2", cursor: 3 };
		for (const view of SHELL_VIZ_VIEWS) {
			prefs = { ...prefs, ...changeShellVizPreferences(prefs, `view:${view}`, 4) };
			expect(prefs.view).toBe(view);
			expect(prefs.selectedNode).toBe("0:0:2");
			expect(prefs.cursor).toBe(3);
		}
		for (const layer of SHELL_VIZ_LAYERS) {
			const next = changeShellVizPreferences(prefs, `layer:${layer}`, 4);
			expect(next.layers[layer]).toBe(!prefs.layers[layer]);
			for (const other of SHELL_VIZ_LAYERS.filter(item => item !== layer))
				expect(next.layers[other]).toBe(prefs.layers[other]);
		}
	});
	it("clamps seek, rejects invalid numeric actions, and distinguishes end from live", () => {
		const initial = defaultShellVizPreferences();
		expect(changeShellVizPreferences(initial, "seek:999", 4).cursor).toBe(4);
		expect(changeShellVizPreferences(initial, "select:1.5", 4)).toBe(initial);
		expect(changeShellVizPreferences(initial, "select:2", 4)).toBe(initial);
		expect(changeShellVizPreferences(initial, "select:0:0:2", 4).selectedNode).toBe("0:0:2");
		const expanded = changeShellVizPreferences(initial, "expand:0:0:2", 4);
		expect(expanded.expandedNodes).toEqual(["0:0:2"]);
		expect(changeShellVizPreferences(expanded, "expand:0:0:2", 4).expandedNodes).toEqual([]);
		expect(changeShellVizPreferences(initial, "speed:3", 4)).toBe(initial);
		expect(changeShellVizPreferences(initial, "play", 4)).toMatchObject({ playing: true, cursor: 0 });
		expect(changeShellVizPreferences(initial, "reset", 4)).toMatchObject({ playing: false, cursor: 0 });
		expect(changeShellVizPreferences(changeShellVizPreferences(initial, "reset", 4), "step", 4).cursor).toBe(1);
		expect(changeShellVizPreferences({ ...initial, cursor: 2 }, "live", 4).cursor).toBeUndefined();
	});
	it("normalizes native actions and idempotent change values to the same controller", () => {
		const prefs = defaultShellVizPreferences();
		expect(
			shellVizEventAction({ type: "action", key: "input", act: "shell-viz", value: "view:raw", mods: [] }, prefs),
		).toBe("view:raw");
		expect(shellVizEventAction({ type: "change", key: "input", item: "view", value: "pseudo" }, prefs)).toBe(
			"view:pseudo",
		);
		expect(
			shellVizEventAction({ type: "change", key: "input", item: "layer:color", value: true }, prefs),
		).toBeUndefined();
		expect(shellVizEventAction({ type: "change", key: "input", item: "layer:color", value: false }, prefs)).toBe(
			"layer:color",
		);
		expect(shellVizEventAction({ type: "select", key: "input", item: "0:0:2" }, prefs)).toBe("select:0:0:2");
		expect(shellVizEventAction({ type: "change", key: "input", item: "select", value: "0:0:2" }, prefs)).toBe(
			"select:0:0:2",
		);
	});
	it("focused keyboard controls select and expand chips and Escape closes", () => {
		const presentation = fixture();
		let closed = false;
		const inspector = new ShellVisualizer({
			presentation: () => presentation,
			replayEpoch: () => 0,
			liveOrigin: () => false,
			action: value => {
				presentation.preferences = changeShellVizPreferences(presentation.preferences, value, 4);
			},
			close: () => {
				closed = true;
			},
			requestRender: () => {},
			height: () => 30,
		});
		for (let index = 1; index <= SHELL_VIZ_VIEWS.length; index++) {
			inspector.handleInput(String(index));
			expect(presentation.preferences.view).toBe(SHELL_VIZ_VIEWS[index - 1]);
		}
		inspector.handleInput("j");
		expect(presentation.preferences.selectedNode).toBe("0:0:1");
		inspector.handleInput("\r");
		expect(presentation.preferences.expandedNodes).toEqual(["0:0:1"]);
		expect(inspector.render(100).join("\n")).toContain("full expansion");
		inspector.handleInput("s");
		expect(presentation.preferences.split).toBe(true);
		inspector.handleInput(" ");
		expect(presentation.preferences.playing).toBe(true);
		inspector.handleInput("r");
		expect(presentation.preferences.cursor).toBe(0);
		inspector.handleInput(".");
		expect(presentation.preferences.cursor).toBe(1);
		inspector.handleInput("l");
		expect(presentation.preferences.cursor).toBeUndefined();
		inspector.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});

describe("shell semantic ANSI views", () => {
	it("keeps every pane width-bounded, sanitizes escapes, and announces stacked split", () => {
		const presentation = fixture();
		presentation.preferences.split = true;
		presentation.rows[0].segments[0].text = "echo\t\x1b[2J" + "long".repeat(50);
		for (const width of [12, 50, 120]) {
			const lines = renderShellVisualization(presentation, theme, width);
			expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
			expect(lines.join("\n")).not.toContain("\x1b[2J");
			expect(lines.join("\n")).not.toContain("\t");
		}
		expect(Bun.stripANSI(renderShellVisualization(presentation, theme, 70).join("\n"))).toContain("Split stacked");
	});
	it("wraps the complete Raw source instead of losing the tail of a long command", () => {
		const presentation = fixture();
		presentation.preferences.view = "raw";
		const source = `printf '${"0123456789".repeat(18)}END-OF-COMMAND'`;
		presentation.rows = [row("0:0:1", source)];
		const lines = renderShellVisualization(presentation, theme, 30);
		// Continuations hang under the row's gutter; the source itself is uninterrupted.
		const plain = lines.map(line => Bun.stripANSI(line).trim()).join("");
		expect(plain).toContain("0123456789".repeat(18));
		expect(plain).toContain("END-OF-COMMAND'");
		expect(lines.every(line => visibleWidth(line) <= 30)).toBe(true);
	});
	it("shows a failed pipeline stage once even when its governing row succeeded", () => {
		const presentation = fixture();
		presentation.rows = [
			{
				...row("0:0:1", ""),
				state: "ok",
				segments: [
					{ text: "false", node: "0:0:3", state: "fail" },
					{ text: " | " },
					{ text: "true", node: "0:0:4", state: "ok" },
				],
			},
		];
		const plain = Bun.stripANSI(renderShellVisualization(presentation, theme, 100).join("\n"));
		expect(plain.match(/×/g)).toHaveLength(1);
		expect(plain).toContain("× false | true");
		presentation.rows[0].state = "fail";
		presentation.rows[0].node = "0:0:3";
		expect(Bun.stripANSI(renderShellVisualization(presentation, theme, 100).join("\n")).match(/×/g)).toHaveLength(1);
	});
	it("dims inactive executable parts without success checkmarks, retaining failure marks", () => {
		const presentation = fixture();
		presentation.running = true;
		presentation.rows[0].active = true;
		presentation.rows[0].segments = [
			{ text: "echo active", style: "cmd", active: true },
			{ text: "inactive", style: "str", active: false },
		];
		presentation.rows[1].state = "fail";
		presentation.rows[1].meta = "exit 7";
		const lines = renderShellVisualization(presentation, theme, 100);
		expect(lines[0]).toContain(theme.faint(theme.fg("syntaxString", "inactive")));
		expect(Bun.stripANSI(lines[0])).toContain("▶");
		const plain = Bun.stripANSI(lines.join("\n"));
		expect(plain).not.toMatch(/[✓✔]/);
		expect(plain).toContain("×");
		expect(plain).toContain("exit 7");
	});
	it("marks only the running statement, not the script rows that run with it", () => {
		const presentation = fixture();
		presentation.running = true;
		presentation.rows[0].segments[0].active = true;
		presentation.rows[0].active = true;
		presentation.rows[1] = { ...row("0:0:1", ""), role: "document", active: true };
		presentation.rows[1].segments = [{ text: "import", style: "kw" }];
		const lines = renderShellVisualization(presentation, theme, 100);
		expect(Bun.stripANSI(lines[0])).toContain("▶");
		expect(Bun.stripANSI(lines[1])).not.toContain("▶");
	});
});
