import type { ProviderDefinition } from "./types";

/** Retained for environment-key and bundled-model compatibility; interactive login was removed. */
export const waferPassProvider = {
	id: "wafer-pass",
	name: "Wafer Pass (flat-rate subscription)",
} as const satisfies ProviderDefinition;
