import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import { isRecord } from "@oh-my-pi/pi-utils";

/** The model call a usage record belongs to. */
export interface AiuBillingRequest {
	provider?: string;
	model?: string;
	api?: string;
	stopReason?: string;
}

/** Whether the request's model declares a server-side AI-credit frame (`reports-aiu`). */
export function declaresAiuBilling(request: AiuBillingRequest): boolean {
	const { provider, model, api } = request;
	if (!provider || !model || !api) return false;
	return resolveCatalogPolicy({ provider, id: model, api }).reportsAiu === true;
}

/** Whether `usage` lacks the server-side AI-credit frame its model declares (`reports-aiu`): unknown spend, not free. */
export function isMissingAiuBillingFrame(request: AiuBillingRequest, usage: unknown): boolean {
	if (!isRecord(usage) || usage.aiu !== undefined) return false;
	if (request.stopReason === "error" && usage.totalTokens === 0) return false;
	return declaresAiuBilling(request);
}
