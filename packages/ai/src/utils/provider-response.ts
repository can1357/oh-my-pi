import type { Api, Model, ProviderResponseMetadata, StreamOptions } from "../types";

export function normalizeProviderResponse(
	response: Response,
	requestId?: string | null,
	metadata?: Record<string, unknown>,
): ProviderResponseMetadata {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});
	const providerResponse: ProviderResponseMetadata = {
		status: response.status,
		headers,
	};
	if (requestId !== undefined) providerResponse.requestId = requestId;
	if (metadata !== undefined) providerResponse.metadata = metadata;
	return providerResponse;
}

export async function notifyProviderResponse(
	options: Pick<StreamOptions, "onResponse"> | undefined,
	response: Response,
	model?: Model<Api>,
	requestId?: string | null,
	metadata?: Record<string, unknown>,
): Promise<void> {
	if (!options?.onResponse) return;
	await options.onResponse(normalizeProviderResponse(response, requestId, metadata), model);
}
