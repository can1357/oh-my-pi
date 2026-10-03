import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { Container } from "../tui";
import { Spacer } from "../components/spacer";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { theme } from "../theme/theme";
import { formatMetricRow, MetricRow, type MetricSpec } from "../components/metric";
import { node, row, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";

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

/** A finished turn's totals, the native `omp.turn.usage` line under its last answer. */
export interface TurnUsageSummary {
	/** Prompt→yield wall time; undefined when either end is unknown. */
	readonly elapsedMs: number | undefined;
	/**
	 * Prompt tokens: input, cache writes and orchestration input. Cache reads
	 * re-read the context each request, so they stay out (as in the status
	 * line's total).
	 */
	readonly input: number;
	/** Output tokens, orchestration output included. */
	readonly output: number;
	/** Billed cost in dollars. */
	readonly cost: number;
}

/**
 * Sums the requests of a turn. {@link add} returns the turn's summary on the
 * message that ends the run (any stop but `toolUse`) and starts over.
 */
export class TurnUsageTally {
	#input = 0;
	#output = 0;
	#cost = 0;

	/** Drop a partial turn (a new prompt, a fresh run). */
	reset(): void {
		this.#input = 0;
		this.#output = 0;
		this.#cost = 0;
	}

	add(message: AssistantMessage, turnStartedAt: number | undefined): TurnUsageSummary | undefined {
		const { usage } = message;
		this.#input += usage.input + usage.cacheWrite + (usage.orchestration?.input ?? 0);
		this.#output += usage.output + (usage.orchestration?.output ?? 0);
		this.#cost += usage.cost.total;
		if (message.stopReason === "toolUse") return undefined;
		const summary =
			this.#input + this.#output > 0 || this.#cost > 0
				? {
						elapsedMs: turnElapsedMs(turnStartedAt, message),
						input: this.#input,
						output: this.#output,
						cost: this.#cost,
					}
				: undefined;
		this.reset();
		return summary;
	}
}

/**
 * The native turn line: `12.4s · 19K tok · $0.02 this turn` (the time drops
 * out when unknown, the cost when nothing was billed), and its tooltip with
 * exact counts.
 */
export function formatTurnUsage(summary: TurnUsageSummary): { text: string; title: string } {
	const tokens = summary.input + summary.output;
	const cost = summary.cost > 0 ? (summary.cost < 0.005 ? "<$0.01" : `$${summary.cost.toFixed(2)}`) : undefined;
	const time = summary.elapsedMs === undefined ? undefined : formatDuration(summary.elapsedMs);
	const text = [time, `${formatNumber(tokens)} tok`, cost].filter(part => part !== undefined).join(" · ");
	const exact = `${tokens.toLocaleString("en-US")} tokens (${summary.input.toLocaleString("en-US")} in · ${summary.output.toLocaleString("en-US")} out)`;
	const title = [time, exact, cost].filter(part => part !== undefined).join(" · ");
	return { text: `${text} this turn`, title: `This turn: ${title}` };
}

/**
 * Output tokens per second over the generation window; undefined when that
 * window is too short to mean anything. With TTFT known, prefill and decode are
 * rated apart: TTFT covers prompt ingestion (cache walk, queueing), the
 * remainder is generation, so a long prefill no longer reads as slow
 * generation. A window TTFT swallows has no honest rate at all.
 */
function usageThroughput(usage: Usage, durationMs: number | undefined, ttftMs?: number): number | undefined {
	if (!durationMs || durationMs <= MIN_DURATION_MS || usage.output <= 0) return undefined;
	if (ttftMs !== undefined && ttftMs > 0) {
		const decodeMs = durationMs - ttftMs;
		return decodeMs <= MIN_DURATION_MS ? undefined : (usage.output / decodeMs) * 1000;
	}
	// TPS over the total request duration — the post-TTFT window undercounts
	// generation time when reasoning tokens are hidden before the first
	// visible byte, inflating the rate.
	return (usage.output / durationMs) * 1000;
}

/** Every metric except throughput, which the native row declares as a `rate`. */
function usageRowBaseSpecs(usage: Usage, ttftMs?: number, timestamp?: number, turnElapsedMs?: number): MetricSpec[] {
	const totalInput = usage.input + usage.cacheWrite;
	const specs: MetricSpec[] = [];
	// Lead with the turn's local wall-clock time (down to the second), log-line style.
	if (timestamp !== undefined && Number.isFinite(timestamp) && timestamp > 0) {
		specs.push({ value: formatUsageTimestamp(timestamp) });
	}
	// The delta the operator actually waited, bare with a space so it scans
	// apart from the TTFT figure below (which keeps the clock icon).
	// `message.duration` comes from performance.now(), so the combined value is
	// fractional; round before formatDuration so the label never prints a raw
	// float (e.g. `347.28381699998863ms`).
	if (turnElapsedMs !== undefined && turnElapsedMs > 0) {
		specs.push({ value: `Δ ${formatDuration(Math.round(turnElapsedMs))}` });
	}
	specs.push({ leading: theme.icon.input, value: formatNumber(totalInput) });
	specs.push({ leading: theme.icon.output, value: formatNumber(usage.output) });
	if (usage.cacheRead > 0) {
		specs.push({ leading: theme.icon.cache, value: formatNumber(usage.cacheRead) });
	}
	if (ttftMs && ttftMs > 0) {
		specs.push({ leading: theme.icon.time, value: `${(ttftMs / 1000).toFixed(1)}s` });
	}
	return specs;
}

function usageRowSpecs(
	usage: Usage,
	durationMs?: number,
	ttftMs?: number,
	timestamp?: number,
	turnElapsedMs?: number,
): MetricSpec[] {
	const specs = usageRowBaseSpecs(usage, ttftMs, timestamp, turnElapsedMs);
	const tokPerSec = usageThroughput(usage, durationMs, ttftMs);
	if (tokPerSec !== undefined) {
		// The split figure says so, so a decode rate is never read as a
		// duration-wide one.
		const suffix = ttftMs !== undefined && ttftMs > 0 ? " (decode)" : "";
		specs.push({ leading: theme.icon.throughput, value: `${tokPerSec.toFixed(1)}/s${suffix}` });
	}
	return specs;
}

/** Per-turn usage block: a dim metric strip under the turn; natively a wrapping row with a `rate` for throughput. */
class UsageRowBlock extends Container {
	readonly #usage: Usage;
	readonly #durationMs: number | undefined;
	readonly #ttftMs: number | undefined;
	readonly #timestamp: number | undefined;
	readonly #turnElapsedMs: number | undefined;
	#nativeNode: NativeNode | undefined;

	constructor(usage: Usage, durationMs?: number, ttftMs?: number, timestamp?: number, turnElapsedMs?: number) {
		super();
		this.#usage = usage;
		this.#durationMs = durationMs;
		this.#ttftMs = ttftMs;
		this.#timestamp = timestamp;
		this.#turnElapsedMs = turnElapsedMs;
		this.addChild(new Spacer(1));
		this.addChild(
			new MetricRow(usageRowSpecs(usage, durationMs, ttftMs, timestamp, turnElapsedMs), {
				separator: "  ",
				overflow: "wrap",
				paddingX: 1,
				paddingY: 0,
				style: text => theme.fg("dim", text),
			}),
		);
	}

	/**
	 * One quiet mono line (`18:02 · Δ 6.2s · in 18.4K · out 640 · cache 12K ·
	 * ttft 0.9s · 96 tok/s`): worded metrics instead of the ANSI icons, the
	 * full timestamp in the tooltip, and throughput as a `rate`.
	 */
	override describe(): NativeNode {
		if (this.#nativeNode) return this.#nativeNode;
		const usage = this.#usage;
		const parts: string[] = [];
		const timestamp = this.#timestamp;
		const stamped = timestamp !== undefined && Number.isFinite(timestamp) && timestamp > 0;
		if (stamped) parts.push(formatUsageTimestamp(timestamp).slice(11, 16));
		if (this.#turnElapsedMs !== undefined && this.#turnElapsedMs > 0) {
			parts.push(`Δ ${formatDuration(Math.round(this.#turnElapsedMs))}`);
		}
		parts.push(`in ${formatNumber(usage.input + usage.cacheWrite)}`, `out ${formatNumber(usage.output)}`);
		if (usage.cacheRead > 0) parts.push(`cache ${formatNumber(usage.cacheRead)}`);
		if (this.#ttftMs && this.#ttftMs > 0) parts.push(`ttft ${(this.#ttftMs / 1000).toFixed(1)}s`);
		const children: NativeChild[] = [text([span(parts.join(" · "), "dim")])];
		const tokPerSec = usageThroughput(usage, this.#durationMs, this.#ttftMs);
		if (tokPerSec !== undefined) {
			children.push(
				text([span(" · ", "dim")]),
				node("rate", { value: Math.round(tokPerSec * 10) / 10, unit: "tok/s" }),
			);
		}
		this.#nativeNode = row(children, {
			role: "omp.usage.turn",
			gap: "none",
			align: "baseline",
			...(stamped ? { title: formatUsageTimestamp(timestamp) } : {}),
		});
		return this.#nativeNode;
	}
}

/** Format the metrics shared by standalone usage blocks and compact tool groups. */
export function formatUsageRow(
	usage: Usage,
	durationMs?: number,
	ttftMs?: number,
	timestamp?: number,
	turnElapsedMs?: number,
): string {
	return formatMetricRow(usageRowSpecs(usage, durationMs, ttftMs, timestamp, turnElapsedMs), {
		separator: "  ",
	});
}

/** Blocks minted by {@link createUsageRowBlock}, so transcript walkers can attribute them to the turn above. */
const usageRowBlocks = new WeakSet<Container>();

/** Whether `component` is a per-turn usage/metrics row from {@link createUsageRowBlock}. */
export function isUsageRowBlock(component: object): boolean {
	return usageRowBlocks.has(component as Container);
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
	const block = new UsageRowBlock(usage, durationMs, ttftMs, timestamp, turnElapsedMs);
	usageRowBlocks.add(block);
	return block;
}
