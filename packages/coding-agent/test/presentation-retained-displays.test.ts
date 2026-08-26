import { describe, expect, it } from "bun:test";
import type {
	ToolCallPresentation,
	ToolDisplayOutput,
	ToolPresentationEvent,
	ToolPresentationRecord,
} from "@oh-my-pi/pi-agent-core/presentation";
import { byteOffset, streamId, ToolPresentationStream } from "@oh-my-pi/pi-agent-core/presentation";
import { checkedNotificationPayload, encodeToolFrames } from "../src/modes/acp/view/encoder";
import { negotiateTerminalMetaCap } from "../src/modes/acp/view/frames";
import type { AcpRenderContext } from "../src/modes/acp/view/reducer";
import { INITIAL_ACP_TOOL_VIEW, reduceAcpToolView } from "../src/modes/acp/view/reducer";
import { hydrateReplayableToolExecution } from "../src/presentation/hydrate";
import { MODEL_PROJECTION_VERSION, TOOL_JOURNAL_RECORD_VERSION, toolCallRecordOf } from "../src/presentation/journal";
import { LiveToolPresentationRecord } from "../src/presentation/live-record";
import { persistedToolJournalSchema } from "../src/presentation/schemas/journal";

/**
 * `display_output` folds into `ToolPresentationRecord.displays`
 * instead of being dropped by the live journal tracker, so `session/load` replay
 * no longer loses eval display output.
 *
 * Every test here writes through the real production path — a real
 * `ToolPresentationStream` producer, `LiveToolPresentationRecord.fold`/`finish`,
 * a JSON round trip through `persistedToolJournalSchema` (the actual on-disk
 * hop) — then reads back through `hydrateReplayableToolExecution` and the ACP
 * reducer, exactly like `session-tool-execution-settled-journal.test.ts` and
 * `presentation-hydrate.test.ts` do for the stream-only case.
 */

const CALL_ID = "call-retained-display-1";
const HEAD = "RETAINED-HEAD-0001\n"; // 19 bytes, all ASCII
const TAIL = "RETAINED-TAIL-0002\n"; // 19 bytes, all ASCII

function execCall(): ToolCallPresentation {
	return { toolCallId: CALL_ID, toolName: "eval", title: "eval cell", kind: "execute", cwd: "/repo" };
}

function metaContext(phase: "live" | "replay"): AcpRenderContext {
	const cap = negotiateTerminalMetaCap(true);
	if (!cap) throw new Error("expected a capability witness");
	return { phase, terminal: { kind: "meta_only", cap }, cwd: "/repo", fence: true };
}

/** Drive events through the reducer, returning the concatenated meta-terminal text. */
function driveTerminalText(events: readonly ToolPresentationEvent[], context: AcpRenderContext): string {
	let state = INITIAL_ACP_TOOL_VIEW;
	let text = "";
	for (const event of events) {
		const step = reduceAcpToolView(state, event, context);
		state = step.state;
		for (const checked of encodeToolFrames("session-1", step.frames)) {
			const payload = checkedNotificationPayload(checked);
			const update = payload.update as { _meta?: { terminal_output?: { data?: string } } };
			const chunk = update._meta?.terminal_output?.data;
			if (typeof chunk === "string") text += chunk;
		}
	}
	return text;
}

/** Round-trip a finished record through the exact on-disk hop: JSON.stringify/parse, then schema-validated. */
function roundTripSettledEntry(call: ToolCallPresentation, presentation: ToolPresentationRecord) {
	const entry = {
		type: "tool_execution_settled" as const,
		recordVersion: TOOL_JOURNAL_RECORD_VERSION,
		executionId: "exec-retained-display-1",
		outcome: { kind: "succeeded" as const },
		presentation,
		modelProjection: { version: MODEL_PROJECTION_VERSION, content: [] },
	};
	const roundTripped = JSON.parse(JSON.stringify(entry));
	const parsed = persistedToolJournalSchema.safeParse(roundTripped);
	expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
	if (!parsed.success || parsed.data.type !== "tool_execution_settled") {
		throw new Error("expected a parsed tool_execution_settled record");
	}
	return { call: toolCallRecordOf(call), ...parsed.data };
}

describe("retained display_output — interleaved with a clean window", () => {
	it("folds a display between two appends at its exact byte cursor and round-trips it through the schema", () => {
		const events: ToolPresentationEvent[] = [];
		const producer = new ToolPresentationStream(streamId(CALL_ID), event => events.push(event));
		const display: ToolDisplayOutput = { kind: "sequence", items: [{ kind: "json", value: { cell: 1 } }] };

		producer.appendTerminal(HEAD);
		producer.declareDisplay(display);
		producer.appendTerminal(TAIL);

		const acc = new LiveToolPresentationRecord();
		for (const event of events) acc.fold(event);
		const presentation = acc.finish();

		// The write side: the display's atByte is exactly where HEAD ended.
		expect(presentation.displays).toEqual([{ atByte: byteOffset(19), display }]);

		const {
			call,
			outcome,
			presentation: readBack,
			modelProjection,
		} = roundTripSettledEntry(execCall(), presentation);
		expect(readBack.displays).toEqual([{ atByte: byteOffset(19), display }]);

		const liveEvents: ToolPresentationEvent[] = [{ type: "started", call: execCall() }, ...events];
		const replayEvents = hydrateReplayableToolExecution({
			state: "settled",
			call,
			outcome,
			presentation: readBack,
			modelProjection,
		});

		// Placement fidelity: the reducer sees the display land between HEAD and
		// TAIL on both the live run and the replayed one — never moved to the end.
		const live = driveTerminalText(liveEvents, metaContext("live"));
		const replay = driveTerminalText(replayEvents, metaContext("replay"));
		expect(replay).toBe(live);
		const headIdx = replay.indexOf("RETAINED-HEAD-0001");
		const displayIdx = replay.indexOf('"cell": 1');
		const tailIdx = replay.indexOf("RETAINED-TAIL-0002");
		expect(headIdx).toBeGreaterThanOrEqual(0);
		expect(displayIdx).toBeGreaterThan(headIdx);
		expect(tailIdx).toBeGreaterThan(displayIdx);

		// Exactly one clean terminal_append per side of the display — proof the
		// replay split the retained text around it rather than degrading.
		expect(replayEvents.filter(event => event.type === "terminal_append")).toHaveLength(2);
		expect(replayEvents.filter(event => event.type === "display_output")).toHaveLength(1);
	});

	it("places a display declared before any append at atByte 0", () => {
		const events: ToolPresentationEvent[] = [];
		const producer = new ToolPresentationStream(streamId(CALL_ID), event => events.push(event));
		const display: ToolDisplayOutput = { kind: "sequence", items: [{ kind: "invalid_json" }] };

		producer.declareDisplay(display);
		producer.appendTerminal(HEAD);

		const acc = new LiveToolPresentationRecord();
		for (const event of events) acc.fold(event);
		const presentation = acc.finish();

		expect(presentation.displays).toEqual([{ atByte: byteOffset(0), display }]);

		const {
			call,
			outcome,
			presentation: readBack,
			modelProjection,
		} = roundTripSettledEntry(execCall(), presentation);
		const replayEvents = hydrateReplayableToolExecution({
			state: "settled",
			call,
			outcome,
			presentation: readBack,
			modelProjection,
		});
		// The display precedes the sole append — never trailing behind it.
		const displayIdx = replayEvents.findIndex(event => event.type === "display_output");
		const appendIdx = replayEvents.findIndex(event => event.type === "terminal_append");
		expect(displayIdx).toBeGreaterThanOrEqual(0);
		expect(appendIdx).toBeGreaterThan(displayIdx);
	});
});

describe("retained display_output — degraded placement under retention truncation", () => {
	it("survives a truncating read: the display is retained and replayed even though its position is lost", () => {
		const events: ToolPresentationEvent[] = [];
		const producer = new ToolPresentationStream(streamId(CALL_ID), event => events.push(event));
		const bigChunk = "X".repeat(40); // 40 ASCII bytes, well past a 10-byte head window
		const display: ToolDisplayOutput = { kind: "sequence", items: [{ kind: "json", value: { late: true } }] };

		producer.appendTerminal(bigChunk);
		producer.declareDisplay(display);

		// A tiny head window forces retention truncation: the record cannot prove
		// where a declared offset past byte 10 sits inside the kept text.
		const acc = new LiveToolPresentationRecord(10);
		for (const event of events) acc.fold(event);
		const presentation = acc.finish();

		expect(presentation.stream?.text).toBe("X".repeat(10));
		expect(presentation.stream?.endByte).toBe(byteOffset(40));
		expect(presentation.facts.some(fact => fact.kind === "truncation")).toBe(true);
		// The display is folded in full regardless of the byte cap — items, not bytes.
		expect(presentation.displays).toEqual([{ atByte: byteOffset(40), display }]);

		const {
			call,
			outcome,
			presentation: readBack,
			modelProjection,
		} = roundTripSettledEntry(execCall(), presentation);
		expect(readBack.displays).toEqual([{ atByte: byteOffset(40), display }]);
		expect(readBack.facts.some(fact => fact.kind === "truncation")).toBe(true);

		const replayEvents = hydrateReplayableToolExecution({
			state: "settled",
			call,
			outcome,
			presentation: readBack,
			modelProjection,
		});

		// Degraded, not dropped: the truncated body still replays, and the display
		// still reaches the reducer — after the body, per declaration order, since
		// the window cannot prove its true position.
		const appendIdx = replayEvents.findIndex(event => event.type === "terminal_append");
		const displayIdx = replayEvents.findIndex(event => event.type === "display_output");
		expect(appendIdx).toBeGreaterThanOrEqual(0);
		expect(displayIdx).toBeGreaterThan(appendIdx);
		const displayEvent = replayEvents[displayIdx];
		if (displayEvent?.type !== "display_output") throw new Error("expected a display_output event");
		expect(displayEvent.display).toEqual(display);

		const replay = driveTerminalText(replayEvents, metaContext("replay"));
		expect(replay).toContain('"late": true');
		expect(replay).toContain("[Showing first 10B of 40B]");
	});
});
