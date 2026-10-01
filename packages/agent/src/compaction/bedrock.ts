import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { untilAborted } from "@oh-my-pi/pi-utils";

export interface BedrockCompactionRequest {
	model: Model;
	apiKey: string;
	fetch: FetchImpl;
}

/**
 * Shape a native compaction request for Amazon Bedrock's OpenAI routes
 * (`isBedrockOpenAIUrl`) the way stream dispatch shapes a normal Bedrock turn:
 * configured headers, transport fetch (proxy, CA, User-Agent, request
 * recording), then the provider's model and request hooks. The bundled
 * `bedrock-mantle` provider's hook fills in `{region}` and picks bearer or
 * SigV4 auth; without it compaction targets an unresolved host.
 *
 * Only Bedrock requests come through here; other providers' compaction
 * requests keep their own transport.
 */
export async function prepareBedrockCompactionRequest(
	model: Model,
	apiKey: string,
	fetch: FetchImpl | undefined,
	signal: AbortSignal | undefined,
): Promise<BedrockCompactionRequest> {
	let resolvedModel = model;
	const resolveHeaders = model.resolveHeaders;
	if (resolveHeaders) {
		const headers = await untilAborted(signal, () => resolveHeaders(signal));
		signal?.throwIfAborted();
		resolvedModel = { ...model, resolveHeaders: undefined, headers: headers ? { ...headers } : undefined };
	}
	const baseFetch = transportFetch(resolvedModel, fetch);
	const provider = getProviderDefinition(resolvedModel.provider);
	const providerModel = provider?.prepareModel?.(resolvedModel) ?? resolvedModel;
	const prepared = provider?.prepareRequest?.(providerModel, { apiKey, fetch: baseFetch, signal }) ?? {
		model: providerModel,
		options: { apiKey, fetch: baseFetch },
	};
	return {
		model: { ...prepared.model, headers: { ...prepared.model.headers, ...prepared.options.headers } },
		apiKey: prepared.options.apiKey || apiKey,
		fetch: prepared.options.fetch ?? baseFetch,
	};
}
