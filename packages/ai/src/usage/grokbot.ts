import { createGrokbotRpcClient, GrokbotRpcError } from "@oh-my-pi/pi-catalog/discovery/grokbot-rpc";
import type { Provider } from "../types";
import type { UsageFetchContext, UsageFetchParams, UsageProvider, UsageReport } from "../usage";
import { isRecord } from "../utils";
import { parseIsoTimestamp, usageStatus } from "./shared";

const USAGE_PATH = "/aiserver.v1.DashboardService/GetSandUsageStatus";
const ALLOWANCE_NOTE =
	"Sand allowance is separate from Cursor model limits; available allowance and catalog visibility do not prove access to a model or inference transport.";

/** Preserve the server's USED percentage; do not invert it or infer model entitlement. */
export function parseGrokbotUsage(
	payload: unknown,
	provider: Provider = "grokbot",
	now = Date.now(),
	sharedGroup?: string,
): UsageReport | null {
	if (!isRecord(payload)) return null;
	const used =
		typeof payload.usagePercent === "number" && Number.isFinite(payload.usagePercent) && payload.usagePercent >= 0
			? payload.usagePercent
			: undefined;
	const available = typeof payload.hasAvailableUsage === "boolean" ? payload.hasAvailableUsage : undefined;
	if (used === undefined && available === undefined) return null;
	const fraction = used === undefined ? undefined : used / 100;
	const resetsAt = parseIsoTimestamp(payload.nextResetTimestampUtc);
	const plan = typeof payload.grokPlanLabel === "string" ? payload.grokPlanLabel : undefined;
	const resetCount =
		typeof payload.availableBankedResetCount === "number" &&
		Number.isSafeInteger(payload.availableBankedResetCount) &&
		payload.availableBankedResetCount >= 0
			? payload.availableBankedResetCount
			: undefined;
	return {
		provider,
		fetchedAt: now,
		limits: [
			{
				id: "grokbot:sand:weekly",
				label: "Sand allowance",
				scope: { provider, tier: plan, windowId: "weekly", shared: true, ...(sharedGroup ? { sharedGroup } : {}) },
				window: { id: "weekly", label: "Weekly", ...(resetsAt !== undefined ? { resetsAt } : {}) },
				amount: {
					unit: "percent",
					...(used === undefined
						? {}
						: {
								used,
								limit: 100,
								remaining: Math.max(0, 100 - used),
								usedFraction: fraction,
								remainingFraction: Math.max(0, 1 - fraction!),
							}),
				},
				status: available === false ? "exhausted" : fraction === undefined ? "unknown" : usageStatus(fraction),
			},
		],
		notes: [ALLOWANCE_NOTE],
		...(resetCount === undefined ? {} : { resetCredits: { availableCount: resetCount } }),
		metadata: {
			...(plan === undefined ? {} : { grokPlanLabel: plan }),
			...(typeof payload.cursorPlanName === "string" ? { cursorPlanName: payload.cursorPlanName } : {}),
			...(available === undefined ? {} : { hasAvailableUsage: available }),
			...(typeof payload.hasNonZeroIncludedLimit === "boolean"
				? { hasNonZeroIncludedLimit: payload.hasNonZeroIncludedLimit }
				: {}),
		},
	};
}

async function fetchGrokbotUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if ((params.provider !== "grokbot" && params.provider !== "grokbot-chat") || params.credential.type !== "api_key")
		return null;
	try {
		const client = await createGrokbotRpcClient({
			apiKey: params.credential.apiKey,
			baseUrl: params.baseUrl,
			fetch: ctx.fetch,
			signal: params.signal,
		});
		return parseGrokbotUsage(await client.rpc(USAGE_PATH), params.provider, Date.now(), client.quotaGroup);
	} catch (error) {
		ctx.logger?.warn("Grok Bot allowance lookup failed", {
			provider: params.provider,
			...(error instanceof GrokbotRpcError ? { status: error.status, code: error.code } : {}),
		});
		return null;
	}
}

export const grokbotUsageProvider: UsageProvider = {
	id: "grokbot",
	fetchUsage: fetchGrokbotUsage,
	validatesCredentials: true,
	retainLastGoodOnFailure: false,
	supports: params => params.credential.type === "api_key",
};

export const grokbotChatUsageProvider: UsageProvider = { ...grokbotUsageProvider, id: "grokbot-chat" };
