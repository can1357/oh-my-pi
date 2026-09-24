import type { Model, Usage } from "../types";

const NANO_AIU_PER_AIU = 1_000_000_000;

/** Stream payload that may carry GitHub Copilot's server-reported billing block. */
export interface CopilotUsageCarrier {
	copilot_usage?: unknown;
}

/**
 * Record GitHub Copilot's authoritative per-response AI-unit charge.
 *
 * Copilot attaches `copilot_usage` beside the standard usage object: on the
 * Responses terminal event, the final Chat Completions chunk, and Anthropic's
 * `message_delta` event. Store it in `usage.aiu`; `cost` and
 * `premiumRequests` stay as computed.
 * Missing or malformed payloads leave `aiu` unset (unknown, not zero).
 */
export function applyCopilotUsage(model: Pick<Model, "provider">, usage: Usage, copilotUsage: unknown): void {
	if (model.provider !== "github-copilot" || typeof copilotUsage !== "object" || copilotUsage === null) return;
	const totalNanoAiu = Reflect.get(copilotUsage, "total_nano_aiu");
	if (typeof totalNanoAiu !== "number" || !Number.isFinite(totalNanoAiu) || totalNanoAiu < 0) return;
	usage.aiu = totalNanoAiu / NANO_AIU_PER_AIU;
}
