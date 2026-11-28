import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "../src/extensibility/extensions/loader";
import type { ExtensionRows, ExtensionTheme } from "../src/extensibility/extensions/render-types";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { ToolRenderResultOptions } from "../src/extensibility/extensions/types";
import { wrapRegisteredTools } from "../src/extensibility/extensions/wrapper";
import { isExtensionRows } from "../src/ui/extensions/render-output";
import { getThemeByName } from "../src/ui/theme/service";
import { EventBus } from "../src/utils/event-bus";

const okResult = { content: [{ type: "text" as const, text: "ok" }] };

// Regression for the pi-fabric startup crash (`undefined is not an object
// (evaluating 'anchor.sourceInfo.path')`): extensions authored against upstream
// `@earendil-works/pi-coding-agent` read `sourceInfo.path` off every entry
// returned by `getAllRegisteredTools()`. omp's RegisteredTool must carry that
// upstream-shaped provenance, matching the SourceInfo synthesized for the
// public `getAllToolInfos()` path.
describe("RegisteredTool sourceInfo (upstream pi compat)", () => {
	test("getAllRegisteredTools() entries expose sourceInfo without crashing upstream-shaped consumers", async () => {
		const runtime = new ExtensionRuntime();
		const events = new EventBus();

		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerTool({
					name: "fs_tool",
					label: "FS Tool",
					description: "tool with an on-disk origin",
					parameters: pi.arktype({}),
					sourcePath: "/abs/plugins/pi-fabric/tool.ts",
					execute: async () => okResult,
				});
				pi.registerTool({
					name: "synthetic_tool",
					label: "Synthetic Tool",
					description: "tool without a filesystem origin",
					parameters: pi.arktype({}),
					execute: async () => okResult,
				});
			},
			"/project",
			events,
			runtime,
			"pi-fabric@0.92.4",
		);

		const runner = new ExtensionRunner(
			[extension],
			runtime,
			"/project",
			{ getCwd: () => "/project" } as never,
			{} as never,
		);

		// Mirrors pi-fabric's interceptor: reads sourceInfo.path off each entry.
		// Before the fix, sourceInfo was undefined and this threw at startup.
		const paths = runner.getAllRegisteredTools().map(entry => entry.sourceInfo.path);
		expect(paths).toEqual(["/abs/plugins/pi-fabric/tool.ts", "<extension:synthetic_tool>"]);

		// A filesystem sourcePath is surfaced verbatim with the full upstream shape.
		expect(runner.getRegisteredTool("fs_tool")?.sourceInfo).toEqual({
			path: "/abs/plugins/pi-fabric/tool.ts",
			source: "extension",
			scope: "temporary",
			origin: "top-level",
		});

		// extensionPath stays intact for existing host callers.
		expect(runner.getRegisteredTool("fs_tool")?.extensionPath).toBe("pi-fabric@0.92.4");
	});

	test("relative extension entries expose their resolved on-disk source path", async () => {
		const projectDir = TempDir.createSync("@registered-tool-source-info-");
		const relativePath = "./plugin.ts";
		const resolvedPath = path.join(projectDir.path(), "plugin.ts");
		await Bun.write(
			resolvedPath,
			`
				export default function(api) {
					api.registerTool({
						name: "relative_tool",
						label: "Relative Tool",
						description: "tool loaded from a relative extension entry",
						parameters: api.arktype({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
					});
				}
			`,
		);

		try {
			const loaded = await loadExtensions([relativePath], projectDir.path());
			expect(loaded.errors).toEqual([]);
			expect(loaded.extensions).toHaveLength(1);

			const extension = loaded.extensions[0];
			expect(extension?.path).toBe(relativePath);
			expect(extension?.resolvedPath).toBe(resolvedPath);
			expect(extension?.tools.get("relative_tool")?.sourceInfo.path).toBe(resolvedPath);
		} finally {
			projectDir.removeSync();
		}
	});

	test("a tool's relative sourcePath falls back to the extension's absolute resolved entry", async () => {
		const projectDir = TempDir.createSync("@registered-tool-relative-source-");
		const relativePath = "./plugin.ts";
		const resolvedPath = path.join(projectDir.path(), "plugin.ts");
		await Bun.write(
			resolvedPath,
			`
				export default function(api) {
					api.registerTool({
						name: "relative_source_tool",
						label: "Relative Source Tool",
						description: "tool that declares a relative sourcePath",
						parameters: api.arktype({}),
						sourcePath: "./tools/relative_source.ts",
						execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
					});
				}
			`,
		);

		try {
			const loaded = await loadExtensions([relativePath], projectDir.path());
			expect(loaded.errors).toEqual([]);

			// A non-absolute sourcePath must not degrade to `<extension:name>` when the
			// extension has a valid absolute resolved entry to point compat consumers at.
			expect(loaded.extensions[0]?.tools.get("relative_source_tool")?.sourceInfo.path).toBe(resolvedPath);
		} finally {
			projectDir.removeSync();
		}
	});
});

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

// omp invokes renderers as `renderCall(args, options, theme)` while pi-era
// renderers are declared `renderCall(args, theme, context)`. The second slot
// must satisfy both shapes, otherwise every pi-authored renderer throws
// `theme.bold is not a function` and silently degrades to the plain tool label.
describe("RegisteredTool renderCall theme slot (upstream pi compat)", () => {
	test("a pi-order renderer styles through its second argument", async () => {
		expect(await renderToolCall(piOrderRenderer, { query: "needle" })).toContain("aft_search needle");
	});

	test("an omp-order renderer still reads render options from its second argument", async () => {
		expect(
			await renderToolCall(ompOrderRenderer, { query: "needle" }, { expanded: true, isPartial: false }),
		).toContain("aft_search needle [expanded]");
	});
});
