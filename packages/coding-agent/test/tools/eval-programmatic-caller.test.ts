/**
 * A cell may call `tool.eval(...)`, and the inner cell's stdout is still
 * consumed by a kernel. `EvalTool` builds its own `OutputSink` with the
 * model-facing spill budget and per-line column cap, both of which run long
 * before the bridge's artifact-spill guard — so the nested tool has to honour
 * `programmaticCaller` itself or the outer cell parses shredded text.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

const PROGRAMMATIC = { programmaticCaller: true } as AgentToolContext;
/** One line, past both the 50 KiB inline budget and the per-line column cap. */
const PAYLOAD = "a".repeat(DEFAULT_MAX_BYTES * 3);

function session(): ToolSession {
	return {
		cwd: "/tmp/eval-programmatic",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "eval.autoBackground.enabled": false }),
	} as unknown as ToolSession;
}

/**
 * Record what the eval tool asks the backend for. The real backend builds its
 * own `OutputSink` from these options, so the contract this file defends is
 * that the tool forwards the caller's mode down to it.
 */
function captureBackendOptions(): { last: () => { unboundedOutput?: boolean } | undefined } {
	let seen: { unboundedOutput?: boolean } | undefined;
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
		_code: string,
		options: { unboundedOutput?: boolean },
	) => {
		seen = options;
		return {
			output: PAYLOAD,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			artifactId: undefined,
			totalLines: 0,
			totalBytes: 0,
			outputLines: 0,
			outputBytes: 0,
			displayOutputs: [] as unknown[],
		};
	}) as never);
	return { last: () => seen };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("");
}

describe("nested eval output for programmatic callers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("asks the backend for the model-facing sink on an ordinary call", async () => {
		const backend = captureBackendOptions();
		await new EvalTool(session()).execute(
			"call-model",
			{ language: "js", code: "print(payload)" },
			undefined,
			undefined,
			undefined,
		);
		expect(backend.last()?.unboundedOutput).toBe(false);
	}, 30_000);

	it("asks the backend to keep the cell's stdout whole for a programmatic caller", async () => {
		const backend = captureBackendOptions();
		const result = await new EvalTool(session()).execute(
			"call-kernel",
			{ language: "js", code: "print(payload)" },
			undefined,
			undefined,
			PROGRAMMATIC,
		);
		expect(backend.last()?.unboundedOutput).toBe(true);
		// The tool's own sink must not re-cap what the backend handed back.
		expect(textOf(result)).toContain(PAYLOAD);
	}, 30_000);
});
