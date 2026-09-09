export type MemoryType = keyof typeof WEIBULL_PARAMS;

export interface WeibullParams {
	readonly k: number;
	readonly eta: number;
}

// Per-memory-type Weibull parameters (k=shape, eta=scale in hours).
// Higher eta = slower decay, lower k = more long-term retention.
export const WEIBULL_PARAMS = {
	profile: { k: 0.3, eta: 8760.0 },
	preference: { k: 0.4, eta: 4380.0 },
	relationship: { k: 0.35, eta: 8760.0 },
	learning: { k: 0.7, eta: 1440.0 },

	fact: { k: 0.8, eta: 720.0 },
	entity: { k: 0.5, eta: 4380.0 },
	setup: { k: 0.6, eta: 2160.0 },
	pattern: { k: 0.6, eta: 1680.0 },
	context: { k: 0.85, eta: 360.0 },
	observation: { k: 0.9, eta: 480.0 },
	artifact: { k: 0.75, eta: 2160.0 },

	project: { k: 0.85, eta: 1080.0 },
	goal: { k: 0.9, eta: 720.0 },
	decision: { k: 1.0, eta: 336.0 },
	commitment: { k: 1.0, eta: 240.0 },

	event: { k: 1.2, eta: 168.0 },
	instruction: { k: 0.9, eta: 480.0 },
	error: { k: 1.1, eta: 336.0 },
	issue: { k: 1.1, eta: 336.0 },
	request: { k: 1.5, eta: 72.0 },

	general: { k: 1.0, eta: 168.0 },
} as const satisfies Record<string, WeibullParams>;

export const DEFAULT_HALFLIFE_HOURS = 168.0;

type TimestampInput = string | Date | null | undefined;
function capture(match: RegExpExecArray, index: number): string {
	return match[index] ?? "";
}

function parseTimestamp(timestamp: TimestampInput): Date | null {
	if (timestamp == null) return null;
	if (timestamp instanceof Date) {
		return Number.isFinite(timestamp.getTime()) ? timestamp : null;
	}

	if (typeof timestamp !== "string") return null;

	const normalized = timestamp.replace("Z", "+00:00");
	const parsed = new Date(normalized);
	if (Number.isFinite(parsed.getTime())) return parsed;

	const truncated = normalized.slice(0, 26);
	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(truncated);
	if (dateOnly !== null) {
		const year = Number(capture(dateOnly, 1));
		const month = Number(capture(dateOnly, 2));
		const day = Number(capture(dateOnly, 3));
		const date = new Date(year, month - 1, day);
		return Number.isFinite(date.getTime()) ? date : null;
	}

	const dateTime = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/.exec(truncated);
	if (dateTime === null) return null;

	const millis = Number(capture(dateTime, 7).padEnd(3, "0").slice(0, 3));
	const date = new Date(
		Number(capture(dateTime, 1)),
		Number(capture(dateTime, 2)) - 1,
		Number(capture(dateTime, 3)),
		Number(capture(dateTime, 4)),
		Number(capture(dateTime, 5)),
		Number(capture(dateTime, 6)),
		millis,
	);
	return Number.isFinite(date.getTime()) ? date : null;
}

function paramsFor(memoryType: string): WeibullParams | undefined {
	return WEIBULL_PARAMS[memoryType as MemoryType];
}

export function weibullBoost(
	timestamp: TimestampInput,
	queryTime: Date | null = new Date(),
	memoryType = "general",
	halflifeHours?: number | null,
): number {
	const memoryTime = parseTimestamp(timestamp);
	const resolvedQueryTime = queryTime ?? new Date();
	if (memoryTime === null || !Number.isFinite(resolvedQueryTime.getTime())) return 0.0;

	const ageHours = (resolvedQueryTime.getTime() - memoryTime.getTime()) / 3_600_000.0;
	if (ageHours < 0) return 1.0;

	if (halflifeHours != null) {
		if (halflifeHours <= 0) return 0.0;
		return Math.exp(-ageHours / halflifeHours);
	}

	const params = paramsFor(memoryType);
	if (params === undefined) {
		return Math.exp(-ageHours / DEFAULT_HALFLIFE_HOURS);
	}

	if (params.eta <= 0) return 0.0;
	return Math.exp(-((ageHours / params.eta) ** params.k));
}

export function weibullDecayFactor(ageHours: number, memoryType = "general"): number {
	if (ageHours <= 0) return 1.0;

	const params = paramsFor(memoryType);
	if (params === undefined) {
		return Math.exp(-ageHours / DEFAULT_HALFLIFE_HOURS);
	}

	if (params.eta <= 0) return 0.0;
	return Math.exp(-((ageHours / params.eta) ** params.k));
}
