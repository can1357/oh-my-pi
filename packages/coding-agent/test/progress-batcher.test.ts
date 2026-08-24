import { afterEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { PROGRESS_BATCH_INTERVAL_MS, type ProgressBatch, ProgressBatcher } from "../src/async/progress-batcher";

describe("ProgressBatcher", () => {
	afterEach(() => {
		vi.useRealTimers();
		setSystemTime();
	});

	test("collects every arrival in one trailing 200 ms event", () => {
		vi.useFakeTimers();
		const seen: ProgressBatch<string>[] = [];
		const batcher = new ProgressBatcher<string>((_id, batch) => {
			seen.push(batch);
		});

		batcher.push("source", "first");
		batcher.push("source", "second");
		vi.advanceTimersByTime(PROGRESS_BATCH_INTERVAL_MS - 1);
		batcher.push("source", "third");
		expect(seen).toEqual([]);

		vi.advanceTimersByTime(1);
		expect(seen).toEqual([
			{
				kind: "progress",
				values: ["first", "second", "third"],
				seq: 1,
				suppressedEvents: 0,
			},
		]);
	});

	test("combines arrivals inside the window when a bounded representation is configured", () => {
		vi.useFakeTimers();
		const seen: ProgressBatch<string>[] = [];
		const batcher = new ProgressBatcher<string>(
			(_id, batch) => {
				seen.push(batch);
			},
			{ merge: (left, right) => `${left}|${right}` },
		);

		batcher.push("source", "first");
		batcher.push("source", "second");
		batcher.push("source", "third");
		vi.advanceTimersByTime(PROGRESS_BATCH_INTERVAL_MS);

		expect(seen[0]?.values).toEqual(["first|second|third"]);
	});

	test("accumulates metadata from every suppressed window while retaining bounded outer text", async () => {
		vi.useFakeTimers();
		interface Record {
			text: string;
			suppressedEvents?: number;
			sourceTruncated?: boolean;
			byteTruncated?: boolean;
			reminder?: "chatty-monitor";
		}
		const seen: ProgressBatch<Record>[] = [];
		const mergeMetadata = (kept: Record, displaced: Record): Record => ({
			...kept,
			suppressedEvents: (kept.suppressedEvents ?? 0) + (displaced.suppressedEvents ?? 0) || undefined,
			sourceTruncated: kept.sourceTruncated === true || displaced.sourceTruncated === true || undefined,
			byteTruncated: kept.byteTruncated === true || displaced.byteTruncated === true || undefined,
			reminder: kept.reminder ?? displaced.reminder,
		});
		const batcher = new ProgressBatcher<Record>(
			(_id, batch) => {
				seen.push(batch);
			},
			{
				merge: (left, right) => ({
					...mergeMetadata(right, left),
					text: `${left.text.split("|")[0]}|${right.text.split("|").at(-1)}`,
				}),
				mergeDisplacedMetadata: mergeMetadata,
			},
		);

		for (let event = 1; event <= 10; event++) {
			batcher.push("source", { text: `burst-${event}` });
			await batcher.flush("source");
		}
		batcher.push("source", { text: "suppressed-first", suppressedEvents: 2 });
		await batcher.flush("source");
		batcher.push("source", {
			text: "suppressed-middle",
			suppressedEvents: 3,
			sourceTruncated: true,
			byteTruncated: true,
			reminder: "chatty-monitor",
		});
		await batcher.flush("source");
		batcher.push("source", { text: "suppressed-last", suppressedEvents: 5 });
		await batcher.flush("source");

		vi.advanceTimersByTime(2_000);
		batcher.push("source", { text: "delivered" });
		await batcher.flush("source");

		expect(seen.at(-1)).toEqual({
			kind: "progress",
			values: [
				{ text: "suppressed-first", suppressedEvents: 2 },
				{
					text: "suppressed-last",
					suppressedEvents: 8,
					sourceTruncated: true,
					byteTruncated: true,
					reminder: "chatty-monitor",
				},
				{ text: "delivered" },
			],
			seq: 14,
			suppressedEvents: 3,
		});
	});

	test("allows an eleven-event burst, suppresses nine, then reports the gap before event twenty-one", () => {
		vi.useFakeTimers();
		const seen: ProgressBatch<string>[] = [];
		const batcher = new ProgressBatcher<string>((_id, batch) => {
			seen.push(batch);
		});

		for (let event = 1; event <= 21; event++) {
			batcher.push("source", `event-${event}`);
			vi.advanceTimersByTime(PROGRESS_BATCH_INTERVAL_MS);
		}

		expect(seen.slice(0, 11).map(batch => batch.kind)).toEqual(Array(11).fill("progress"));
		expect(seen.slice(11, 20).map(batch => batch.kind)).toEqual(Array(9).fill("artifact-only"));
		expect(seen[20]).toEqual({
			kind: "progress",
			values: ["event-12", "event-20", "event-21"],
			seq: 21,
			suppressedEvents: 9,
		});
	});

	test("adds the chatty-monitor reminder to every fifth suppression report", () => {
		vi.useFakeTimers();
		const seen: ProgressBatch<string>[] = [];
		const batcher = new ProgressBatcher<string>((_id, batch) => {
			seen.push(batch);
		});

		for (let event = 1; event <= 61; event++) {
			batcher.push("source", `event-${event}`);
			vi.advanceTimersByTime(PROGRESS_BATCH_INTERVAL_MS);
		}

		const reports = seen.filter(batch => batch.kind === "progress" && batch.suppressedEvents > 0);
		expect(reports).toHaveLength(5);
		expect(reports.map(batch => batch.reminder)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			"chatty-monitor",
		]);
	});

	test("refills one rate-limit permit after two quiet seconds", async () => {
		vi.useFakeTimers();
		const seen: ProgressBatch<string>[] = [];
		const batcher = new ProgressBatcher<string>((_id, batch) => {
			seen.push(batch);
		});

		for (let event = 1; event <= 11; event++) {
			batcher.push("source", `event-${event}`);
			await batcher.flush("source");
		}
		expect(seen.at(-1)?.kind).toBe("artifact-only");

		vi.advanceTimersByTime(2_000);
		batcher.push("source", "after-quiet-period");
		await batcher.flush("source");
		expect(seen.at(-1)).toEqual({
			kind: "progress",
			values: ["event-11", "after-quiet-period"],
			seq: 12,
			suppressedEvents: 1,
		});
	});

	test("meters independent sources separately", async () => {
		vi.useFakeTimers();
		const seen: Array<{ id: string; batch: ProgressBatch<string> }> = [];
		const batcher = new ProgressBatcher<string>((id, batch) => {
			seen.push({ id, batch });
		});

		for (let event = 1; event <= 11; event++) {
			batcher.push("chatty", `event-${event}`);
			await batcher.flush("chatty");
		}
		batcher.push("new-monitor", "first event");
		await batcher.flush("new-monitor");

		expect(seen.at(-2)?.batch.kind).toBe("artifact-only");
		expect(seen.at(-1)).toMatchObject({
			id: "new-monitor",
			batch: { kind: "progress", values: ["first event"], seq: 1 },
		});
	});

	test("reports a final suppressed event before terminal delivery", async () => {
		vi.useFakeTimers();
		const seen: ProgressBatch<string>[] = [];
		const batcher = new ProgressBatcher<string>((_id, batch) => {
			seen.push(batch);
		});

		for (let event = 1; event <= 11; event++) {
			batcher.push("source", `event-${event}`);
			vi.advanceTimersByTime(PROGRESS_BATCH_INTERVAL_MS);
		}
		batcher.push("source", "final-suppressed");
		await batcher.finish("source");

		expect(seen.slice(-2)).toEqual([
			{
				kind: "artifact-only",
				values: ["final-suppressed"],
				seq: 12,
				suppressedEvents: 0,
			},
			{
				kind: "suppression-summary",
				values: ["final-suppressed"],
				seq: 13,
				suppressedEvents: 1,
			},
		]);
	});

	test("attempts the terminal suppression summary after the final progress delivery rejects", async () => {
		vi.useFakeTimers();
		const seen: ProgressBatch<string>[] = [];
		const batcher = new ProgressBatcher<string>((_id, batch) => {
			seen.push(batch);
			if (batch.seq === 12) throw new Error("final progress unavailable");
		});

		for (let event = 1; event <= 11; event++) {
			batcher.push("source", `event-${event}`);
			await batcher.flush("source");
		}
		batcher.push("source", "final-suppressed");

		await expect(batcher.finish("source")).rejects.toThrow("final progress unavailable");
		expect(seen.slice(-2)).toEqual([
			{
				kind: "artifact-only",
				values: ["final-suppressed"],
				seq: 12,
				suppressedEvents: 0,
			},
			{
				kind: "suppression-summary",
				values: ["event-11", "final-suppressed"],
				seq: 13,
				suppressedEvents: 2,
			},
		]);
	});

	test("delivers a queued batch after the preceding delivery rejects", async () => {
		vi.useFakeTimers();
		const firstDelivery = Promise.withResolvers<void>();
		const seen: string[] = [];
		const batcher = new ProgressBatcher<string>((_id, batch) => {
			const text = batch.values.join("\n");
			seen.push(text);
			if (text === "first") return firstDelivery.promise;
		});

		batcher.push("source", "first");
		vi.advanceTimersByTime(PROGRESS_BATCH_INTERVAL_MS);
		batcher.push("source", "second");
		vi.advanceTimersByTime(PROGRESS_BATCH_INTERVAL_MS);
		firstDelivery.reject(new Error("transient sink failure"));
		await batcher.flush("source");

		expect(seen).toEqual(["first", "second"]);
	});

	test("starts a fresh sequence after terminal delivery rejects", async () => {
		vi.useFakeTimers();
		setSystemTime(100);
		const sequences: number[] = [];
		let rejectDelivery = true;
		const batcher = new ProgressBatcher<string>((_id, batch) => {
			sequences.push(batch.seq);
			if (!rejectDelivery) return;
			rejectDelivery = false;
			throw new Error("terminal sink failure");
		});

		batcher.push("source", "first generation");
		await expect(batcher.finish("source")).rejects.toThrow("terminal sink failure");
		batcher.push("source", "second generation");
		await batcher.finish("source");

		expect(sequences).toEqual([1, 1]);
	});
});
