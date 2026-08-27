/**
 * Migrated bash/eval routes stopped emitting live
 * `tool_execution_update`s on the wire, so `RpcClient` folds raw
 * `tool_presentation` frames into cumulative snapshots for its listeners.
 * Raw frames stay unforwarded exactly as before; synthesis is a
 * display-consumer concern and never reaches an ACP-bound subscriber.
 *
 * Contracts under test (via the exported {@link RpcPresentationFold}):
 *  - Synthesized updates are cumulative `tool_execution_update`s carrying the
 *    `[stream.text, …displays, …facts]` composition and the call's args.
 *  - Bare `started` synthesizes nothing; settled stops folding (status stays
 *    with the real end event) and drops the accumulator.
 *  - Lifecycle clears: noteEnd per call, clear wholesale (agent_end/stop).
 */
import { describe, expect, it } from "bun:test";
import { streamId, ToolPresentationStream } from "@oh-my-pi/pi-agent-core/presentation";
import { RpcPresentationFold } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

type PresentationFrame = Extract<AgentSessionEvent, { type: "tool_presentation" }>;

function startedFrame(toolCallId: string): PresentationFrame {
	return {
		type: "tool_presentation",
		toolCallId,
		toolName: "bash",
		event: { type: "started", call: { toolCallId, toolName: "bash", title: "ls", kind: "execute" } },
	};
}

function frame(toolCallId: string, event: PresentationFrame["event"]): PresentationFrame {
	return { type: "tool_presentation", toolCallId, toolName: "bash", event };
}

/** Producer wired straight through the fold, mirroring the live frame flow. */
function wireToFold(fold: RpcPresentationFold, streamKey: string, toolCallId: string) {
	let lastUpdate: AgentSessionEvent | undefined;
	const producer = new ToolPresentationStream(streamId(streamKey), event => {
		const synthesized = fold.synthesize(frame(toolCallId, event));
		if (synthesized !== undefined) lastUpdate = synthesized;
	});
	const lastText = (): string =>
		lastUpdate?.type === "tool_execution_update" ? (lastUpdate.partialResult.content[0]?.text ?? "") : "";
	return { producer, lastText };
}

describe("RpcPresentationFold", () => {
	it("synthesizes cumulative tool_execution_updates carrying stream text, displays, facts, and args", () => {
		const fold = new RpcPresentationFold();
		fold.noteStart("c1", { command: "ls" });
		const source = wireToFold(fold, "s:c1", "c1");

		// Bare started: nothing observable yet, no delivery.
		expect(fold.synthesize(startedFrame("c1"))).toBeUndefined();
		expect(source.lastText()).toBe("");

		source.producer.appendTerminal("hello ");
		expect(source.lastText()).toContain("hello");

		source.producer.declareDisplay({ kind: "sequence", items: [{ kind: "json", value: { n: 7 } }] });
		source.producer.appendTerminal("world");
		source.producer.fact({ kind: "notice", text: "done soon" });

		// Cumulative snapshot composes [stream.text, …displays, …facts].
		const text = source.lastText();
		expect(text).toContain("hello world");
		expect(text).toContain("display[1]");
		expect(text).toContain("7");
		expect(text).toContain("done soon");
		expect(text.indexOf("hello world")).toBeLessThan(text.indexOf("display[1]"));
		expect(text.indexOf("display[1]")).toBeLessThan(text.indexOf("done soon"));
	});

	it("carries the call identity and start args on every synthesized update", () => {
		let captured: AgentSessionEvent | undefined;
		const fold = new RpcPresentationFold();
		fold.noteStart("c9", { command: "true" });
		const producer = new ToolPresentationStream(streamId("s:c9"), event => {
			const synthesized = fold.synthesize(frame("c9", event));
			if (synthesized !== undefined) captured = synthesized;
		});

		producer.appendTerminal("x\n");
		expect(captured?.type).toBe("tool_execution_update");
		if (captured?.type !== "tool_execution_update") throw new Error("expected a synthesized update");
		expect(captured.toolCallId).toBe("c9");
		expect(captured.toolName).toBe("bash");
		expect(captured.args).toEqual({ command: "true" });
	});

	it("stops folding at settled and drops the accumulator", () => {
		const fold = new RpcPresentationFold();
		fold.noteStart("c2", undefined);
		const source = wireToFold(fold, "s:c2", "c2");

		expect(fold.synthesize(startedFrame("c2"))).toBeUndefined();
		source.producer.appendTerminal("bytes\n");
		expect(source.lastText()).toContain("bytes");

		// Settled: no delivery, accumulator dropped — status rides the real end.
		expect(
			fold.synthesize({
				type: "tool_presentation",
				toolCallId: "c2",
				toolName: "bash",
				event: { type: "settled", outcome: { kind: "succeeded", process: { kind: "exited", code: 0 } } },
			}),
		).toBeUndefined();

		// A late append after settled starts a FRESH fold — no stale bytes leak
		// across calls that reuse the id.
		const lateSource = wireToFold(fold, "s:c2-late", "c2");
		lateSource.producer.appendTerminal("next-call\n");
		expect(lateSource.lastText()).not.toContain("bytes");
		expect(lateSource.lastText()).toContain("next-call");
	});

	it("clears per call on noteEnd and wholesale on clear()", () => {
		const fold = new RpcPresentationFold();
		const source = wireToFold(fold, "s:c3", "c3");

		fold.noteEnd("never-created");
		fold.noteStart("c3", { command: "true" });
		source.producer.appendTerminal("payload\n");
		expect(source.lastText()).toContain("payload");

		// After end, the next presentation event folds into a fresh accumulator
		// instead of appending onto dead state.
		fold.noteEnd("c3");
		source.producer.appendTerminal("payload\n");
		expect(source.lastText()).toBe("payload\n");

		// agent_end / stop: everything goes, even without end events.
		fold.clear();
		const tailSource = wireToFold(fold, "s:c4", "c4");
		tailSource.producer.appendTerminal("tail\n");
		expect(tailSource.lastText()).toBe("tail\n");
	});
});
