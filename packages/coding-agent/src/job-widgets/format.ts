/**
 * Number and trend formatting for job widgets: `186 tok/s`, `5.37 ms`,
 * `12.3k req`, `▲ 15%`.
 */
import type { JobWidgetTrend } from "@oh-my-pi/pi-tui/tools/job-widget";
import type { JobWidgetBetter } from "./spec";

const COMPACT_STEPS: readonly [number, string][] = [
	[1e12, "T"],
	[1e9, "G"],
	[1e6, "M"],
	[1e3, "k"],
];

/** Values from here up print compacted (`12.3k`); smaller ones print in full (`4096`). */
const COMPACT_FROM = 10_000;

/**
 * A number with its unit: auto decimals (≥ 100 → 0, ≥ 10 → 1, else 2)
 * unless `digits` is given, whole numbers without decimals, large values
 * compacted (`12.3k`, `4.5M`). `%` attaches to the number; other units follow
 * a space.
 */
export function formatWidgetNumber(value: number, unit?: string, digits?: number): string {
	if (!Number.isFinite(value)) return "—";
	const magnitude = Math.abs(value);
	let text: string | undefined;
	if (magnitude >= COMPACT_FROM) {
		for (const [step, suffix] of COMPACT_STEPS) {
			if (magnitude < step) continue;
			const scaled = value / step;
			text = `${scaled.toFixed(digits ?? (Math.abs(scaled) >= 100 ? 0 : 1))}${suffix}`;
			break;
		}
	}
	text ??=
		Number.isInteger(value) && digits === undefined
			? String(value)
			: value.toFixed(digits ?? (magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2));
	if (!unit) return text;
	return unit === "%" ? `${text}%` : `${text} ${unit}`;
}

/**
 * How `last` moved from `first`, judged against `better`: `▲ 15%` / `▼ 3.2%`,
 * or the absolute move with its unit when `first` is 0. `success` toward
 * `better`, `error` away from it; `undefined` when nothing moved.
 */
export function formatWidgetTrend(
	first: number,
	last: number,
	better: JobWidgetBetter,
	unit?: string,
): JobWidgetTrend | undefined {
	const delta = last - first;
	if (delta === 0 || !Number.isFinite(delta)) return undefined;
	const arrow = delta > 0 ? "▲" : "▼";
	const toward = delta > 0 === (better === "higher");
	const tone = toward ? "success" : "error";
	if (first === 0) return { text: `${arrow} ${formatWidgetNumber(Math.abs(delta), unit)}`, tone };
	const percent = Math.abs(delta / first) * 100;
	return { text: `${arrow} ${percent.toFixed(percent >= 10 ? 0 : 1)}%`, tone };
}
