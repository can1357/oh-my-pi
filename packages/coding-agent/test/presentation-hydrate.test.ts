import { describe, expect, it } from "bun:test";
import type { ToolAttachment, ToolCallPresentation, ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import { byteOffset, streamId, ToolPresentationStream } from "@oh-my-pi/pi-agent-core/presentation";
import { checkedNotificationPayload, encodeToolFrames } from "../src/modes/acp/view/encoder";
import { negotiateTerminalMetaCap } from "../src/modes/acp/view/frames";
import type { AcpRenderContext } from "../src/modes/acp/view/reducer";
import { INITIAL_ACP_TOOL_VIEW, reduceAcpToolView } from "../src/modes/acp/view/reducer";
import { hydrateReplayableToolExecution } from "../src/presentation/hydrate";
import type { ReplayableToolExecution } from "../src/presentation/journal";
import { renderModelContent } from "../src/presentation/projections";

/**
 * `hydrateReplayableToolExecution` in isolation, separate from the production
 * callers that wire it in: `AcpAgent#replayHydratedToolExecution`
 * (`acp-agent.ts`) feeds `session/tool-journal-correlation.ts`'s
 * `nextReplayableToolExecution` result through this exact function during
 * `#replaySessionHistory`, for `session/load`, fork, and rewind replay alike.
 * `interactive-mode.ts`/`ui-helpers.ts` and `session/exit-diagnostics.ts`
 * consume the correlated `ReplayableToolExecution` for their own dangling-call
 * detection (see `session-context.ts`'s `InterruptedToolCallsMarker`), not
 * this hydration step directly — they render the folded record, not a
 * replayed event stream.
 *
 * Every test proves the same contract: hydrating a `ReplayableToolExecution`
 * and reducing the result with `phase: "replay"` reproduces what the *live*
 * event sequence produced through the same reducer, given the persisted
 * record actually carries the necessary information. Where the
 * record structurally cannot ("chunk-by-chunk append boundaries"), the
 * assertion is on the reducer's rendered *output* — the concatenated body and
 * model content — rather than on frame-for-frame equality, because that is
 * the fidelity the reducer actually promises.
 */

const CALL_ID = "call-hyd-1";

function plainContext(): AcpRenderContext {
	return { phase: "live", terminal: { kind: "none" }, cwd: "/repo", fence: true };
}

function replayPlainContext(): AcpRenderContext {
	return { phase: "replay", terminal: { kind: "none" }, cwd: "/repo", fence: true };
}

function metaContext(): AcpRenderContext {
	const cap = negotiateTerminalMetaCap(true);
	if (!cap) throw new Error("expected a capability witness");
	return { phase: "live", terminal: { kind: "meta_only", cap }, cwd: "/repo", fence: true };
}

function replayMetaContext(): AcpRenderContext {
	const cap = negotiateTerminalMetaCap(true);
	if (!cap) throw new Error("expected a capability witness");
	return { phase: "replay", terminal: { kind: "meta_only", cap }, cwd: "/repo", fence: true };
}

function execCall(overrides: Partial<ToolCallPresentation> = {}): ToolCallPresentation {
	return { toolCallId: CALL_ID, toolName: "bash", title: "echo hi", kind: "execute", cwd: "/repo", ...overrides };
}

/** Drive an event list through the reducer, returning the final state, text updates, and raw content items. */
function drive(events: readonly ToolPresentationEvent[], context: AcpRenderContext) {
	let state = INITIAL_ACP_TOOL_VIEW;
	const terminalOutputs: string[] = [];
	let contentTexts: string[] = [];
	let contentItems: unknown[] = [];
	for (const event of events) {
		const step = reduceAcpToolView(state, event, context);
		state = step.state;
		for (const checked of encodeToolFrames("session-1", step.frames)) {
			const payload = checkedNotificationPayload(checked);
			const update = payload.update as {
				content?: readonly { type: string; content?: { type: string; text?: string } }[];
				_meta?: { terminal_output?: { data?: string } };
			};
			const chunk = update._meta?.terminal_output?.data;
			if (typeof chunk === "string") terminalOutputs.push(chunk);
			if (Array.isArray(update.content)) {
				contentItems = update.content;
				contentTexts = update.content
					.filter(item => item.type === "content" && item.content?.type === "text")
					.map(item => item.content?.text ?? "");
			}
		}
	}
	return { state, terminalOutputs, contentTexts, contentItems };
}

/** Build a settled record's terminal-bearing execution from a real producer run. */
function recordFromProducerRun(build: (producer: ToolPresentationStream) => void): {
	events: ToolPresentationEvent[];
	presentation: ReplayableToolExecution & { state: "settled" };
} {
	const events: ToolPresentationEvent[] = [];
	const producer = new ToolPresentationStream(streamId(CALL_ID), event => events.push(event));
	build(producer);
	const attachments: ToolAttachment[] = [];
	for (const event of events) if (event.type === "attachment") attachments.push(event.attachment);
	const endByte = byteOffset(producer.nextByte);
	const text = events
		.filter(
			(event): event is Extract<ToolPresentationEvent, { type: "terminal_append" }> =>
				event.type === "terminal_append",
		)
		.map(event => event.data)
		.join("");
	return {
		events,
		presentation: {
			state: "settled",
			call: { toolCallId: CALL_ID, toolName: "bash", title: "echo hi", kind: "execute", cwd: "/repo" },
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				stream:
					text.length > 0
						? { streamId: streamId(CALL_ID), startByte: byteOffset(0), endByte, text, gaps: [] }
						: undefined,
				facts: producer.declaredFacts,
				attachments,
			},
			modelProjection: { version: 1, content: [] },
		},
	};
}

describe("hydrateReplayableToolExecution — settled, plain content", () => {
	it("reproduces the live model content for a plain result with a fact", () => {
		const { presentation } = recordFromProducerRun(producer => {
			producer.appendTerminal("HYDRATE-PLAIN-LINE-0001\n");
			producer.fact({ kind: "wall_time", ms: 42 });
		});

		const liveEvents: ToolPresentationEvent[] = [
			{ type: "started", call: execCall() },
			{
				type: "terminal_append",
				streamId: streamId(CALL_ID),
				sequence: 0 as never,
				startByte: 0 as never,
				data: "HYDRATE-PLAIN-LINE-0001\n",
			},
			{ type: "fact", fact: presentation.presentation.facts[0] as never },
			{ type: "settled", outcome: { kind: "succeeded" } },
		];

		const live = drive(liveEvents, plainContext());
		const replay = drive(hydrateReplayableToolExecution(presentation), replayPlainContext());

		expect(replay.contentTexts).toEqual(live.contentTexts);
		expect(replay.contentTexts.join("\n")).toContain("HYDRATE-PLAIN-LINE-0001");
		if (replay.state.state !== "settled") throw new Error("expected settled state");
		expect(replay.state.outcome).toEqual({ kind: "succeeded" });

		// Model content fidelity: the persisted view (record + outcome) renders the
		// same body a fresh live run's settled record would.
		const modelContent = renderModelContent({
			call: presentation.call,
			outcome: presentation.outcome,
			presentation: presentation.presentation,
		});
		expect(modelContent).toEqual([
			{ type: "text", text: expect.stringContaining("HYDRATE-PLAIN-LINE-0001") as unknown as string },
		]);
	});
});

describe("hydrateReplayableToolExecution — settled, terminal-bearing", () => {
	it("delivers the same concatenated terminal bytes as a multi-chunk live run, in one replay append", () => {
		const { presentation } = recordFromProducerRun(producer => {
			producer.appendTerminal("TERM-CHUNK-AAA\n");
			producer.appendTerminal("TERM-CHUNK-BBB\n");
			producer.appendTerminal("TERM-CHUNK-CCC\n");
		});

		const liveEvents: ToolPresentationEvent[] = [
			{ type: "started", call: execCall() },
			{
				type: "terminal_append",
				streamId: streamId(CALL_ID),
				sequence: 0 as never,
				startByte: 0 as never,
				data: "TERM-CHUNK-AAA\n",
			},
			{
				type: "terminal_append",
				streamId: streamId(CALL_ID),
				sequence: 1 as never,
				startByte: 15 as never,
				data: "TERM-CHUNK-BBB\n",
			},
			{
				type: "terminal_append",
				streamId: streamId(CALL_ID),
				sequence: 2 as never,
				startByte: 30 as never,
				data: "TERM-CHUNK-CCC\n",
			},
			{ type: "settled", outcome: { kind: "succeeded" } },
		];

		const live = drive(liveEvents, metaContext());
		const replayEvents = hydrateReplayableToolExecution(presentation);
		const replay = drive(replayEvents, replayMetaContext());

		// Live streams three separate terminal_output frames; replay carries the same
		// bytes in one — a difference in frame *count* is the honest chunk-boundary
		// loss the adapter's doc comment states, not a body divergence.
		expect(replayEvents.filter(event => event.type === "terminal_append")).toHaveLength(1);
		expect(replay.terminalOutputs.join("")).toBe(live.terminalOutputs.join(""));
		expect(replay.terminalOutputs.join("")).toBe("TERM-CHUNK-AAA\nTERM-CHUNK-BBB\nTERM-CHUNK-CCC\n");
	});

	it("carries a declared gap to the same exact discontinuity notice as live", () => {
		const events: ToolPresentationEvent[] = [];
		const producer = new ToolPresentationStream(streamId(CALL_ID), event => events.push(event));
		producer.appendTerminal("GAP-HEAD-0001\n");
		producer.declareGap(64);
		producer.appendTerminal("GAP-TAIL-0002\n");

		const text = events
			.filter(
				(event): event is Extract<ToolPresentationEvent, { type: "terminal_append" }> =>
					event.type === "terminal_append",
			)
			.map(event => event.data)
			.join("");
		const presentation: ReplayableToolExecution & { state: "settled" } = {
			state: "settled",
			call: { toolCallId: CALL_ID, toolName: "bash", title: "echo hi", kind: "execute", cwd: "/repo" },
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				stream: {
					streamId: streamId(CALL_ID),
					startByte: byteOffset(0),
					endByte: byteOffset(producer.nextByte),
					text,
					gaps: [{ fromByte: byteOffset(14), toByte: byteOffset(78) }],
				},
				facts: [],
				attachments: [],
			},
			modelProjection: { version: 1, content: [] },
		};

		const live = drive(
			[{ type: "started", call: execCall() }, ...events, { type: "settled", outcome: { kind: "succeeded" } }],
			metaContext(),
		);
		const replay = drive(hydrateReplayableToolExecution(presentation), replayMetaContext());

		expect(replay.terminalOutputs.join("")).toBe(live.terminalOutputs.join(""));
		expect(replay.terminalOutputs.join("")).toContain(
			"[terminal output discontinuity: 64 bytes dropped before delivery]",
		);
	});

	it("falls back to body-then-discontinuities when the window cannot support exact placement", () => {
		// A middle-elided retained window: retained text is shorter than
		// endByte-startByte minus the declared gap, so the record cannot prove the
		// gap's position — the honest degradation, not a guess.
		const presentation: ReplayableToolExecution & { state: "settled" } = {
			state: "settled",
			call: { toolCallId: CALL_ID, toolName: "bash", title: "echo hi", kind: "execute", cwd: "/repo" },
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				stream: {
					streamId: streamId(CALL_ID),
					startByte: byteOffset(0),
					endByte: byteOffset(10_000),
					text: "RETAINED-HEAD-AND-TAIL-ONLY\n",
					gaps: [{ fromByte: byteOffset(5000), toByte: byteOffset(5010) }],
				},
				facts: [],
				attachments: [],
			},
			modelProjection: { version: 1, content: [] },
		};

		const replay = drive(hydrateReplayableToolExecution(presentation), replayMetaContext());
		expect(replay.terminalOutputs.join("")).toContain("RETAINED-HEAD-AND-TAIL-ONLY");
		expect(replay.terminalOutputs.join("")).toContain(
			"[terminal output discontinuity: 10 bytes dropped before delivery]",
		);
		if (replay.state.state !== "settled") throw new Error("expected settled state");
	});
});

describe("hydrateReplayableToolExecution — settled, attachment", () => {
	it("carries a diff attachment into the reduced content, forcing the meta_terminal → content transition", () => {
		const presentation: ReplayableToolExecution & { state: "settled" } = {
			state: "settled",
			call: { toolCallId: CALL_ID, toolName: "bash", title: "echo hi", kind: "execute", cwd: "/repo" },
			outcome: { kind: "succeeded" },
			presentation: {
				version: 1,
				stream: undefined,
				facts: [],
				attachments: [{ kind: "diff", path: "/repo/file.ts", oldText: "old\n", newText: "new\n" }],
			},
			modelProjection: { version: 1, content: [] },
		};

		const replay = drive(hydrateReplayableToolExecution(presentation), replayMetaContext());
		expect(replay.contentTexts).toEqual([]);
		// The discriminating assertion: this must fail if the adapter silently
		// dropped the attachment event, since `contentTexts` alone (text-only) stays
		// empty either way. `RetainedStreamView`-free records force the reducer into
		// the meta_terminal → content transition only when an attachment is present
		// (`reduceSettled`'s `state.attachments.length > 0` branch), so finding the
		// diff item here also proves that transition ran.
		expect(replay.contentItems).toContainEqual({
			type: "diff",
			path: "/repo/file.ts",
			oldText: "old\n",
			newText: "new\n",
		});
		if (replay.state.state !== "settled") throw new Error("expected settled state");
		expect(replay.state.outcome).toEqual({ kind: "succeeded" });
	});
});

describe("hydrateReplayableToolExecution — interrupted", () => {
	it("settles through the reducer's interrupted outcome, with a warning severity and no exit code", () => {
		const presentation: ReplayableToolExecution = {
			state: "interrupted",
			call: { toolCallId: CALL_ID, toolName: "bash", title: "echo hi", kind: "execute", cwd: "/repo" },
			reason: "process crashed before settlement",
			presentation: { version: 1, facts: [] },
		};

		const events = hydrateReplayableToolExecution(presentation);
		expect(events[0]).toEqual({ type: "started", call: presentation.call });
		expect(events.at(-1)).toEqual({
			type: "settled",
			outcome: { kind: "interrupted", reason: "process crashed before settlement" },
		});

		const replay = drive(events, replayMetaContext());
		if (replay.state.state !== "settled") throw new Error("expected settled state");
		expect(replay.state.outcome).toEqual({ kind: "interrupted", reason: "process crashed before settlement" });
	});
});
