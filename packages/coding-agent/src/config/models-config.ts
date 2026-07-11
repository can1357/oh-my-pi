/**
 * models.json config file handle and provider configuration validation.
 */

import type { Api, ModelSpec } from "@pk-nerdsaver-ai/pi-ai/types";
import { ConfigFile } from "./config-file";
import {
	type ModelsConfig,
	ModelsConfigSchema,
	type ProviderAuthMode,
	type ProviderDiscovery,
} from "./models-config-schema";

export type ProviderValidationMode = "models-config" | "runtime-register";

export interface ProviderValidationModel {
	id: string;
	api?: Api;
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
	modelOverrides?: Record<string, unknown>;
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
				!config.remoteCompaction &&
				!hasModelOverrides &&
				!config.discovery
			) {
				throw new Error(
					`Provider ${providerName}: must specify "baseUrl", "headers", "apiKey", "auth: none", "compat", "disableStrictTools", "remoteCompaction", "modelOverrides", "discovery", or "models"`,
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
				: !config.apiKey && (config.auth ?? "apiKey") !== "none";
		if (requiresAuth) {
			throw new Error(
				mode === "runtime-register"
					? `Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`
					: `Provider ${providerName}: "apiKey" is required when defining custom models unless auth is "none".`,
			);
		}
	}

	if (mode === "models-config" && config.discovery && !config.api && config.discovery.type !== "proxy") {
		throw new Error(`Provider ${providerName}: "api" is required when discovery is enabled at provider level.`);
	}

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
		if (mode === "models-config") {
			if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
			}
			if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
			}
		}
	}
}

export const ModelsConfigFile = new ConfigFile<ModelsConfig>("models", ModelsConfigSchema).withValidation(
	"models",
	config => {
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
					modelOverrides: providerConfig.modelOverrides,
					models: (providerConfig.models ?? []) as ProviderValidationModel[],
				},
				"models-config",
			);
		}
	},
);
