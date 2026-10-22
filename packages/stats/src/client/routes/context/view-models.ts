import { buildColorLookup, OTHER_COLOR } from "../../data/colors";
import { formatCost } from "../../data/formatters";
import { densify } from "../../data/series";
import type {
	ContextEvent,
	ContextFileActivity,
	ContextModelRow,
	ContextOverview,
	ContextStep,
	TimeRange,
} from "../../types";

export const CATEGORY_KEYS = ["systemPrompt", "systemTools", "systemContext", "skills", "messages"] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

/** The only mapping from a context category to its label and mark colour. */
export const CATEGORY_STYLE: Record<CategoryKey, { label: string; color: string }> = {
	systemPrompt: { label: "System prompt", color: "var(--ctx-system-prompt)" },
	systemTools: { label: "System tools", color: "var(--ctx-system-tools)" },
	systemContext: { label: "System context", color: "var(--ctx-system-context)" },
	skills: { label: "Skills", color: "var(--ctx-skills)" },
	messages: { label: "Messages", color: "var(--ctx-messages)" },
};

export function categoryRows(step: ContextStep | undefined) {
	return CATEGORY_KEYS.map(key => ({
		key,
		...CATEGORY_STYLE[key],
		tokens: step?.composition?.[key] ?? null,
	}));
}

export function categoryShare(value: number | null, step: ContextStep | undefined): number {
	const total = step?.promptTokens ?? 0;
	return value === null || total <= 0 ? 0 : value / total;
}

/** Unpriced spend must not read as free. */
export function formatContextCost(value: number, unpriced: number): string {
	if (value === 0 && unpriced > 0) return "N/A";
	const cost = formatCost(value);
	return unpriced > 0 ? `~${cost}` : cost;
}

export function modelMixSegments(models: readonly ContextModelRow[], limit = 5) {
	const sorted = [...models].sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
	const colors = buildColorLookup(sorted.map(row => ({ key: row.model, weight: row.requests })));
	const visible = sorted.slice(0, limit);
	const rest = sorted.slice(limit);
	const segments = visible.map(row => ({
		key: row.model,
		label: row.model,
		value: row.requests,
		color: colors.get(row.model) ?? OTHER_COLOR,
	}));
	if (rest.length > 0) {
		segments.push({
			key: "other",
			label: `Other (${rest.length})`,
			value: rest.reduce((sum, row) => sum + row.requests, 0),
			color: OTHER_COLOR,
		});
	}
	return segments;
}

export interface ContextActivityCell {
	key: string;
	start: number;
	end: number;
	row: number;
	col: number;
	requests: number;
	promptTokens: number;
	outputTokens: number;
	totalTokens: number;
	costTotal: number;
	unpricedRequests: number;
	partial: boolean;
	label: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function localDateKey(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dateKeyOrdinal(key: string): number {
	const [year, month, day] = key.split("-").map(Number);
	return Math.floor(Date.UTC(year!, month! - 1, day!) / DAY_MS);
}

function dateKeyWeekday(key: string): number {
	const [year, month, day] = key.split("-").map(Number);
	return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
}

function cellLabel(start: number, end: number, daily: boolean): string {
	const date = new Date(start);
	if (daily) return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	const startText = date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
	const endText = new Date(end).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return `${startText}–${endText}`;
}

function emptyCell(key: string, start: number, end: number, row: number, col: number): ContextActivityCell {
	return {
		key,
		start,
		end,
		row,
		col,
		requests: 0,
		promptTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		costTotal: 0,
		unpricedRequests: 0,
		partial: false,
		label: "",
	};
}

/**
 * Fold the epoch-aligned overview buckets into the display cells fixed by the
 * design. Every bucket is assigned once: 1h merges all buckets; 24h/7d clamp a
 * bucket into 24/168 rolling cells; 30d/90d group by the local date of the
 * bucket start. Cell intervals are derived from member buckets, never from the
 * slot, so a boundary cell carries its real partial range.
 */
export function buildActivityCells(overview: ContextOverview, now = Date.now()): ContextActivityCell[] {
	const range = overview.range;
	const bucketMs = Math.max(1, overview.heatmapBucketMs);
	const daily = range === "30d" || range === "90d";
	const oneHour = range === "1h";
	const slots = oneHour ? 1 : range === "24h" ? 24 : range === "7d" ? 168 : 0;
	const cells: ContextActivityCell[] = [];
	const byKey = new Map<string, ContextActivityCell>();
	const members = new Map<string, number[]>();

	const ensure = (key: string, start: number, end: number, row: number, col: number) => {
		let cell = byKey.get(key);
		if (!cell) {
			cell = emptyCell(key, start, end, row, col);
			byKey.set(key, cell);
			cells.push(cell);
			members.set(key, []);
		}
		return cell;
	};

	if (daily) {
		const first = Math.floor(overview.cutoff / bucketMs) * bucketMs;
		const last = Math.floor(now / bucketMs) * bucketMs;
		for (let bucket = first; bucket <= last; bucket += bucketMs) {
			const key = localDateKey(bucket);
			ensure(key, bucket, bucket + bucketMs, 0, 0);
			members.get(key)?.push(bucket);
		}
	} else {
		for (let index = 0; index < slots; index++) {
			const key = `slot-${index}`;
			const start = oneHour ? overview.cutoff : overview.cutoff + index * bucketMs;
			ensure(key, start, Math.min(now, start + (oneHour ? HOUR_MS : bucketMs)), 0, 0);
		}
		// Enumerate every epoch bucket, including absent zero buckets, so even an
		// empty display cell has the real interval it covers.
		const first = Math.floor(overview.cutoff / bucketMs) * bucketMs;
		for (let bucket = first; bucket <= now; bucket += bucketMs) {
			const index = oneHour
				? 0
				: Math.min(slots - 1, Math.max(0, Math.floor((bucket - overview.cutoff) / bucketMs)));
			members.get(`slot-${index}`)?.push(bucket);
		}
	}

	for (const point of overview.heatmap) {
		let key: string;
		if (oneHour) {
			key = "slot-0";
		} else if (daily) {
			key = localDateKey(point.bucket);
		} else {
			const index = Math.min(slots - 1, Math.max(0, Math.floor((point.bucket - overview.cutoff) / bucketMs)));
			key = `slot-${index}`;
		}
		const cell = byKey.get(key);
		if (!cell) continue;
		cell.requests += point.requests;
		cell.promptTokens += point.promptTokens;
		cell.outputTokens += point.outputTokens;
		cell.totalTokens += point.totalTokens;
		cell.costTotal += point.costTotal;
		cell.unpricedRequests += point.unpricedRequests;
	}

	for (const cell of cells) {
		const bucketStarts = members.get(cell.key) ?? [];
		if (bucketStarts.length > 0) {
			const first = Math.min(...bucketStarts);
			const last = Math.max(...bucketStarts);
			cell.start = Math.max(overview.cutoff, first);
			cell.end = Math.min(now, last + bucketMs);
			cell.partial = first < overview.cutoff || last + bucketMs > now;
		} else {
			cell.start = Math.max(overview.cutoff, cell.start);
			cell.end = Math.min(now, cell.end);
		}
		cell.label = cellLabel(cell.start, cell.end, daily);
	}

	if (daily && cells.length > 0) {
		const firstKey = localDateKey(Math.min(...cells.map(cell => cell.start)));
		const origin = dateKeyOrdinal(firstKey) - dateKeyWeekday(firstKey);
		for (const cell of cells) {
			// Keep the bucket's local date even when the first cell's visible start is
			// clamped to a cutoff that crossed midnight.
			const bucketStart = members.get(cell.key)?.[0] ?? cell.start;
			const key = localDateKey(bucketStart);
			cell.row = Math.floor((dateKeyOrdinal(key) - origin) / 7);
			cell.col = dateKeyWeekday(key);
		}
	} else if (!oneHour) {
		for (let index = 0; index < cells.length; index++) {
			cells[index]!.row = Math.floor(index / 24);
			cells[index]!.col = index % 24;
		}
	}

	return cells.sort((a, b) => a.row - b.row || a.col - b.col);
}

/** 7d chart uses one point per 24-cell rolling band; other ranges use cells. */
export function chartCells(cells: readonly ContextActivityCell[], range: TimeRange): ContextActivityCell[] {
	if (range !== "7d") return [...cells];
	const bands: ContextActivityCell[] = [];
	for (let index = 0; index < cells.length; index += 24) {
		const group = cells.slice(index, index + 24);
		if (group.length === 0) continue;
		bands.push({
			...group[0]!,
			key: `band-${index / 24}`,
			start: group[0]!.start,
			end: group[group.length - 1]!.end,
			requests: group.reduce((sum, cell) => sum + cell.requests, 0),
			promptTokens: group.reduce((sum, cell) => sum + cell.promptTokens, 0),
			outputTokens: group.reduce((sum, cell) => sum + cell.outputTokens, 0),
			totalTokens: group.reduce((sum, cell) => sum + cell.totalTokens, 0),
			costTotal: group.reduce((sum, cell) => sum + cell.costTotal, 0),
			unpricedRequests: group.reduce((sum, cell) => sum + cell.unpricedRequests, 0),
			partial: group.some(cell => cell.partial),
			label: `${group[0]!.label} – ${group[group.length - 1]!.label}`,
		});
	}
	return bands;
}

export function heatmapBuckets(
	overview: Pick<ContextOverview, "cutoff" | "heatmapBucketMs">,
	now = Date.now(),
): number[] {
	const size = Math.max(1, overview.heatmapBucketMs);
	const start = Math.floor(overview.cutoff / size) * size;
	const end = Math.floor(now / size) * size;
	const count = Math.max(1, Math.floor((end - start) / size) + 1);
	return Array.from({ length: count }, (_, index) => start + index * size);
}

export function denseHeatmap(overview: ContextOverview, now = Date.now()) {
	const buckets = heatmapBuckets(overview, now);
	return {
		buckets,
		requests: densify(
			overview.heatmap.map(point => ({ timestamp: point.bucket, value: point.requests })),
			buckets,
			point => point.value,
		),
		promptTokens: densify(
			overview.heatmap.map(point => ({ timestamp: point.bucket, value: point.promptTokens })),
			buckets,
			point => point.value,
		),
	};
}

export function eventKinds(events: readonly ContextEvent[]): string[] {
	return [...new Set(events.map(event => event.kind))].sort();
}

export function filterContextEvents(events: readonly ContextEvent[], kinds: readonly string[]): ContextEvent[] {
	if (kinds.length === 0) return [...events];
	return events.filter(event => kinds.includes(event.kind));
}

export function sortFiles(
	files: readonly ContextFileActivity[],
	sort: keyof ContextFileActivity = "lastTimestamp",
	direction: "asc" | "desc" = "desc",
) {
	return [...files].sort((a, b) => {
		const left = a[sort];
		const right = b[sort];
		if (typeof left === "number" && typeof right === "number") return (left - right) * (direction === "asc" ? 1 : -1);
		return String(left).localeCompare(String(right)) * (direction === "asc" ? 1 : -1);
	});
}
