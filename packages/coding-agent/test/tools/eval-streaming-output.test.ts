import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import type { EvalToolDetails } from "@oh-my-pi/pi-coding-agent/eval/types";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { evalToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/eval-render";
import {
	formatOutputNotice,
	stripOutputNotice,
	wrapToolWithMetaNotice,
} from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { removeWithRetries, sanitizeText } from "@oh-my-pi/pi-utils";

function makeSession(settings = Settings.isolated()): ToolSession {
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	};
}

function baseResult(overrides: Record<string, unknown> = {}) {
	return {
		output: "",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		displayOutputs: [] as unknown[],
		...overrides,
	};
}

/**
 * Defends the contract that stdout streamed by a still-running cell lands in the
 * running cell's rendered `output` *before* `backend.execute()` returns — so a
 * long-running cell (e.g. a `time.sleep()` monitor loop) shows progress live in
 * the eval card instead of dumping everything at once on completion/interrupt.
 *
 * The eval card renderer draws cell output from `details.cells[i].output`; if
 * that field is only filled after the backend resolves, the card stays blank for
 * the whole run. This pins the live bridge that keeps it populated mid-flight.
 */
describe("EvalTool live stdout streaming", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("populates the running cell's output with streamed chunks before the cell returns", async () => {
		const updates: EvalToolDetails[] = [];
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onChunk?: (chunk: string) => void },
		) => {
			// Emit a chunk while the cell is still running, mirroring a print()
			// before a long sleep. The host's onChunk path runs synchronously.
			options.onChunk?.("tick 1\n");
			return baseResult({ output: "tick 1\ntick 2\n" });
		}) as never);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute(
			"call-stream",
			{ language: "js", code: "for (let i = 0; i < 2; i++) print('tick ' + i)" },
			undefined,
			update => {
				if (update.details) updates.push(update.details as EvalToolDetails);
			},
		);

		// A snapshot taken while the cell was still running carried the streamed
		// chunk — proving the output bridge fires mid-execution, not just at the end.
		const liveRunning = updates.find(
			d => d.cells?.[0]?.status === "running" && (d.cells?.[0]?.output ?? "").includes("tick 1"),
		);
		expect(liveRunning).toBeDefined();
		// The live snapshot shows only what streamed so far, not the post-return total.
		expect(liveRunning?.cells?.[0]?.output).not.toContain("tick 2");

		// Completion still overwrites with the authoritative full output.
		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("tick 1");
		expect(text).toContain("tick 2");
		expect(result.details?.cells?.[0]?.status).toBe("complete");
		expect(result.details?.cells?.[0]?.output).toContain("tick 2");
	});

	it("preserves the column-cap notice after rebuilding the final eval summary", async () => {
		const settings = Settings.isolated();
		settings.set("tools.outputMaxColumns", 8);
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onChunk?: (chunk: string) => void },
		) => {
			const output = "x".repeat(50);
			options.onChunk?.(output);
			return baseResult({ output });
		}) as never);

		const result = await new EvalTool(makeSession(settings)).execute(
			"call-column-cap",
			{ language: "js", code: "print('x'.repeat(50))" },
			undefined,
			undefined,
		);

		expect(result.details?.meta?.truncation).toBeUndefined();
		expect(formatOutputNotice(result.details?.meta)).toContain("Some lines truncated to 8 chars");
	});

	it.each([
		{ scenario: "without window truncation", bytes: 50, respilled: false, cancelled: false },
		{ scenario: "when the wrapper caps the preview", bytes: 2 * 1024, respilled: true, cancelled: false },
		{ scenario: "when the cell was cancelled", bytes: 50, respilled: false, cancelled: true },
	])(
		"reports capture failure $scenario without changing the cell outcome",
		async ({ bytes, respilled, cancelled }) => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-artifact-failure-"));
			const sessionManager = SessionManager.inMemory(dir);
			try {
				const settings = Settings.isolated({
					"tools.outputMaxColumns": 8,
					"tools.artifactSpillThreshold": 1,
					"tools.artifactTailBytes": 1,
					"tools.artifactHeadBytes": 0,
				});
				const session = makeSession(settings);
				session.allocateOutputArtifact = async () => ({ path: dir, id: "failed-stream" });
				const saveArtifact = vi.spyOn(sessionManager, "saveArtifact");
				const output = "x".repeat(bytes);
				vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation(async (_code, options) => {
					options.onChunk(output);
					return {
						output,
						exitCode: cancelled ? undefined : 0,
						cancelled,
						truncated: false,
						artifactId: undefined,
						totalLines: 1,
						totalBytes: output.length,
						outputLines: 1,
						outputBytes: output.length,
						displayOutputs: [],
					};
				});
				const tool = wrapToolWithMetaNotice(new EvalTool(session));
				const context = { sessionManager, settings } as unknown as AgentToolContext;
				const result = await tool.execute(
					"capture-failure",
					{ language: "js", code: "print('output')" },
					undefined,
					undefined,
					context,
				);
				const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
				const body = stripOutputNotice(text, result.details?.meta);

				expect(Boolean(result.isError)).toBe(cancelled);
				expect(result.details?.cells?.[0]?.status).toBe(cancelled ? "error" : "complete");
				expect(result.details?.cells?.[0]?.exitCode).toBe(cancelled ? undefined : 0);
				expect(text).toContain("not saved completely");
				expect(text).not.toContain("artifact://");
				expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1024);
				expect(Boolean(result.details?.meta?.truncation)).toBe(respilled);
				expect(saveArtifact).not.toHaveBeenCalled();

				const uiTheme = await getThemeByName("dark");
				if (!uiTheme) throw new Error("Expected dark theme");
				const rendered = sanitizeText(
					evalToolRenderer
						.renderResult(result, { expanded: false, isPartial: false }, uiTheme)
						.render(160)
						.join("\n"),
				);
				expect(rendered).toContain("not saved completely");
				expect(rendered).not.toContain("artifact://");
			} finally {
				await sessionManager.close();
				await removeWithRetries(dir);
			}
		},
	);
});
