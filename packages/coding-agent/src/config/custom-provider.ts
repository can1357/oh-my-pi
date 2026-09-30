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

	let providers = doc.get("providers");
	if (!isMap(providers)) {
		providers = new YAMLMap();
		doc.set("providers", providers);
	}
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
	if (context.authStorage.credentials.has(id)) throw new Error(`Provider "${id}" is already configured.`);

	const provider = {
		baseUrl: endpoint.toString().replace(/\/+$/, ""),
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
