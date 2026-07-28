// TZ is pinned before any Date work so the DST and local-hour assertions are
// deterministic rather than dependent on the machine running the suite.
// America/New_York: 2026-03-08 springs forward (23h day), 2026-11-01 falls
// back (25h day).
process.env.TZ = "America/New_York";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ActivityEvidence, SqliteActivityLedger } from "@pk-nerdsaver-ai/pi-activity-journal";
import { floorToLocalHour, localDayWindow, localHourStarts, readActivitySummary, summarizeActivity } from "./read";

const HOUR = 3_600_000;

/** Minimal evidence row; only the fields the summarizer reads are meaningful. */
function evidence(startedAt: number, endedAt: number, appId: string, digest?: string): ActivityEvidence {
	return {
		id: `gopk_clips:${appId}:${startedAt}`,
		source: "gopk_clips",
		sourceEventId: `${appId}:${startedAt}`,
		window: { startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString() },
		recordedAt: new Date(endedAt).toISOString(),
		application: { id: appId, category: "other" },
		activityCategory: "unknown",
		strength: "corroborating",
		signal: "screen_active",
		confidence: "medium",
		confidenceReason: "test",
		...(digest ? { redactedDigest: digest } : {}),
		evidenceRefs: [],
	};
}

describe("localDayWindow", () => {
	it("spans 24 hours on an ordinary day", () => {
		const { startedAt, endedAt } = localDayWindow("2026-07-27");
		expect((endedAt - startedAt) / HOUR).toBe(24);
		expect(new Date(startedAt).getHours()).toBe(0);
	});

	it("spans 23 hours across a spring-forward transition", () => {
		const { startedAt, endedAt } = localDayWindow("2026-03-08");
		expect((endedAt - startedAt) / HOUR).toBe(23);
	});

	it("spans 25 hours across a fall-back transition", () => {
		const { startedAt, endedAt } = localDayWindow("2026-11-01");
		expect((endedAt - startedAt) / HOUR).toBe(25);
	});

	it("rejects malformed and non-existent dates", () => {
		expect(() => localDayWindow("27-07-2026")).toThrow();
		expect(() => localDayWindow("2026-02-30")).toThrow();
	});
});

describe("localHourStarts", () => {
	it("emits one mark per local hour, all on a local hour boundary", () => {
		const window = localDayWindow("2026-07-27");
		const starts = localHourStarts(window);
		expect(starts.length).toBe(24);
		for (const start of starts) {
			expect(new Date(start).getMinutes()).toBe(0);
			expect(floorToLocalHour(start)).toBe(start);
		}
	});

	it("emits 23 marks on the spring-forward day, skipping the lost hour", () => {
		const starts = localHourStarts(localDayWindow("2026-03-08"));
		expect(starts.length).toBe(23);
		expect(starts.map(s => new Date(s).getHours())).not.toContain(2);
	});

	it("emits 25 marks on the fall-back day, keeping the repeated hour distinct", () => {
		const starts = localHourStarts(localDayWindow("2026-11-01"));
		expect(starts.length).toBe(25);
		const ones = starts.filter(s => new Date(s).getHours() === 1);
		expect(ones.length).toBe(2);
		expect(ones[0]).not.toBe(ones[1]);
	});
});

describe("summarizeActivity", () => {
	it("returns an all-zero summary for no evidence", () => {
		const window = localDayWindow("2026-07-27");
		const summary = summarizeActivity([], window);
		expect(summary.clipCount).toBe(0);
		expect(summary.trackedMs).toBe(0);
		expect(summary.apps).toEqual([]);
		expect(summary.hours.length).toBe(24);
		expect(summary.hours.every(hour => hour.trackedMs === 0)).toBe(true);
	});

	it("splits a window spanning an hour boundary across both hours", () => {
		const window = localDayWindow("2026-07-27");
		const tenAm = new Date(2026, 6, 27, 10).getTime();
		// 09:58 -> 10:04: two minutes in hour 9, four in hour 10.
		const summary = summarizeActivity([evidence(tenAm - 2 * 60_000, tenAm + 4 * 60_000, "code")], window);

		expect(summary.clipCount).toBe(1);
		expect(summary.trackedMs).toBe(6 * 60_000);
		const nine = summary.hours.find(hour => hour.hourLabel === 9);
		const ten = summary.hours.find(hour => hour.hourLabel === 10);
		expect(nine?.trackedMs).toBe(2 * 60_000);
		expect(ten?.trackedMs).toBe(4 * 60_000);
		// Counted once overall, not once per bucket it touches.
		expect(summary.apps).toEqual([["code", 6 * 60_000]]);
	});

	it("clips evidence to the requested window", () => {
		const window = localDayWindow("2026-07-27");
		// Starts 30m before local midnight, ends 30m after.
		const summary = summarizeActivity(
			[evidence(window.startedAt - 30 * 60_000, window.startedAt + 30 * 60_000, "code")],
			window,
		);
		expect(summary.trackedMs).toBe(30 * 60_000);
	});

	it("ignores evidence entirely outside the window", () => {
		const window = localDayWindow("2026-07-27");
		const summary = summarizeActivity([evidence(window.endedAt + HOUR, window.endedAt + 2 * HOUR, "code")], window);
		expect(summary.clipCount).toBe(0);
		expect(summary.trackedMs).toBe(0);
	});

	it("keeps the two repeated 1am hours separate on a fall-back day", () => {
		const window = localDayWindow("2026-11-01");
		const [firstOne, secondOne] = localHourStarts(window).filter(s => new Date(s).getHours() === 1);
		const summary = summarizeActivity(
			[
				evidence((firstOne as number) + 10 * 60_000, (firstOne as number) + 20 * 60_000, "code"),
				evidence((secondOne as number) + 10 * 60_000, (secondOne as number) + 40 * 60_000, "comet"),
			],
			window,
		);
		const ones = summary.hours.filter(hour => hour.hourLabel === 1);
		expect(ones.length).toBe(2);
		expect(ones[0]?.trackedMs).toBe(10 * 60_000);
		expect(ones[1]?.trackedMs).toBe(30 * 60_000);
	});

	it("dedupes multi-line digests into one collapsed line", () => {
		const window = localDayWindow("2026-07-27");
		const tenAm = new Date(2026, 6, 27, 10).getTime();
		const summary = summarizeActivity(
			[evidence(tenAm, tenAm + 60_000, "code", "main.rs\n  main.rs  \nlib.rs\n")],
			window,
		);
		expect(summary.hours.find(hour => hour.hourLabel === 10)?.digests).toEqual(["main.rs  ·  lib.rs"]);
	});

	it("orders apps by tracked time, descending", () => {
		const window = localDayWindow("2026-07-27");
		const nineAm = new Date(2026, 6, 27, 9).getTime();
		const summary = summarizeActivity(
			[
				evidence(nineAm, nineAm + 5 * 60_000, "comet"),
				evidence(nineAm, nineAm + 20 * 60_000, "code"),
				evidence(nineAm, nineAm + 10 * 60_000, "notion"),
			],
			window,
		);
		expect(summary.apps.map(([app]) => app)).toEqual(["code", "notion", "comet"]);
	});
});

describe("readActivitySummary", () => {
	let root: string;
	let ledgerPath: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "gopk-read-"));
		ledgerPath = path.join(root, "activity-ledger.sqlite");
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("reports an absent ledger instead of creating one", () => {
		const summary = readActivitySummary({ window: localDayWindow("2026-07-27"), ledgerPath });
		expect(summary.ledgerPresent).toBe(false);
		expect(summary.clipCount).toBe(0);
		expect(summary.hours.length).toBe(24);
	});

	it("does not create the ledger file as a side effect of reading", async () => {
		readActivitySummary({ window: localDayWindow("2026-07-27"), ledgerPath });
		expect(await fs.exists(ledgerPath)).toBe(false);
	});

	it("reads an existing ledger without mutating it", async () => {
		const writer = new SqliteActivityLedger(ledgerPath);
		const tenAm = new Date(2026, 6, 27, 10).getTime();
		writer.record(evidence(tenAm, tenAm + 15 * 60_000, "code", "main.rs"));
		writer.record(evidence(tenAm + HOUR, tenAm + HOUR + 5 * 60_000, "comet"));
		writer.close();
		const before = (await fs.stat(ledgerPath)).size;

		const summary = readActivitySummary({ window: localDayWindow("2026-07-27"), ledgerPath });
		expect(summary.ledgerPresent).toBe(true);
		expect(summary.clipCount).toBe(2);
		expect(summary.trackedMs).toBe(20 * 60_000);
		expect(summary.hours.find(hour => hour.hourLabel === 10)?.digests).toEqual(["main.rs"]);
		expect((await fs.stat(ledgerPath)).size).toBe(before);
	});

	it("excludes rows outside the requested day", () => {
		const writer = new SqliteActivityLedger(ledgerPath);
		const tenAm = new Date(2026, 6, 27, 10).getTime();
		writer.record(evidence(tenAm, tenAm + 10 * 60_000, "code"));
		writer.record(evidence(tenAm - 24 * HOUR, tenAm - 24 * HOUR + 10 * 60_000, "comet"));
		writer.close();

		const summary = readActivitySummary({ window: localDayWindow("2026-07-27"), ledgerPath });
		expect(summary.clipCount).toBe(1);
		expect(summary.apps).toEqual([["code", 10 * 60_000]]);
	});
});
