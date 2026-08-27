import { describe, expect, it } from "bun:test";
import type { ToolCallPresentation, ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import {
	createLiveTerminalBinding,
	nonZeroExitCode,
	streamId,
	ToolPresentationStream,
} from "@oh-my-pi/pi-agent-core/presentation";
import type { SessionUpdate } from "@oh-my-pi/pi-utils/acp";
import { checkedNotificationPayload, encodeToolFrames } from "../src/modes/acp/view/encoder";
import { type AcpToolFrame, negotiateTerminalMetaCap } from "../src/modes/acp/view/frames";
import type { AcpRenderContext, AcpToolViewState, DeliveryReceipt } from "../src/modes/acp/view/reducer";
import {
	AcpPresentationContinuityError,
	INITIAL_ACP_TOOL_VIEW,
	PROCESS_TEXT_HEAD_WINDOW_BYTES,
	reduceAcpToolView,
} from "../src/modes/acp/view/reducer";
import { driveAcpToolView } from "./helpers/acp-tool-view-driver";

const CALL_ID = "call-1";

function metaOnlyContext(): AcpRenderContext {
	const cap = negotiateTerminalMetaCap(true);
	if (!cap) throw new Error("expected a capability witness");
	return { phase: "live", terminal: { kind: "meta_only", cap }, cwd: "/repo", fence: true };
}

function bashCall(overrides: Partial<ToolCallPresentation> = {}): ToolCallPresentation {
	return {
		toolCallId: CALL_ID,
		toolName: "bash",
		title: "echo hi",
		kind: "execute",
		cwd: "/repo",
		...overrides,
	};
}

/** Drive a whole event list through the reducer, collecting frames and receipts. */
function run(
	events: readonly ToolPresentationEvent[],
	context: AcpRenderContext = metaOnlyContext(),
): { updates: SessionUpdate[]; receipts: DeliveryReceipt[]; state: AcpToolViewState } {
	const run = driveAcpToolView(events, context);
	// Additional assertion layer: the fact-audience delivery ledger,
	// derived structurally from the same typed events, must agree with every
	// receipt the reducer itself issued.
	expect(run.deliveryViolations).toEqual([]);
	return { updates: run.updates, receipts: run.receipts, state: run.state };
}

/** Record the events a producer emits, so tests use the real minting path. */
function record(): { events: ToolPresentationEvent[]; producer: ToolPresentationStream } {
	const events: ToolPresentationEvent[] = [];
	return { events, producer: new ToolPresentationStream(streamId(CALL_ID), event => events.push(event)) };
}

/** Widen branded numeric ids for value assertions. */
function plain(value: number): number {
	return value;
}

function terminalOutputs(updates: readonly SessionUpdate[]): string[] {
	const data: string[] = [];
	for (const update of updates) {
		const meta = (update as { _meta?: { terminal_output?: { data?: unknown } } })._meta;
		const chunk = meta?.terminal_output?.data;
		if (typeof chunk === "string") data.push(chunk);
	}
	return data;
}

/** ACP updates replace a tool call's content array when they carry `content`. */
function applyAcpContentReplacement(updates: readonly SessionUpdate[]): unknown[] | undefined {
	let content: unknown[] | undefined;
	for (const update of updates) {
		const candidate = update as { content?: unknown };
		if (Array.isArray(candidate.content)) content = [...candidate.content];
	}
	return content;
}

describe("ACP tool view reducer — display-only meta terminal", () => {
	it("announces a terminal-bearing tool_call whose content array holds only the terminal", () => {
		const { updates } = run([{ type: "started", call: bashCall() }]);

		expect(updates).toHaveLength(1);
		const announce = updates[0] as unknown as {
			sessionUpdate: string;
			status: string;
			title: string;
			kind: string;
			content: unknown[];
			_meta: { terminal_info: { terminal_id: string; cwd: string } };
		};
		expect(announce.sessionUpdate).toBe("tool_call");
		expect(announce.status).toBe("pending");
		expect(announce.title).toBe("echo hi");
		expect(announce.kind).toBe("execute");
		expect(announce.content).toEqual([{ type: "terminal", terminalId: CALL_ID }]);
		expect(announce._meta.terminal_info).toEqual({ terminal_id: CALL_ID, cwd: "/repo" });
	});

	it("delivers repeated identical chunks exactly once each", () => {
		const { events, producer } = record();
		producer.appendTerminal("SAME-LINE-0001\n");
		producer.appendTerminal("SAME-LINE-0001\n");
		producer.appendTerminal("SAME-LINE-0001\n");

		const { updates, receipts } = run([{ type: "started", call: bashCall() }, ...events]);

		expect(terminalOutputs(updates)).toEqual(["SAME-LINE-0001\n", "SAME-LINE-0001\n", "SAME-LINE-0001\n"]);
		const streamReceipts = receipts.filter(receipt => receipt.kind === "stream");
		expect(
			streamReceipts.map(receipt =>
				receipt.kind === "stream" ? [plain(receipt.fromByte), plain(receipt.toByte)] : [],
			),
		).toEqual([
			[0, 15],
			[15, 30],
			[30, 45],
		]);
	});

	it("moves the card to in_progress exactly once, on the first append", () => {
		const { events, producer } = record();
		producer.appendTerminal("one\n");
		producer.appendTerminal("two\n");

		const { updates } = run([{ type: "started", call: bashCall() }, ...events]);
		const statuses = updates.map(update => (update as { status?: string }).status);
		expect(statuses).toEqual(["pending", "in_progress", undefined]);
	});

	it("counts multi-byte UTF-8 offsets and never splits a chunk mid-character", () => {
		const { events, producer } = record();
		producer.appendTerminal("héllo→\n");
		producer.appendTerminal("😀 done\n");

		const { updates, receipts } = run([{ type: "started", call: bashCall() }, ...events]);
		expect(terminalOutputs(updates)).toEqual(["héllo→\n", "😀 done\n"]);
		const bytes = receipts.flatMap(receipt =>
			receipt.kind === "stream" ? [plain(receipt.fromByte), plain(receipt.toByte)] : [],
		);
		expect(bytes).toEqual([0, 10, 10, 20]);
	});

	it("delivers a final annotation as a fact frame instead of resending the stream", () => {
		const { events, producer } = record();
		producer.appendTerminal("working\n");
		producer.fact({ kind: "wall_time", ms: 1230 });

		const { updates, receipts } = run([{ type: "started", call: bashCall() }, ...events]);
		expect(terminalOutputs(updates)).toEqual(["working\n", "\nWall time: 1.23 seconds\n"]);
		expect(receipts.filter(receipt => receipt.kind === "fact")).toHaveLength(1);
	});

	it("puts settlement status and terminal_exit in one frame", () => {
		const { updates } = run([
			{ type: "started", call: bashCall() },
			{ type: "settled", outcome: { kind: "succeeded" } },
		]);

		const settlement = updates[1] as unknown as {
			sessionUpdate: string;
			status: string;
			_meta: { terminal_exit: { terminal_id: string; exit_code: number | null; signal: string | null } };
		};
		expect(settlement.sessionUpdate).toBe("tool_call_update");
		expect(settlement.status).toBe("completed");
		expect(settlement._meta.terminal_exit).toEqual({ terminal_id: CALL_ID, exit_code: 0, signal: null });
		expect(updates).toHaveLength(2);
	});

	it("computes failed status and the real exit code from the outcome", () => {
		const { updates } = run([
			{ type: "started", call: bashCall() },
			{
				type: "settled",
				outcome: {
					kind: "failed",
					failure: { reason: "process", message: "exit 3" },
					process: { kind: "exited", code: nonZeroExitCode(3) },
				},
			},
		]);

		const settlement = updates[1] as unknown as {
			status: string;
			_meta: { terminal_exit: { exit_code: number | null }; terminal_output?: { data: string } };
		};
		expect(settlement.status).toBe("failed");
		expect(settlement._meta.terminal_exit.exit_code).toBe(3);
		expect(settlement._meta.terminal_output?.data).toBe("\nCommand exited with code 3\n");
	});

	it("reports no exit code for a timeout while still failing the card", () => {
		const { updates } = run([
			{ type: "started", call: bashCall() },
			{
				type: "settled",
				outcome: {
					kind: "failed",
					failure: { reason: "process", message: "Command timed out after 1 seconds" },
					process: { kind: "timed_out", timeoutMs: 1000 },
				},
			},
		]);
		const settlement = updates[1] as unknown as {
			status: string;
			_meta: { terminal_exit: { exit_code: number | null } };
		};
		expect(settlement.status).toBe("failed");
		expect(settlement._meta.terminal_exit.exit_code).toBeNull();
	});
});

describe("ACP tool view reducer — declared gaps", () => {
	it("emits a producer-declared discontinuity and keeps later offsets absolute", () => {
		const { events, producer } = record();
		producer.appendTerminal("head\n");
		producer.declareGap(1024);
		producer.appendTerminal("tail\n");

		const { updates, receipts } = run([{ type: "started", call: bashCall() }, ...events]);
		expect(terminalOutputs(updates)).toEqual([
			"head\n",
			"\n[terminal output discontinuity: 1024 bytes dropped before delivery]\n",
			"tail\n",
		]);
		const gap = receipts.find(receipt => receipt.kind === "stream_gap");
		if (gap?.kind !== "stream_gap") throw new Error("expected a stream_gap receipt");
		expect([plain(gap.fromByte), plain(gap.toByte)]).toEqual([5, 1029]);
	});
});

describe("ACP tool view reducer — continuity assertions", () => {
	it("rejects a duplicated append instead of guessing", () => {
		const { events, producer } = record();
		producer.appendTerminal("only-once\n");
		const [append] = events;
		if (append?.type !== "terminal_append") throw new Error("expected an append");

		let state = reduceAcpToolView(
			INITIAL_ACP_TOOL_VIEW,
			{ type: "started", call: bashCall() },
			metaOnlyContext(),
		).state;
		state = reduceAcpToolView(state, append, metaOnlyContext()).state;
		expect(() => reduceAcpToolView(state, append, metaOnlyContext())).toThrow(AcpPresentationContinuityError);
	});

	it("rejects a byte-offset hole", () => {
		const started = reduceAcpToolView(
			INITIAL_ACP_TOOL_VIEW,
			{ type: "started", call: bashCall() },
			metaOnlyContext(),
		).state;
		expect(() =>
			reduceAcpToolView(
				started,
				{
					type: "terminal_append",
					streamId: streamId(CALL_ID),
					sequence: 0 as never,
					startByte: 99 as never,
					data: "late\n",
				},
				metaOnlyContext(),
			),
		).toThrow(/byte offset discontinuity/);
	});

	it("rejects a second settlement", () => {
		const context = metaOnlyContext();
		let state = reduceAcpToolView(INITIAL_ACP_TOOL_VIEW, { type: "started", call: bashCall() }, context).state;
		state = reduceAcpToolView(state, { type: "settled", outcome: { kind: "succeeded" } }, context).state;
		expect(() => reduceAcpToolView(state, { type: "settled", outcome: { kind: "succeeded" } }, context)).toThrow(
			/settled twice/,
		);
	});
});

describe("ACP tool view reducer — meta_terminal to content transition", () => {
	it("finalizes the display-only terminal in its own frame before emitting attachment content", () => {
		const { events, producer } = record();
		producer.appendTerminal("plot ready\n");
		producer.declareDisplay({ kind: "sequence", items: [{ kind: "json", value: { points: 3 } }] });
		producer.attachment({ kind: "image", data: "AAAA", mimeType: "image/png" });

		const { updates } = run([
			{ type: "started", call: bashCall({ toolName: "eval", title: "[py] plot", sourceEcho: "plot()" }) },
			...events,
			{ type: "settled", outcome: { kind: "succeeded" } },
		]);

		// announce, append, display, terminal exit, replacement snapshot
		expect(updates).toHaveLength(5);
		const exitFrame = updates[3] as unknown as {
			status: string;
			_meta: { terminal_exit: unknown };
			content?: unknown;
		};
		expect(exitFrame.status).toBe("completed");
		expect(exitFrame._meta.terminal_exit).toEqual({ terminal_id: CALL_ID, exit_code: 0, signal: null });
		expect(exitFrame.content).toBeUndefined();

		const contentFrame = updates[4] as unknown as {
			status?: string;
			content: Array<{ type: string; content?: { type?: string; text?: string } }>;
		};
		expect(contentFrame.status).toBeUndefined();
		expect(contentFrame.content.map(item => item.type)).toEqual(["content", "content"]);
		// No terminal item sits beside the image.
		expect(contentFrame.content.some(item => item.type === "terminal")).toBe(false);
		// ACP content is a replacement snapshot, so the terminal-delivered timeline
		// is retained once in the final non-terminal content rather than lost.
		expect(contentFrame.content[0]?.content).toEqual({
			type: "text",
			text: 'plot()\n\n```\nplot ready\n\ndisplay[1]:\n{\n  "points": 3\n}\n```',
		});
	});

	it("replaces terminal content with one complete logical card after an attachment", () => {
		const { events, producer } = record();
		producer.appendTerminal("process");
		producer.declareDisplay({ kind: "sequence", items: [{ kind: "json", value: { points: 3 } }] });
		producer.fact({ kind: "wall_time", ms: 1000 });
		producer.attachment({ kind: "image", data: "AAAA", mimeType: "image/png" });

		const { updates } = run([
			{ type: "started", call: bashCall({ toolName: "eval", title: "[py] plot", sourceEcho: "plot()" }) },
			...events,
			{ type: "settled", outcome: { kind: "succeeded" } },
		]);

		const content = applyAcpContentReplacement(updates);
		expect(content).toEqual([
			{
				type: "content",
				content: {
					type: "text",
					text: 'plot()\n\n```\nprocess\n\ndisplay[1]:\n{\n  "points": 3\n}\n```\n\nWall time: 1.00 seconds',
				},
			},
			{ type: "content", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
		]);

		const text = (content?.[0] as { content?: { text?: string } } | undefined)?.content?.text ?? "";
		expect((text.match(/plot\(\)/g) ?? []).length).toBe(1);
		expect((text.match(/process/g) ?? []).length).toBe(1);
		expect((text.match(/display\[1\]/g) ?? []).length).toBe(1);
		expect((text.match(/Wall time: 1\.00 seconds/g) ?? []).length).toBe(1);
	});
});

it("delivers a no-output eval source echo before the image terminal exit", () => {
	const { events, producer } = record();
	producer.attachment({ kind: "image", data: "AAAA", mimeType: "image/png" });

	const { updates } = run([
		{ type: "started", call: bashCall({ toolName: "eval", title: "[py] plot", sourceEcho: "plot()" }) },
		...events,
		{ type: "settled", outcome: { kind: "succeeded" } },
	]);

	const sourceFrame = updates[1] as unknown as { _meta: { terminal_output?: { data?: string } } };
	expect(sourceFrame._meta.terminal_output?.data).toBe(`plot()\n${"─".repeat(48)}\n`);
	const exitFrame = updates[2] as unknown as { _meta: { terminal_exit?: unknown } };
	expect(exitFrame._meta.terminal_exit).toEqual({ terminal_id: CALL_ID, exit_code: 0, signal: null });
	const contentFrame = updates[3] as unknown as { content: { type: string }[] };
	expect(contentFrame.content.some(item => item.type === "terminal")).toBe(false);
});

describe("ACP tool view reducer — plain fallback", () => {
	it("holds bytes and facts until settlement and fences the body", () => {
		const { events, producer } = record();
		producer.appendTerminal("hello\n");
		producer.fact({ kind: "artifact", artifactId: "7" });

		const { updates } = run([{ type: "started", call: bashCall() }, ...events], {
			phase: "live",
			terminal: { kind: "none" },
			fence: true,
		});

		expect(updates).toHaveLength(1);
		const settlement = run(
			[{ type: "started", call: bashCall() }, ...events, { type: "settled", outcome: { kind: "succeeded" } }],
			{ phase: "live", terminal: { kind: "none" }, fence: true },
		).updates[1] as unknown as { content: { content: { text: string } }[] };
		// The producer's own trailing newline survives verbatim inside the fence:
		// nothing here rewrites the bytes the process emitted.
		expect(settlement.content[0]?.content.text).toBe("```\nhello\n\n```\n\n[raw output: artifact://7]");
	});

	it("uses projection-owned separators for ordered process and display segments on the plain path", () => {
		const { events, producer } = record();
		producer.appendTerminal("A");
		producer.declareDisplay({
			kind: "sequence",
			items: [
				{ kind: "json", value: { x: 1 } },
				{ kind: "json", value: { y: 2 } },
			],
		} as never);
		producer.appendTerminal("B");

		const settlement = run(
			[{ type: "started", call: bashCall() }, ...events, { type: "settled", outcome: { kind: "succeeded" } }],
			{ phase: "live", terminal: { kind: "none" }, fence: false },
		).updates[1] as unknown as { content: { content: { text: string } }[] };

		expect(settlement.content[0]?.content.text).toBe(
			'A\n\ndisplay[1]:\n{\n  "x": 1\n}\n\ndisplay[2]:\n{\n  "y": 2\n}\n\nB',
		);
	});

	it("uses the same separators for separate display events on the meta terminal", () => {
		const { events, producer } = record();
		producer.appendTerminal("A");
		producer.declareDisplay({ kind: "sequence", items: [{ kind: "json", value: { first: 1 } }] });
		producer.declareDisplay({ kind: "sequence", items: [{ kind: "json", value: { second: 2 } }] });
		producer.appendTerminal("B");

		const { updates } = run([{ type: "started", call: bashCall() }, ...events]);
		expect(terminalOutputs(updates).join("")).toBe(
			'A\n\ndisplay[1]:\n{\n  "first": 1\n}\n\ndisplay[1]:\n{\n  "second": 2\n}\n\nB',
		);
	});
});

it("projects typed image dimensions without producer-authored display text", () => {
	const { events, producer } = record();
	producer.declareDisplay({
		kind: "sequence",
		items: [
			{
				kind: "image_dimensions",
				originalWidth: 200,
				originalHeight: 100,
				width: 100,
				height: 50,
			},
		],
	});

	const settlement = run(
		[{ type: "started", call: bashCall() }, ...events, { type: "settled", outcome: { kind: "succeeded" } }],
		{ phase: "live", terminal: { kind: "none" }, fence: false },
	).updates[1] as unknown as { content: { content: { text: string } }[] };

	expect(settlement.content[0]?.content.text).toBe(
		"display image 1: [Image: original 200x100, displayed at 100x50. Multiply coordinates by 2.00 to map to original image.]",
	);
});

describe("ACP tool view reducer — process text retention bound", () => {
	it("bounds the plain-mode settlement content to the process-text head window and discloses the cut", () => {
		const { events, producer } = record();
		const head = "h".repeat(PROCESS_TEXT_HEAD_WINDOW_BYTES);
		const overflow = "o".repeat(PROCESS_TEXT_HEAD_WINDOW_BYTES);
		producer.appendTerminal(head);
		producer.appendTerminal(overflow);

		const settlement = run(
			[{ type: "started", call: bashCall() }, ...events, { type: "settled", outcome: { kind: "succeeded" } }],
			{ phase: "live", terminal: { kind: "none" }, fence: false },
		).updates.at(-1) as unknown as { content: { content: { text: string } }[] };

		expect(settlement.content[0]?.content.text).toBe(`${head}\n\n[Showing first 1.0MB of 2.0MB]`);
	});

	it("keeps every byte on the meta-terminal wire even past the retained head window (wire delivery stays uncapped)", () => {
		const { events, producer } = record();
		const chunkA = "a".repeat(PROCESS_TEXT_HEAD_WINDOW_BYTES);
		const chunkB = "b".repeat(4096); // arrives entirely after the window filled
		producer.appendTerminal(chunkA);
		producer.appendTerminal(chunkB);

		const { updates } = run([{ type: "started", call: bashCall() }, ...events]);
		// Every live terminal_control frame carries the event's own bytes in full,
		// regardless of what the reducer's own `segments` accumulator retained.
		expect(terminalOutputs(updates).join("")).toBe(chunkA + chunkB);
	});

	it("keeps byte offsets continuous across the window boundary and into settlement", () => {
		const { events, producer } = record();
		producer.appendTerminal("x".repeat(PROCESS_TEXT_HEAD_WINDOW_BYTES));
		producer.appendTerminal("y".repeat(10));

		const { receipts } = run(
			[{ type: "started", call: bashCall() }, ...events, { type: "settled", outcome: { kind: "succeeded" } }],
			{ phase: "live", terminal: { kind: "none" }, fence: false },
		);
		const streamReceipts = receipts.filter(receipt => receipt.kind === "stream");
		expect(streamReceipts.map(receipt => (receipt.kind === "stream" ? plain(receipt.toByte) : undefined))).toEqual([
			PROCESS_TEXT_HEAD_WINDOW_BYTES,
			PROCESS_TEXT_HEAD_WINDOW_BYTES + 10,
		]);
	});

	it("carries the full plain-era process bytes at live_terminal_attached even past the retained head window", () => {
		// `reduceLiveTerminalAttached`'s plain catch-up
		// frame is the ONLY delivery path for bytes buffered while a plain-routed
		// call had no live wire — `reduceAppend`'s plain arm emits no frame.
		// Capping `segments` for the settlement-snapshot replay must not truncate
		// what this one-shot catch-up frame puts on the wire.
		//
		// `awaitsLiveTerminal: true` (bash's client_terminal route) is the only
		// route `selectAcpToolRenderMode` ever sends a `live_terminal_attached`
		// event to — see the regression test below for the (far more
		// common) plain routes that never receive that event and must not build
		// this mirror at all.
		const cap = negotiateTerminalMetaCap(true);
		if (!cap) throw new Error("expected a capability witness");
		const { events, producer } = record();
		const head = "h".repeat(PROCESS_TEXT_HEAD_WINDOW_BYTES);
		const tail = "t".repeat(5000);
		producer.appendTerminal(head);
		producer.appendTerminal(tail);
		events.push({ type: "live_terminal_attached", binding: createLiveTerminalBinding("term-16") });

		const { updates } = run([{ type: "started", call: bashCall({ awaitsLiveTerminal: true }) }, ...events], {
			phase: "live",
			terminal: { kind: "real", metaCap: cap },
			fence: true,
		});

		expect(terminalOutputs(updates).join("")).toBe(head + tail);
	});

	it("never accumulates an unbounded raw mirror for a plain call that cannot receive live_terminal_attached", () => {
		// `awaitsLiveTerminal` is the only route
		// `selectAcpToolRenderMode` ever sends a `live_terminal_attached` event to
		// (bash's client_terminal route). A `read`-kind call — like any other plain
		// call with `awaitsLiveTerminal` unset — stays `plain` for its ENTIRE
		// lifetime and never reaches that catch-up frame, so the uncapped
		// `rawSegments` mirror must never be built for it: it would otherwise grow
		// unboundedly with nothing ever reading it.
		const { events, producer } = record();
		producer.appendTerminal("x".repeat(PROCESS_TEXT_HEAD_WINDOW_BYTES + 5000));
		producer.declareDisplay({ kind: "sequence", items: [{ kind: "json", value: { x: 1 } }] });

		const { state } = run([{ type: "started", call: bashCall({ kind: "read" }) }, ...events], {
			phase: "live",
			terminal: { kind: "none" },
			fence: true,
		});

		if (state.state !== "plain") throw new Error(`expected the view to stay plain, got ${state.state}`);
		expect(state.rawSegments).toEqual([]);
		expect(state.rawProcessTextBytes).toBe(0);
		expect(state.rawNextSegmentId).toBe(1);
	});
});

describe("ACP tool view reducer — announcement rawInput", () => {
	it("carries rawInput onto the literal tool_call wire frame", () => {
		const { updates } = run([
			{ type: "started", call: bashCall({ rawInput: { command: "echo hi", cwd: "/repo" } }) },
		]);

		// Literal wire assertion: the whole announcement, field for field. The encoder
		// used to drop `ToolCallPresentation.rawInput`, so a migrated call's card lost
		// the arguments a client renders beside it.
		expect(updates[0]).toEqual({
			sessionUpdate: "tool_call",
			toolCallId: CALL_ID,
			title: "echo hi",
			kind: "execute",
			status: "pending",
			content: [{ type: "terminal", terminalId: CALL_ID }],
			rawInput: { command: "echo hi", cwd: "/repo" },
			_meta: { terminal_info: { terminal_id: CALL_ID, cwd: "/repo" } },
		});
	});

	it("omits rawInput when the producer declared none, and emits only the bounded settlement marker as rawOutput", () => {
		const { updates } = run([
			{ type: "started", call: bashCall() },
			{ type: "settled", outcome: { kind: "succeeded" } },
		]);
		for (const update of updates) {
			expect(Object.hasOwn(update, "rawInput")).toBe(false);
		}
		// Non-settlement frames carry no `rawOutput` at all. The settlement frame
		// carries exactly the three-key `AcpToolDiagnostic` marker Zed's
		// `acp_thread.rs` needs (see `frames.ts`) — never a raw result object.
		for (const update of updates.slice(0, -1)) {
			expect(Object.hasOwn(update, "rawOutput")).toBe(false);
		}
		expect(updates.at(-1)).toMatchObject({
			rawOutput: { kind: "tool_settlement", tool: "bash", outcome: "completed" },
		});
	});

	it("carries rawInput on a plain-channel announcement too", () => {
		const { updates } = run(
			[{ type: "started", call: bashCall({ kind: "read", rawInput: { path: "/repo/a.txt" } }) }],
			{ phase: "live", terminal: { kind: "none" }, fence: true },
		);
		expect((updates[0] as unknown as { rawInput?: unknown }).rawInput).toEqual({ path: "/repo/a.txt" });
	});
});

describe("ACP tool view reducer — fact delivery by audience", () => {
	it("delivers each human-facing fact as its own precise terminal payload", () => {
		const { events, producer } = record();
		producer.appendTerminal("out\n");
		producer.fact({ kind: "wall_time", ms: 2500 });
		producer.fact({
			kind: "truncation",
			meta: { direction: "middle", totalBytes: 2048, retainedBytes: 512, elidedBytes: 1536, elidedLines: 12 },
		});
		producer.fact({ kind: "artifact", artifactId: "9" });

		const { updates, receipts } = run([{ type: "started", call: bashCall() }, ...events]);

		// Precise rendered bytes per fact, in order — not merely "a block exists".
		expect(terminalOutputs(updates)).toEqual([
			"out\n",
			"\nWall time: 2.50 seconds\n",
			"\n[Elided 12 lines, 1.5KB from the middle of 2.0KB]\n",
			"\n[raw output: artifact://9]\n",
		]);
		// One receipt per declared fact, each naming the channel it rode.
		const factReceipts = receipts.flatMap(receipt =>
			receipt.kind === "fact" ? [[receipt.factId, receipt.channel] as const] : [],
		);
		const declared = events.flatMap(event => (event.type === "fact" ? [event.fact.id] : []));
		expect(factReceipts.map(([factId]) => factId)).toEqual(declared);
		expect(factReceipts.every(([, channel]) => channel === "terminal_output")).toBe(true);
	});

	it("renders the same facts into the plain settlement content, in the same order", () => {
		const { events, producer } = record();
		producer.appendTerminal("out\n");
		producer.fact({ kind: "wall_time", ms: 2500 });
		producer.fact({ kind: "artifact", artifactId: "9" });

		const { updates } = run(
			[{ type: "started", call: bashCall() }, ...events, { type: "settled", outcome: { kind: "succeeded" } }],
			{ phase: "live", terminal: { kind: "none" }, fence: false },
		);
		const settlement = updates.at(-1) as unknown as { content: { content: { text: string } }[] };
		expect(settlement.content[0]?.content.text).toBe("out\n\n\nWall time: 2.50 seconds\n[raw output: artifact://9]");
	});

	it("keeps a fact on the wire for a live client terminal that also negotiated terminal meta", () => {
		// The reducer used to hard-code `metaCap: undefined` when a live terminal
		// superseded plain rendering, so every later fact was suppressed as having "no
		// capable channel" on a client that had one.
		const cap = negotiateTerminalMetaCap(true);
		if (!cap) throw new Error("expected a capability witness");
		const { events, producer } = record();
		producer.fact({ kind: "wall_time", ms: 1000 });

		const { updates, receipts } = run(
			[
				{ type: "started", call: bashCall({ kind: "read" }) },
				{ type: "live_terminal_attached", binding: createLiveTerminalBinding("term-7") },
				...events,
			],
			{ phase: "live", terminal: { kind: "real", metaCap: cap }, fence: true },
		);
		expect(terminalOutputs(updates)).toEqual(["\nWall time: 1.00 seconds\n"]);
		expect(receipts.some(receipt => receipt.kind === "fact_suppressed")).toBe(false);
	});

	describe("ACP tool view reducer — plain to live_terminal transition", () => {
		it("delivers carried plain-era output at attach and never replaces the terminal card at settlement", () => {
			// Regression coverage: the closing-snapshot settle arm used to remove the
			// live terminal item from the card and erase every byte displayed after
			// attachment. The carry now resolves at the transition, where the
			// pre-attach bytes precede post-attach live bytes in the client's
			// terminal buffer; settlement touches only correlated status/exit state.
			//
			// `awaitsLiveTerminal: true` is load-bearing: it
			// is the only route `selectAcpToolRenderMode` ever sends a
			// `live_terminal_attached` event to, and now the only route whose plain
			// state builds the uncapped `rawSegments` mirror this carry reads from.
			const cap = negotiateTerminalMetaCap(true);
			if (!cap) throw new Error("expected a capability witness");
			const { events, producer } = record();
			producer.appendTerminal("abc");
			producer.fact({ kind: "wall_time", ms: 2500 });
			events.splice(2, 0, { type: "live_terminal_attached", binding: createLiveTerminalBinding("term-9") });
			producer.appendTerminal("def");

			const { updates, receipts } = run(
				[
					{ type: "started", call: bashCall({ awaitsLiveTerminal: true }) },
					...events,
					{ type: "settled", outcome: { kind: "succeeded" } },
				],
				{
					phase: "live",
					terminal: { kind: "real", metaCap: cap },
					fence: true,
				},
			);

			// `_meta.terminal_output`; the post-attach append emits no frame.
			expect(terminalOutputs(updates)).toEqual(["abc\nWall time: 2.50 seconds\n"]);
			expect(JSON.stringify(updates)).not.toContain("def");

			// Settlement emits ONLY the exit frame with its diagnostic — no content
			// replacement of any kind, so the card keeps its terminal item and every
			// byte the terminal displayed.
			expect(updates).toHaveLength(4);
			const settle = updates.at(-1) as unknown as {
				status?: string;
				content?: unknown;
				rawOutput?: unknown;
				_meta?: { terminal_exit?: unknown };
			};
			expect(settle.status).toBe("completed");
			expect(settle.content).toBeUndefined();
			// The AcpToolDiagnostic rides the literal wire as `rawOutput` (encoder).
			expect(settle.rawOutput).toEqual({ kind: "tool_settlement", tool: "bash", outcome: "completed" });
			expect(settle._meta?.terminal_exit).toEqual({ terminal_id: "term-9", exit_code: 0, signal: null });

			// The attach batch receipted the carried byte span and fact on the
			// channel that actually carried them.
			const carriedStream = receipts.some(
				receipt =>
					receipt.kind === "stream" &&
					receipt.channel === "terminal_output" &&
					plain(receipt.fromByte) === 0 &&
					plain(receipt.toByte) === 3,
			);
			const carriedFact = receipts.some(receipt => receipt.kind === "fact" && receipt.channel === "terminal_output");
			expect(carriedStream).toBe(true);
			expect(carriedFact).toBe(true);
		});

		it("records explicit suppressions at attach when no terminal-meta channel exists", () => {
			const { events, producer } = record();
			producer.appendTerminal("abc");
			producer.fact({ kind: "wall_time", ms: 2500 });
			events.splice(2, 0, { type: "live_terminal_attached", binding: createLiveTerminalBinding("term-10") });

			const { updates, receipts } = run(
				[
					{ type: "started", call: bashCall({ kind: "read" }) },
					...events,
					{ type: "settled", outcome: { kind: "succeeded" } },
				],
				{
					phase: "live",
					terminal: { kind: "real", metaCap: undefined },
					fence: true,
				},
			);

			// No `_meta.terminal_output` witness: nothing can replay the carried
			// bytes or fact, and each is recorded as deliberately suppressed.
			expect(terminalOutputs(updates)).toEqual([]);
			const suppressedStreams = receipts.flatMap(receipt =>
				receipt.kind === "stream_suppressed"
					? [[plain(receipt.fromByte), plain(receipt.toByte), receipt.reason] as const]
					: [],
			);
			expect(suppressedStreams).toEqual([[0, 3, "no_capable_channel"]]);
			const suppressedFacts = receipts.flatMap(receipt =>
				receipt.kind === "fact_suppressed" ? [[receipt.factId, receipt.reason] as const] : [],
			);
			const declaredFact = events.find(
				(event): event is Extract<(typeof events)[number], { type: "fact" }> => event.type === "fact",
			);
			expect(declaredFact).toBeDefined();
			expect(suppressedFacts).toEqual(
				declaredFact === undefined ? [] : [[declaredFact.fact.id, "no_capable_channel"]],
			);

			// Settlement emits nothing but the status frame with its diagnostic.
			expect(updates).toHaveLength(3);
			const settle = updates.at(-1) as unknown as {
				status?: string;
				content?: unknown;
				rawOutput?: unknown;
				_meta?: unknown;
			};
			expect(settle.status).toBe("completed");
			expect(settle.content).toBeUndefined();
			expect(settle._meta).toBeUndefined();
			// The AcpToolDiagnostic rides the literal wire as `rawOutput` (encoder).
			expect(settle.rawOutput).toEqual({ kind: "tool_settlement", tool: "bash", outcome: "completed" });
		});

		it("accepts-and-suppresses an attachment declared while the view is live_terminal", () => {
			// An image has no byte form the client-owned terminal buffer could
			// replay, and a sibling content item would erase the terminal card — so
			// the attachment is accepted, never framed, and explicitly suppressed.
			const cap = negotiateTerminalMetaCap(true);
			if (!cap) throw new Error("expected a capability witness");
			const { events, producer } = record();
			producer.attachLiveTerminal(createLiveTerminalBinding("term-11"));
			producer.attachment({ kind: "image", data: "AAAA", mimeType: "image/png" });

			const { updates, receipts } = run(
				[
					{ type: "started", call: bashCall({ kind: "read" }) },
					...events,
					{ type: "settled", outcome: { kind: "succeeded" } },
				],
				{ phase: "live", terminal: { kind: "real", metaCap: cap }, fence: true },
			);

			expect(receipts.filter(receipt => receipt.kind === "attachment_suppressed")).toHaveLength(1);
			// The only content-bearing update is the attach announcement's terminal
			// item; neither the attachment nor settlement ever introduces content.
			const contentBearing = updates.filter(update =>
				Array.isArray((update as unknown as { content?: unknown[] }).content),
			);
			expect(contentBearing).toHaveLength(1);
			expect(JSON.stringify(updates)).not.toContain("AAAA");
			expect(JSON.stringify(updates)).not.toContain("replacement_snapshot");
		});

		it("suppresses an attachment accepted while plain when the live terminal attaches", () => {
			// `kind: "read"` is load-bearing: an `execute` call on a terminal-capable
			// client selects meta_terminal at started, which would exercise the
			// meta->live arm instead of the genuinely-plain acceptance loop this
			// test exists for.
			const cap = negotiateTerminalMetaCap(true);
			if (!cap) throw new Error("expected a capability witness");
			const { events, producer } = record();
			producer.attachment({ kind: "image", data: "AAAA", mimeType: "image/png" });
			producer.attachLiveTerminal(createLiveTerminalBinding("term-12"));

			const { receipts } = run([{ type: "started", call: bashCall({ kind: "read" }) }, ...events], {
				phase: "live",
				terminal: { kind: "real", metaCap: cap },
				fence: true,
			});

			// Suppressed once, at the transition — not silently dropped until a
			// settlement that no longer replays it.
			expect(receipts.filter(receipt => receipt.kind === "attachment_suppressed")).toHaveLength(1);
		});

		it("suppresses an attachment pending on the display-only terminal when a real one attaches", () => {
			const { events, producer } = record();
			producer.appendTerminal("plot ready\n");
			producer.attachment({ kind: "image", data: "AAAA", mimeType: "image/png" });
			producer.attachLiveTerminal(createLiveTerminalBinding("term-13"));

			const { updates, receipts } = run([
				{ type: "started", call: bashCall() },
				...events,
				{ type: "settled", outcome: { kind: "succeeded" } },
			]);

			expect(receipts.filter(receipt => receipt.kind === "attachment_suppressed")).toHaveLength(1);
			expect(JSON.stringify(updates)).not.toContain("AAAA");
			// Settlement after the transition is still exit-state only: no closing
			// content snapshot resurrects the suppressed attachment.
			const settle = updates.at(-1) as unknown as { content?: unknown };
			expect(settle.content).toBeUndefined();
		});

		it("receipts the attach transition's carried spans excluding declared gaps", () => {
			// Regression coverage: the transition used to claim the whole [0, cursor)
			// range as delivered, including gap bytes whose own stream_gap receipts
			// already record them as never received.
			//
			// `awaitsLiveTerminal: true` is load-bearing: see
			// the matching note on the earlier "delivers carried plain-era output"
			// test — `carriedData` (and so these "stream" receipts) comes from the
			// `rawSegments` mirror, which only this route ever populates.
			const cap = negotiateTerminalMetaCap(true);
			if (!cap) throw new Error("expected a capability witness");
			const { events, producer } = record();
			producer.appendTerminal("head\n"); // [0, 5)
			producer.declareGap(1024); // declared: [5, 1029)
			producer.appendTerminal("tail\n"); // [1029, 1034)
			events.push({ type: "live_terminal_attached", binding: createLiveTerminalBinding("term-14") });

			const { receipts } = run([{ type: "started", call: bashCall({ awaitsLiveTerminal: true }) }, ...events], {
				phase: "live",
				terminal: { kind: "real", metaCap: cap },
				fence: true,
			});

			const delivered = receipts.flatMap(receipt =>
				receipt.kind === "stream" && receipt.channel === "terminal_output"
					? [[plain(receipt.fromByte), plain(receipt.toByte)] as const]
					: [],
			);
			expect(delivered).toEqual([
				[0, 5],
				[1029, 1034],
			]);
			const suppressed = receipts.flatMap(receipt =>
				receipt.kind === "stream_suppressed" ? [[plain(receipt.fromByte), plain(receipt.toByte)]] : [],
			);
			expect(suppressed).toEqual([]);
		});

		it("suppresses only the appended spans when no terminal-meta channel exists", () => {
			const { events, producer } = record();
			producer.appendTerminal("head\n"); // [0, 5)
			producer.declareGap(1024); // declared: [5, 1029)
			producer.appendTerminal("tail\n"); // [1029, 1034)
			events.push({ type: "live_terminal_attached", binding: createLiveTerminalBinding("term-15") });

			const { receipts } = run([{ type: "started", call: bashCall({ kind: "read" }) }, ...events], {
				phase: "live",
				terminal: { kind: "real", metaCap: undefined },
				fence: true,
			});

			const suppressed = receipts.flatMap(receipt =>
				receipt.kind === "stream_suppressed"
					? [[plain(receipt.fromByte), plain(receipt.toByte), receipt.reason] as const]
					: [],
			);
			expect(suppressed).toEqual([
				[0, 5, "no_capable_channel"],
				[1029, 1034, "no_capable_channel"],
			]);
		});
	});
});

describe("ACP tool view reducer — sourceEcho delivery invariants", () => {
	it("delivers sourceEcho at settlement on the meta terminal when no bytes were appended", () => {
		// A successful no-output eval has no terminal_append, so the reducer
		// must deliver sourceEcho in the settlement frame before terminal_exit.
		const call: ToolCallPresentation = {
			toolCallId: CALL_ID,
			toolName: "eval",
			title: "test cell",
			kind: "execute",
			sourceEcho: "display({x: 1})",
			rawInput: { language: "js", code: "display({x: 1})" },
		};
		const { updates, state } = run([
			{ type: "started", call },
			{ type: "settled", outcome: { kind: "succeeded", process: { kind: "exited", code: 0 } } },
		]);
		expect(state.state).toBe("settled");
		const data = terminalOutputs(updates).join("");
		// Source echo + separator + exit notice (none for success) — just the echo.
		expect(data).toContain("display({x: 1})");
		expect(data).toContain("─".repeat(48));
		// Exactly one settlement frame.
		const settleFrames = updates.filter(u => (u as { status?: string }).status === "completed");
		expect(settleFrames).toHaveLength(1);
	});

	it("does not duplicate sourceEcho on the meta terminal when bytes were appended", () => {
		const call: ToolCallPresentation = {
			toolCallId: CALL_ID,
			toolName: "eval",
			title: "test cell",
			kind: "execute",
			sourceEcho: "print('hi')",
		};
		const { events, producer } = record();
		producer.appendTerminal("hi\n");
		const { updates } = run([
			{ type: "started", call },
			...events,
			{ type: "settled", outcome: { kind: "succeeded", process: { kind: "exited", code: 0 } } },
		]);
		const data = terminalOutputs(updates).join("");
		// Source echo appears once (on the first append), not again at settlement.
		const echoCount = (data.match(/print\('hi'\)/g) ?? []).length;
		expect(echoCount).toBe(1);
	});

	it("delivers sourceEcho on the plain path at settlement when no bytes were appended", () => {
		const call: ToolCallPresentation = {
			toolCallId: CALL_ID,
			toolName: "eval",
			title: "no output",
			kind: "execute",
			sourceEcho: "1 + 1",
		};
		const { updates } = run(
			[
				{ type: "started", call },
				{ type: "settled", outcome: { kind: "succeeded", process: { kind: "exited", code: 0 } } },
			],
			{ phase: "live", terminal: { kind: "none" }, cwd: "/repo", fence: true },
		);
		// Plain path: sourceEcho delivered on the announcement frame already.
		// Settlement has no body, so it's a status frame — no echo duplication.
		const data = terminalOutputs(updates).join("");
		expect(data).toBe(""); // no terminal output on plain path
		// The announcement frame carries the sourceEcho as content.
		function frameTexts(frames: readonly SessionUpdate[]): string[] {
			const texts: string[] = [];
			for (const frame of frames) {
				const content = (frame as { content?: unknown }).content;
				if (Array.isArray(content)) {
					for (const item of content) {
						if (item !== null && typeof item === "object" && "content" in item) {
							const inner = (item as { content?: unknown }).content;
							if (inner !== null && typeof inner === "object" && "text" in inner) {
								const text = (inner as { text?: unknown }).text;
								if (typeof text === "string") texts.push(text);
							}
						}
					}
				}
			}
			return texts;
		}
		expect(frameTexts(updates)[0]).toBe("1 + 1");
	});
});

describe("ACP tool view encoder — resource and audio content", () => {
	it("encodes a text-backed embedded resource to the ACP resource content block", () => {
		const frame: AcpToolFrame = {
			toolCallId: "call-resource-text",
			announce: false,
			channel: "content",
			contentMode: "replacement_snapshot",
			content: [
				{
					type: "resource",
					resource: { uri: "file:///fixture/aa.txt", text: "fixture-body-aaaa", mimeType: "text/plain" },
				},
			],
		};
		const [checked] = encodeToolFrames("session-1", [frame]);
		const update = checkedNotificationPayload(checked!).update as SessionUpdate & {
			content?: Array<{ type: string; content?: { type: string; resource?: unknown } }>;
		};
		expect(update.content).toEqual([
			{
				type: "content",
				content: {
					type: "resource",
					resource: { uri: "file:///fixture/aa.txt", text: "fixture-body-aaaa", mimeType: "text/plain" },
				},
			},
		]);
	});

	it("encodes a blob-backed embedded resource to the ACP resource content block", () => {
		const frame: AcpToolFrame = {
			toolCallId: "call-resource-blob",
			announce: false,
			channel: "content",
			contentMode: "replacement_snapshot",
			content: [
				{
					type: "resource",
					resource: { uri: "file:///fixture/bb.bin", blob: "QUFBQQ==", mimeType: "application/octet-stream" },
				},
			],
		};
		const [checked] = encodeToolFrames("session-1", [frame]);
		const update = checkedNotificationPayload(checked!).update as SessionUpdate & {
			content?: Array<{ type: string; content?: { type: string; resource?: unknown } }>;
		};
		expect(update.content).toEqual([
			{
				type: "content",
				content: {
					type: "resource",
					resource: { uri: "file:///fixture/bb.bin", blob: "QUFBQQ==", mimeType: "application/octet-stream" },
				},
			},
		]);
	});

	it("encodes audio content to the ACP audio content block", () => {
		const frame: AcpToolFrame = {
			toolCallId: "call-audio-cc",
			announce: false,
			channel: "content",
			contentMode: "replacement_snapshot",
			content: [{ type: "audio", data: "UklGRjcAAABXQVZFAAAA", mimeType: "audio/wav" }],
		};
		const [checked] = encodeToolFrames("session-1", [frame]);
		const update = checkedNotificationPayload(checked!).update as SessionUpdate & {
			content?: Array<{ type: string; content?: { type: string; data?: string; mimeType?: string } }>;
		};
		expect(update.content).toEqual([
			{ type: "content", content: { type: "audio", data: "UklGRjcAAABXQVZFAAAA", mimeType: "audio/wav" } },
		]);
	});
});

describe("ACP tool view encoder — settlement diagnostic (rawOutput)", () => {
	it("mints rawOutput from the frame's diagnostic on a content-channel settlement", () => {
		const frame: AcpToolFrame = {
			toolCallId: "call-diag-dd1",
			announce: false,
			channel: "content",
			contentMode: "replacement_snapshot",
			content: [{ type: "text", text: "fixture-settlement-body-dd1" }],
			changes: [{ kind: "status", value: "completed" }],
			diagnostic: { kind: "tool_settlement", tool: "fixture_tool_dd1", outcome: "completed" },
		};
		const [checked] = encodeToolFrames("session-1", [frame]);
		const update = checkedNotificationPayload(checked!).update as SessionUpdate & { rawOutput?: unknown };
		expect(update.rawOutput).toEqual({ kind: "tool_settlement", tool: "fixture_tool_dd1", outcome: "completed" });
	});

	it("mints rawOutput from the frame's diagnostic on a status-channel settlement", () => {
		const frame: AcpToolFrame = {
			toolCallId: "call-diag-dd2",
			announce: false,
			channel: "status",
			changes: [{ kind: "status", value: "failed" }],
			diagnostic: { kind: "tool_settlement", tool: "fixture_tool_dd2", outcome: "failed" },
		};
		const [checked] = encodeToolFrames("session-1", [frame]);
		const update = checkedNotificationPayload(checked!).update as SessionUpdate & { rawOutput?: unknown };
		expect(update.rawOutput).toEqual({ kind: "tool_settlement", tool: "fixture_tool_dd2", outcome: "failed" });
	});

	it("omits rawOutput entirely when the frame carries no diagnostic", () => {
		const frame: AcpToolFrame = {
			toolCallId: "call-diag-dd3",
			announce: false,
			channel: "content",
			contentMode: "replacement_snapshot",
			content: [{ type: "text", text: "fixture-progress-body-dd3" }],
			changes: [{ kind: "status", value: "in_progress" }],
		};
		const [checked] = encodeToolFrames("session-1", [frame]);
		const update = checkedNotificationPayload(checked!).update as SessionUpdate;
		expect(Object.hasOwn(update, "rawOutput")).toBe(false);
	});

	it("never lets the settlement diagnostic carry the tool's actual result text", () => {
		// The diagnostic is a closed three-field marker, so a real result string
		// (however sensitive) cannot be assigned into it in the first place — this
		// pins that at the value level too, not only the type level.
		const frame: AcpToolFrame = {
			toolCallId: "call-diag-dd4",
			announce: false,
			channel: "content",
			contentMode: "replacement_snapshot",
			content: [{ type: "text", text: "fixture-sensitive-output-dd4-should-not-leak" }],
			changes: [{ kind: "status", value: "completed" }],
			diagnostic: { kind: "tool_settlement", tool: "fixture_tool_dd4", outcome: "completed" },
		};
		const [checked] = encodeToolFrames("session-1", [frame]);
		const update = checkedNotificationPayload(checked!).update as SessionUpdate & { rawOutput?: unknown };
		expect(JSON.stringify(update.rawOutput)).not.toContain("fixture-sensitive-output-dd4-should-not-leak");
	});

	it("announces a tool_call with a diagnostic when the caller sets one on an announce frame", () => {
		const frame: AcpToolFrame = {
			toolCallId: "call-diag-dd5",
			announce: true,
			channel: "status",
			changes: [
				{ kind: "status", value: "completed" },
				{ kind: "title", value: "Fixture title dd5" },
				{ kind: "tool_kind", value: "other" },
			],
			diagnostic: { kind: "tool_settlement", tool: "fixture_tool_dd5", outcome: "completed" },
		};
		const [checked] = encodeToolFrames("session-1", [frame]);
		const update = checkedNotificationPayload(checked!).update as SessionUpdate & { rawOutput?: unknown };
		expect(update.rawOutput).toEqual({ kind: "tool_settlement", tool: "fixture_tool_dd5", outcome: "completed" });
	});

	it("strips extra fields from an over-widened diagnostic instead of forwarding it by reference", () => {
		// `AcpToolDiagnostic`'s type alone only stops excess properties at an
		// object-literal's own construction site — TypeScript still lets a wider,
		// separately-constructed value with extra fields flow through a variable
		// typed `AcpToolDiagnostic`. Simulate a future caller that accidentally
		// attaches real output onto the marker (an `as` cast, the same shape a
		// loosely-typed helper could produce) and assert the encoder rebuilds a
		// clean three-key object rather than forwarding the wider one by reference.
		const overWidenedDiagnostic = {
			kind: "tool_settlement",
			tool: "fixture_tool_dd6",
			outcome: "completed",
			content: "fixture-leaked-result-dd6-should-be-stripped",
		} as AcpToolFrame["diagnostic"];
		const frame: AcpToolFrame = {
			toolCallId: "call-diag-dd6",
			announce: false,
			channel: "content",
			contentMode: "replacement_snapshot",
			content: [{ type: "text", text: "fixture-body-dd6" }],
			changes: [{ kind: "status", value: "completed" }],
			diagnostic: overWidenedDiagnostic,
		};
		const [checked] = encodeToolFrames("session-1", [frame]);
		const update = checkedNotificationPayload(checked!).update as SessionUpdate & { rawOutput?: unknown };
		expect(update.rawOutput).toEqual({ kind: "tool_settlement", tool: "fixture_tool_dd6", outcome: "completed" });
		expect(Object.keys(update.rawOutput as object).sort()).toEqual(["kind", "outcome", "tool"]);
		expect(JSON.stringify(update.rawOutput)).not.toContain("fixture-leaked-result-dd6-should-be-stripped");
	});
});
