/**
 * A tool result destined for the `eval` kernel must never be middle-elided.
 *
 * Incident: an eval cell captured a screenshot via `tool.browser({action:"run"})`
 * and `Buffer.from(shot.text, "base64")`-decoded the result. The text had been
 * middle-elided by the 50 KiB inline cap, base64 decoding skipped the
 * `[…NB elided…]` marker, and the cell wrote a PNG with a valid header, six
 * intact IDAT chunks, a hole, and no IEND. Every subsequent provider request
 * failed with `invalid_value` and the session was unrecoverable.
 *
 * The inline cap protects the MODEL's context window; a programmatic caller
 * gets the bytes it asked for.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { BrowserTool } from "@oh-my-pi/pi-coding-agent/tools/browser";
import * as tabSupervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

/** Comfortably past the 50 KiB `enforceInlineByteCap` default. */
const HUGE_OUTPUT = Array.from({ length: 4000 }, (_, i) => `line-${i}-${"payload".repeat(4)}`).join("\n");

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/eval-bridge-untruncated",
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("eval bridge tool output", () => {
	it("stays byte-identical for the kernel while the model path is still capped", async () => {
		expect(Buffer.byteLength(HUGE_OUTPUT, "utf-8")).toBeGreaterThan(50 * 1024);

		using _runInTab = spyOn(tabSupervisor, "runInTab").mockResolvedValue({
			displays: [{ type: "text", text: HUGE_OUTPUT }],
			returnValue: undefined,
			screenshots: [],
		} as never);

		const session = makeSession();
		const tool = new BrowserTool(session);
		const args = { action: "run", code: "return capture()" };

		// Model path: the tool executes with no programmatic-caller context.
		const modelResult = await tool.execute("call-model", args as never, undefined, undefined, undefined);
		const modelText = textOf(modelResult);
		expect(modelText).toMatch(/\[…\d+B elided…\]/);
		expect(modelText).not.toBe(HUGE_OUTPUT);

		// Kernel path: the same tool driven through the eval bridge.
		const bridgeValue = await callSessionTool("browser", args, {
			session: { ...session, getToolByName: () => tool } as unknown as ToolSession,
		});
		const bridgeText = typeof bridgeValue === "string" ? bridgeValue : "text" in bridgeValue ? bridgeValue.text : "";
		expect(bridgeText).toBe(HUGE_OUTPUT);
		expect(bridgeText).not.toContain("elided");
	});
});
