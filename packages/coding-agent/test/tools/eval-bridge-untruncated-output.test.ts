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
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import * as tabSupervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

/** Comfortably past the 50 KiB `enforceInlineByteCap` default. */
const HUGE_OUTPUT = Array.from({ length: 4000 }, (_, i) => `line-${i}-${"payload".repeat(4)}`).join("\n");

function makeSession(): { session: ToolSession; prelude: EvalPreludeDefinition } {
	const session = {
		cwd: "/tmp/eval-bridge-untruncated",
		settings: Settings.isolated(),
	} as unknown as ToolSession;
	const prelude = createBrowserPrelude(session);
	// The bridge resolves preludes from the session's live enabled set.
	(session as { getEvalPreludes?: () => EvalPreludeDefinition[] }).getEvalPreludes = () => [prelude];
	return { session, prelude };
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

		const { session, prelude } = makeSession();
		const args = { action: "run", code: "return capture()" };

		// Model path: the prelude runs with no programmatic-caller tool context.
		const modelResult = await prelude.invoke(args, { session, toolCallId: "call-model" });
		const modelText = textOf(modelResult);
		expect(modelText).toMatch(/\[…\d+B elided…\]/);
		expect(modelText).not.toBe(HUGE_OUTPUT);

		// Kernel path: the same prelude driven through the eval bridge.
		const bridgeValue = await callSessionTool("__prelude__", { name: "browser", parameters: args }, { session });
		const bridgeText = typeof bridgeValue === "string" ? bridgeValue : "text" in bridgeValue ? bridgeValue.text : "";
		expect(bridgeText).toBe(HUGE_OUTPUT);
		expect(bridgeText).not.toContain("elided");
	});
});
