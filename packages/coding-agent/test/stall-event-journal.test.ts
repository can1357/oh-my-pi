import { describe, expect, it } from "bun:test";
import { StallEventJournal } from "../src/session/stall-event-journal";

describe("stall report event retention", () => {
	it("retains events through unsuccessful delivery and commits only the sampled watermark", () => {
		const journal = new StallEventJournal<string>(3);
		journal.append("completed");
		const report = journal.snapshot();
		journal.append("reopened");
		expect(journal.snapshot().events).toEqual(["completed", "reopened"]);
		report.commit();
		expect(journal.snapshot().events).toEqual(["reopened"]);
		report.commit();
		expect(journal.snapshot().events).toEqual(["reopened"]);
	});

	it("reports exact omission counts after overflow, including overflow after sampling", () => {
		const journal = new StallEventJournal<number>(2);
		journal.append(1);
		const first = journal.snapshot();
		journal.append(2);
		journal.append(3);
		journal.append(4);
		expect(journal.snapshot()).toMatchObject({ events: [3, 4], omitted: 2 });
		first.commit();
		expect(journal.snapshot()).toMatchObject({ events: [3, 4], omitted: 1 });
		journal.snapshot().commit();
		expect(journal.snapshot()).toMatchObject({ events: [], omitted: 0 });
	});

	it("does not regress the baseline when an older receipt arrives late", () => {
		const journal = new StallEventJournal<number>(2);
		journal.append(1);
		const old = journal.snapshot();
		journal.append(2);
		journal.snapshot().commit();
		journal.append(3);
		old.commit();
		expect(journal.snapshot()).toMatchObject({ events: [3], omitted: 0 });
	});

	it("rejects a capacity that cannot retain any evidence", () => {
		expect(() => new StallEventJournal(0)).toThrow("capacity");
	});
});
