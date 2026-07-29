import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ActivityEvidence, SqliteActivityLedger } from "@pk-nerdsaver-ai/pi-activity-journal";
import {
	floorToLocalHour,
	localDateOf,
	localDayWindow,
	localHourStarts,
	readActivitySummary,
	summarizeActivity,
} from "./read";

const HOUR = 3_600_000;

// This file never assigns `process.env.TZ`. A process timezone can only be
// changed once — Bun applies the first assignment and then ignores `delete`
// and any later re-assignment — so setting it here would irreversibly re-zone
// every sibling suite sharing this `bun test` process. Zone-dependent
// assertions run in a child instead (see ./tz-probe-fixture.ts); everything
// below is written to hold in ANY timezone.

interface ZoneProbe {
	zone: string;
	dayHours: number;
	markCount: number;
	labels: number[];
	markMinutes: number[];
	marksAreFixpoints: boolean;
	firstMarkCoversStart: boolean;
}

const FIXTURE = path.join(import.meta.dir, "tz-probe-fixture.ts");

/** Measure one calendar day under `zone`, in a child process. */
function probeZone(zone: string, date: string): ZoneProbe {
	const run = Bun.spawnSync(["bun", FIXTURE, date], {
		env: { ...process.env, TZ: zone },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (run.exitCode !== 0) throw new Error(`probe ${zone} ${date} failed: ${run.stderr.toString()}`);
	return JSON.parse(run.stdout.toString()) as ZoneProbe;
}

/** Minimal evidence row; only the fields the summarizer reads are meaningful. */
function evidence(
	startedAt: number,
	endedAt: number,
	appId: string,
	digest?: string,
	ocrSnippet?: string,
): ActivityEvidence {
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
		...(ocrSnippet ? { ocrSnippet } : {}),
		evidenceRefs: [],
	};
}

/** A six-hour window starting on a local hour mark — six buckets in any zone. */
function sixHourWindow(): { startedAt: number; endedAt: number } {
	const startedAt = floorToLocalHour(Date.parse("2026-07-27T12:00:00Z"));
	return { startedAt, endedAt: startedAt + 6 * HOUR };
}

describe("localDayWindow / localHourStarts across timezones", () => {
	// America/New_York: 2026-03-08 springs forward, 2026-11-01 falls back.
	it("spans 24 hours on an ordinary day", () => {
		const probe = probeZone("America/New_York", "2026-07-27");
		expect(probe.dayHours).toBe(24);
		expect(probe.markCount).toBe(24);
	});

	it("spans 23 hours across a spring-forward transition and skips the lost hour", () => {
		const probe = probeZone("America/New_York", "2026-03-08");
		expect(probe.dayHours).toBe(23);
		expect(probe.markCount).toBe(23);
		expect(probe.labels).not.toContain(2);
	});

	it("spans 25 hours across a fall-back transition and keeps the repeated hour", () => {
		const probe = probeZone("America/New_York", "2026-11-01");
		expect(probe.dayHours).toBe(25);
		expect(probe.markCount).toBe(25);
		expect(probe.labels.filter(hour => hour === 1).length).toBe(2);
	});

	it("puts every bucket on a real local hour mark in half-hour-offset zones", () => {
		// The bug this replaced floored to UTC hour boundaries, which land at
		// :30 local in Asia/Kolkata (+5:30) and :45 in Asia/Kathmandu (+5:45).
		for (const zone of ["Asia/Kolkata", "Asia/Kathmandu", "Australia/Adelaide"]) {
			const probe = probeZone(zone, "2026-07-27");
			expect({ zone, minutes: probe.markMinutes }).toEqual({ zone, minutes: [0] });
			expect(probe.markCount).toBe(24);
			expect(probe.marksAreFixpoints).toBe(true);
		}
	});

	it("never emits a first mark that starts after the window it covers", () => {
		for (const [zone, date] of [
			["America/New_York", "2026-03-08"],
			["Asia/Kolkata", "2026-07-27"],
			["UTC", "2026-07-27"],
			["Australia/Sydney", "2026-10-04"],
		] as const) {
			expect({ zone, ok: probeZone(zone, date).firstMarkCoversStart }).toEqual({ zone, ok: true });
		}
	});

	it("rejects malformed and non-existent dates", () => {
		expect(() => localDayWindow("27-07-2026")).toThrow();
		expect(() => localDayWindow("2026-02-30")).toThrow();
		expect(() => localDayWindow("")).toThrow();
	});

	it("round-trips localDateOf through localDayWindow", () => {
		const today = localDateOf();
		const { startedAt } = localDayWindow(today);
		expect(localDateOf(startedAt)).toBe(today);
	});

	it("emits marks one hour apart, each a floorToLocalHour fixpoint", () => {
		const starts = localHourStarts(sixHourWindow());
		expect(starts.length).toBe(6);
		for (let i = 0; i < starts.length; i++) {
			expect(floorToLocalHour(starts[i] as number)).toBe(starts[i]);
			if (i > 0) expect((starts[i] as number) - (starts[i - 1] as number)).toBe(HOUR);
		}
	});
});

describe("summarizeActivity", () => {
	it("returns an all-zero summary for no evidence", () => {
		const summary = summarizeActivity([], sixHourWindow());
		expect(summary.clipCount).toBe(0);
		expect(summary.trackedMs).toBe(0);
		expect(summary.apps).toEqual([]);
		expect(summary.hours.length).toBe(6);
		expect(summary.hours.every(hour => hour.trackedMs === 0)).toBe(true);
	});

	it("splits a window spanning an hour boundary across both hours", () => {
		const window = sixHourWindow();
		const boundary = window.startedAt + 2 * HOUR;
		// 2 minutes before the boundary, 4 after.
		const summary = summarizeActivity([evidence(boundary - 2 * 60_000, boundary + 4 * 60_000, "code")], window);

		expect(summary.clipCount).toBe(1);
		expect(summary.trackedMs).toBe(6 * 60_000);
		expect(summary.hours[1]?.trackedMs).toBe(2 * 60_000);
		expect(summary.hours[2]?.trackedMs).toBe(4 * 60_000);
		// Counted once overall, not once per bucket it touches.
		expect(summary.apps).toEqual([["code", 6 * 60_000]]);
	});

	it("clips evidence to the requested window", () => {
		const window = sixHourWindow();
		const summary = summarizeActivity(
			[evidence(window.startedAt - 30 * 60_000, window.startedAt + 30 * 60_000, "code")],
			window,
		);
		expect(summary.trackedMs).toBe(30 * 60_000);
	});

	it("ignores evidence entirely outside the window", () => {
		const window = sixHourWindow();
		const summary = summarizeActivity([evidence(window.endedAt + HOUR, window.endedAt + 2 * HOUR, "code")], window);
		expect(summary.clipCount).toBe(0);
		expect(summary.trackedMs).toBe(0);
	});

	it("conserves total time across bucket splits", () => {
		const window = sixHourWindow();
		// Spans the whole window and overhangs both ends.
		const summary = summarizeActivity([evidence(window.startedAt - HOUR, window.endedAt + HOUR, "code")], window);
		const bucketed = summary.hours.reduce((total, hour) => total + hour.trackedMs, 0);
		expect(summary.trackedMs).toBe(window.endedAt - window.startedAt);
		expect(bucketed).toBe(summary.trackedMs);
	});

	it("dedupes multi-line digests into one collapsed line", () => {
		const window = sixHourWindow();
		const summary = summarizeActivity(
			[evidence(window.startedAt, window.startedAt + 60_000, "code", "main.rs\n  main.rs  \nlib.rs\n")],
			window,
		);
		expect(summary.hours[0]?.digests).toEqual(["main.rs  ·  lib.rs"]);
	});

	it("includes independent OCR snippets in activity digests", () => {
		const window = sixHourWindow();
		const summary = summarizeActivity(
			[evidence(window.startedAt, window.startedAt + 60_000, "code", "editor title", "ERROR ZephyrQuill42 failed")],
			window,
		);
		expect(summary.hours[0]?.digests).toEqual(["editor title  ·  ERROR ZephyrQuill42 failed"]);
	});

	it("orders apps by tracked time, descending", () => {
		const window = sixHourWindow();
		const summary = summarizeActivity(
			[
				evidence(window.startedAt, window.startedAt + 5 * 60_000, "comet"),
				evidence(window.startedAt, window.startedAt + 20 * 60_000, "code"),
				evidence(window.startedAt, window.startedAt + 10 * 60_000, "notion"),
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

	it("reports an absent ledger instead of creating one", async () => {
		const summary = readActivitySummary({ window: sixHourWindow(), ledgerPath });
		expect(summary.ledgerPresent).toBe(false);
		expect(summary.clipCount).toBe(0);
		expect(summary.hours.length).toBe(6);
		expect(await fs.exists(ledgerPath)).toBe(false);
	});

	it("reads an existing ledger without mutating it", async () => {
		const window = sixHourWindow();
		const writer = new SqliteActivityLedger(ledgerPath);
		writer.record(evidence(window.startedAt, window.startedAt + 15 * 60_000, "code", "main.rs"));
		writer.record(evidence(window.startedAt + HOUR, window.startedAt + HOUR + 5 * 60_000, "comet"));
		writer.close();
		const before = (await fs.stat(ledgerPath)).size;

		const summary = readActivitySummary({ window, ledgerPath });
		expect(summary.ledgerPresent).toBe(true);
		expect(summary.clipCount).toBe(2);
		expect(summary.trackedMs).toBe(20 * 60_000);
		expect(summary.hours[0]?.digests).toEqual(["main.rs"]);
		expect((await fs.stat(ledgerPath)).size).toBe(before);
	});

	it("excludes rows outside the requested window", () => {
		const window = sixHourWindow();
		const writer = new SqliteActivityLedger(ledgerPath);
		writer.record(evidence(window.startedAt, window.startedAt + 10 * 60_000, "code"));
		writer.record(evidence(window.startedAt - 24 * HOUR, window.startedAt - 24 * HOUR + 10 * 60_000, "comet"));
		writer.close();

		const summary = readActivitySummary({ window, ledgerPath });
		expect(summary.clipCount).toBe(1);
		expect(summary.apps).toEqual([["code", 10 * 60_000]]);
	});
});
