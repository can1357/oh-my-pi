/**
 * Custom model/provider config file handle and validation.
 */

import type { FluentType } from "@oh-my-pi/omptype";
import type { Api, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { AXES } from "@oh-my-pi/pi-catalog/compat/axes";
import { type ModelKind, servedKinds } from "@oh-my-pi/pi-catalog/types";
import { isRecord, once } from "@oh-my-pi/pi-utils";
import { ConfigFile } from "./config-file";
import type { ModelsConfig, ProviderAuthMode, ProviderDiscovery } from "./models-config-schema";
import { getModelsConfigSchema, getModelsConfigSchemaBundle } from "./models-config-schema-bundle";

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

const KIND_LIST = new Intl.ListFormat("en", { type: "disjunction" });

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

	// Runners dispatch on `api`, so an explicit `kind` must be one its api serves. An
	// omitted `kind` follows the api.
	const checkKind = (subject: string, kind: ModelKind, api: Api) => {
		const served = servedKinds(api);
		if (served === undefined || served.includes(kind)) return;
		throw new Error(
			`Provider ${providerName}, ${subject}: kind "${kind}" does not match api "${api}", which serves kind ${KIND_LIST.format(served.map(k => `"${k}"`))}.`,
		);
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

	// Only an api this file names is known here. Built-in, discovered, and `kind-apis`
	// rows get their api later, so `applyModelOverride` checks their kind against it.
	for (const [modelId, override] of Object.entries(config.modelOverrides ?? {})) {
		if (override.kind === undefined) continue;
		const declared = models.find(model => model.id === modelId);
		const api = override.api ?? (declared ? (declared.api ?? config.api) : undefined);
		if (api !== undefined) checkKind(`modelOverrides.${modelId}`, override.kind, api);
	}
}

function isObjectSchema(
	schema: FluentType<unknown>,
): schema is FluentType<unknown> & FluentType<Record<string, unknown>, unknown> {
	return schema.ir.k === "object";
}

// The file schema validates a curated subset of the runtime compatibility fields.
const getRuntimeCompatKeys = once(
	() =>
		new Set(
			Object.values(AXES)
				.filter(axis => axis.set === "wire")
				.map(axis => axis.key),
		),
);

/** Unknown keys are diagnostic only: keep newer-release configuration intact. */
export function getUnknownCompatKeys(config: ModelsConfig): string[] {
	const unknownKeys: string[] = [];
	const { ApiCompatSchema } = getModelsConfigSchemaBundle();
	const visit = <Input>(
		value: unknown,
		schema: FluentType<Record<string, unknown>, Input>,
		path: string,
		level: "compat" | "whenThinking" | "nested",
	): void => {
		if (!isRecord(value)) return;
		const keys = schema.keyof();
		const properties = schema.props;
		for (const [key, entry] of Object.entries(value)) {
			const keyPath = `${path}.${key}`;
			if (!keys.allows(key) && !(level !== "nested" && key !== "whenThinking" && getRuntimeCompatKeys().has(key))) {
				unknownKeys.push(keyPath);
				continue;
			}
			if (!isRecord(entry)) continue;
			const property = properties.find(property => property.key === key);
			// Open records (extraBody) have no declared properties to recurse into.
			if (property && isObjectSchema(property.value)) {
				visit(
					entry,
					property.value,
					keyPath,
					level === "compat" && key === "whenThinking" ? "whenThinking" : "nested",
				);
			}
		}
	};
	for (const [name, provider] of Object.entries(config.providers ?? {})) {
		const path = `providers.${name}`;
		visit(provider.compat, ApiCompatSchema, `${path}.compat`, "compat");
		for (const [index, model] of (provider.models ?? []).entries()) {
			visit(model.compat, ApiCompatSchema, `${path}.models.${index}.compat`, "compat");
		}
		for (const [id, override] of Object.entries(provider.modelOverrides ?? {})) {
			visit(override.compat, ApiCompatSchema, `${path}.modelOverrides.${id}.compat`, "compat");
		}
	}
	return unknownKeys;
}

/** Provider-level checks a loadable `models.yml` must pass beyond its schema. */
export function validateModelsConfigProviders(config: ModelsConfig): void {
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
}

export const ModelsConfigFile = new ConfigFile<ModelsConfig>("models", {
	kind: "deferred",
	resolve: getModelsConfigSchema,
}).withValidation("models", validateModelsConfigProviders);
