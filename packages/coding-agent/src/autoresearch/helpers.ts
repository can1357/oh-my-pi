import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { ASIData, ASIValue, MetricDirection, NumericMetricMap } from "./types";

export const METRIC_LINE_PREFIX = "METRIC";
export const ASI_LINE_PREFIX = "ASI";
export const EXPERIMENT_MAX_LINES = 10;
export const EXPERIMENT_MAX_BYTES = 4 * 1024;

const DENIED_KEY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function parseMetricLines(output: string): Map<string, number> {
	const metrics = new Map<string, number>();
	const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ-]+)=(\\S+)\\s*$`, "gm");
	let match = regex.exec(output);
	while (match !== null) {
		const name = match[1];
		if (!DENIED_KEY_NAMES.has(name)) {
			const value = Number(match[2]);
			if (Number.isFinite(value)) {
				metrics.set(name, value);
			}
		}
		match = regex.exec(output);
	}
	return metrics;
}

export function parseAsiLines(output: string): ASIData | null {
	const asi: ASIData = {};
	const regex = new RegExp(`^${ASI_LINE_PREFIX}\\s+([\\w.-]+)=(.+)\\s*$`, "gm");
	let match = regex.exec(output);
	while (match !== null) {
		const key = match[1];
		if (!DENIED_KEY_NAMES.has(key)) {
			asi[key] = parseAsiValue(match[2]);
		}
		match = regex.exec(output);
	}
	return Object.keys(asi).length > 0 ? asi : null;
}

function parseAsiValue(raw: string): ASIValue {
	const value = raw.trim();
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;
	if (/^-?\d+(?:\.\d+)?$/.test(value)) {
		const numberValue = Number(value);
		if (Number.isFinite(numberValue)) return numberValue;
	}
	if (value.startsWith("{") || value.startsWith("[") || value.startsWith('"')) {
		try {
			const parsed = JSON.parse(value) as ASIValue;
			return parsed;
		} catch {
			return value;
		}
	}
	return value;
}

export function mergeAsi(base: ASIData | null, override: ASIData | undefined): ASIData | undefined {
	if (!base && !override) return undefined;
	return {
		...base,
		...override,
	};
}

export function commas(value: number): string {
	const sign = value < 0 ? "-" : "";
	const digits = String(Math.trunc(Math.abs(value)));
	const groups: string[] = [];
	for (let index = digits.length; index > 0; index -= 3) {
		groups.unshift(digits.slice(Math.max(0, index - 3), index));
	}
	return sign + groups.join(",");
}

export function fmtNum(value: number, decimals: number = 0): string {
	if (decimals <= 0) return commas(Math.round(value));
	const absolute = Math.abs(value);
	const whole = Math.floor(absolute);
	const fraction = (absolute - whole).toFixed(decimals).slice(1);
	return `${value < 0 ? "-" : ""}${commas(whole)}${fraction}`;
}

export function formatNum(value: number | null, unit: string): string {
	if (value === null) return "-";
	if (Number.isInteger(value)) return `${fmtNum(value)}${unit}`;
	return `${fmtNum(value, 2)}${unit}`;
}

export function formatElapsed(milliseconds: number): string {
	const totalSeconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) {
		return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	}
	return `${seconds}s`;
}

export function killTree(pid: number, signal: NodeJS.Signals | number = "SIGTERM"): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Process already exited.
		}
	}
}

export function isBetter(current: number, best: number, direction: MetricDirection): boolean {
	return direction === "lower" ? current < best : current > best;
}

export function inferMetricUnitFromName(name: string): string {
	if (name.endsWith("µs") || name.endsWith("_µs")) return "µs";
	if (name.endsWith("ms") || name.endsWith("_ms")) return "ms";
	if (name.endsWith("_s") || name.endsWith("_sec") || name.endsWith("_secs")) return "s";
	if (name.endsWith("_kb") || name.endsWith("kb")) return "kb";
	if (name.endsWith("_mb") || name.endsWith("mb")) return "mb";
	return "";
}

export function normalizePathSpec(value: string): string {
	const trimmed = value.trim().replaceAll("\\", "/");
	if (trimmed === "" || trimmed === "." || trimmed === "./") return ".";
	const collapsed = trimmed.replace(/^\.\/+/, "").replace(/\/+$/, "");
	return collapsed.length === 0 ? "." : collapsed;
}

export function pathMatchesSpec(pathValue: string, specValue: string): boolean {
	const normalizedPath = normalizePathSpec(pathValue);
	const normalizedSpec = normalizePathSpec(specValue);
	if (normalizedSpec === ".") return true;
	return normalizedPath === normalizedSpec || normalizedPath.startsWith(`${normalizedSpec}/`);
}

export function dedupeStrings(values: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const trimmed = value.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

export function ensureNumericMetricMap(value: NumericMetricMap | undefined): NumericMetricMap {
	if (!value) return {};
	const out: NumericMetricMap = {};
	for (const [key, entryValue] of Object.entries(value)) {
		if (DENIED_KEY_NAMES.has(key)) continue;
		if (typeof entryValue === "number" && Number.isFinite(entryValue)) {
			out[key] = entryValue;
		}
	}
	return out;
}

export function sanitizeAsi(value: { [key: string]: unknown } | undefined): ASIData | undefined {
	if (!value) return undefined;
	const result: ASIData = {};
	for (const [key, entryValue] of Object.entries(value)) {
		if (DENIED_KEY_NAMES.has(key)) continue;
		const sanitized = sanitizeAsiValue(entryValue);
		if (sanitized !== undefined) {
			result[key] = sanitized;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeAsiValue(value: unknown): ASIValue | undefined {
	if (value === null) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) {
		const items = value
			.map(item => sanitizeAsiValue(item))
			.filter((item): item is NonNullable<typeof item> => item !== undefined);
		return items;
	}
	if (typeof value === "object") {
		const objectValue = value as { [key: string]: unknown };
		const result: ASIData = {};
		for (const [key, entryValue] of Object.entries(objectValue)) {
			if (DENIED_KEY_NAMES.has(key)) continue;
			const sanitized = sanitizeAsiValue(entryValue);
			if (sanitized !== undefined) {
				result[key] = sanitized;
			}
		}
		return result;
	}
	return undefined;
}

export async function tryGitStatus(cwd: string): Promise<string> {
	try {
		return await vcs.require(cwd).statusPorcelain({ untracked: "all", nulTerminated: true });
	} catch {
		return "";
	}
}

export async function tryGitPrefix(cwd: string): Promise<string> {
	try {
		return vcs.require(cwd).prefixOf(cwd) ?? "";
	} catch {
		return "";
	}
}
