import type { Model } from "@oh-my-pi/pi-ai/types";
import { untilAborted } from "@oh-my-pi/pi-utils";

/**
 * Materialize a model's request-time `resolveHeaders` into plain `headers` for
 * one compaction request, the way stream dispatch does for a normal turn, so
 * configured headers (including command-backed ones) reach the wire.
 */
export async function resolveCompactionModelHeaders(model: Model, signal: AbortSignal | undefined): Promise<Model> {
	const resolveHeaders = model.resolveHeaders;
	if (!resolveHeaders) return model;
	const headers = await untilAborted(signal, () => resolveHeaders(signal));
	signal?.throwIfAborted();
	return { ...model, resolveHeaders: undefined, headers: headers ? { ...headers } : undefined };
}
