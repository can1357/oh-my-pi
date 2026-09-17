/**
 * Atomic models configuration writer and provider validator.
 *
 * Utilities for safely reading, writing, updating, and probing custom OpenAI-compatible
 * model configurations in `models.yml`.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api } from "@oh-my-pi/pi-ai/types";
import { getAgentDir, isEnoent, wrapFetchForExtraCa } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { YAML } from "bun";
import { invalidate as invalidateFsCache } from "../capability/fs";
import { stringifyYamlConfig } from "./config-file";
import {
	ModelsConfigFile,
	type ProviderValidationConfig,
	type ProviderValidationModel,
	validateProviderConfiguration,
} from "./models-config";
import type { ModelsConfig, ProviderAuthMode, ProviderDiscovery } from "./models-config-schema";

export interface AddCustomOpenAIProviderOptions {
	provider: string;
	baseUrl: string;
	apiKey?: string;
	auth?: "apiKey" | "none";
	api?: "openai-completions" | "openai-responses";
	disableStrictTools?: boolean;
	discovery?: boolean;
	model?: {
		id: string;
		name?: string;
		reasoning?: boolean;
		contextWindow?: number;
		maxTokens?: number;
	};
}

export interface AddCustomProviderResult {
	filePath: string;
	provider: string;
	modelId?: string;
	isNew: boolean;
	discovery: boolean;
}

export interface ProbeEndpointResult {
	ok: boolean;
	models: string[];
	error?: string;
}

/**
 * Validate a provider identifier.
 * Provider IDs must be alphanumeric with hyphens or underscores (max 64 chars).
 */
export function validateProviderId(id: string): string | undefined {
	const trimmed = id.trim();
	if (!trimmed) {
		return "Provider ID cannot be empty";
	}
	if (trimmed.length > 64) {
		return "Provider ID is too long (max 64 characters)";
	}
	if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
		return "Provider ID can only contain letters, numbers, hyphens, and underscores";
	}
	return undefined;
}

/**
 * Validate an endpoint base URL.
 * Must be a valid HTTP or HTTPS URL.
 */
export function validateBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return "Base URL cannot be empty";
	}
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return "Base URL must use http:// or https:// protocol";
		}
	} catch {
		return "Base URL must be a valid URL (e.g. http://localhost:8000/v1)";
	}
	return undefined;
}

/**
 * Sanitize a base URL by removing trailing slashes.
 */
export function sanitizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * Resolve the models configuration file path.
 * If not specified, checks for existing `models.yml` or `models.yaml` in agentDir,
 * defaulting to `models.yml`.
 */
export async function resolveModelsConfigPath(configPath?: string): Promise<string> {
	if (configPath) return configPath;
	const agentDir = getAgentDir();
	const ymlPath = path.join(agentDir, "models.yml");
	const yamlPath = path.join(agentDir, "models.yaml");

	try {
		await fs.access(ymlPath);
		return ymlPath;
	} catch {
		try {
			await fs.access(yamlPath);
			return yamlPath;
		} catch {
			return ymlPath;
		}
	}
}

/**
 * Read the models configuration file.
 * Returns empty config `{ providers: {} }` if the file doesn't exist.
 */
export async function readModelsConfigFile(configPath?: string): Promise<ModelsConfig> {
	const filePath = await resolveModelsConfigPath(configPath);
	try {
		const content = await fs.readFile(filePath, "utf-8");
		const parsed = YAML.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { providers: {} };
		}
		const config = parsed as ModelsConfig;
		if (!config.providers) {
			config.providers = {};
		}
		return config;
	} catch (error) {
		if (isEnoent(error)) {
			return { providers: {} };
		}
		throw error;
	}
}

async function writeModelsConfigInternal(filePath: string, config: ModelsConfig): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });

	const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	const content = stringifyYamlConfig(config);
	try {
		await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
		await fs.rename(tmpPath, filePath);
	} catch (error) {
		await fs.rm(tmpPath, { force: true }).catch(() => {});
		throw error;
	}

	invalidateFsCache(filePath);
	ModelsConfigFile.invalidate();
}

/**
 * Write a models configuration file atomically under file lock.
 */
export async function writeModelsConfigFile(config: ModelsConfig, configPath?: string): Promise<void> {
	const filePath = await resolveModelsConfigPath(configPath);
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });

	await withFileLock(filePath, async () => {
		await writeModelsConfigInternal(filePath, config);
	});
}

/**
 * Add or update a custom OpenAI-compatible provider in `models.yml`.
 * Ensures atomic write, provider validation, and tool calling compatibility (`supportsTools: true`).
 */
export async function addCustomOpenAIProvider(
	options: AddCustomOpenAIProviderOptions,
	configPath?: string,
): Promise<AddCustomProviderResult> {
	const providerError = validateProviderId(options.provider);
	if (providerError) {
		throw new Error(providerError);
	}

	const urlError = validateBaseUrl(options.baseUrl);
	if (urlError) {
		throw new Error(urlError);
	}

	const filePath = await resolveModelsConfigPath(configPath);
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });

	return await withFileLock(filePath, async () => {
		const config = await readModelsConfigFile(filePath);
		if (!config.providers) {
			config.providers = {};
		}

		const existingProvider = config.providers[options.provider];
		const isNew = !existingProvider;
		const sanitizedBaseUrl = sanitizeBaseUrl(options.baseUrl);
		const api = options.api ?? "openai-completions";
		const authMode: ProviderAuthMode = options.auth ?? (options.apiKey ? "apiKey" : "none");

		const updatedProvider: Record<string, unknown> = {
			...(existingProvider ? { ...existingProvider } : {}),
			baseUrl: sanitizedBaseUrl,
			api,
		};

		if (authMode === "none") {
			updatedProvider.auth = "none";
			delete updatedProvider.apiKey;
		} else {
			if (options.apiKey) {
				updatedProvider.apiKey = options.apiKey;
			}
			delete updatedProvider.auth;
		}

		if (options.disableStrictTools !== undefined) {
			updatedProvider.disableStrictTools = options.disableStrictTools;
		} else if (updatedProvider.disableStrictTools === undefined) {
			updatedProvider.disableStrictTools = true;
		}

		let discoveryConfig = updatedProvider.discovery as ProviderDiscovery | undefined;
		if (options.discovery) {
			discoveryConfig = { type: "openai-models-list" };
			updatedProvider.discovery = discoveryConfig;
		}

		let updatedModels = Array.isArray(updatedProvider.models)
			? [...(updatedProvider.models as ProviderValidationModel[])]
			: [];

		let modelId: string | undefined;
		if (options.model) {
			modelId = options.model.id;
			const newModelDef: ProviderValidationModel & { [key: string]: unknown } = {
				id: options.model.id,
				supportsTools: true,
			};
			if (options.model.name) newModelDef.name = options.model.name;
			if (options.model.reasoning !== undefined) newModelDef.reasoning = options.model.reasoning;
			if (options.model.contextWindow !== undefined) newModelDef.contextWindow = options.model.contextWindow;
			if (options.model.maxTokens !== undefined) newModelDef.maxTokens = options.model.maxTokens;

			const existingIndex = updatedModels.findIndex(m => m.id === options.model?.id);
			if (existingIndex >= 0) {
				updatedModels[existingIndex] = {
					...updatedModels[existingIndex],
					...newModelDef,
				};
			} else {
				updatedModels.push(newModelDef);
			}
			updatedProvider.models = updatedModels;
		}

		const validationConfig: ProviderValidationConfig = {
			baseUrl: updatedProvider.baseUrl as string,
			headers: updatedProvider.headers as Record<string, string> | undefined,
			apiKey: updatedProvider.apiKey as string | undefined,
			api: updatedProvider.api as Api | undefined,
			auth: (updatedProvider.auth ?? "apiKey") as ProviderAuthMode,
			discovery: discoveryConfig,
			disableStrictTools: updatedProvider.disableStrictTools as boolean | undefined,
			models: updatedModels,
		};

		validateProviderConfiguration(options.provider, validationConfig, "models-config");

		config.providers[options.provider] = updatedProvider as unknown as typeof config.providers[string];
		await writeModelsConfigInternal(filePath, config);

		return {
			filePath,
			provider: options.provider,
			modelId,
			isNew,
			discovery: Boolean(options.discovery || updatedProvider.discovery),
		};
	});
}

/**
 * Probe an OpenAI-compatible endpoint to check connectivity and fetch available models.
 */
export async function probeOpenAIEndpoint(
	baseUrl: string,
	apiKey?: string,
	timeoutMs = 8000,
): Promise<ProbeEndpointResult> {
	const sanitized = sanitizeBaseUrl(baseUrl);
	const targetUrl = `${sanitized}/models`;

	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (apiKey && apiKey.trim().length > 0) {
		headers.Authorization = `Bearer ${apiKey.trim()}`;
	}

	const fetchFn = wrapFetchForExtraCa(fetch);

	try {
		const response = await fetchFn(targetUrl, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			return {
				ok: false,
				models: [],
				error: `HTTP ${response.status} ${response.statusText}${errorText ? `: ${errorText.slice(0, 200)}` : ""}`,
			};
		}

		const body: unknown = await response.json();
		const models: string[] = [];

		if (Array.isArray(body)) {
			for (const item of body) {
				if (typeof item === "string" && item.trim()) {
					models.push(item.trim());
				} else if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
					models.push(item.id.trim());
				}
			}
		} else if (body && typeof body === "object") {
			const record = body as Record<string, unknown>;
			const candidates = Array.isArray(record.data)
				? record.data
				: Array.isArray(record.models)
					? record.models
					: [];
			for (const item of candidates) {
				if (typeof item === "string" && item.trim()) {
					models.push(item.trim());
				} else if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
					models.push(item.id.trim());
				}
			}
		}

		return {
			ok: true,
			models,
		};
	} catch (error) {
		return {
			ok: false,
			models: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
