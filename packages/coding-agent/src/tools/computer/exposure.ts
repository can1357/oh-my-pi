import type { Model } from "@oh-my-pi/pi-ai";

/** How the computer tool is represented to the active model. */
export type ComputerExposureMode = "function" | "unavailable";

/**
 * Report the computer tool's callable representation.
 *
 * Window selection is part of the tool's JSON schema, so even models with
 * provider-native Computer Use support receive it as a function.
 */
export function computerExposureMode(model: Model | undefined): ComputerExposureMode {
	return model ? "function" : "unavailable";
}
