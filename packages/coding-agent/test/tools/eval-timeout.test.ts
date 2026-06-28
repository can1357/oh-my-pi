import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@pk-nerdsaver-ai/pi-coding-agent/eval/js/context-manager";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { EvalTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/eval";

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

/**
 * Defends the contract that a cell which does not delegate to an `agent()`/
 * `completion()` bridge call is bounded by a *plain wall-clock* timeout — not the
 * activity watchdog, which now only extends the budget while a bridge call is in
 * flight. Regression guard for the watchdog killing ordinary compute cells and
 * surfacing a misleading "of inactivity" message.
 */
describe("EvalTool timeout semantics", () => {
	afterAll(async () => {
		await disposeAllVmContexts();
	});

	it("bounds a compute cell (no agent/completion) by a plain wall-clock timeout", async () => {
		const tool = new EvalTool(makeSession());
		// 1s budget; the cell idles for 5s and emits no status, so nothing extends
		// the budget — it must be cut off at the wall-clock limit.
		const result = await tool.execute("call-compute-timeout", {
			language: "js",
			code: "await Bun.sleep(2000); return 'never';",
			timeout: 1,
		});

		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(text).toContain("timed out after 1 seconds");
		// The new wording is a plain wall-clock timeout, not an inactivity stall.
		expect(text).not.toContain("inactivity");
		expect(text).not.toContain("never");

		const cell = result.details?.cells?.[0];
		expect(cell?.exitCode).toBeUndefined();
	});
});
