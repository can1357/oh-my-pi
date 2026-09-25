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
	return gatewaySurfaceAllowsApi(surface, modelApi);
}
import { gatewaySurfaceAllowsApi } from "@oh-my-pi/pi-catalog/compat/behavior";
