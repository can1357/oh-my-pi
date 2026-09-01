import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import * as toolTimeouts from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";

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
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("disables the cell timeout when timeout is zero", async () => {
		// Keep the integration path real while making a mistakenly armed timeout
		// fail quickly. Fake timers cannot drive the isolated worker's clock, and
		// a zero timeout must bypass the production clamp entirely.
		vi.spyOn(toolTimeouts, "clampTimeout").mockReturnValue(0.05);
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-unlimited-timeout", {
			language: "js",
			code: "await Bun.sleep(100); print('completed');",
			timeout: 0,
		});

		expect(result.content.some(block => block.type === "text" && block.text.includes("completed"))).toBe(true);
		expect(result.details?.cells?.[0]?.status).toBe("complete");
	});

	it("bounds a compute cell (no agent/completion) by a plain wall-clock timeout", async () => {
		// Exercise the real worker cancellation path without spending a full
		// second waiting for the requested public timeout.
		vi.spyOn(toolTimeouts, "clampTimeout").mockReturnValue(0.05);
		const tool = new EvalTool(makeSession());
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

	it("reports a dead JS worker instead of waiting for the cell timeout", async () => {
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-worker-exit", {
			language: "js",
			code: "process.exit(0);",
			timeout: 1,
		});

		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(text).toContain("JS eval worker exited");
		expect(text).not.toContain("timed out");

		const cell = result.details?.cells?.[0];
		expect(cell?.status).toBe("error");
		expect(cell?.exitCode).toBe(1);
	});
});
