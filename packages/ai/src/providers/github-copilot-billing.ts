import type { Usage } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "../utils";

type CopilotAiu = NonNullable<Usage["aiu"]>;
type CopilotAiuByType = NonNullable<CopilotAiu["nanoByType"]>;

const TOKEN_TYPE_KEYS: Readonly<Record<string, keyof CopilotAiuByType>> = {
	input: "input",
	cache_read: "cacheRead",
	cache_write: "cacheWrite",
	output: "output",
};

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Parse the `copilot_usage` billing frame GitHub Copilot attaches to terminal
 * SSE events (`message_delta` on Messages, `response.completed` on Responses).
 * Returns undefined unless the frame carries a valid `total_nano_aiu`: a
 * missing or malformed frame is unknown, never zero.
 */
export function parseCopilotUsageFrame(frame: unknown): CopilotAiu | undefined {
	if (!isRecord(frame)) return undefined;
	const nano = finiteNonNegative(frame.total_nano_aiu);
	if (nano === undefined) return undefined;
	const aiu: CopilotAiu = { nano };
	if (!Array.isArray(frame.token_details)) return aiu;
	const nanoByType: CopilotAiuByType = {};
	for (const row of frame.token_details) {
		if (!isRecord(row) || typeof row.token_type !== "string") continue;
		const key = TOKEN_TYPE_KEYS[row.token_type];
		const count = finiteNonNegative(row.token_count);
		const perBatch = finiteNonNegative(row.cost_per_batch);
		const batchSize = finiteNonNegative(row.batch_size);
		if (key === undefined || count === undefined || perBatch === undefined || !batchSize) continue;
		nanoByType[key] = (nanoByType[key] ?? 0) + (count * perBatch) / batchSize;
	}
	if (Object.keys(nanoByType).length > 0) aiu.nanoByType = nanoByType;
	return aiu;
}

/**
 * Record the billing frame carried by a terminal SSE event on `usage`. Leaves
 * `usage.aiu` untouched when the event has no valid
 * `copilot_usage` field.
 */
export function applyCopilotUsageFrame(usage: Usage, event: unknown): void {
	if (!isRecord(event)) return;
	const aiu = parseCopilotUsageFrame(event.copilot_usage);
	if (aiu) usage.aiu = aiu;
}
