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
import {
	getModelsConfigSchema,
	getModelsConfigSchemaBundle,
	supportedInputModalities,
} from "./models-config-schema-bundle";

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

/**
 * Drop the input modalities the catalog cannot honour and report each one.
 * A modality the catalog does not know (a `video` entry written against a
 * future-capable model) must not take the whole file down: the file loads
 * without it and the operator learns what was ignored. Non-string entries are
 * left alone so the schema still rejects a genuinely malformed list. The
 * accepted set is the catalog axis, the same list the schema enumerates.
 */
function normalizeModelInputModalities(
	model: Record<string, unknown>,
	owner: string,
	supportedModalities: ReadonlySet<string>,
	allowedLabel: string,
	report: (message: string) => void,
): void {
	const input = model.input;
	if (!Array.isArray(input)) return;
	const supported = input.filter(entry => typeof entry !== "string" || supportedModalities.has(entry)) as unknown[];
	if (supported.length === input.length) return;
	for (const entry of input) {
		if (typeof entry !== "string" || supportedModalities.has(entry)) continue;
		report(`${owner}: input modality "${entry}" is not supported yet (allowed: ${allowedLabel}) — ignoring`);
	}
	// An empty list would leave the model with no input modality at all: drop
	// the key so the catalog's own default applies.
	if (supported.length > 0) model.input = supported;
	else delete model.input;
}

/**
 * Normalize a parsed models.yml before schema validation: an input modality
 * the catalog cannot express is dropped with a warning instead of failing the
 * file (issue #16342).
 */
export function normalizeModelsConfig(value: unknown, report: (message: string) => void): unknown {
	if (!isRecord(value)) return value;
	const providers = value.providers;
	if (!isRecord(providers)) return value;
	const modalities = supportedInputModalities();
	const supportedModalities = new Set(modalities);
	const allowedLabel = modalities.join(", ");
	for (const [providerName, providerConfig] of Object.entries(providers)) {
		if (!isRecord(providerConfig)) continue;
		const models = providerConfig.models;
		if (Array.isArray(models)) {
			for (const model of models) {
				if (!isRecord(model)) continue;
				const id = typeof model.id === "string" ? model.id : "<unnamed>";
				normalizeModelInputModalities(
					model,
					`provider "${providerName}", model "${id}"`,
					supportedModalities,
					allowedLabel,
					report,
				);
			}
		}
		const overrides = providerConfig.modelOverrides;
		if (isRecord(overrides)) {
			for (const [modelId, override] of Object.entries(overrides)) {
				if (!isRecord(override)) continue;
				normalizeModelInputModalities(
					override,
					`provider "${providerName}", model override "${modelId}"`,
					supportedModalities,
					allowedLabel,
					report,
				);
			}
		}
	}
	return value;
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

export const ModelsConfigFile = new ConfigFile<ModelsConfig>("models", {
	kind: "deferred",
	resolve: getModelsConfigSchema,
})
	.withNormalization("models", normalizeModelsConfig)
	.withValidation("models", config => {
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
