import type { Usage } from "@oh-my-pi/pi-ai";
import { Container, Spacer, Text } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";

/** Below this the rate is nonsense (cached/instant responses yield absurd tok/s). */
const MIN_DURATION_MS = 100;

/** Local `YYYY-MM-DD HH:mm:ss` stamp for the per-turn usage row. */
function formatUsageTimestamp(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	return `${date} ${time}`;
}

/**
 * Prompt→yield wall time for a turn, from pure local timestamps: the user
 * prompt's timestamp to the response's completion time (`completedAt`, stamped
 * by the session at `message_end`). No provider-reported duration is involved —
 * messages persisted before the stamp existed simply have no span.
 * Undefined when either end is unknown (mid-attach or unstamped message).
 */
export function turnElapsedMs(
	turnStartedAt: number | undefined,
	message: { completedAt?: number },
): number | undefined {
	if (turnStartedAt === undefined || message.completedAt === undefined) return undefined;
	const elapsed = message.completedAt - turnStartedAt;
	return elapsed > 0 ? Math.round(elapsed) : undefined;
}

/** Format the metrics shared by standalone usage blocks and compact tool groups. */
export function formatUsageRow(
	usage: Usage,
	durationMs?: number,
	ttftMs?: number,
	timestamp?: number,
	turnElapsedMs?: number,
): string {
	const totalInput = usage.input + usage.cacheWrite;
	const parts: string[] = [];
	// Lead with the turn's local wall-clock time (down to the second), log-line style.
	if (timestamp !== undefined && Number.isFinite(timestamp) && timestamp > 0) {
		parts.push(formatUsageTimestamp(timestamp));
	}
	// The delta the operator actually waited, clock-suffixed so it reads apart
	// from the TTFT figure below (which reuses the same clock icon).
	// `message.duration` comes from performance.now(), so the combined value is
	// fractional; round before formatDuration so the label never prints a raw
	// float (e.g. `347.28381699998863ms`).
	if (turnElapsedMs !== undefined && turnElapsedMs > 0) {
		parts.push(`${theme.icon.time}Δ${formatDuration(Math.round(turnElapsedMs))}`);
	}
	parts.push(`${theme.icon.input} ${formatNumber(totalInput)}`);
	parts.push(`${theme.icon.output} ${formatNumber(usage.output)}`);
	if (usage.cacheRead > 0) {
		parts.push(`${theme.icon.cache} ${formatNumber(usage.cacheRead)}`);
	}
	if (ttftMs && ttftMs > 0) {
		parts.push(`${theme.icon.time} ${(ttftMs / 1000).toFixed(1)}s`);
	}
	if (durationMs && durationMs > MIN_DURATION_MS && usage.output > 0) {
		// TPS over the total request duration — the post-TTFT window undercounts
		// generation time when reasoning tokens are hidden before the first
		// visible byte, inflating the rate.
		const tokPerSec = (usage.output / durationMs) * 1000;
		parts.push(`${theme.icon.throughput} ${tokPerSec.toFixed(1)}/s`);
	}
	return parts.join("  ");
}

// `timestamp` and `turnElapsedMs` are optional and trail the throughput args to
// preserve the existing (usage, durationMs, ttftMs) call contract — this
// function is part of the package's public export surface (./modes/components/*).
export function createUsageRowBlock(
	usage: Usage,
	durationMs?: number,
	ttftMs?: number,
	timestamp?: number,
	turnElapsedMs?: number,
): Container {
	const block = new Container();
	block.addChild(new Spacer(1));
	block.addChild(new Text(theme.fg("dim", formatUsageRow(usage, durationMs, ttftMs, timestamp, turnElapsedMs)), 1, 0));
	return block;
}
