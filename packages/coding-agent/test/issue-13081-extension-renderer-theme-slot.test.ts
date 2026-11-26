import { describe, expect, test } from "bun:test";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import type { ExtensionRows, ExtensionTheme } from "../src/extensibility/extensions/render-types";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { ToolRenderResultOptions } from "../src/extensibility/extensions/types";
import { wrapRegisteredTools } from "../src/extensibility/extensions/wrapper";
import { isExtensionRows } from "../src/ui/extensions/render-output";
import { getThemeByName } from "../src/ui/theme/service";
import { EventBus } from "../src/utils/event-bus";

const okResult = { content: [{ type: "text" as const, text: "ok" }] };

const uiTheme = await getThemeByName("dark");
if (!uiTheme) throw new Error("dark theme missing");

/** omp's declared tool-call renderer contract. */
type RenderCall = (args: unknown, options: ToolRenderResultOptions, theme: ExtensionTheme) => ExtensionRows;

function queryOf(args: unknown): string {
	return args && typeof args === "object" && "query" in args ? String(args.query) : "";
}

/** Rows of `text` wrapped at the width (what a row renderer returns). */
function textRows(text: string): ExtensionRows {
	return { render: width => wrap(text, width) };
}

/**
 * Renderer in upstream pi's `renderCall(args, theme, context)` order. Shipped
 * plugins are compiled JavaScript, so the declaration mismatch omp's type
 * forbids is exactly what reaches the adapter at runtime.
 */
const piOrderRenderer = ((args: unknown, theme: ExtensionTheme): ExtensionRows =>
	textRows(theme.fg("toolTitle", theme.bold("aft_search ")) + queryOf(args))) as unknown as RenderCall;

/** Renderer in omp's documented `renderCall(args, options, theme)` order. */
const ompOrderRenderer: RenderCall = (args, options, theme) =>
	textRows(theme.fg("toolTitle", theme.bold("aft_search ")) + queryOf(args) + (options.expanded ? " [expanded]" : ""));

async function renderToolCall(
	renderCall: RenderCall,
	args: Record<string, unknown>,
	options: { expanded: boolean; isPartial: boolean } = { expanded: false, isPartial: false },
): Promise<string> {
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.registerTool({
				name: "aft_search",
				label: "AFT Search",
				description: "third-party search tool",
				parameters: pi.arktype({}),
				execute: async () => okResult,
				renderCall,
			});
		},
		"/project",
		new EventBus(),
		runtime,
		"@cortexkit/aft-pi@0.56.2",
	);

	const runner = new ExtensionRunner(
		[extension],
		runtime,
		"/project",
		{ getCwd: () => "/project" } as never,
		{} as never,
	);
	const tool = wrapRegisteredTools(runner.getAllRegisteredTools(), runner)[0];
	if (!tool?.renderCall) throw new Error("renderCall missing on wrapped tool");
	const rendered = tool.renderCall(args, options, uiTheme);
	if (!isExtensionRows(rendered)) throw new Error("renderer returned no rows");
	return Bun.stripANSI(rendered.render(80).join("\n"));
}

// Issue #13081: omp invokes renderers as `renderCall(args, options, theme)`
// while pi-era renderers are declared `renderCall(args, theme, context)`. The
// second slot must satisfy both shapes, otherwise every pi-authored renderer
// throws `theme.bold is not a function` and silently degrades to the plain
// tool label.
describe("extension renderCall theme slot (upstream pi compat)", () => {
	test("a pi-order renderer styles through its second argument", async () => {
		expect(await renderToolCall(piOrderRenderer, { query: "needle" })).toContain("aft_search needle");
	});

	test("an omp-order renderer still reads render options from its second argument", async () => {
		expect(
			await renderToolCall(ompOrderRenderer, { query: "needle" }, { expanded: true, isPartial: false }),
		).toContain("aft_search needle [expanded]");
	});
});
