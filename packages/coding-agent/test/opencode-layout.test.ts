import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { taskToolRenderer } from "@oh-my-pi/pi-coding-agent/task/renderer";
import type { TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import type { LayoutMode } from "@oh-my-pi/pi-coding-agent/modes/layout-mode";
import { loadTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/loader";
import { getThemeByName, initTheme, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { CachedOutputBlock, markFramedBlockComponent } from "@oh-my-pi/pi-coding-agent/tui/output-block";
import { replaceTabs, Text, type TUI, visibleWidth } from "@oh-my-pi/pi-tui";

/**
 * Contract under test (`display.layout: "opencode"`):
 *
 * - The layout is per-mode state: components capture a layout accessor at
 *   construction, so two live modes with different settings render
 *   independently in the same process (no module-global flag).
 * - A collapsed tool block renders as exactly one row — its status line (the
 *   first visible row of the card) — instead of the full card.
 * - `setExpanded(true)` (Ctrl+O) restores the complete card.
 * - An error result never collapses: the message must stay readable.
 * - The default `omp` layout (no accessor) is untouched.
 * - User messages gain a left gutter column in opencode layout.
 * - `renderOutputBlock`/`CachedOutputBlock` key on the explicit `flat` option.
 */
describe("opencode layout", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
	const opencode = (): LayoutMode => "opencode";
	const omp = (): LayoutMode => "omp";

	interface MultiLineTool {
		name: string;
		label: string;
		/** Mirror the built-in renderers: the result's first row is the status header. */
		mergeCallAndResult: boolean;
		renderResult(result: { content: Array<{ type: string; text?: string }> }): Text;
	}

	function makeMultiLineTool(): MultiLineTool {
		return {
			name: "custom_render",
			label: "Custom",
			mergeCallAndResult: true,
			renderResult(result) {
				const joined = result.content.map(c => c.text ?? "").join("");
				return new Text(`HEADLINE ${joined}\nDETAIL-1\nDETAIL-2`, 0, 0);
			},
		};
	}

	function makeComponent(tool: MultiLineTool, layout?: () => LayoutMode): ToolExecutionComponent {
		return new ToolExecutionComponent(
			"custom_render",
			{},
			{ layout },
			tool as unknown as AgentTool,
			ui,
			process.cwd(),
		);
	}

	function visibleRows(component: ToolExecutionComponent, width = 80): string[] {
		return component
			.render(width)
			.map(line => stripVTControlCharacters(line))
			.filter(line => /\S/.test(line));
	}

	it("collapses a finalized tool block to its status line; expand restores the card", () => {
		const component = makeComponent(makeMultiLineTool(), opencode);
		component.updateResult({ content: [{ type: "text", text: "ok" }] }, false);

		const collapsed = visibleRows(component);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("HEADLINE ok");
		expect(collapsed[0]).not.toContain("DETAIL-1");

		component.setExpanded(true);
		const expanded = visibleRows(component).join("\n");
		expect(expanded).toContain("DETAIL-1");
		expect(expanded).toContain("DETAIL-2");
	});

	it("collapses a multi-file edit to one dim status row per file", () => {
		settings.override("tui.hyperlinks", "always");
		try {
			const paths = ["alpha.ts", "beta.ts", "gamma.ts"].map(name => path.resolve("/workspace/src", name));
			const component = new ToolExecutionComponent(
				"edit",
				{ edits: paths.map(path => ({ path, oldText: "before", newText: "after" })) },
				{ layout: opencode },
				undefined,
				ui,
				process.cwd(),
			);
			component.updateResult(
				{
					content: [],
					details: { perFileResults: paths.map(path => ({ path, diff: "" })) },
				},
				false,
			);

			const rows = component.render(80).filter(line => /\S/.test(stripVTControlCharacters(line)));
			expect(rows).toHaveLength(3);
			for (const [index, row] of rows.entries()) {
				expect(row).toContain(theme.getFgAnsi("dim"));
				expect(row).toContain(url.pathToFileURL(paths[index]!).href);
				expect(stripVTControlCharacters(row)).toContain(paths[index]!);
			}
		} finally {
			settings.clearOverride("tui.hyperlinks");
		}
	});

	it("bounds collapsed multi-file edits with a remaining-files row", () => {
		const paths = Array.from({ length: 10 }, (_, index) => `src/file-${index}.ts`);
		const component = new ToolExecutionComponent(
			"edit",
			{ edits: paths.map(path => ({ path, oldText: "before", newText: "after" })) },
			{ layout: opencode },
			undefined,
			ui,
			process.cwd(),
		);
		component.updateResult(
			{
				content: [],
				details: { perFileResults: paths.map(path => ({ path, diff: "" })) },
			},
			false,
		);

		const rows = visibleRows(component);
		expect(rows).toHaveLength(9);
		expect(rows.at(-1)).toContain("... +2 more");
	});

	it("never collapses an error result", () => {
		const component = makeComponent(makeMultiLineTool(), opencode);
		component.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false);

		const rows = visibleRows(component).join("\n");
		expect(rows).toContain("DETAIL-2");
	});

	it("keeps the full card when no layout accessor is supplied (default omp)", () => {
		const component = makeComponent(makeMultiLineTool());
		component.updateResult({ content: [{ type: "text", text: "ok" }] }, false);

		expect(visibleRows(component).join("\n")).toContain("DETAIL-2");
	});

	it("isolates two live modes with different layouts in the same process", () => {
		// Regression for the module-global layout flag: constructing/rendering a
		// second InteractiveMode's components must not change the first mode's
		// transcript. Each component reads its own mode's accessor at render time.
		const ompMode = { layout: "omp" as LayoutMode };
		const ocMode = { layout: "opencode" as LayoutMode };

		const framed = makeComponent(makeMultiLineTool(), () => ompMode.layout);
		const flat = makeComponent(makeMultiLineTool(), () => ocMode.layout);
		framed.updateResult({ content: [{ type: "text", text: "ok" }] }, false);
		flat.updateResult({ content: [{ type: "text", text: "ok" }] }, false);

		// Interleave renders in both orders: neither construction nor render of
		// one mode's component may leak into the other's output.
		expect(visibleRows(flat)).toHaveLength(1);
		expect(visibleRows(framed).join("\n")).toContain("DETAIL-2");
		expect(visibleRows(flat)).toHaveLength(1);

		const gutterMsg = stripVTControlCharacters(
			new UserMessageComponent("hello world", false, undefined, () => ocMode.layout).render(60)[0]!,
		);
		const plainMsg = stripVTControlCharacters(
			new UserMessageComponent("hello world", false, undefined, () => ompMode.layout).render(60)[0]!,
		);
		expect(gutterMsg.trimStart().startsWith("│")).toBe(true);
		expect(plainMsg).not.toContain("│");

		// A live toggle on one mode re-renders that mode only.
		ocMode.layout = "omp";
		flat.invalidate();
		expect(visibleRows(flat).join("\n")).toContain("DETAIL-2");
		expect(visibleRows(framed).join("\n")).toContain("DETAIL-2");
	});

	it("prefixes user messages with a left gutter only in opencode layout", () => {
		const withGutter = stripVTControlCharacters(
			new UserMessageComponent("hello world", false, undefined, opencode).render(60)[0]!,
		);
		expect(withGutter.trimStart().startsWith("│")).toBe(true);

		const plain = stripVTControlCharacters(
			new UserMessageComponent("hello world", false, undefined, omp).render(60)[0]!,
		);
		expect(plain).not.toContain("│");
	});

	it("keeps the OSC-8 file link in a collapsed write row", () => {
		settings.override("tui.hyperlinks", "always");
		try {
			const resolvedPath = path.resolve("/workspace/src/example.ts");
			const component = new ToolExecutionComponent(
				"write",
				{ file_path: "src/example.ts", content: "hello\n" },
				{ layout: opencode },
				undefined,
				ui,
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: "Wrote 1 lines" }], details: { resolvedPath } },
				false,
			);

			const rows = component.render(120).filter(line => /\S/.test(stripVTControlCharacters(line)));
			expect(rows).toHaveLength(1);
			// The dim restyle must retain the renderer's own OSC-8 link — same
			// URI the framed header carried (write links details.resolvedPath).
			expect(rows[0]).toContain(url.pathToFileURL(resolvedPath).href);
			expect(rows[0]).toContain("\x1b]8;;");
			expect(stripVTControlCharacters(rows[0]!)).toContain("example.ts");
		} finally {
			settings.clearOverride("tui.hyperlinks");
		}
	});

	it("keeps the OSC-8 link around a truncated collapsed write path", () => {
		settings.override("tui.hyperlinks", "always");
		try {
			const filePath = "src/a-directory-with-a-long-name/example.ts";
			const resolvedPath = path.resolve("/workspace", filePath);
			const component = new ToolExecutionComponent(
				"write",
				{ file_path: filePath, content: "hello\n" },
				{ layout: opencode },
				undefined,
				ui,
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: "Wrote 1 lines" }], details: { resolvedPath } },
				false,
			);

			const [row] = component.render(48).filter(line => /\S/.test(stripVTControlCharacters(line)));
			const open = row!.search(/\x1b]8;[^;]*;/);
			const close = row!.indexOf("\x1b]8;;", open + 1);
			expect(open).toBeGreaterThanOrEqual(0);
			expect(close).toBeGreaterThan(open);
			expect(row!.slice(open, close)).toContain("src/a");
			expect(stripVTControlCharacters(row!)).toContain("…");
		} finally {
			settings.clearOverride("tui.hyperlinks");
		}
	});

	it("keeps both OSC-8 links, in order, in a collapsed rename header", () => {
		// A rename/move edit header carries two links: source and destination.
		// The collapse restyle must re-wrap every span, not just the first.
		const srcUri = url.pathToFileURL(path.resolve("/workspace/src/old.ts")).href;
		const dstUri = url.pathToFileURL(path.resolve("/workspace/lib/new.ts")).href;
		const link = (uri: string, text: string) => `\x1b]8;;${uri}\x07${text}\x1b]8;;\x07`;
		const header = `← Move ${link(srcUri, "src/old.ts")} → ${link(dstUri, "lib/new.ts")}`;
		const tool: MultiLineTool = {
			name: "custom_render",
			label: "Custom",
			mergeCallAndResult: true,
			renderResult() {
				return markFramedBlockComponent({
					render: () => [header, "DETAIL-1"],
					invalidate() {},
				}) as unknown as Text;
			},
		};
		const component = makeComponent(tool, opencode);
		component.updateResult({ content: [{ type: "text", text: "ok" }] }, false);

		const rows = component.render(120).filter(line => /\S/.test(stripVTControlCharacters(line)));
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row).toContain(srcUri);
		expect(row).toContain(dstUri);
		expect(row.indexOf(srcUri)).toBeLessThan(row.indexOf(dstUri));
		const plain = stripVTControlCharacters(row);
		expect(plain).toContain("src/old.ts");
		expect(plain).toContain("lib/new.ts");
	});

	it("normalizes tabs so a collapsed row stays one clean line", () => {
		// Framed (self-drawing) renderers pass their rows through verbatim —
		// truncateToWidth's short-string fast path preserves a raw `\t` — so the
		// collapse restyle is the last place that can normalize it.
		const tool: MultiLineTool = {
			name: "custom_render",
			label: "Custom",
			mergeCallAndResult: true,
			renderResult() {
				return markFramedBlockComponent({
					render: () => ["HEAD\tLINE ok", "DETAIL-1"],
					invalidate() {},
				}) as unknown as Text;
			},
		};
		const component = makeComponent(tool, opencode);
		component.updateResult({ content: [{ type: "text", text: "ok" }] }, false);

		const rows = component.render(80).filter(line => /\S/.test(stripVTControlCharacters(line)));
		expect(rows).toHaveLength(1);
		expect(rows[0]).not.toContain("\t");
		expect(stripVTControlCharacters(rows[0]!)).toContain(replaceTabs("HEAD\tLINE ok"));
	});

	it("bounds a live custom row without dropping its styling", () => {
		const uri = "file:///tmp/live.ts";
		const link = `\x1b]8;;${uri}\x07${theme.fg("accent", "live.ts")}\x1b]8;;\x07`;
		const longUri = "file:///tmp/long.ts";
		const longLink = `\x1b]8;;${longUri}\x07${"long".repeat(75)}\x1b]8;;\x07`;
		const styled = theme.fg("toolTitle", `first\t${link} ${longLink}`);
		const tool = {
			name: "custom_render",
			label: "Custom",
			parameters: { type: "object", additionalProperties: true },
			renderCall: () =>
				markFramedBlockComponent({
					render: () => [styled, "DETAIL-1"],
					invalidate() {},
				}) as unknown as Text,
			async execute() {
				return { content: [] };
			},
		} as unknown as AgentTool;
		const component = new ToolExecutionComponent("custom_render", {}, { layout: opencode }, tool, ui, process.cwd());

		const rows = component.render(40).filter(line => /\S/.test(stripVTControlCharacters(line)));
		expect(rows).toHaveLength(1);
		expect(rows[0]).not.toContain("\t");
		expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(40);
		expect(rows[0]).toContain(theme.getFgAnsi("toolTitle"));
		expect(rows[0]).toContain(theme.getFgAnsi("accent"));
		expect(rows[0]).toContain(uri);
		expect(rows[0]).not.toContain(longUri);
		expect(rows[0]!.match(/\x1b\]8;;\x07/g)).toHaveLength(1);
	});

	it("keys CachedOutputBlock on the explicit flat option", () => {
		const block = new CachedOutputBlock();
		const options = {
			header: "Tool header",
			state: "success" as const,
			sections: [{ lines: ["body line"] }],
			width: 60,
		};

		const framed = block.render({ ...options, flat: false }, theme).join("\n");
		const flat = block.render({ ...options, flat: true }, theme).join("\n");
		const framedAgain = block.render({ ...options, flat: false }, theme).join("\n");

		// Framed draws the omp box glyphs; flat draws none. Identical options that
		// differ only in `flat` MUST NOT collide in the memo.
		expect(stripVTControlCharacters(framed)).toContain(theme.boxRound.topLeft);
		expect(stripVTControlCharacters(flat)).not.toContain(theme.boxRound.topLeft);
		expect(framedAgain).toBe(framed);
	});

	it("renders ascii-preset collapsed rows without Unicode glyphs", async () => {
		const baseTheme = await getThemeByName("dark");
		if (!baseTheme) throw new Error("theme unavailable");
		setThemeInstance(await loadTheme("dark", { symbolPresetOverride: "ascii" }));
		try {
			// One mapped name per glyph family plus an unmapped fallback.
			const rows = ["write", "task", "custom_render"].map(name => {
				const tool = { ...makeMultiLineTool(), name };
				const component = new ToolExecutionComponent(
					name,
					{},
					{ layout: opencode },
					tool as unknown as AgentTool,
					ui,
					process.cwd(),
				);
				component.updateResult({ content: [{ type: "text", text: "ok" }] }, false);
				return stripVTControlCharacters(component.render(80).join("\n"));
			});
			expect(rows[0]).toContain("<- HEADLINE ok");
			expect(rows[1]).toContain("# HEADLINE ok");
			// Unmapped tools fall back to the search glyph.
			expect(rows[2]).toContain("* HEADLINE ok");
			for (const row of rows) expect(row).toMatch(/^[\x20-\x7E]*$/);
		} finally {
			setThemeInstance(baseTheme);
		}
	});

	it("keeps ascii icon words from custom settled headers", async () => {
		const baseTheme = await getThemeByName("dark");
		if (!baseTheme) throw new Error("theme unavailable");
		setThemeInstance(await loadTheme("dark", { symbolPresetOverride: "ascii" }));
		try {
			const tool = {
				...makeMultiLineTool(),
				name: "write",
				renderResult: () => new Text("web result detail\nDETAIL-1", 0, 0),
			};
			const component = new ToolExecutionComponent(
				"write",
				{},
				{ layout: opencode },
				tool as unknown as AgentTool,
				ui,
				process.cwd(),
			);
			component.updateResult({ content: [{ type: "text", text: "ok" }] }, false);

			expect(visibleRows(component)).toEqual([" <- web result detail"]);
		} finally {
			setThemeInstance(baseTheme);
		}
	});

	it("strips the +f icon from a built-in ascii write header", async () => {
		const baseTheme = await getThemeByName("dark");
		if (!baseTheme) throw new Error("theme unavailable");
		setThemeInstance(await loadTheme("dark", { symbolPresetOverride: "ascii" }));
		try {
			const component = new ToolExecutionComponent(
				"write",
				{ file_path: "src/example.ts", content: "hello\n" },
				{ layout: opencode },
				undefined,
				ui,
				process.cwd(),
			);
			component.updateResult({ content: [{ type: "text", text: "Wrote 1 lines" }] }, false);

			const [row] = visibleRows(component);
			expect(row).toMatch(/^ <- /);
			expect(row).not.toContain("+f");
		} finally {
			setThemeInstance(baseTheme);
		}
	});

	it("strips TaskTool's built-in ascii done icon but preserves custom renderer text", async () => {
		const baseTheme = await getThemeByName("dark");
		if (!baseTheme) throw new Error("theme unavailable");
		setThemeInstance(await loadTheme("dark", { symbolPresetOverride: "ascii" }));
		try {
			const taskTool = {
				name: "task",
				label: "Task",
				mergeCallAndResult: true,
				renderResult: taskToolRenderer.renderResult,
			};
			const component = new ToolExecutionComponent(
				"task",
				{},
				{ layout: opencode },
				taskTool as unknown as AgentTool,
				ui,
				process.cwd(),
			);
			component.updateResult({ content: [] }, false);

			const [row] = visibleRows(component);
			expect(row).toBe(" # Task");
			expect(row).not.toContain("* Task");
		} finally {
			setThemeInstance(baseTheme);
		}
	});

	it("keeps aggregate task failures expanded", () => {
		const taskTool = {
			name: "task",
			label: "Task",
			mergeCallAndResult: true,
			renderResult: taskToolRenderer.renderResult,
		};
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			totalDurationMs: 0,
			results: [
				{
					index: 0,
					id: "worker",
					agent: "task",
					agentSource: "bundled",
					task: "fails",
					exitCode: 1,
					output: "failure",
					stderr: "boom",
					truncated: false,
					durationMs: 0,
					tokens: 0,
					requests: 0,
				},
			],
		};
		const component = new ToolExecutionComponent(
			"task",
			{},
			{ layout: opencode },
			taskTool as unknown as AgentTool,
			ui,
			process.cwd(),
		);
		component.updateResult({ content: [], details }, false);

		expect(visibleRows(component).join("\n")).toContain("failure");
	});

	it("renders an ascii squeezed settled row through the oc.* marker, not `•`", async () => {
		const baseTheme = await getThemeByName("dark");
		if (!baseTheme) throw new Error("theme unavailable");
		setThemeInstance(await loadTheme("dark", { symbolPresetOverride: "ascii" }));
		try {
			const component = makeComponent(makeMultiLineTool(), opencode);
			component.updateResult({ content: [{ type: "text", text: "ok" }] }, false);
			component.setTranscriptAllocation(1, { tick: 0, now: 0 });
			const rows = component.render(80).map(line => stripVTControlCharacters(line));
			expect(rows).toHaveLength(1);
			// Unmapped tools take the oc.search marker; ascii preset renders "*".
			expect(rows[0]).toBe("* Custom");
			expect(rows[0]).toMatch(/^[\x20-\x7E]*$/);
		} finally {
			setThemeInstance(baseTheme);
		}
	});
});
