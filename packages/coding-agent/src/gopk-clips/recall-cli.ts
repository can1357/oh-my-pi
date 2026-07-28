/**
 * Hour-over-hour recall over the local activity ledger: "what was I working
 * on today?" rendered as a terminal timeline. Reads the SQLite ledger the
 * gopk-clips host feeds (see ./session-state.ts) and prints, per hour, the
 * tracked minutes, the app mix, and (with --digests) sample sanitized
 * digests. Local viewing only — nothing leaves the machine.
 *
 * Usage:
 *   bun src/gopk-clips/recall-cli.ts [--date YYYY-MM-DD] [--ledger <path>]
 *     [--digests] [--json]
 */
import * as path from "node:path";
import { type ActivityEvidence, SqliteActivityLedger } from "@pk-nerdsaver-ai/pi-activity-journal";
import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils";

interface HourBucket {
	readonly hour: number;
	trackedMs: number;
	readonly appMs: Map<string, number>;
	readonly digests: string[];
}

function parseArgs(argv: string[]): { date: string; ledgerPath: string; digests: boolean; json: boolean } {
	const today = new Date();
	const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
	const options = {
		date: localDate,
		ledgerPath: path.join(getAgentDir(), "gopk-clips", "activity-ledger.sqlite"),
		digests: false,
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--date") options.date = argv[++i] ?? options.date;
		else if (arg === "--ledger") options.ledgerPath = argv[++i] ?? options.ledgerPath;
		else if (arg === "--digests") options.digests = true;
		else if (arg === "--json") options.json = true;
		else {
			console.error(`Unknown argument: ${arg}`);
			process.exit(1);
		}
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
		console.error("--date must be YYYY-MM-DD");
		process.exit(1);
	}
	return options;
}

function formatMinutes(ms: number): string {
	if (ms <= 0) return "0m";
	const minutes = ms / 60_000;
	if (minutes >= 60) return `${(minutes / 60).toFixed(1)}h`;
	return `${Math.max(1, Math.round(minutes))}m`;
}

function bar(ms: number, maxMs: number, width = 20): string {
	const filled = maxMs > 0 ? Math.round((ms / maxMs) * width) : 0;
	return "█".repeat(Math.min(width, Math.max(ms > 0 ? 1 : 0, filled))).padEnd(width, "·");
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	// Local-midnight day window.
	const dayStart = new Date(`${options.date}T00:00:00`).getTime();
	const dayEnd = dayStart + 24 * 3_600_000;
	if (!Number.isFinite(dayStart)) {
		console.error(`Invalid date: ${options.date}`);
		process.exit(1);
	}

	let ledger: SqliteActivityLedger;
	try {
		ledger = new SqliteActivityLedger(options.ledgerPath);
	} catch (error) {
		console.error(`Could not open ledger at ${options.ledgerPath}: ${String(error)}`);
		process.exit(1);
	}
	const evidence = ledger.list();
	ledger.close();

	const buckets = new Map<number, HourBucket>();
	const dayApps = new Map<string, number>();
	let dayTrackedMs = 0;
	let clipCount = 0;

	for (const item of evidence as readonly ActivityEvidence[]) {
		const start = Date.parse(item.window.startedAt);
		const end = Date.parse(item.window.endedAt);
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= dayStart || start >= dayEnd) continue;
		clipCount++;
		const appId = item.application?.id ?? "unknown";
		// Split each evidence window across the hour boundaries it spans.
		for (let hourStart = Math.floor(Math.max(start, dayStart) / 3_600_000) * 3_600_000; hourStart < Math.min(end, dayEnd); hourStart += 3_600_000) {
			const overlap = Math.min(end, hourStart + 3_600_000, dayEnd) - Math.max(start, hourStart, dayStart);
			if (overlap <= 0) continue;
			const hour = new Date(hourStart).getHours();
			let bucket = buckets.get(hour);
			if (!bucket) {
				bucket = { hour, trackedMs: 0, appMs: new Map(), digests: [] };
				buckets.set(hour, bucket);
			}
			bucket.trackedMs += overlap;
			bucket.appMs.set(appId, (bucket.appMs.get(appId) ?? 0) + overlap);
			dayApps.set(appId, (dayApps.get(appId) ?? 0) + overlap);
			dayTrackedMs += overlap;
			// Digests are multi-line (one sampled title per line); collapse to a
			// deduped single-line summary for display.
			const digest = [...new Set((item.redactedDigest ?? "").split("\n").map(line => line.trim()).filter(Boolean))].join("  ·  ");
			if (digest && bucket.digests[bucket.digests.length - 1] !== digest) bucket.digests.push(digest);
		}
	}

	if (options.json) {
		const output = [...buckets.values()]
			.sort((a, b) => a.hour - b.hour)
			.map(bucket => ({
				hour: bucket.hour,
				trackedMinutes: Math.round(bucket.trackedMs / 60_000),
				apps: Object.fromEntries([...bucket.appMs.entries()].map(([app, ms]) => [app, Math.round(ms / 60_000)])),
				...(options.digests ? { digests: bucket.digests.slice(0, 8) } : {}),
			}));
		console.log(JSON.stringify({ date: options.date, clips: clipCount, hours: output }, null, 2));
		return;
	}

	console.log(`\nActivity — ${options.date}   (${clipCount} clips, ${formatMinutes(dayTrackedMs)} tracked)`);
	console.log("─".repeat(64));
	if (buckets.size === 0) {
		console.log("No activity recorded for this day.");
		console.log(`Ledger: ${options.ledgerPath}`);
		return;
	}

	const maxHourMs = Math.max(...[...buckets.values()].map(bucket => bucket.trackedMs));
	for (const bucket of [...buckets.values()].sort((a, b) => a.hour - b.hour)) {
		const label = `${String(bucket.hour).padStart(2, "0")}:00`;
		const apps = [...bucket.appMs.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 4)
			.map(([app, ms]) => `${app} ${formatMinutes(ms)}`)
			.join(", ");
		console.log(`${label}  ${bar(bucket.trackedMs, maxHourMs)}  ${formatMinutes(bucket.trackedMs).padStart(5)}  ${apps}`);
		if (options.digests) {
			for (const digest of bucket.digests.slice(0, 5)) {
				console.log(`         · ${digest.length > 90 ? `${digest.slice(0, 90)}…` : digest}`);
			}
		}
	}

	const topApps = [...dayApps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
	console.log("─".repeat(64));
	console.log(`Top apps: ${topApps.map(([app, ms]) => `${app} ${formatMinutes(ms)}`).join(", ")}`);
}

main();
