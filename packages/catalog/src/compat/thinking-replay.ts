/**
 * How a reader bills a replayed signed thinking block as input, from the
 * `thinking-replay-tokens` rules in the compat cascade. A model line's lineage
 * rule (`rules/classes/*.kdl`) applies on every host; readers without one are
 * estimated from the signature's bytes.
 */
import { classifyModel } from "../identity";
import { resolveCascade } from "./cascade";
import type { ImageTokenizationTarget } from "./image-tokenization";

/**
 * `output`: the reasoning the signature carries, at the size its turn billed
 * as output; the signature's own bytes are free. `signature`: the signature's
 * bytes stand in for that reasoning.
 */
export type ThinkingReplayTokens = "output" | "signature";

/** How `reader` bills replayed thinking; `signature` unless its lineage declares otherwise. */
export function resolveThinkingReplayTokens(reader: ImageTokenizationTarget): ThinkingReplayTokens {
	const provider = reader.provider ?? "";
	const model = reader.id ?? "";
	const identity = reader.identity ?? (model ? classifyModel(provider, model, { lenient: true }) : undefined);
	const tokens = resolveCascade({
		provider,
		api: reader.api ?? "",
		class: identity?.class ?? "unknown",
		model,
		reasoning: false,
		...(identity?.family !== undefined && { family: identity.family }),
		...(identity?.revision !== undefined && { revision: identity.revision }),
	}).catalog.thinkingReplayTokens;
	return tokens === "output" ? "output" : "signature";
}
