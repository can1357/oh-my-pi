/**
 * Which model APIs a gateway format surface may serve.
 * Pairings that do not match a surface's allow-rule are false.
 */

export type GatewaySurface = "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini-v1beta" | "pi-native";

export interface RouteSurfaceEligibility {
	surface: GatewaySurface;
	modelApi: string;
}

/** True when `modelApi` is eligible on `surface`. Unknown pairings are false. */
export function surfaceAllowsApi(surface: GatewaySurface, modelApi: string): boolean {
	switch (surface) {
		case "openai-chat":
			return (
				modelApi.includes("openai-completions") ||
				modelApi.includes("openai-chat") ||
				modelApi.includes("openai-compatible") ||
				(modelApi.includes("grok") && !modelApi.includes("responses"))
			);
		case "openai-responses":
			return modelApi.includes("responses");
		case "anthropic-messages":
			return modelApi.includes("anthropic");
		case "gemini-v1beta":
			return modelApi.includes("google-generative-ai") || modelApi.includes("google-vertex");
		case "pi-native":
			return true;
	}
}
