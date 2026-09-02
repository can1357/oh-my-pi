import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import type { LayoutMode } from "@oh-my-pi/pi-coding-agent/modes/layout-mode";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { CachedOutputBlock, markFramedBlockComponent } from "@oh-my-pi/pi-coding-agent/tui/output-block";
import { replaceTabs, Text, type TUI } from "@oh-my-pi/pi-tui";

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
});
