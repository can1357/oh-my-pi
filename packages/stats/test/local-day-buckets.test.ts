import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { bucketAxis } from "../src/client/data/range";
import { densify } from "../src/client/data/series";

const HOUR = 60 * 60 * 1000;
const at = (iso: string) => Date.parse(iso);

/** `[bucket start, requests]` pairs from the probe, before and after rolling the hours. */
type DaySeries = Record<"beforeRollup" | "afterRollup", Record<"series" | "cost", number[][]>>;

/**
 * Day series from a child process started with `tz`: SQLite's `localtime` only
 * reads the timezone the process started with, and bun test pins JS `Date` to UTC.
 */
async function serverDaySeries(tz: string, timestamps: number[]): Promise<DaySeries> {
	using temp = TempDir.createSync("@pi-stats-local-day-");
	// Stats DB location follows PI_CONFIG_DIR / XDG_DATA_HOME, so isolate both.
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CONFIG_DIR: path.relative(os.homedir(), temp.join("config")),
		TZ: tz,
	};
	for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete env[key];
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "helpers/local-day-series-probe.ts"),
			temp.path(),
			JSON.stringify(timestamps),
		],
		{ env, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	return JSON.parse(stdout) as DaySeries;
}

function expectAllSeries(result: DaySeries, expected: number[][]) {
	for (const phase of [result.beforeRollup, result.afterRollup]) {
		expect(phase.series).toEqual(expected);
		expect(phase.cost).toEqual(expected);
	}
}

// IANA `TZ` names need a POSIX libc for SQLite's `localtime`; CI runs on Linux.
describe.skipIf(process.platform === "win32")("server day series", () => {
	it("groups by the local calendar day, including a 25-hour DST day", async () => {
		const result = await serverDaySeries("America/Los_Angeles", [
			at("2026-10-20T05:30:00Z"), // Oct 19, 22:30 PDT
			at("2026-10-20T18:00:00Z"), // Oct 20, 11:00 PDT
			at("2026-10-21T01:00:00Z"), // Oct 20, 18:00 PDT
			at("2026-11-01T08:30:00Z"), // Nov 1, 01:30 PDT (before fall-back)
			at("2026-11-02T06:00:00Z"), // Nov 1, 22:00 PST
			at("2026-11-02T08:30:00Z"), // Nov 2, 00:30 PST
		]);
		expectAllSeries(result, [
			[at("2026-10-19T07:00:00Z"), 1],
			[at("2026-10-20T07:00:00Z"), 2],
			[at("2026-11-01T07:00:00Z"), 2],
			[at("2026-11-02T08:00:00Z"), 1],
		]);
	});

	it("starts a day whose midnight DST skips at the same instant as the client axis", async () => {
		// Cairo: DST starts 2026-04-24 at 00:00 → 01:00, so Apr 24 begins at 22:00Z.
		const result = await serverDaySeries("Africa/Cairo", [at("2026-04-24T10:00:00Z")]);
		expectAllSeries(result, [[at("2026-04-23T22:00:00Z"), 1]]);
	});
});

describe("client day axis", () => {
	const previousTz = process.env.TZ;
	afterEach(() => {
		// bun test pins `Date` to UTC with TZ unset; restore that explicitly so a
		// zone set here cannot leak into later files.
		process.env.TZ = previousTz ?? "UTC";
	});

	it("ends the 7d axis on today's local midnight", () => {
		process.env.TZ = "America/Los_Angeles";
		const buckets = bucketAxis("7d", [], undefined, at("2026-10-21T03:56:00Z")); // Oct 20, 20:56 PDT
		expect(buckets.at(-1)).toBe(at("2026-10-20T07:00:00Z"));
		expect(buckets[0]).toBe(at("2026-10-13T07:00:00Z"));
		expect(buckets).toHaveLength(8);
	});

	it("steps across DST by calendar day, not by 24 hours", () => {
		process.env.TZ = "America/Los_Angeles";
		const buckets = bucketAxis("7d", [], undefined, at("2026-11-04T20:00:00Z"));
		expect(buckets).toContain(at("2026-11-01T07:00:00Z"));
		expect(buckets).toContain(at("2026-11-02T08:00:00Z"));
		for (const bucket of buckets) expect(new Date(bucket).getHours()).toBe(0);
	});

	it("returns to local midnight after a day whose midnight DST skips", () => {
		process.env.TZ = "Africa/Cairo";
		const buckets = bucketAxis("7d", [], undefined, at("2026-04-28T12:00:00Z"));
		expect(buckets).toContain(at("2026-04-23T22:00:00Z")); // Apr 24: first instant of the day
		expect(buckets).toContain(at("2026-04-24T21:00:00Z")); // Apr 25, 00:00 EEST
	});

	it("keeps sub-day buckets epoch-aligned", () => {
		process.env.TZ = "America/Los_Angeles";
		const now = at("2026-10-21T03:56:00Z");
		const buckets = bucketAxis("24h", [], undefined, now);
		expect(buckets.at(-1)).toBe(Math.floor(now / HOUR) * HOUR);
		expect(buckets[1] - buckets[0]).toBe(HOUR);
	});

	it("still charts a server whose timezone differs from the browser's", () => {
		// Browser on Pacific time, server on UTC (e.g. `--host` or a container): the
		// server's day buckets start at UTC midnight, not on any axis key.
		process.env.TZ = "America/Los_Angeles";
		const buckets = bucketAxis("7d", [], undefined, at("2026-10-21T03:56:00Z"));
		const points = [
			{ timestamp: at("2026-10-19T00:00:00Z"), requests: 3 },
			{ timestamp: at("2026-10-20T00:00:00Z"), requests: 5 },
		];
		const daily = densify(points, buckets, p => p.requests);
		expect(daily.reduce((sum, v) => sum + v, 0)).toBe(8);
	});
});
