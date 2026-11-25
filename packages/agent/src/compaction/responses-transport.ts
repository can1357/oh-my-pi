import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { withResolvedHeaders } from "@oh-my-pi/pi-ai/utils/model-headers";
import { isBedrockOpenAIUrl } from "@oh-my-pi/pi-catalog/hosts";
import { prepareBedrockCompactionRequest } from "./bedrock";

interface ResponsesCompactionTransport {
	model: Model;
	apiKey: string;
	fetch: FetchImpl;
}

/** Resolve headers once. Put the live guard below retries, compression and Bedrock signing. */
export async function prepareResponsesCompactionTransport(
	model: Model,
	apiKey: string,
	fetchImpl: FetchImpl | undefined,
	signal: AbortSignal | undefined,
	beforeDispatch: (() => void) | undefined,
): Promise<ResponsesCompactionTransport> {
	model = await withResolvedHeaders(model, signal);
	const base = fetchImpl ?? globalThis.fetch;
	const guarded: FetchImpl = beforeDispatch
		? (input, init) => {
				beforeDispatch();
				return base(input, init);
			}
		: base;
	if (isBedrockOpenAIUrl(model.baseUrl)) return prepareBedrockCompactionRequest(model, apiKey, guarded, signal);
	return { model, apiKey, fetch: guarded };
}
