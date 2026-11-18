import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Api, Model } from "../types";

/**
 * Materialize a model's configured header chain for one request. Registered
 * models (models.yml providers, extension `registerProvider` models) carry
 * their headers only in `resolveHeaders`, with `headers` unset, so a request
 * built from `model.headers` alone sends none of them. The returned model has
 * the resolved headers and no resolver, so resolving it again is a no-op.
 */
export async function withResolvedHeaders<TApi extends Api>(
	model: Model<TApi>,
	signal: AbortSignal | undefined,
): Promise<Model<TApi>> {
	const resolveHeaders = model.resolveHeaders;
	if (!resolveHeaders) return model;
	const headers = await untilAborted(signal, () => resolveHeaders(signal));
	signal?.throwIfAborted();
	return { ...model, resolveHeaders: undefined, headers: headers ? { ...headers } : undefined };
}
