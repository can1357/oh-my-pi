import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";

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
 * `model.headers` must already be materialized by the auth driver
 * (`withAuth` with `headerResolver: model`), so a 401 can retire the
 * command-backed values this request sent.
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
	const baseFetch = transportFetch(model, fetch);
	const provider = getProviderDefinition(model.provider);
	const providerModel = provider?.prepareModel?.(model) ?? model;
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
