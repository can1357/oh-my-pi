import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import { isRecord } from "@oh-my-pi/pi-utils";

/** nano-AIU per AI credit. */
export const NANO_AIU_PER_CREDIT = 1e9;

/** A recorded model call: an assistant message or a `model_usage` entry, possibly as a raw transcript record. */
export interface AiuCall {
	provider?: unknown;
	model?: unknown;
	api?: unknown;
	stopReason?: unknown;
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
 * The AI credits one call was charged: nano-AIU when its billing frame arrived, `"unknown"` when its
 * model declares one (`reports-aiu`) and none came, undefined when the model reports no credits or the
 * call ended on an error or abort before any token (it never reached the frame).
 */
export function callAiu(call: AiuCall): number | "unknown" | undefined {
	const { provider, model, api, usage } = call;
	if (typeof provider !== "string" || typeof model !== "string" || typeof api !== "string") return undefined;
	if (!provider || !model || !api || !isRecord(usage)) return undefined;
	if (resolveCatalogPolicy({ provider, id: model, api }).reportsAiu !== true) return undefined;
	const nano = isRecord(usage.aiu) ? usage.aiu.nano : undefined;
	if (typeof nano === "number" && Number.isFinite(nano) && nano >= 0) return nano;
	if ((call.stopReason === "error" || call.stopReason === "aborted") && usage.totalTokens === 0) return undefined;
	return "unknown";
}

/** Add one call's {@link callAiu} to `totals` in place. */
export function addCallAiu(totals: AiuTotals, aiu: number | "unknown" | undefined): void {
	if (aiu === "unknown") totals.unknownCalls++;
	else if (aiu !== undefined) totals.nano += aiu;
}

/** A session's credits: its own calls plus its subagent tree's; undefined while no call reported or missed one. */
export function sessionAiu(direct: AiuTotals, tree: AiuTotals | undefined): AiuTotals | undefined {
	const nano = direct.nano + (tree?.nano ?? 0);
	const unknownCalls = direct.unknownCalls + (tree?.unknownCalls ?? 0);
	return nano > 0 || unknownCalls > 0 ? { nano, unknownCalls } : undefined;
}

/** AI credits at `digits` decimals; a trailing `+` marks a lower bound (calls without a billing frame). */
export function formatAiuCredits(aiu: AiuTotals, digits: number): string {
	return `${(aiu.nano / NANO_AIU_PER_CREDIT).toFixed(digits)}${aiu.unknownCalls > 0 ? "+" : ""}`;
}
