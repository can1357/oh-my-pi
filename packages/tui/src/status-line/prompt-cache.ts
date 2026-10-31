/**
 * Prompt-cache details: what the `cache` chip's hover card (Tern) and the
 * `/session` section (classic TUI) show beyond the chip's cached/not cached word.
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

/**
 * How the details read times. `card`: a hover card the terminal shows later,
 * so absolute times only. `snapshot`: read the moment it is built (`/session`),
 * so times also say how long ago or ahead they are.
 */
export type PromptCacheDetailsView = "card" | "snapshot";

function sameDay(at: number, nowMs: number): boolean {
	return new Date(at).toDateString() === new Date(nowMs).toDateString();
}

/** `4:53 PM` on `nowMs`'s local day; `Oct 17, 5:12 PM` on any other, which a bare clock time would misdate. */
function when(at: number, nowMs: number): string {
	return sameDay(at, nowMs)
		? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
		: new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** ` (in 41 min)` / ` (3 h ago)` / ` (12 days ago)` in a snapshot; empty on a card. */
function relative(at: number, nowMs: number, view: PromptCacheDetailsView): string {
	if (view === "card") return "";
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

/** Why the next message re-sends the prefix, as one phrase. */
export function promptCacheColdReasonText(
	reason: PromptCacheColdReason,
	nowMs: number,
	view: PromptCacheDetailsView,
): string {
	switch (reason.kind) {
		case "expired": {
			const at = `${sameDay(reason.at, nowMs) ? "at " : ""}${when(reason.at, nowMs)}`;
			return `expired ${at}${relative(reason.at, nowMs, view)}`;
		}
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
		case "cache-key":
			return "provider cache session changed";
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
 * model, another tool set (the first cached block) or another cache key leaves nothing to read. Any
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
		case "cache-key":
			return `re-sends ${tokens} uncached`;
		default:
			return `re-sends up to ${tokens} uncached`;
	}
}

/** One-line summary for the chip's tooltip. */
export function promptCacheSummary(status: PromptCacheStatus): string {
	if (status.state === "cold") return `Prompt cache: next message ${resendText(status)}`;
	const reads = formatNumber(Math.min(status.cachedTokens, status.nextTokens));
	return `Prompt cache: next message ${status.inferred ? "likely reads" : "reads"} ${reads} from cache`;
}

/**
 * The details rows, in display order. Times carry the date unless they fall on
 * `nowMs`'s local day; `view` decides whether they also read relative.
 */
export function promptCacheDetails(
	status: PromptCacheStatus,
	nowMs: number,
	view: PromptCacheDetailsView,
): PromptCacheDetailRow[] {
	const cached = status.state === "warm";
	const rows: PromptCacheDetailRow[] = [];
	rows.push(
		cached
			? { label: "State", value: status.inferred ? "Likely cached" : "Cached" }
			: { label: "State", value: "Not cached", tone: "warning" },
	);
	if (!cached && status.reason) {
		rows.push({
			label: "Why not cached",
			value: promptCacheColdReasonText(status.reason, nowMs, view),
			tone: "warning",
		});
	}
	if (cached) {
		if (status.ttlMs === undefined) {
			rows.push({ label: "Expires", value: "never (the provider keeps it)" });
		} else {
			const expiresAt = status.touchedAt + status.ttlMs;
			rows.push({ label: "Expires", value: `${when(expiresAt, nowMs)}${relative(expiresAt, nowMs, view)}` });
		}
	}
	rows.push({ label: "Tier", value: status.ttlMs === undefined ? "no expiry" : formatDuration(status.ttlMs) });
	if (status.warming) rows.push({ label: "Warming", value: warmingText(status.warming, nowMs) });
	if (cached) {
		const reads = Math.min(status.cachedTokens, status.nextTokens);
		rows.push({
			label: "Next message",
			value: `reads ~${formatNumber(reads)} from cache, sends ~${formatNumber(status.nextTokens - reads)} new`,
		});
	} else {
		rows.push({ label: "Next message", value: resendText(status) });
		rows.push({ label: "Hint", value: "/compact snapcompact first to send less" });
	}
	return rows;
}
