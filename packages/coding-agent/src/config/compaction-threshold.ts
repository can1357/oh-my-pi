import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * One `task.agentCompactionThresholdOverrides` entry: a positive token count
 * (`90000`) or a percentage string (`"80%"`). `null` clears an entry inherited
 * from a lower-priority settings layer.
 */
export type AgentCompactionThresholdOverride = number | string | null;

/** Both compaction threshold fields, as consumed by `compaction.thresholdPercent`/`compaction.thresholdTokens`. */
export interface CompactionThresholdPair {
	thresholdPercent: number;
	thresholdTokens: number;
}

const PERCENT_PATTERN = /^(\d+(?:\.\d+)?)%$/;

function parseEntry(agentName: string, entry: unknown): CompactionThresholdPair {
	if (typeof entry === "number") {
		if (Number.isSafeInteger(entry) && entry > 0) return { thresholdPercent: -1, thresholdTokens: entry };
	} else if (typeof entry === "string") {
		const match = PERCENT_PATTERN.exec(entry.trim());
		const percent = match ? Number(match[1]) : Number.NaN;
		if (percent > 0 && percent <= 100) return { thresholdPercent: percent, thresholdTokens: -1 };
	}
	const received = Array.isArray(entry) ? "an array" : typeof entry === "string" ? `"${entry}"` : String(entry);
	throw new Error(
		`Invalid task.agentCompactionThresholdOverrides.${agentName}: expected a positive integer token count (e.g. 90000) or a percentage in (0, 100] (e.g. "80%"), got ${received}.`,
	);
}

/** Validate the exact-agent compaction threshold map and normalize each entry to both threshold fields. */
export function validateAgentCompactionThresholdOverrides(value: unknown): Record<string, CompactionThresholdPair> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		const received = Array.isArray(value) ? "an array" : `a ${typeof value}`;
		throw new Error(
			`Invalid task.agentCompactionThresholdOverrides: expected a map of agent name to token count or percentage, got ${received}.`,
		);
	}

	const overrides: Record<string, CompactionThresholdPair> = {};
	for (const [agentName, entry] of Object.entries(value)) {
		if (entry === null) continue;
		overrides[agentName] = parseEntry(agentName, entry);
	}
	return overrides;
}
