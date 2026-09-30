import * as fs from "node:fs/promises";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { OmpErrors } from "@oh-my-pi/omptype";
import { isEnoent, toError } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { isMap, parseDocument, YAMLMap } from "yaml";
import { writeFileAtomically } from "../utils/atomic-file";
import type { ConfigFile } from "./config-file";
import { ModelsConfigFile, validateModelsConfigProviders } from "./models-config";
import type { ModelsConfig } from "./models-config-schema";

const CHANGED_ON_DISK = "models.yml changed on disk; retry";

async function readIfPresent(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/**
 * Edit only the `providers` map of `models.yml`, keeping every other byte (comments, other
 * providers, formatting) intact. Refuses an unloadable file, verifies the result would load,
 * and aborts if the file changed since it was read.
 */
export async function editModelsConfig(
	configFile: ConfigFile<ModelsConfig>,
	mutate: (providers: YAMLMap) => void,
): Promise<{ previous: string | undefined; written: string }> {
	const filePath = configFile.path();
	const previous = await readIfPresent(filePath);
	configFile.invalidate();
	const loaded = configFile.tryLoad();
	if (loaded.status === "error") throw loaded.error;
	const doc = parseDocument(previous ?? "");
	if (doc.errors.length > 0) throw doc.errors[0];

	const existing = doc.get("providers");
	const providers = isMap(existing) ? existing : new YAMLMap();
	if (providers !== existing) doc.set("providers", providers);
	mutate(providers);
	const written = doc.toString({ lineWidth: 0 });

	try {
		const checked = configFile.schema(YAML.parse(written));
		if (checked instanceof OmpErrors) throw new Error(checked.summary);
		validateModelsConfigProviders(checked as ModelsConfig);
	} catch (error) {
		throw new Error(`Invalid provider configuration: ${toError(error).message}`);
	}

	if ((await readIfPresent(filePath)) !== previous) throw new Error(CHANGED_ON_DISK);
	await writeFileAtomically(filePath, written);
	configFile.invalidate();
	return { previous, written };
}

/** Undo {@link editModelsConfig}, but only if nothing else has touched the file since. */
export async function restoreModelsConfig(
	configFile: ConfigFile<ModelsConfig>,
	expectedCurrent: string,
	previous: string | undefined,
): Promise<void> {
	const filePath = configFile.path();
	if ((await readIfPresent(filePath)) !== expectedCurrent) throw new Error(CHANGED_ON_DISK);
	if (previous === undefined) await fs.rm(filePath, { force: true });
	else await writeFileAtomically(filePath, previous);
	configFile.invalidate();
}

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

/** Validate a provider endpoint and return it without trailing slashes. */
function parseEndpoint(raw: string): string {
	let endpoint: URL;
	try {
		endpoint = new URL(raw);
	} catch {
		throw new Error("Enter a valid provider endpoint URL.");
	}
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
		throw new Error("Provider endpoint must use HTTP or HTTPS.");
	}
	if (endpoint.username || endpoint.password || endpoint.href.includes("?") || endpoint.href.includes("#")) {
		throw new Error("Provider endpoint cannot contain credentials, a query, or a fragment.");
	}
	return endpoint.toString().replace(/\/+$/, "");
}

/** Register a discoverable provider without leaving unusable config or credentials behind. */
export async function addCustomProvider(input: CustomProviderInput, context: CustomProviderContext): Promise<void> {
	const { id, apiKey } = input;
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
		throw new Error(
			"Provider ID must start with a letter or number and contain only lowercase letters, numbers, - or _.",
		);
	}
	const baseUrl = parseEndpoint(input.baseUrl);

	const configFile = context.config ?? ModelsConfigFile;
	if (context.authStorage.credentials.has(id)) throw new Error(`Provider "${id}" is already configured.`);

	const provider = {
		baseUrl,
		api: "openai-completions" as const,
		...(apiKey ? {} : { auth: "none" as const }),
		discovery: { type: "openai-models-list" as const },
	};
	let keySaved = false;
	let edit: { previous: string | undefined; written: string } | undefined;
	try {
		if (apiKey) {
			await context.authStorage.credentials.set(id, { type: "api_key", key: apiKey, source: "login" });
			keySaved = true;
		}
		edit = await editModelsConfig(configFile, providers => {
			if (providers.has(id)) throw new Error(`Provider "${id}" is already configured.`);
			providers.set(id, provider);
		});
		await context.refreshProvider(id);
		if (!context.discoverySucceeded(id) || !context.hasChatModels(id)) {
			throw new Error("No chat models were discovered. Check the endpoint and API key, then try again.");
		}
	} catch (error) {
		try {
			if (edit) await restoreModelsConfig(configFile, edit.written, edit.previous);
			if (keySaved) await context.authStorage.credentials.remove(id);
		} catch (rollbackError) {
			throw new Error(`Could not undo failed provider setup: ${String(rollbackError)}`, { cause: error });
		} finally {
			configFile.invalidate();
		}
		if (edit) await context.refreshProvider(id).catch(() => {});
		throw error;
	}
}

export interface CustomProviderUpdate {
	baseUrl?: string;
	/** Non-empty: store as the credential and drop any inline `apiKey`. */
	apiKey?: string;
	/** Remove the credential and mark the provider keyless. */
	clearApiKey?: boolean;
}

export interface CustomProviderInfo {
	id: string;
	baseUrl: string | undefined;
	hasKey: boolean;
}

function notDefined(id: string): Error {
	return new Error(`Provider "${id}" is not defined in models.yml.`);
}

/** Read a provider declared in a successfully loaded `models.yml`. */
export function getCustomProvider(
	id: string,
	configFile: ConfigFile<ModelsConfig> = ModelsConfigFile,
	authStorage?: AuthStorage,
): CustomProviderInfo | undefined {
	const loaded = configFile.tryLoad();
	const node = loaded.status === "ok" ? loaded.value.providers?.[id] : undefined;
	if (!node) return undefined;
	return { id, baseUrl: node.baseUrl, hasKey: Boolean(node.apiKey) || (authStorage?.credentials.has(id) ?? false) };
}

/** Fail before touching credentials when the ID is absent or the file is unloadable. */
function requireProvider(id: string, configFile: ConfigFile<ModelsConfig>): void {
	configFile.invalidate();
	const loaded = configFile.tryLoad();
	if (loaded.status === "error") throw loaded.error;
	if (!loaded.value?.providers?.[id]) throw notDefined(id);
}

/** Run every rollback step even if earlier ones fail, then surface all failures together. */
async function rollBack(what: string, steps: Array<() => Promise<void>>, cause: unknown): Promise<void> {
	const failures: string[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			failures.push(toError(error).message);
		}
	}
	if (failures.length > 0) throw new Error(`Could not undo ${what}: ${failures.join("; ")}`, { cause });
}

/** Edit a provider's endpoint and/or key without losing anything else in its `models.yml` node. */
export async function updateCustomProvider(
	id: string,
	update: CustomProviderUpdate,
	context: CustomProviderContext,
): Promise<void> {
	const { apiKey, clearApiKey } = update;
	if (apiKey && clearApiKey) throw new Error("Cannot both set and clear the API key.");
	const baseUrl = update.baseUrl === undefined ? undefined : parseEndpoint(update.baseUrl);
	const configFile = context.config ?? ModelsConfigFile;
	requireProvider(id, configFile);

	const { credentials } = context.authStorage;
	const previousCredential = credentials.get(id);
	let credentialChanged = false;
	let edit: { previous: string | undefined; written: string } | undefined;
	try {
		if (apiKey) {
			await credentials.set(id, { type: "api_key", key: apiKey, source: "login" });
			credentialChanged = true;
		} else if (clearApiKey) {
			await credentials.remove(id);
			credentialChanged = true;
		}
		edit = await editModelsConfig(configFile, providers => {
			const node = providers.get(id);
			if (!isMap(node)) throw notDefined(id);
			if (baseUrl !== undefined) node.set("baseUrl", baseUrl);
			if (apiKey) {
				node.delete("apiKey");
				if (node.get("auth") === "none") node.delete("auth");
			} else if (clearApiKey) {
				node.delete("apiKey");
				node.set("auth", "none");
			}
		});
		await context.refreshProvider(id);
		if (!context.discoverySucceeded(id) || !context.hasChatModels(id)) {
			throw new Error("No chat models were discovered. Check the endpoint and API key, then try again.");
		}
	} catch (error) {
		const steps: Array<() => Promise<void>> = [];
		if (edit) {
			const { written, previous } = edit;
			steps.push(() => restoreModelsConfig(configFile, written, previous));
		}
		if (credentialChanged) {
			steps.push(async () => {
				if (previousCredential) await credentials.set(id, previousCredential);
				else await credentials.remove(id);
			});
		}
		try {
			await rollBack("failed provider update", steps, error);
		} finally {
			configFile.invalidate();
		}
		if (edit) await context.refreshProvider(id).catch(() => {});
		throw error;
	}
}

/** Delete a provider from `models.yml`, then its stored credential. */
export async function removeCustomProvider(
	id: string,
	context: Pick<CustomProviderContext, "authStorage" | "refreshProvider" | "config">,
): Promise<void> {
	const configFile = context.config ?? ModelsConfigFile;
	requireProvider(id, configFile);
	const edit = await editModelsConfig(configFile, providers => {
		if (!providers.has(id)) throw notDefined(id);
		providers.delete(id);
	});
	try {
		await context.authStorage.credentials.remove(id);
	} catch (error) {
		await rollBack("provider removal", [() => restoreModelsConfig(configFile, edit.written, edit.previous)], error);
		throw error;
	}
	await context.refreshProvider(id);
}
