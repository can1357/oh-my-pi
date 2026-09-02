import type { ProviderDefinition } from "./types";

export const kymaProvider = {
	id: "kyma",
	name: "Kyma",
} as const satisfies ProviderDefinition;
