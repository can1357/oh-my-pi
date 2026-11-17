import type { Model } from "@oh-my-pi/pi-ai/types";
import { untilAborted } from "@oh-my-pi/pi-utils";

/**
 * Materialize a model's configured header chain for one compaction request,
 * as stream dispatch does for a turn. Registered models (models.yml providers,
 * extension `registerProvider` models) carry their headers only in
 * `resolveHeaders`, with `headers` unset, so a request built from
 * `model.headers` alone sends none of them.
 */
export async function withResolvedHeaders(model: Model, signal: AbortSignal | undefined): Promise<Model> {
	const resolveHeaders = model.resolveHeaders;
	if (!resolveHeaders) return model;
	const headers = await untilAborted(signal, () => resolveHeaders(signal));
	signal?.throwIfAborted();
	return { ...model, resolveHeaders: undefined, headers: headers ? { ...headers } : undefined };
}
