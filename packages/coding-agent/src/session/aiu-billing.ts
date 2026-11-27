import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import { isRecord } from "@oh-my-pi/pi-utils";

/** The model call a usage record belongs to. */
export interface AiuBillingRequest {
	provider?: string;
	model?: string;
	api?: string;
	stopReason?: string;
}

/**
 * Whether a turn written at `timestamp` was copied into a fork before it reset its inherited billing
 * (`SessionHeader.billingResetAt`): its charge was stripped on purpose and belongs to the parent.
 */
export function isInheritedBilling(
	billingResetAt: number | undefined,
	timestamp: number | string | undefined,
): boolean {
	if (billingResetAt === undefined || timestamp === undefined) return false;
	const at = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
	return Number.isFinite(at) && at <= billingResetAt;
}

/**
 * Whether `usage` lacks the server-side AI-credit frame its model declares (`reports-aiu`): unknown spend, not free.
 * A turn that ended before any token (a failed request, or one aborted before the first byte) never reached the frame.
 */
export function isMissingAiuBillingFrame(request: AiuBillingRequest, usage: unknown): boolean {
	const { provider, model, api } = request;
	if (!provider || !model || !api || !isRecord(usage) || usage.aiu !== undefined) return false;
	if ((request.stopReason === "error" || request.stopReason === "aborted") && usage.totalTokens === 0) return false;
	return resolveCatalogPolicy({ provider, id: model, api }).reportsAiu === true;
}
