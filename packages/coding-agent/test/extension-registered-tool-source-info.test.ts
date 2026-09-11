import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
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
});
