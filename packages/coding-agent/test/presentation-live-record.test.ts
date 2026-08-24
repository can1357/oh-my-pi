import { describe, expect, it } from "bun:test";
import type { ToolFactBody, ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import { byteOffset, factId, sequence, streamId, ToolPresentationStream } from "@oh-my-pi/pi-agent-core/presentation";
import { LiveToolPresentationRecord, ToolPresentationRecordContinuityError } from "../src/presentation/live-record";

/**
 * {@link LiveToolPresentationRecord} in isolation — the accumulator
 * that folds live `tool_presentation` events into the exact
 * {@link ToolPresentationRecord} shape `model-golden-corpus.ts` hand-builds for
 * the goldens. Every fixture line below is fixed-width and unique
 * (`LINE-0001 ..........`-style) so byte offsets are computable by hand, never
 * by luck.
 */

const LINE_A = "LINE-0001..........\n"; // 20 bytes, all ASCII
const LINE_B = "LINE-0002..........\n"; // 20 bytes, all ASCII

function factBody(): ToolFactBody {
	return { kind: "wall_time", ms: 42 };
}

describe("LiveToolPresentationRecord", () => {
	it("folds appends and a fact into the same shape model-golden-corpus.ts hand-builds", () => {
		const stream = new ToolPresentationStream(streamId("live-record-test"), () => {});
		const acc = new LiveToolPresentationRecord();

		acc.fold({
			type: "terminal_append",
			streamId: stream.streamId,
			sequence: sequence(0),
			startByte: byteOffset(0),
			data: LINE_A,
		});
		acc.fold({
			type: "terminal_append",
			streamId: stream.streamId,
			sequence: sequence(1),
			startByte: byteOffset(20),
			data: LINE_B,
		});
		acc.fold({ type: "fact", fact: { id: factId("f0"), ...factBody() } });
		acc.fold({
			type: "attachment",
			attachment: { kind: "resource_link", uri: "file:///tmp/x", name: "x" },
		});

		const record = acc.finish();

		expect(record).toEqual({
			version: 1,
			stream: {
				streamId: stream.streamId,
				startByte: byteOffset(0),
				endByte: byteOffset(40),
				text: LINE_A + LINE_B,
				gaps: [],
			},
			facts: [{ id: factId("f0"), ...factBody() }],
			attachments: [{ kind: "resource_link", uri: "file:///tmp/x", name: "x" }],
		});
	});

	it("records a declared gap at the exact byte range and keeps continuity across it", () => {
		const id = streamId("live-record-gap-test");
		const acc = new LiveToolPresentationRecord();

		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(0),
			startByte: byteOffset(0),
			data: LINE_A,
		});
		acc.fold({
			type: "terminal_gap",
			streamId: id,
			sequence: sequence(1),
			fromByte: byteOffset(20),
			toByte: byteOffset(29),
		});
		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(2),
			startByte: byteOffset(29),
			data: LINE_B,
		});

		const record = acc.finish();

		expect(record.stream).toEqual({
			streamId: id,
			startByte: byteOffset(0),
			endByte: byteOffset(49),
			text: LINE_A + LINE_B,
			gaps: [{ fromByte: byteOffset(20), toByte: byteOffset(29) }],
		});
	});

	it("rejects a first terminal_append that does not start at byte 0", () => {
		const id = streamId("live-record-nonzero-first-append-test");
		const acc = new LiveToolPresentationRecord();

		expect(() =>
			acc.fold({
				type: "terminal_append",
				streamId: id,
				sequence: sequence(0),
				// A live producer's cursor always starts at 0 — an undeclared initial
				// byte range must never be silently retained as an intentional window.
				startByte: byteOffset(5),
				data: LINE_A,
			}),
		).toThrow(ToolPresentationRecordContinuityError);
	});

	it("rejects a first terminal_gap that does not start at byte 0", () => {
		const id = streamId("live-record-nonzero-first-gap-test");
		const acc = new LiveToolPresentationRecord();

		expect(() =>
			acc.fold({
				type: "terminal_gap",
				streamId: id,
				sequence: sequence(0),
				fromByte: byteOffset(5),
				toByte: byteOffset(10),
			}),
		).toThrow(ToolPresentationRecordContinuityError);
	});

	it("throws on a byte-offset discontinuity instead of repairing or swallowing it", () => {
		const id = streamId("live-record-continuity-test");
		const acc = new LiveToolPresentationRecord();

		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(0),
			startByte: byteOffset(0),
			data: LINE_A,
		});

		expect(() =>
			acc.fold({
				type: "terminal_append",
				streamId: id,
				sequence: sequence(1),
				// Wrong start: the stream is at byte 20, not 5.
				startByte: byteOffset(5),
				data: LINE_B,
			}),
		).toThrow(ToolPresentationRecordContinuityError);
	});

	it("rejects a non-positive gap range", () => {
		const id = streamId("live-record-bad-gap-test");
		const acc = new LiveToolPresentationRecord();
		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(0),
			startByte: byteOffset(0),
			data: LINE_A,
		});

		expect(() =>
			acc.fold({
				type: "terminal_gap",
				streamId: id,
				sequence: sequence(1),
				fromByte: byteOffset(20),
				toByte: byteOffset(20),
			}),
		).toThrow(ToolPresentationRecordContinuityError);
	});

	it("rejects started/settled — those stay the agent loop's job", () => {
		const acc = new LiveToolPresentationRecord();
		const started: ToolPresentationEvent = {
			type: "started",
			call: { toolCallId: "x", toolName: "bash", title: "echo hi", kind: "execute" },
		};
		expect(() => acc.fold(started)).toThrow(ToolPresentationRecordContinuityError);

		const settled: ToolPresentationEvent = {
			type: "settled",
			outcome: { kind: "succeeded", process: { kind: "exited", code: 0 } },
		};
		expect(() => acc.fold(settled)).toThrow(ToolPresentationRecordContinuityError);
	});

	it("silently drops live-only events the record cannot represent", () => {
		const acc = new LiveToolPresentationRecord();
		acc.fold({ type: "display_output", display: { kind: "sequence", items: [{ kind: "invalid_json" }] } });
		expect(acc.finish()).toEqual({ version: 1, facts: [], attachments: [] });
	});

	it("returns an empty record with no stream field when nothing was folded", () => {
		const acc = new LiveToolPresentationRecord();
		const record = acc.finish();
		expect(record).toEqual({ version: 1, facts: [], attachments: [] });
		expect("stream" in record).toBe(false);
	});

	it("finish() is a repeatable, independent snapshot — a later fold cannot mutate one already taken", () => {
		const id = streamId("live-record-snapshot-test");
		const acc = new LiveToolPresentationRecord();
		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(0),
			startByte: byteOffset(0),
			data: LINE_A,
		});

		const first = acc.finish();
		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(1),
			startByte: byteOffset(20),
			data: LINE_B,
		});
		const second = acc.finish();

		expect(first.stream?.text).toBe(LINE_A);
		expect(second.stream?.text).toBe(LINE_A + LINE_B);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.stream)).toBe(true);
	});

	it("deep-freezes through a shallow-frozen child so a mutable grandchild cannot escape", () => {
		const acc = new LiveToolPresentationRecord();

		// A producer can legitimately hand `fact()` a value where it already
		// froze one level itself (e.g. a shared, pre-frozen `entries` array) but
		// never touched the objects that array holds. `deepFreeze` must not
		// mistake that shallow freeze for "this whole subtree is already safe"
		// and stop recursing there.
		const mutableEntry = { path: "a.ts", severity: "error" as const, message: "boom" };
		const preFrozenEntries = Object.freeze([mutableEntry]);
		acc.fold({ type: "fact", fact: { id: factId("f-diag"), kind: "diagnostics", entries: preFrozenEntries } });

		const record = acc.finish();
		const fact = record.facts[0];
		if (fact?.kind !== "diagnostics") throw new Error("expected the diagnostics fact to round-trip");
		const entry = fact.entries[0];
		if (!entry) throw new Error("expected the pre-frozen entries array to still carry its one entry");

		expect(Object.isFrozen(preFrozenEntries)).toBe(true);
		expect(Object.isFrozen(entry)).toBe(true);
		expect(() => Object.assign(entry, { message: "mutated" })).toThrow();

		// And the live accumulator's own state was never mutated: a second
		// `finish()` still reports the original message.
		const secondEntry = acc.finish().facts[0];
		if (secondEntry?.kind !== "diagnostics") throw new Error("expected the diagnostics fact to still be present");
		expect(secondEntry.entries[0]?.message).toBe("boom");
	});
});
