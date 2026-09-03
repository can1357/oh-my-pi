import { getModelsConfigSchemaBundle } from "./models-config-schema-bundle";

export const {
	OpenAICompatSchema,
	ModelOverrideSchema,
	ProviderDiscoverySchema,
	ProviderAuthSchema,
	ModelsConfigSchema,
} = getModelsConfigSchemaBundle();

export type ModelOverride = typeof ModelOverrideSchema.infer;
export type ProviderAuthMode = typeof ProviderAuthSchema.infer;
export type ProviderDiscovery = typeof ProviderDiscoverySchema.infer;
export type ModelsConfig = typeof ModelsConfigSchema.infer;
