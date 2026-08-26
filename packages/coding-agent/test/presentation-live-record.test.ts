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
const LINE_C = "LINE-0003..........\n"; // 20 bytes, all ASCII

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

	it("bounds retained text at a custom head window while keeping full byte continuity", () => {
		const id = streamId("live-record-head-window-test");
		const acc = new LiveToolPresentationRecord(25);

		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(0),
			startByte: byteOffset(0),
			data: LINE_A,
		});
		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(1),
			startByte: byteOffset(20),
			data: LINE_B,
		});
		// Past the window: continuity is still asserted over the full byte range
		// (this must not throw), but nothing further joins the retained text.
		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(2),
			startByte: byteOffset(40),
			data: LINE_C,
		});

		const record = acc.finish();
		expect(record.stream?.startByte).toBe(byteOffset(0));
		expect(record.stream?.endByte).toBe(byteOffset(60));
		expect(record.stream?.text).toBe(`${LINE_A}LINE-`); // LINE_A (20) + first 5 bytes of LINE_B
		expect(record.stream?.gaps).toEqual([]);
		expect(record.facts).toEqual([
			{
				id: factId(`${id}:retention-truncation`),
				kind: "truncation",
				meta: { direction: "head", totalBytes: 60, retainedBytes: 25, truncatedBy: "bytes", maxBytes: 25 },
			},
		]);
	});

	it("a stream ending exactly at the head window declares no truncation fact", () => {
		const id = streamId("live-record-head-window-exact-test");
		const acc = new LiveToolPresentationRecord(40);

		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(0),
			startByte: byteOffset(0),
			data: LINE_A,
		});
		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(1),
			startByte: byteOffset(20),
			data: LINE_B,
		});

		const record = acc.finish();
		expect(record.stream?.text).toBe(LINE_A + LINE_B);
		expect(record.stream?.endByte).toBe(byteOffset(40));
		expect(record.facts).toEqual([]);
	});

	it("recomputes the truncation fact fresh on every finish() instead of freezing it at the moment the window filled", () => {
		const id = streamId("live-record-head-window-fresh-test");
		const acc = new LiveToolPresentationRecord(20);

		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(0),
			startByte: byteOffset(0),
			data: LINE_A,
		});
		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(1),
			startByte: byteOffset(20),
			data: LINE_B,
		});
		const midFlight = acc.finish();

		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(2),
			startByte: byteOffset(40),
			data: LINE_C,
		});
		const final = acc.finish();

		expect(midFlight.stream?.endByte).toBe(byteOffset(40));
		expect(final.stream?.endByte).toBe(byteOffset(60));
		// Both retained the same 20-byte head window...
		expect(midFlight.stream?.text).toBe(LINE_A);
		expect(final.stream?.text).toBe(LINE_A);
		// ...but the fact's `totalBytes` reflects each snapshot's own live total,
		// not whatever it was the first time the window filled.
		expect(midFlight.facts[0]).toMatchObject({ kind: "truncation", meta: { totalBytes: 40, retainedBytes: 20 } });
		expect(final.facts[0]).toMatchObject({ kind: "truncation", meta: { totalBytes: 60, retainedBytes: 20 } });
		// Earlier snapshot is untouched by the later fold — still frozen and independent.
		expect(Object.isFrozen(midFlight)).toBe(true);
		expect(midFlight.stream?.endByte).toBe(byteOffset(40));
	});

	it("latches on the first dropped byte so a later chunk cannot fill a boundary back-off's residual budget", () => {
		// Regression: a multibyte code point straddling the exact window makes
		// `utf8PrefixWithin` back off, landing retained bytes one short of the
		// cap. Without the latch, a later small chunk would slip through the
		// `remaining` check and append after the dropped tail — punching a hole
		// in the pure head-prefix the `truncation` fact declares.
		const id = streamId("live-record-head-window-latch-test");
		const acc = new LiveToolPresentationRecord(21);

		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(0),
			startByte: byteOffset(0),
			data: "x".repeat(20),
		});
		acc.fold({ type: "terminal_append", streamId: id, sequence: sequence(1), startByte: byteOffset(20), data: "é" }); // 2-byte code point; prefix within 1 byte backs off to ""
		acc.fold({ type: "terminal_append", streamId: id, sequence: sequence(2), startByte: byteOffset(22), data: "z" }); // must be rejected by the latch, not appended at byte 20

		const record = acc.finish();
		expect(record.stream?.text).toBe("x".repeat(20));
		expect(record.stream?.endByte).toBe(byteOffset(23));
		expect(record.facts).toEqual([
			{
				id: factId(`${id}:retention-truncation`),
				kind: "truncation",
				meta: { direction: "head", totalBytes: 23, retainedBytes: 20, truncatedBy: "bytes", maxBytes: 21 },
			},
		]);
	});

	it("a declared gap after the window filled still advances the cursor without joining the retained text", () => {
		const id = streamId("live-record-head-window-gap-test");
		const acc = new LiveToolPresentationRecord(20);

		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(0),
			startByte: byteOffset(0),
			data: LINE_A,
		});
		acc.fold({
			type: "terminal_append",
			streamId: id,
			sequence: sequence(1),
			startByte: byteOffset(20),
			data: LINE_B,
		});
		acc.fold({
			type: "terminal_gap",
			streamId: id,
			sequence: sequence(2),
			fromByte: byteOffset(40),
			toByte: byteOffset(50),
		});

		const record = acc.finish();
		expect(record.stream?.text).toBe(LINE_A);
		expect(record.stream?.endByte).toBe(byteOffset(50));
		expect(record.stream?.gaps).toEqual([{ fromByte: byteOffset(40), toByte: byteOffset(50) }]);
		expect(record.facts).toEqual([
			{
				id: factId(`${id}:retention-truncation`),
				kind: "truncation",
				meta: { direction: "head", totalBytes: 50, retainedBytes: 20, truncatedBy: "bytes", maxBytes: 20 },
			},
		]);
	});
});
