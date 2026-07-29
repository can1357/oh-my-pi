/**
 * Read side of Activity Memory — job #3 of the gopk-clips pipeline.
 *
 * The sampler writes handoff files; the always-on `gopk-ingest` daemon drains
 * them into `activity-ledger.sqlite` (jobs #1 and #2, see ./daemon.ts). This
 * module only ever *queries* that ledger, read-only, and never touches the
 * handoff directory. It is the single implementation behind both the recall
 * CLI and the in-session `activity` tool, so their numbers cannot diverge.
 *
 * Local-time correctness is the whole difficulty here, and both hazards are
 * handled explicitly rather than by flooring epoch milliseconds:
 *
 *  - A calendar day is NOT 24 hours. On DST transition days it is 23 or 25,
 *    so the day window is derived from local midnight to the *next* local
 *    midnight via the Date constructor, which normalizes the shift for us.
 *  - Hour boundaries are NOT UTC hour boundaries. In half-hour-offset zones
 *    (IST +5:30, NPT +5:45) a UTC-floored bucket straddles two local hours and
 *    is mislabelled. Buckets here start on a real local hour mark, and a
 *    bucket is keyed by its absolute start instant — so the repeated hour on a
 *    fall-back day stays two distinct buckets instead of collapsing into one.
 *
 * Nothing leaves the machine; the ledger is a local SQLite file.
 */
import * as fs from "node:fs";
import { type ActivityEvidence, SqliteActivityLedgerReader } from "@pk-nerdsaver-ai/pi-activity-journal";
import { resolveGopkClipsPaths } from "./paths";

const HOUR_MS = 3_600_000;

/** Half-open instant range `[startedAt, endedAt)`, in epoch milliseconds. */
export interface ActivityWindowMs {
	readonly startedAt: number;
	readonly endedAt: number;
}

export interface ActivityHourBucket {
	/** Absolute start of this local hour, epoch ms. Unique per bucket. */
	readonly hourStartedAt: number;
	/** Local hour label 0-23. Not unique: a fall-back day repeats one. */
	readonly hourLabel: number;
	readonly trackedMs: number;
	/** Tracked ms per `application.id`, descending by duration. */
	readonly apps: readonly (readonly [string, number])[];
	/** Deduped one-line sanitized digests sampled in this hour. */
	readonly digests: readonly string[];
}

export interface ActivitySummary {
	readonly window: ActivityWindowMs;
	/** False when the ledger file does not exist yet; every total is then zero. */
	readonly ledgerPresent: boolean;
	readonly ledgerPath: string;
	readonly clipCount: number;
	readonly trackedMs: number;
	/** Tracked ms per `application.id` across the window, descending. */
	readonly apps: readonly (readonly [string, number])[];
	readonly hours: readonly ActivityHourBucket[];
}

/** Start of the local hour containing `ms`. Correct at any UTC offset. */
export function floorToLocalHour(ms: number): number {
	const at = new Date(ms);
	return new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours()).getTime();
}

/**
 * The local calendar day `date` (YYYY-MM-DD) as a half-open instant range.
 * Length is 23, 24, or 25 hours depending on DST — the Date constructor
 * normalizes day rollover, so this is correct without a timezone database.
 * Throws on a date that does not exist.
 */
export function localDayWindow(date: string): ActivityWindowMs {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) throw new Error(`date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const startedAt = new Date(year, month - 1, day).getTime();
	const endedAt = new Date(year, month - 1, day + 1).getTime();
	if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) throw new Error(`invalid date: ${date}`);
	// Reject rollover (2026-02-30 -> Mar 2) rather than silently summarizing
	// a day the caller did not ask for.
	const start = new Date(startedAt);
	if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
		throw new Error(`invalid date: ${date}`);
	}
	return { startedAt, endedAt };
}

/** The local date (YYYY-MM-DD) containing `ms`; defaults to now. */
export function localDateOf(ms: number = Date.now()): string {
	const at = new Date(ms);
	const month = String(at.getMonth() + 1).padStart(2, "0");
	const day = String(at.getDate()).padStart(2, "0");
	return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * Local hour marks covering `window`, ascending. Steps by one hour from the
 * first local hour mark: across a DST shift the UTC offset moves by a whole
 * hour, so the marks stay on local `:00` and the day yields 23 or 25 of them.
 */
export function localHourStarts(window: ActivityWindowMs): number[] {
	const starts: number[] = [];
	for (let at = floorToLocalHour(window.startedAt); at < window.endedAt; at += HOUR_MS) starts.push(at);
	return starts;
}

/** Collapse a multi-line digest (one sampled title per line) to one deduped line. */
function collapseDigest(digest: string | undefined): string {
	const lines = (digest ?? "").split("\n").map(line => line.trim());
	return [...new Set(lines.filter(Boolean))].join("  ·  ");
}

function descending(totals: ReadonlyMap<string, number>): (readonly [string, number])[] {
	return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Bucket `evidence` into local hours across `window`. Each evidence window is
 * split across every hour it spans and credited proportionally, so a clip
 * straddling 09:58-10:04 contributes to both hours rather than to whichever
 * one happens to hold its start.
 */
export function summarizeActivity(
	evidence: readonly ActivityEvidence[],
	window: ActivityWindowMs,
	options: { readonly ledgerPath?: string; readonly ledgerPresent?: boolean } = {},
): ActivitySummary {
	interface Bucket {
		trackedMs: number;
		readonly apps: Map<string, number>;
		readonly digests: string[];
	}
	const buckets = new Map<number, Bucket>();
	for (const hourStart of localHourStarts(window)) {
		buckets.set(hourStart, { trackedMs: 0, apps: new Map(), digests: [] });
	}
	const hourStarts = [...buckets.keys()].sort((a, b) => a - b);
	const apps = new Map<string, number>();
	let trackedMs = 0;
	let clipCount = 0;

	for (const item of evidence) {
		const start = Date.parse(item.window.startedAt);
		const end = Date.parse(item.window.endedAt);
		if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
		if (end <= window.startedAt || start >= window.endedAt) continue;
		clipCount++;
		const appId = item.application?.id ?? "unknown";
		const digestText =
			item.ocrSnippet && !item.redactedDigest?.includes(item.ocrSnippet)
				? `${item.redactedDigest ?? ""}\n${item.ocrSnippet}`
				: item.redactedDigest;
		const digest = collapseDigest(digestText);

		for (let index = 0; index < hourStarts.length; index++) {
			const hourStart = hourStarts[index] as number;
			const hourEnd = index + 1 < hourStarts.length ? (hourStarts[index + 1] as number) : window.endedAt;
			const overlap = Math.min(end, hourEnd, window.endedAt) - Math.max(start, hourStart, window.startedAt);
			if (overlap <= 0) continue;
			const bucket = buckets.get(hourStart);
			if (!bucket) continue;
			bucket.trackedMs += overlap;
			bucket.apps.set(appId, (bucket.apps.get(appId) ?? 0) + overlap);
			apps.set(appId, (apps.get(appId) ?? 0) + overlap);
			trackedMs += overlap;
			if (digest && bucket.digests[bucket.digests.length - 1] !== digest) bucket.digests.push(digest);
		}
	}

	return {
		window,
		ledgerPresent: options.ledgerPresent ?? true,
		ledgerPath: options.ledgerPath ?? "",
		clipCount,
		trackedMs,
		apps: descending(apps),
		hours: hourStarts.map(hourStart => {
			const bucket = buckets.get(hourStart) as Bucket;
			return {
				hourStartedAt: hourStart,
				hourLabel: new Date(hourStart).getHours(),
				trackedMs: bucket.trackedMs,
				apps: descending(bucket.apps),
				digests: bucket.digests,
			};
		}),
	};
}

/**
 * Open the ledger read-only, query the window, and summarize. A ledger that
 * does not exist yet yields an empty summary with `ledgerPresent: false` —
 * the normal state before the Activity Memory app has ever run — rather than
 * an error, and never creates the file.
 */
export function readActivitySummary(options: {
	readonly window: ActivityWindowMs;
	readonly ledgerPath?: string;
}): ActivitySummary {
	const ledgerPath = resolveGopkClipsPaths({ ledgerPath: options.ledgerPath }).ledgerPath;
	if (!fs.existsSync(ledgerPath)) {
		return summarizeActivity([], options.window, { ledgerPath, ledgerPresent: false });
	}
	const reader = new SqliteActivityLedgerReader(ledgerPath);
	try {
		const evidence = reader.listOverlapping(
			new Date(options.window.startedAt).toISOString(),
			new Date(options.window.endedAt).toISOString(),
		);
		return summarizeActivity(evidence, options.window, { ledgerPath, ledgerPresent: true });
	} finally {
		reader.close();
	}
}

/** `1.5h` / `12m` / `0m`, for terminal and model-facing output alike. */
export function formatTrackedMs(ms: number): string {
	if (ms <= 0) return "0m";
	const minutes = ms / 60_000;
	if (minutes >= 60) return `${(minutes / 60).toFixed(1)}h`;
	return `${Math.max(1, Math.round(minutes))}m`;
}
