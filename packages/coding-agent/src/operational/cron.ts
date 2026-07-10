/**
 * Standard 5-field cron helpers (minute hour day-of-month month day-of-week).
 *
 * Supports `*`, lists, ranges, and steps. Day-of-month / day-of-week use
 * classic Unix OR semantics when both fields are restricted (not `*`).
 * All next-occurrence math is UTC.
 */

/** Default scan horizon (~4 years) when searching for the next fire time. */
export const DEFAULT_CRON_HORIZON_MS = 4 * 365 * 24 * 60 * 60 * 1000;

export class CronValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CronValidationError";
	}
}

export class CronHorizonError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CronHorizonError";
	}
}

interface CronField {
	readonly raw: string;
	readonly unrestricted: boolean;
	readonly values: ReadonlySet<number>;
}

export interface ParsedCron {
	readonly minute: CronField;
	readonly hour: CronField;
	readonly dayOfMonth: CronField;
	readonly month: CronField;
	readonly dayOfWeek: CronField;
}

function parseNumber(token: string, min: number, max: number, label: string): number {
	if (!/^\d+$/.test(token)) {
		throw new CronValidationError(`invalid ${label} value '${token}'`);
	}
	const value = Number(token);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new CronValidationError(`${label} out of bounds: ${value} (expected ${min}-${max})`);
	}
	return value;
}

function parseField(raw: string, min: number, max: number, label: string): CronField {
	const field = raw.trim();
	if (!field) {
		throw new CronValidationError(`empty ${label} field`);
	}
	if (field === "*") {
		const values = new Set<number>();
		for (let i = min; i <= max; i += 1) values.add(i);
		return { raw: field, unrestricted: true, values };
	}

	const values = new Set<number>();
	for (const part of field.split(",")) {
		const piece = part.trim();
		if (!piece) {
			throw new CronValidationError(`empty list entry in ${label}`);
		}

		const slash = piece.split("/");
		const rangePart = slash[0] ?? "";
		const stepPart = slash.length > 1 ? slash[1] : undefined;
		if (!rangePart) {
			throw new CronValidationError(`invalid ${label} entry '${piece}'`);
		}
		if (piece.includes("/") && (stepPart === undefined || stepPart === "")) {
			throw new CronValidationError(`invalid step in ${label} entry '${piece}'`);
		}
		if (slash.length > 2) {
			throw new CronValidationError(`invalid ${label} entry '${piece}'`);
		}

		let step = 1;
		if (stepPart !== undefined) {
			step = parseNumber(stepPart, 1, max - min + 1, `${label} step`);
		}

		let start: number;
		let end: number;
		if (rangePart === "*") {
			start = min;
			end = max;
		} else if (rangePart.includes("-")) {
			const bits = rangePart.split("-");
			if (bits.length !== 2 || !bits[0] || !bits[1]) {
				throw new CronValidationError(`invalid ${label} range '${rangePart}'`);
			}
			start = parseNumber(bits[0], min, max, label);
			end = parseNumber(bits[1], min, max, label);
			if (start > end) {
				throw new CronValidationError(`invalid ${label} range ${start}-${end}`);
			}
		} else {
			start = parseNumber(rangePart, min, max, label);
			end = stepPart !== undefined ? max : start;
		}

		for (let value = start; value <= end; value += step) {
			values.add(value);
		}
	}

	if (values.size === 0) {
		throw new CronValidationError(`${label} matched no values`);
	}

	return { raw: field, unrestricted: false, values };
}

function normalizeDayOfWeek(field: CronField): CronField {
	if (!field.values.has(7)) return field;
	const values = new Set(field.values);
	values.delete(7);
	values.add(0);
	return { raw: field.raw, unrestricted: field.unrestricted, values };
}

/** Parse and validate a standard 5-field cron expression. */
export function parseCron(expression: string): ParsedCron {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new CronValidationError(`expected 5 cron fields, got ${parts.length} in '${expression.trim()}'`);
	}
	const minuteRaw = parts[0];
	const hourRaw = parts[1];
	const domRaw = parts[2];
	const monthRaw = parts[3];
	const dowRaw = parts[4];
	if (!minuteRaw || !hourRaw || !domRaw || !monthRaw || !dowRaw) {
		throw new CronValidationError(`invalid cron expression '${expression.trim()}'`);
	}

	return {
		minute: parseField(minuteRaw, 0, 59, "minute"),
		hour: parseField(hourRaw, 0, 23, "hour"),
		dayOfMonth: parseField(domRaw, 1, 31, "day-of-month"),
		month: parseField(monthRaw, 1, 12, "month"),
		dayOfWeek: normalizeDayOfWeek(parseField(dowRaw, 0, 7, "day-of-week")),
	};
}

/** Validate a cron expression; throws {@link CronValidationError} on failure. */
export function validateCron(expression: string): void {
	parseCron(expression);
}

function matchesDate(cron: ParsedCron, date: Date): boolean {
	if (!cron.minute.values.has(date.getUTCMinutes())) return false;
	if (!cron.hour.values.has(date.getUTCHours())) return false;
	if (!cron.month.values.has(date.getUTCMonth() + 1)) return false;

	const domMatch = cron.dayOfMonth.values.has(date.getUTCDate());
	const dowMatch = cron.dayOfWeek.values.has(date.getUTCDay());

	if (cron.dayOfMonth.unrestricted && cron.dayOfWeek.unrestricted) return true;
	if (cron.dayOfMonth.unrestricted) return dowMatch;
	if (cron.dayOfWeek.unrestricted) return domMatch;
	// Standard Unix semantics: when both day fields are restricted, OR them.
	return domMatch || dowMatch;
}

/**
 * Next UTC occurrence strictly after `afterMs`, scanning at most `horizonMs`.
 * Throws {@link CronValidationError} for bad expressions and
 * {@link CronHorizonError} when nothing matches inside the horizon.
 */
export function getNextOccurrenceUtc(
	expression: string,
	afterMs: number,
	horizonMs: number = DEFAULT_CRON_HORIZON_MS,
): number {
	if (!Number.isFinite(afterMs)) {
		throw new CronValidationError("afterMs must be a finite epoch millisecond");
	}
	if (!Number.isFinite(horizonMs) || horizonMs <= 0) {
		throw new CronValidationError("horizonMs must be a positive finite duration");
	}

	const cron = parseCron(expression);
	const startMinute = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
	const deadline = afterMs + horizonMs;

	for (let ts = startMinute; ts <= deadline; ts += 60_000) {
		const date = new Date(ts);
		if (matchesDate(cron, date)) return ts;
	}

	throw new CronHorizonError(`no occurrence of '${expression.trim()}' within horizon ${horizonMs}ms after ${afterMs}`);
}
