/**
 * A settings refresh must reach the tools that read those settings.
 *
 * `ReadTool` and `WriteTool` each captured their settings in the constructor, so
 * an on-disk edit picked up by `settings.reload()` updated `Settings` while the
 * live tool kept its startup behaviour until the process restarted.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as lsp from "@oh-my-pi/pi-coding-agent/lsp/writethrough";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("tool settings refresh", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-settings-refresh-"));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	function text(result: { content: unknown }): string {
		return (result.content as Array<{ type: string; text?: string }>)
			.filter(part => part.type === "text")
			.map(part => part.text ?? "")
			.join("\n");
	}

	function session(settings: Settings): ToolSession {
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		} as unknown as ToolSession;
	}

	it("honors the refreshed read default limit on a limitless read", async () => {
		const settings = Settings.isolated({ "read.defaultLimit": 5 });
		const tool = new ReadTool(session(settings));
		const target = path.join(testDir, "many-lines.txt");
		fs.writeFileSync(target, Array.from({ length: 60 }, (_, index) => `line-${index + 1}`).join("\n"));

		const before = await tool.execute("read-before", { path: target });
		expect(text(before)).toContain("line-5");
		expect(text(before)).not.toContain("line-6");

		// What a `/refresh settings` does to an already-built tool.
		settings.override("read.defaultLimit", 20);
		const after = await tool.execute("read-after", { path: target });

		// RED (pre-fix): the constructor captured 5, so this still stopped at
		// line-5 however the on-disk setting moved.
		expect(text(after)).toContain("line-20");
		expect(text(after)).not.toContain("line-21");
	});

	it("rebuilds the write tool's LSP options from the live settings", async () => {
		// The three flags reach behaviour ONLY through the options object handed to
		// `createLspWritethrough`, so that object is what a test has to observe:
		// asserting on `settings.get(...)` would pass with the fix ablated.
		const settings = Settings.isolated({
			"lsp.formatOnWrite": true,
			"lsp.diagnosticsOnWrite": true,
			"lsp.diagnosticsDeduplicate": true,
		});
		const tool = new WriteTool(session(settings));
		const observed: Array<{ enableFormat: boolean; enableDiagnostics: boolean; dedup: boolean }> = [];
		const writethrough = spyOn(lsp, "createLspWritethrough").mockImplementation((_cwd, options) => {
			observed.push({
				enableFormat: options?.enableFormat === true,
				enableDiagnostics: options?.enableDiagnostics === true,
				dedup: options?.transformDiagnostics !== undefined,
			});
			return async (_dst: string, content: string) => ({ finalContent: content });
		});

		try {
			const target = path.join(testDir, "sample.txt");
			await tool.execute("write-1", { path: target, content: "one\n" });
			settings.override("lsp.formatOnWrite", false);
			settings.override("lsp.diagnosticsDeduplicate", false);
			await tool.execute("write-2", { path: target, content: "two\n" });

			expect(observed[0]).toEqual({ enableFormat: true, enableDiagnostics: true, dedup: true });
			// RED (pre-fix): the constructor built ONE writethrough, so there was no
			// second options object at all and the first one kept formatting.
			expect(observed[1]).toEqual({ enableFormat: false, enableDiagnostics: true, dedup: false });
		} finally {
			writethrough.mockRestore();
		}
	});
});
