/**
 * OpenAI-side compat residue: the first-party xAI Responses effort remap used
 * by the xai-oauth discovery mapper when curating sparse rows. Everything else
 * that lived here (the chat-completions/Responses compat builders) moved into
 * the compat engine (`./resolve`) and the KDL rules.
 */

import type { OpenAICompat } from "../types";
import { compareRevision, parseRevision } from "./revision";
import { classifyModel } from "./taxonomy";

/** Shared `minimal → low` clamp. xhigh-capable Grok keeps `xhigh` unmapped. */
const XAI_RESPONSES_MINIMAL_EFFORT_MAP: NonNullable<OpenAICompat["reasoningEffortMap"]> = {
	minimal: "low",
};
/** Grok 4.5 / 4.3 / 3-mini: leftover `xhigh`/`max` clamp to `high`. */
const XAI_RESPONSES_CLAMPED_EFFORT_MAP: NonNullable<OpenAICompat["reasoningEffortMap"]> = {
	minimal: "low",
	xhigh: "high",
	max: "high",
};

/** Wire effort remap for first-party xAI Responses. */
export function xaiResponsesReasoningEffortMap(modelId: string): NonNullable<OpenAICompat["reasoningEffortMap"]> {
	const identity = classifyModel("xai", modelId, { lenient: true });
	const revision = identity.revision === undefined ? undefined : parseRevision(identity.revision);
	const floor = parseRevision("4.6");
	return identity.class === "xai" &&
		identity.family === "grok" &&
		revision !== undefined &&
		floor !== undefined &&
		compareRevision(revision, floor) >= 0
		? XAI_RESPONSES_MINIMAL_EFFORT_MAP
		: XAI_RESPONSES_CLAMPED_EFFORT_MAP;
}
