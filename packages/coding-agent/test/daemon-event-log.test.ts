import { describe, expect, test } from "bun:test";
import { AttachmentEventStream, OrderedEventLog } from "../src/daemon/event-log";

type E = { type: string; value: number };

describe("ordered daemon event log", () => {
	test("allocates strictly monotonic sequence numbers", () => {
		const log = new OrderedEventLog<E>();
		expect(log.append({ type: "one", value: 1 })).toEqual({ seq: 1, event: { type: "one", value: 1 } });
		expect(log.append({ type: "two", value: 2 }).seq).toBe(2);
		expect(log.latestSeq).toBe(2);
	});

	test("replays events after a reconnect cursor without duplicates", () => {
		const log = new OrderedEventLog<E>({ maxEvents: 8 });
		log.append({ type: "one", value: 1 });
		log.append({ type: "two", value: 2 });
		log.append({ type: "three", value: 3 });
		expect(log.replayAfter(2)).toEqual({ kind: "replay", events: [{ seq: 3, event: { type: "three", value: 3 } }] });
		expect(log.replayAfter(3)).toEqual({ kind: "replay", events: [] });
	});
	test("buffers events during snapshot chunking and flushes a contiguous range", () => {
		const log = new OrderedEventLog<E>();
		log.append({ type: "old", value: 1 });
		log.append({ type: "old", value: 2 });
		const stream = new AttachmentEventStream<E, readonly string[]>(log, {
			chunkSize: 1,
			snapshot: () => ["state-a", "state-b"],
		});
		expect(stream.attach()).toEqual([{ type: "snapshot_begin", barrierSeq: 2 }]);
		const first = stream.next();
		expect(first).toEqual([{ type: "snapshot_chunk", barrierSeq: 2, index: 0, chunk: ["state-a"] }]);
		const during = log.append({ type: "during", value: 3 });
		expect(stream.publish(during)).toEqual([]);
		expect(stream.next()).toEqual([{ type: "snapshot_chunk", barrierSeq: 2, index: 1, chunk: ["state-b"] }]);
		expect(stream.next()).toEqual([
			{ type: "snapshot_end", barrierSeq: 2, nextSeq: 3 },
			{ type: "event", seq: 3, event: { type: "during", value: 3 } },
		]);
		expect(stream.next()).toEqual([]);
	});

	test("restarts snapshot when the attachment buffer overflows", () => {
		const log = new OrderedEventLog<E>();
		log.append({ type: "old", value: 0 });
		const stream = new AttachmentEventStream<E, readonly string[]>(log, {
			chunkSize: 10,
			maxBufferedEvents: 1,
			snapshot: () => ["state"],
		});
		stream.attach();
		stream.next();
		const first = log.append({ type: "one", value: 1 });
		const second = log.append({ type: "two", value: 2 });
		stream.publish(first);
		expect(stream.publish(second)).toEqual([
			{ type: "snapshot_restart", reason: "overflow", previousBarrierSeq: 1 },
			{ type: "snapshot_begin", barrierSeq: 3 },
		]);
	});

	test("restarts snapshot when a sequence gap is detected", () => {
		const log = new OrderedEventLog<E>();
		const stream = new AttachmentEventStream<E, readonly string[]>(log, { snapshot: () => [] });
		stream.attach();
		const frame = stream.publish({ seq: 2, event: { type: "gap", value: 2 } });
		expect(frame).toEqual([
			{ type: "snapshot_restart", reason: "gap", previousBarrierSeq: 0 },
			{ type: "snapshot_begin", barrierSeq: 0 },
		]);
	});

	test("prunes only history acknowledged by every attachment", () => {
		const log = new OrderedEventLog<E>({ maxEvents: 16 });
		log.registerAttachment("a");
		log.registerAttachment("b");
		for (let value = 1; value <= 3; value++) log.append({ type: "event", value });
		log.acknowledge("a", 3);
		expect(log.oldestSeq).toBe(1);
		log.acknowledge("b", 2);
		expect(log.oldestSeq).toBe(3);
		log.acknowledge("b", 3);
		expect(log.oldestSeq).toBe(4);
	});
	test("measures an event once even when acknowledgement prunes it", () => {
		let measurements = 0;
		const log = new OrderedEventLog<E>({
			sizeOf: () => {
				measurements++;
				return 32;
			},
		});
		log.registerAttachment("a");
		log.append({ type: "event", value: 1 });
		log.acknowledge("a", 1);
		expect(measurements).toBe(1);
	});
});
