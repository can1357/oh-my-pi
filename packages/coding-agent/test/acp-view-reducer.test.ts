import { describe, expect, it } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ToolCallPresentation, ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import {
	createLiveTerminalBinding,
	nonZeroExitCode,
	streamId,
	ToolPresentationStream,
} from "@oh-my-pi/pi-agent-core/presentation";
import { checkedNotificationPayload, encodeToolFrames } from "../src/modes/acp/view/encoder";
import { type AcpToolFrame, negotiateTerminalMetaCap } from "../src/modes/acp/view/frames";
import type { AcpRenderContext, AcpToolViewState, DeliveryReceipt } from "../src/modes/acp/view/reducer";
import {
	AcpPresentationContinuityError,
	INITIAL_ACP_TOOL_VIEW,
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

	it("omits rawInput when the producer declared none, and never emits rawOutput", () => {
		const { updates } = run([
			{ type: "started", call: bashCall() },
			{ type: "settled", outcome: { kind: "succeeded" } },
		]);
		for (const update of updates) {
			expect(Object.hasOwn(update, "rawInput")).toBe(false);
			// `rawOutput` stays removed: it leaked the untyped result object onto the wire.
			expect(Object.hasOwn(update, "rawOutput")).toBe(false);
		}
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
