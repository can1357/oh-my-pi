import { prepareProviderRequest } from "@oh-my-pi/pi-ai/registry";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { untilAborted } from "@oh-my-pi/pi-utils";

export interface PreparedCompactionRequest {
	model: Model;
	apiKey: string;
	fetch: FetchImpl;
}

/**
 * Shape a compaction request the way a normal turn is shaped: configured
 * headers, transport fetch (proxy, CA, User-Agent, request recording), then
 * provider hooks. The hooks fill Bedrock Mantle's `{region}` and choose its
 * bearer or SigV4 auth, for example.
 */
export async function prepareCompactionRequest(
	model: Model,
	apiKey: string,
	fetch: FetchImpl | undefined,
	signal: AbortSignal | undefined,
): Promise<PreparedCompactionRequest> {
	let resolvedModel = model;
	const resolveHeaders = model.resolveHeaders;
	if (resolveHeaders) {
		const headers = await untilAborted(signal, () => resolveHeaders(signal));
		signal?.throwIfAborted();
		resolvedModel = { ...model, resolveHeaders: undefined, headers: headers ? { ...headers } : undefined };
	}
	const baseFetch = transportFetch(resolvedModel, fetch);
	const prepared = prepareProviderRequest(resolvedModel, { apiKey, fetch: baseFetch, signal });
	return {
		model: { ...prepared.model, headers: { ...prepared.model.headers, ...prepared.options.headers } },
		apiKey: prepared.options.apiKey ?? apiKey,
		fetch: prepared.options.fetch ?? baseFetch,
	};
}
