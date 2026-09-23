import * as fs from "node:fs/promises";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { OmpErrors } from "@oh-my-pi/omptype";
import { stringifyYamlConfig } from "@oh-my-pi/pi-utils/yaml-config";
import { writeFileAtomically } from "../utils/atomic-file";
import type { ConfigFile } from "./config-file";
import { ModelsConfigFile, validateProviderConfiguration } from "./models-config";
import type { ModelsConfig } from "./models-config-schema";

export interface CustomProviderInput {
	id: string;
	baseUrl: string;
	apiKey: string;
}

export interface CustomProviderContext {
	readonly authStorage: AuthStorage;
	refreshProvider(id: string): Promise<void>;
	discoverySucceeded(id: string): boolean;
	hasChatModels(id: string): boolean;
	readonly config?: ConfigFile<ModelsConfig>;
}

/** Register a discoverable provider without leaving unusable config or credentials behind. */
export async function addCustomProvider(input: CustomProviderInput, context: CustomProviderContext): Promise<void> {
	const { id, apiKey } = input;
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
		throw new Error(
			"Provider ID must start with a letter or number and contain only lowercase letters, numbers, - or _.",
		);
	}
	let endpoint: URL;
	try {
		endpoint = new URL(input.baseUrl);
	} catch {
		throw new Error("Enter a valid provider endpoint URL.");
	}
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
		throw new Error("Provider endpoint must use HTTP or HTTPS.");
	}
	if (endpoint.username || endpoint.password || endpoint.href.includes("?") || endpoint.href.includes("#")) {
		throw new Error("Provider endpoint cannot contain credentials, a query, or a fragment.");
	}

	const configFile = context.config ?? ModelsConfigFile;
	const loaded = configFile.tryLoad();
	if (loaded.status === "error") throw loaded.error;
	const config = loaded.status === "ok" ? loaded.value : configFile.createDefault();
	if (config.providers?.[id] || context.authStorage.credentials.has(id)) {
		throw new Error(`Provider "${id}" is already configured.`);
	}

	const provider = {
		baseUrl: endpoint.toString().replace(/\/+$/, ""),
		api: "openai-completions" as const,
		...(apiKey ? {} : { auth: "none" as const }),
		discovery: { type: "openai-models-list" as const },
	};
	const next = { ...config, providers: { ...config.providers, [id]: provider } };
	const checked = configFile.schema(next);
	if (checked instanceof OmpErrors) throw new Error(`Invalid provider configuration: ${checked.summary}`);
	validateProviderConfiguration(id, { ...provider, models: [] }, "models-config");

	const filePath = configFile.path();
	const previous = loaded.status === "ok" ? await fs.readFile(filePath, "utf8") : undefined;
	let keySaved = false;
	let configSaved = false;
	try {
		if (apiKey) {
			await context.authStorage.credentials.set(id, { type: "api_key", key: apiKey, source: "login" });
			keySaved = true;
		}
		await writeFileAtomically(filePath, stringifyYamlConfig(checked));
		configSaved = true;
		configFile.invalidate();
		await context.refreshProvider(id);
		if (!context.discoverySucceeded(id) || !context.hasChatModels(id)) {
			throw new Error("No chat models were discovered. Check the endpoint and API key, then try again.");
		}
	} catch (error) {
		try {
			if (configSaved) {
				if (previous === undefined) await fs.rm(filePath, { force: true });
				else await writeFileAtomically(filePath, previous);
			}
			if (keySaved) await context.authStorage.credentials.remove(id);
		} catch (rollbackError) {
			throw new Error(`Could not undo failed provider setup: ${String(rollbackError)}`, { cause: error });
		} finally {
			configFile.invalidate();
		}
		if (configSaved) await context.refreshProvider(id).catch(() => {});
		throw error;
	}
}
