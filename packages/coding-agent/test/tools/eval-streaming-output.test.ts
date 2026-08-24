import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import type { EvalToolDetails } from "@oh-my-pi/pi-coding-agent/eval/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { formatOutputNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";

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
		termination: undefined,
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

	/**
	 * Regression test for the double-append bug: `onChunk` streams raw stdout
	 * into the aggregate progress tail live, and completion used to re-append
	 * the same (trimmed) stdout as `cellOutput` on top of it, producing a
	 * shrinking, duplicated final snapshot (`one\ntwo\none\ntwo` followed by a
	 * shorter `one\ntwo`). The aggregate tail sent via `onUpdate({ content })`
	 * must never shrink or duplicate already-streamed bytes across ticks.
	 */
	it("never re-appends already-streamed stdout into the aggregate progress tail on cell completion", async () => {
		const tailTexts: string[] = [];
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onChunk?: (chunk: string) => void },
		) => {
			options.onChunk?.("one\n");
			options.onChunk?.("two\n");
			return baseResult({ output: "one\ntwo\n" });
		}) as never);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute(
			"call-no-double-append",
			{ language: "js", code: "print('one'); print('two')" },
			undefined,
			update => {
				const text = update.content.find(c => c.type === "text")?.text;
				if (typeof text === "string") tailTexts.push(text);
			},
		);

		// Every progress snapshot must extend the previous one (never shrink),
		// and no snapshot may duplicate bytes already delivered.
		for (let i = 1; i < tailTexts.length; i++) {
			expect(tailTexts[i]!.startsWith(tailTexts[i - 1]!)).toBe(true);
		}
		const finalTail = tailTexts.at(-1) ?? "";
		expect(finalTail).toBe("one\ntwo\n");
		expect(finalTail).not.toContain("one\ntwo\none");

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toBe("one\ntwo");
	});

	/**
	 * Regression test for the cell-boundary separator fix: `appendTail` now
	 * inserts `"\n\n"` between cells' streamed output to mirror
	 * `cellOutputs.join("\n\n")` in the final result (see `eval.ts`'s
	 * `awaitingCellSeparator`). `EvalTool.execute()`'s single public entrypoint
	 * only ever runs one cell per call, so this pins the common (only
	 * reachable) path: a lone cell's streamed tail must never gain a spurious
	 * separator it didn't itself produce.
	 */
	it("never inserts a cell-boundary separator for a single-cell run", async () => {
		const tailTexts: string[] = [];
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onChunk?: (chunk: string) => void },
		) => {
			options.onChunk?.("solo");
			return baseResult({ output: "solo" });
		}) as never);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute(
			"call-single-cell",
			{ language: "js", code: "process.stdout.write('solo')" },
			undefined,
			update => {
				const text = update.content.find(c => c.type === "text")?.text;
				if (typeof text === "string") tailTexts.push(text);
			},
		);

		const finalTail = tailTexts.at(-1) ?? "";
		expect(finalTail).toBe("solo");
		expect(finalTail).not.toContain("\n\n");

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toBe("solo");
	});

	it("marks a cancelled eval as a top-level tool error", async () => {
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({ output: "Command aborted", exitCode: undefined, termination: { kind: "interrupted" } }) as never,
		);

		const result = await new EvalTool(makeSession()).execute("call-cancelled", {
			language: "js",
			code: "await new Promise(() => {})",
		});

		expect(result.isError).toBe(true);
		expect(result.details?.isError).toBe(true);
		expect(result.details?.cells?.[0]?.status).toBe("error");
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
});
