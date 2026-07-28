/**
 * Hour-over-hour recall over the local activity ledger: "what was I working
 * on today?" rendered as a terminal timeline. All querying and bucketing
 * lives in ./read.ts, which the in-session `activity` tool shares — this file
 * is presentation only, so the CLI and the tool can never report different
 * numbers. Local viewing only; nothing leaves the machine.
 *
 * Usage:
 *   bun src/gopk-clips/recall-cli.ts [--date YYYY-MM-DD] [--ledger <path>]
 *     [--digests] [--json]
 */
import { type ActivitySummary, formatTrackedMs, localDateOf, localDayWindow, readActivitySummary } from "./read";

interface Options {
	readonly date: string;
	readonly ledgerPath: string;
	readonly digests: boolean;
	readonly json: boolean;
}

function parseArgs(argv: string[]): Options {
	let date = localDateOf();
	// Empty defers to the shared resolver, so the CLI reads whichever ledger
	// the daemon writes.
	let ledgerPath = "";
	let digests = false;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--date") date = argv[++i] ?? date;
		else if (arg === "--ledger") ledgerPath = argv[++i] ?? ledgerPath;
		else if (arg === "--digests") digests = true;
		else if (arg === "--json") json = true;
		else {
			console.error(`Unknown argument: ${arg}`);
			process.exit(1);
		}
	}
	return { date, ledgerPath, digests, json };
}

function bar(ms: number, maxMs: number, width = 20): string {
	const filled = maxMs > 0 ? Math.round((ms / maxMs) * width) : 0;
	return "█".repeat(Math.min(width, Math.max(ms > 0 ? 1 : 0, filled))).padEnd(width, "·");
}

function printJson(summary: ActivitySummary, options: Options): void {
	const hours = summary.hours
		.filter(hour => hour.trackedMs > 0)
		.map(hour => ({
			hour: hour.hourLabel,
			startedAt: new Date(hour.hourStartedAt).toISOString(),
			trackedMinutes: Math.round(hour.trackedMs / 60_000),
			apps: Object.fromEntries(hour.apps.map(([app, ms]) => [app, Math.round(ms / 60_000)])),
			...(options.digests ? { digests: hour.digests.slice(0, 8) } : {}),
		}));
	console.log(JSON.stringify({ date: options.date, clips: summary.clipCount, hours }, null, 2));
}

function printTimeline(summary: ActivitySummary, options: Options): void {
	console.log(
		`\nActivity — ${options.date}   (${summary.clipCount} clips, ${formatTrackedMs(summary.trackedMs)} tracked)`,
	);
	console.log("─".repeat(64));
	const active = summary.hours.filter(hour => hour.trackedMs > 0);
	if (active.length === 0) {
		console.log(
			summary.ledgerPresent
				? "No activity recorded for this day."
				: "No activity ledger yet — the Activity Memory app has not recorded anything.",
		);
		console.log(`Ledger: ${summary.ledgerPath}`);
		return;
	}

	const maxHourMs = Math.max(...active.map(hour => hour.trackedMs));
	for (const hour of active) {
		const label = `${String(hour.hourLabel).padStart(2, "0")}:00`;
		const apps = hour.apps
			.slice(0, 4)
			.map(([app, ms]) => `${app} ${formatTrackedMs(ms)}`)
			.join(", ");
		const tracked = formatTrackedMs(hour.trackedMs).padStart(5);
		console.log(`${label}  ${bar(hour.trackedMs, maxHourMs)}  ${tracked}  ${apps}`);
		if (options.digests) {
			for (const digest of hour.digests.slice(0, 5)) {
				console.log(`         · ${digest.length > 90 ? `${digest.slice(0, 90)}…` : digest}`);
			}
		}
	}

	console.log("─".repeat(64));
	const topApps = summary.apps.slice(0, 6).map(([app, ms]) => `${app} ${formatTrackedMs(ms)}`);
	console.log(`Top apps: ${topApps.join(", ")}`);
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	let summary: ActivitySummary;
	try {
		summary = readActivitySummary({
			window: localDayWindow(options.date),
			...(options.ledgerPath ? { ledgerPath: options.ledgerPath } : {}),
		});
	} catch (error) {
		console.error(String(error instanceof Error ? error.message : error));
		process.exit(1);
	}
	if (options.json) printJson(summary, options);
	else printTimeline(summary, options);
}

main();
