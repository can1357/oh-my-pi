import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { setLayoutMode } from "@oh-my-pi/pi-coding-agent/modes/layout-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Text, type TUI } from "@oh-my-pi/pi-tui";

/**
 * Contract under test (`display.layout: "opencode"`):
 *
 * - A collapsed tool block renders as exactly one row — its status line (the
 *   first visible row of the card) — instead of the full card.
 * - `setExpanded(true)` (Ctrl+O) restores the complete card.
 * - An error result never collapses: the message must stay readable.
 * - The default `omp` layout is untouched by the flag round-trip.
 * - User messages gain a left gutter column in opencode layout.
 */
describe("opencode layout", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		// Full-suite safety: never leak the layout flag into other test files.
		setLayoutMode("omp");
	});

	const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

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

	function makeComponent(tool: MultiLineTool): ToolExecutionComponent {
		return new ToolExecutionComponent("custom_render", {}, {}, tool as unknown as AgentTool, ui, process.cwd());
	}

	function visibleRows(component: ToolExecutionComponent, width = 80): string[] {
		return component
			.render(width)
			.map(line => stripVTControlCharacters(line))
			.filter(line => /\S/.test(line));
	}

	it("collapses a finalized tool block to its status line; expand restores the card", () => {
		setLayoutMode("opencode");
		const component = makeComponent(makeMultiLineTool());
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
		setLayoutMode("opencode");
		const component = makeComponent(makeMultiLineTool());
		component.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false);

		const rows = visibleRows(component).join("\n");
		expect(rows).toContain("DETAIL-2");
	});

	it("keeps the full card in the default omp layout after a flag round-trip", () => {
		setLayoutMode("opencode");
		setLayoutMode("omp");
		const component = makeComponent(makeMultiLineTool());
		component.updateResult({ content: [{ type: "text", text: "ok" }] }, false);

		expect(visibleRows(component).join("\n")).toContain("DETAIL-2");
	});

	it("prefixes user messages with a left gutter only in opencode layout", () => {
		setLayoutMode("opencode");
		const withGutter = stripVTControlCharacters(new UserMessageComponent("hello world").render(60)[0]!);
		expect(withGutter.trimStart().startsWith("│")).toBe(true);

		setLayoutMode("omp");
		const plain = stripVTControlCharacters(new UserMessageComponent("hello world").render(60)[0]!);
		expect(plain).not.toContain("│");
	});
});
