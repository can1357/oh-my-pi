import type { Component } from "../tui";
import { Ellipsis, getWidthConfigEpoch, truncateToWidth, visibleWidth } from "../utils";
import { Text } from "./text";

/** One preformatted metric. Domain-specific number, cost, and quota policy stays with the caller. */
export interface MetricSpec {
	/** Undefined omits the metric; an empty string and zero-like strings remain observable values. */
	readonly value: string | undefined;
	/** Optional icon or label placed before the value. */
	readonly leading?: string;
	/** Separator between `leading` and `value`. */
	readonly separator?: string;
	/** Higher-priority metrics survive first when a row uses `drop` overflow. */
	readonly priority?: number;
	/** Render-time styling for the complete metric. */
	readonly style?: (text: string) => string;
}

/** Width behavior for an inline metric row. */
export type MetricOverflow = "allow" | "drop" | "truncate" | "wrap";

/** Presentation options shared by {@link formatMetricRow} and {@link MetricRow}. */
export interface MetricRowOptions {
	readonly separator?: string;
	readonly overflow?: MetricOverflow;
	readonly maxWidth?: number;
	readonly paddingX?: number;
	readonly paddingY?: number;
	readonly style?: (text: string) => string;
}

/** Format one metric without imposing domain-specific value policy. */
export function formatMetric(metric: MetricSpec): string | undefined {
	if (metric.value === undefined) return undefined;
	const text =
		metric.leading !== undefined ? `${metric.leading}${metric.separator ?? " "}${metric.value}` : metric.value;
	return metric.style ? metric.style(text) : text;
}

/**
 * Join metrics in declaration order. `drop` removes the lowest-priority metric
 * first (rightmost on ties); `truncate` clips the complete row. `wrap` is
 * applied by {@link MetricRow}, where the component owns the available width.
 */
export function formatMetricRow(metrics: readonly MetricSpec[], options: MetricRowOptions = {}): string {
	const separator = options.separator ?? " ";
	const entries = metrics.flatMap((metric, index) => {
		const text = formatMetric(metric);
		return text === undefined ? [] : [{ text, index, priority: metric.priority ?? 0 }];
	});
	if (entries.length === 0) return "";

	const maxWidth = options.maxWidth;
	const overflow = options.overflow ?? "allow";
	const join = (): string => entries.map(entry => entry.text).join(separator);
	if (maxWidth === undefined || overflow === "allow" || overflow === "wrap") return join();

	if (overflow === "truncate") {
		return truncateToWidth(join(), Math.max(0, maxWidth));
	}

	while (entries.length > 1 && visibleWidth(join()) > maxWidth) {
		let dropIndex = 0;
		for (let i = 1; i < entries.length; i += 1) {
			const candidate = entries[i]!;
			const current = entries[dropIndex]!;
			if (
				candidate.priority < current.priority ||
				(candidate.priority === current.priority && candidate.index > current.index)
			) {
				dropIndex = i;
			}
		}
		entries.splice(dropIndex, 1);
	}
	return join();
}

/**
 * Component form of an inline metric row. It delegates ANSI-aware wrapping,
 * padding, theme invalidation, and stable unchanged-render arrays to {@link Text}.
 */
export class MetricRow implements Component {
	#metrics: readonly MetricSpec[];
	readonly #options: MetricRowOptions;
	readonly #text: Text;
	#cache: { width: number; epoch: number; source: readonly string[]; lines: readonly string[] } | undefined;

	constructor(metrics: readonly MetricSpec[], options: MetricRowOptions = {}) {
		this.#metrics = metrics;
		this.#options = options;
		this.#text = new Text("", options.paddingX ?? 0, options.paddingY ?? 0).setStyleFn(options.style);
	}

	setMetrics(metrics: readonly MetricSpec[]): boolean {
		if (this.#metrics === metrics) return false;
		this.#metrics = metrics;
		this.#cache = undefined;
		return true;
	}

	invalidate(): void {
		this.#text.invalidate();
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		const renderWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		const paddingX =
			this.#options.paddingX !== undefined && Number.isFinite(this.#options.paddingX)
				? Math.max(0, Math.trunc(this.#options.paddingX))
				: 0;
		const maxWidth = Math.max(0, renderWidth - paddingX * 2);
		this.#text.setText(
			formatMetricRow(this.#metrics, {
				...this.#options,
				maxWidth,
				overflow: this.#options.overflow === "wrap" ? "allow" : this.#options.overflow,
			}),
		);
		const source = this.#text.render(renderWidth);
		const epoch = getWidthConfigEpoch();
		if (this.#cache?.width === renderWidth && this.#cache.epoch === epoch && this.#cache.source === source) {
			return this.#cache.lines;
		}
		const lines = source.every(line => visibleWidth(line) <= renderWidth)
			? source
			: source.map(line => truncateToWidth(line, renderWidth, Ellipsis.Omit));
		this.#cache = { width: renderWidth, epoch, source, lines };
		return lines;
	}
}
