import { isRecord } from "@oh-my-pi/pi-utils";

/** nano-AIU per AI credit. */
export const NANO_AIU_PER_CREDIT = 1e9;

/** A recorded model call: an assistant message or a `model_usage` entry, possibly as a raw transcript record. */
export interface AiuCall {
	usage?: unknown;
}

/** Server-reported AI credits over a set of calls. */
export interface AiuTotals {
	/** Reported charge in nano-AIU (1e9 = 1 credit). */
	nano: number;
	/** Calls whose model declares a billing frame (`reports-aiu`) that never arrived; positive makes `nano` a lower bound. */
	unknownCalls: number;
}

/**
 * The AI credits one call was charged: nano-AIU when its billing frame arrived, `"unknown"` when the
 * transport recorded the frame as missing (`usage.aiuMissing`), undefined otherwise: the model reports
 * no credits, the call failed before any token, or the transcript predates the frame.
 */
export function callAiu(call: AiuCall): number | "unknown" | undefined {
	const usage = call.usage;
	if (!isRecord(usage)) return undefined;
	const nano = isRecord(usage.aiu) ? usage.aiu.nano : undefined;
	if (typeof nano === "number" && Number.isFinite(nano) && nano >= 0) return nano;
	return usage.aiuMissing === true ? "unknown" : undefined;
}

/** Add one call's {@link callAiu} to `totals` in place. */
export function addCallAiu(totals: AiuTotals, aiu: number | "unknown" | undefined): void {
	if (aiu === "unknown") totals.unknownCalls++;
	else if (aiu !== undefined) totals.nano += aiu;
}

/** Credits summed over lanes (own calls, subagent tree, advisors); undefined while no call reported or missed one. */
export function sessionAiu(...parts: readonly (AiuTotals | undefined)[]): AiuTotals | undefined {
	let nano = 0;
	let unknownCalls = 0;
	for (const part of parts) {
		nano += part?.nano ?? 0;
		unknownCalls += part?.unknownCalls ?? 0;
	}
	return nano > 0 || unknownCalls > 0 ? { nano, unknownCalls } : undefined;
}

/** AI credits at `digits` decimals; a trailing `+` marks a lower bound (calls without a billing frame). */
export function formatAiuCredits(aiu: AiuTotals, digits: number): string {
	return `${(aiu.nano / NANO_AIU_PER_CREDIT).toFixed(digits)}${aiu.unknownCalls > 0 ? "+" : ""}`;
}
