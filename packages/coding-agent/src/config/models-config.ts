/**
 * Custom model/provider config file handle and validation.
 */

import type { Api, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { type ModelKind, runnerApiKind } from "@oh-my-pi/pi-catalog/types";
import { ConfigFile } from "./config-file";
import type { ModelsConfig, ProviderAuthMode, ProviderDiscovery } from "./models-config-schema";
import { getModelsConfigSchema } from "./models-config-schema-bundle";

export type ProviderValidationMode = "models-config" | "runtime-register";

export interface ProviderValidationModel {
	id: string;
	api?: Api;
	kind?: ModelKind;
	contextWindow?: number;
	supportsTools?: boolean;
	maxTokens?: number;
}

export interface ProviderValidationConfig {
	baseUrl?: string;
	headers?: Record<string, string>;
	apiKey?: string;
	api?: Api;
	auth?: ProviderAuthMode;
	oauthConfigured?: boolean;
	discovery?: ProviderDiscovery;
	compat?: ModelSpec<Api>["compat"];
	remoteCompaction?: unknown;
	disableStrictTools?: boolean;
	guardrailIdentifier?: string;
	requestMetadata?: Record<string, string>;
	modelOverrides?: Record<string, { api?: Api; kind?: ModelKind }>;
	models: ProviderValidationModel[];
}

export function validateProviderConfiguration(
	providerName: string,
	config: ProviderValidationConfig,
	mode: ProviderValidationMode,
): void {
	const hasProviderApi = !!config.api;
	const models = config.models;

	if (models.length === 0) {
		if (mode === "models-config") {
			const hasModelOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
			if (
				!config.baseUrl &&
				!config.headers &&
				!config.compat &&
				!config.apiKey &&
				config.auth !== "none" &&
				!config.disableStrictTools &&
				!config.guardrailIdentifier &&
				!config.requestMetadata &&
				!config.remoteCompaction &&
				!hasModelOverrides &&
				!config.discovery
			) {
				throw new Error(
					`Provider ${providerName}: must specify "baseUrl", "headers", "apiKey", "auth: none", "compat", "disableStrictTools", "guardrailIdentifier", "requestMetadata", "remoteCompaction", "modelOverrides", "discovery", or "models"`,
				);
			}
		}
	} else {
		if (!config.baseUrl) {
			throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
		}
		const requiresAuth =
			mode === "runtime-register"
				? !config.apiKey && !config.oauthConfigured
				: !config.apiKey && (config.auth ?? "apiKey") !== "none" && (config.auth ?? "apiKey") !== "oauth";
		if (requiresAuth) {
			throw new Error(
				mode === "runtime-register"
					? `Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`
					: `Provider ${providerName}: "apiKey" is required when defining custom models unless auth is "none" or "oauth".`,
			);
		}
	}

	if (mode === "models-config" && config.discovery && !config.api && config.discovery.type !== "proxy") {
		throw new Error(`Provider ${providerName}: "api" is required when discovery is enabled at provider level.`);
	}

	// Runners dispatch on `api`, so an explicit `kind` must be the kind its api serves
	// (chat for chat transports). An omitted `kind` follows the api. `local-inference`
	// hosts several kinds, so it accepts any `kind`.
	const checkKind = (subject: string, kind: ModelKind, api: Api) => {
		if (api === "local-inference") return;
		const apiKind = runnerApiKind(api) ?? "chat";
		if (kind !== apiKind) {
			throw new Error(
				`Provider ${providerName}, ${subject}: kind "${kind}" does not match api "${api}", which serves kind "${apiKind}".`,
			);
		}
	};
	for (const modelDef of models) {
		if (!hasProviderApi && !modelDef.api) {
			throw new Error(
				mode === "runtime-register"
					? `Provider ${providerName}, model ${modelDef.id}: no "api" specified.`
					: `Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
			);
		}
		if (!modelDef.id) {
			throw new Error(`Provider ${providerName}: model missing "id"`);
		}
		const api = modelDef.api ?? config.api;
		if (modelDef.kind !== undefined && api !== undefined) checkKind(`model ${modelDef.id}`, modelDef.kind, api);
		if (mode === "models-config") {
			if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
			}
			if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
			}
		}
	}

	for (const [modelId, override] of Object.entries(config.modelOverrides ?? {})) {
		if (override.kind === undefined) continue;
		const api = override.api ?? models.find(model => model.id === modelId)?.api ?? config.api;
		if (api === undefined) {
			throw new Error(
				`Provider ${providerName}, modelOverrides.${modelId}: "kind" requires "api" on the override or the provider.`,
			);
		}
		checkKind(`modelOverrides.${modelId}`, override.kind, api);
	}
}

export const ModelsConfigFile = new ConfigFile<ModelsConfig>("models", {
	kind: "deferred",
	resolve: getModelsConfigSchema,
}).withValidation("models", config => {
	const providers = config.providers ?? {};
	for (const providerName in providers) {
		const providerConfig = providers[providerName];
		validateProviderConfiguration(
			providerName,
			{
				baseUrl: providerConfig.baseUrl,
				headers: providerConfig.headers,
				apiKey: providerConfig.apiKey,
				api: providerConfig.api as Api | undefined,
				auth: (providerConfig.auth ?? "apiKey") as ProviderAuthMode,
				discovery: providerConfig.discovery as ProviderDiscovery | undefined,
				compat: providerConfig.compat,
				remoteCompaction: providerConfig.remoteCompaction,
				disableStrictTools: providerConfig.disableStrictTools,
				guardrailIdentifier: providerConfig.guardrailIdentifier,
				requestMetadata: providerConfig.requestMetadata,
				modelOverrides: providerConfig.modelOverrides,
				models: (providerConfig.models ?? []) as ProviderValidationModel[],
			},
			"models-config",
		);
	}
});
