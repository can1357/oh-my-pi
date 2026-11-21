/**
 * Prompt-cache text beyond the `cache` marker: the two lines of its hover card
 * (Tern) and the rows of `/session`'s Prompt Cache section.
 */
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { sanitizeStatusText } from "../chrome/shared";
import type { PromptCacheColdReason, PromptCacheStatus, PromptCacheWarming } from "./host";

/** One `label: value` line of the prompt-cache details. */
export interface PromptCacheDetailRow {
	label: string;
	value: string;
	tone?: "warning";
}

function sameDay(at: number, nowMs: number): boolean {
	return new Date(at).toDateString() === new Date(nowMs).toDateString();
}

/** `4:53 PM` on `nowMs`'s local day; `Oct 17, 5:12 PM` on any other, which a bare clock time would misdate. */
function when(at: number, nowMs: number): string {
	return sameDay(at, nowMs)
		? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
		: new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** ` (in 41 min)` / ` (3 h ago)` / ` (12 days ago)`. */
function relative(at: number, nowMs: number): string {
	const minutes = Math.round(Math.abs(at - nowMs) / 60_000);
	if (minutes === 0) return at >= nowMs ? " (in under a minute)" : " (just now)";
	const span =
		minutes < 60
			? `${minutes} min`
			: minutes < 48 * 60
				? `${Math.round(minutes / 60)} h`
				: `${Math.round(minutes / (24 * 60))} days`;
	return at >= nowMs ? ` (in ${span})` : ` (${span} ago)`;
}

/**
 * Why the next message re-sends the prefix, as one phrase. With `nowMs` an expiry says when; the hover card
 * omits it, since the terminal shows the card later without repainting it.
 */
function coldReasonText(reason: PromptCacheColdReason, nowMs?: number): string {
	switch (reason.kind) {
		case "expired":
			if (nowMs === undefined) return "expired";
			return `expired ${sameDay(reason.at, nowMs) ? "at " : ""}${when(reason.at, nowMs)}${relative(reason.at, nowMs)}`;
		case "refresh-missed":
			return "omp's refresh found the entry gone";
		case "model":
			return `model changed: ${sanitizeStatusText(reason.from)} → ${sanitizeStatusText(reason.to)}`;
		case "thinking":
			return `thinking level changed: ${sanitizeStatusText(reason.from)} → ${sanitizeStatusText(reason.to)}`;
		case "tools":
			return "tool set changed";
		case "system-prompt":
			return "system prompt changed";
		case "retention":
			return "cache retention setting changed";
		case "compaction":
			return "context was compacted";
	}
}

function warmingText(warming: PromptCacheWarming, nowMs: number): string {
	switch (warming.state) {
		case "scheduled": {
			const next =
				warming.nextWarmAt === undefined ? "refresh scheduled" : `next refresh ${when(warming.nextWarmAt, nowMs)}`;
			return warming.stopsAt === undefined ? next : `${next}, gives up by ${when(warming.stopsAt, nowMs)}`;
		}
		case "refreshing":
			return "refreshing now";
		case "inactive": {
			const reason = warming.reason === undefined ? "" : sanitizeStatusText(warming.reason);
			return reason ? `off: ${reason}` : "off";
		}
	}
}

/**
 * What the next message re-sends uncached. A lapsed entry, a missed refresh, another
 * model or another tool set (the first cached block) leaves nothing to read. Any
 * other change keeps the cached blocks ahead of it (tools, then the system prompt),
 * whose share omp cannot see, so the whole prompt is only the most it re-sends.
 */
function resendText(status: PromptCacheStatus): string {
	const tokens = `~${formatNumber(status.nextTokens)}`;
	switch (status.reason?.kind) {
		case "expired":
		case "refresh-missed":
		case "model":
		case "tools":
			return `re-sends ${tokens}`;
		default:
			return `re-sends up to ${tokens}`;
	}
}

/**
 * The hover card's two lines: whether the next message reads the cache (until when, or why not), then what it
 * sends. The terminal shows the card later without repainting it, so it names no time relative to now.
 */
export function promptCacheBrief(status: PromptCacheStatus, nowMs: number): readonly [string, string] {
	if (status.state === "cold") {
		const why = status.reason ? ` — ${coldReasonText(status.reason)}` : "";
		return [`Not cached${why}`, `Next message ${resendText(status)}`];
	}
	const cached = status.inferred ? "Likely cached" : "Cached";
	const until = status.ttlMs === undefined ? ", no expiry" : ` until ${when(status.touchedAt + status.ttlMs, nowMs)}`;
	const reads = formatNumber(Math.min(status.cachedTokens, status.nextTokens));
	return [`${cached}${until}`, `Next message reads ~${reads} from cache`];
}

/** The `/session` rows, in display order; times say how long ago or ahead of `nowMs` they are. */
export function promptCacheDetails(status: PromptCacheStatus, nowMs: number): PromptCacheDetailRow[] {
	const tier: PromptCacheDetailRow = {
		label: "Tier",
		value: status.ttlMs === undefined ? "no expiry" : formatDuration(status.ttlMs),
	};
	const warming: PromptCacheDetailRow[] = status.warming
		? [{ label: "Warming", value: warmingText(status.warming, nowMs) }]
		: [];
	if (status.state === "cold") {
		return [
			{ label: "State", value: "Not cached", tone: "warning" },
			...(status.reason
				? [{ label: "Why not cached", value: coldReasonText(status.reason, nowMs), tone: "warning" as const }]
				: []),
			tier,
			...warming,
			{ label: "Next message", value: `${resendText(status)} uncached` },
		];
	}
	const expiresAt = status.ttlMs === undefined ? undefined : status.touchedAt + status.ttlMs;
	const reads = Math.min(status.cachedTokens, status.nextTokens);
	return [
		{ label: "State", value: status.inferred ? "Likely cached" : "Cached" },
		{
			label: "Expires",
			value:
				expiresAt === undefined
					? "never (the provider keeps it)"
					: `${when(expiresAt, nowMs)}${relative(expiresAt, nowMs)}`,
		},
		tier,
		...warming,
		{
			label: "Next message",
			value: `reads ~${formatNumber(reads)} from cache, sends ~${formatNumber(status.nextTokens - reads)} new`,
		},
	];
}
