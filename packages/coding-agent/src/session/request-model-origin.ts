import type { AssistantMessage } from "@oh-my-pi/pi-ai";

/** Ephemeral request identity for quota recovery; spread copies it, JSON does not. */
export const kRequestModelOrigin = Symbol("request-model-origin");

export interface RequestModelOrigin {
	provider: string;
	modelId: string;
	/** Registry route at dispatch, caller-owned route, or a mismatched provider response. */
	source: "registry" | "external" | "mismatched";
}

export type OriginStampedAssistantMessage = AssistantMessage & {
	[kRequestModelOrigin]?: RequestModelOrigin;
};
