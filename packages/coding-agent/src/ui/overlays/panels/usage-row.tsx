/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A request's usage under its answer: natively one quiet line (`18:02 ·
 * Δ 6.2s · in 18K · out 640 · cache 12K · ttft 0.9s`) with throughput as a
 * `rate` and the full timestamp in the tooltip; in the terminal a dim metric
 * strip with icons (`⤵ 18K  ⤴ 640  💾 12K`) under a blank row.
 */
import type { Usage } from "@oh-my-pi/pi-ai";
import { type JSXNode, type Reactive, read } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import "../../styles/panels/usage-row";

/** Below this a rate means nothing (cached or instant responses). */
const MIN_RATE_DURATION_MS = 100;

export type UsageRowUsage = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">;

export interface UsageRowProps {
	readonly usage: UsageRowUsage;
	/** Whole-request duration (throughput). */
	readonly durationMs?: number;
	/** Time to first token. */
	readonly ttftMs?: number;
	/** When the turn ended (ms). */
	readonly timestamp?: number;
	/** Prompt→yield wall time. */
	readonly turnElapsedMs?: number;
	/** The terminal's clock; 24-hour when unset. */
	readonly hour12?: Reactive<boolean | undefined>;
}

/** One metric of the terminal strip: an optional icon (symbol key) and its value. */
export interface UsageMetric {
	readonly icon?: string;
	readonly value: string;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

/** `2026-01-01 18:05:09` local; the time follows the 12-hour clock when asked. */
function stamp(ms: number, hour12: boolean | undefined): string {
	const d = new Date(ms);
	const time = hour12
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12 })
		: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

/** Output tokens per second over the request; undefined when too short to mean anything. */
function throughput(props: UsageRowProps): number | undefined {
	const { durationMs } = props;
	if (!durationMs || durationMs <= MIN_RATE_DURATION_MS || props.usage.output <= 0) return undefined;
	return (props.usage.output / durationMs) * 1000;
}

function stamped(props: UsageRowProps): props is UsageRowProps & { timestamp: number } {
	return props.timestamp !== undefined && Number.isFinite(props.timestamp) && props.timestamp > 0;
}

/** The terminal strip's metrics. */
export function usageMetrics(props: UsageRowProps): UsageMetric[] {
	const { usage } = props;
	const metrics: UsageMetric[] = [];
	if (stamped(props)) metrics.push({ value: stamp(props.timestamp, false) });
	if (props.turnElapsedMs !== undefined && props.turnElapsedMs > 0)
		metrics.push({ value: `Δ ${formatDuration(Math.round(props.turnElapsedMs))}` });
	metrics.push({ icon: "icon.input", value: formatNumber(usage.input + usage.cacheWrite) });
	metrics.push({ icon: "icon.output", value: formatNumber(usage.output) });
	if (usage.cacheRead > 0) metrics.push({ icon: "icon.cache", value: formatNumber(usage.cacheRead) });
	if (props.ttftMs && props.ttftMs > 0)
		metrics.push({ icon: "icon.time", value: `${(props.ttftMs / 1000).toFixed(1)}s` });
	const rate = throughput(props);
	if (rate !== undefined) metrics.push({ icon: "icon.throughput", value: `${rate.toFixed(1)}/s` });
	return metrics;
}

export function UsageRow(props: UsageRowProps): JSXNode {
	const { usage } = props;
	const rate = throughput(props);
	const metrics = usageMetrics(props);
	return () => {
		const hour12 = read(props.hour12);
		const parts: string[] = [];
		if (stamped(props)) {
			parts.push(
				hour12
					? new Date(props.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12 })
					: stamp(props.timestamp, false).slice(11, 16),
			);
		}
		if (props.turnElapsedMs !== undefined && props.turnElapsedMs > 0)
			parts.push(`Δ ${formatDuration(Math.round(props.turnElapsedMs))}`);
		parts.push(`in ${formatNumber(usage.input + usage.cacheWrite)}`, `out ${formatNumber(usage.output)}`);
		if (usage.cacheRead > 0) parts.push(`cache ${formatNumber(usage.cacheRead)}`);
		if (props.ttftMs && props.ttftMs > 0) parts.push(`ttft ${(props.ttftMs / 1000).toFixed(1)}s`);
		return (
			<row
				role="omp.usage.turn"
				gap="none"
				align="baseline"
				title={stamped(props) ? stamp(props.timestamp, hour12) : undefined}
				term={{ metrics }}
			>
				<text spans={[{ s: "dim", t: parts.join(" · ") }]} />
				{rate !== undefined && [
					<text spans={[{ s: "dim", t: " · " }]} />,
					<rate value={Math.round(rate * 10) / 10} unit="tok/s" />,
				]}
			</row>
		);
	};
}
