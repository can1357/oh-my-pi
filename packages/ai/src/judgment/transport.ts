import { getProviderDefinition } from "../registry/registry";
import type { Api, Model } from "../types";
import type { TypeSafeJudgeOptions } from "./typesafe";

/** Runs the provider transport's `prepareRequest` (gateway URL, auth headers) for a judgment attempt. */
export function judgmentRequestPreparer(
	model: Model<Api>,
	headers: Record<string, string> | undefined,
): TypeSafeJudgeOptions["prepareRequest"] {
	const prepareRequest = getProviderDefinition(model.provider)?.prepareRequest;
	if (prepareRequest === undefined) return undefined;
	return key => {
		const prepared = prepareRequest({ ...model, headers }, { apiKey: key });
		return {
			baseUrl: prepared.model.baseUrl,
			headers: prepared.model.headers,
			apiKey: prepared.options.apiKey ?? key,
		};
	};
}
