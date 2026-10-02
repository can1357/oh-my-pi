import * as fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { isEnoent, toError } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { isMap, isScalar, type Pair, parseDocument, YAMLMap } from "yaml";
import { writeFileAtomically } from "../utils/atomic-file";
import type { ConfigFile } from "./config-file";
import type { ModelRegistry } from "./model-registry";
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

/** Where a write lands and with which mode: through a symlink to its target, keeping an existing file's permissions (a new file stays private). */
async function writeTarget(filePath: string): Promise<{ target: string; mode: number | undefined }> {
	const target = await fs.realpath(filePath).catch(() => filePath);
	const mode = await fs.stat(target).then(
		stat => stat.mode & 0o777,
		() => undefined,
	);
	return { target, mode };
}

/** A `models.yml` edit: the bytes it replaced (`undefined` when the file was absent) and the bytes it wrote. */
interface ModelsEdit {
	previous: string | undefined;
	written: string;
}

/** The pair whose key YAML reads as `id`: `123`, `true` and `null` are non-string keys that `providers.get(id)` never matches. */
function findPair(providers: YAMLMap, id: string): Pair | undefined {
	return providers.items.find(pair => isScalar(pair.key) && String(pair.key.value) === id);
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** `models.yml` text as the plain object OMP loads (same parser), before schema coercion. */
function parseRoot(text: string | undefined): Record<string, unknown> {
	const trimmed = text?.trim();
	return trimmed ? asRecord(YAML.parse(trimmed)) : {};
}

/**
 * Serialization is the one step that can silently change meaning, so prove it did not: `providers`
 * must have one entry per YAML pair (no key collapsed), and everything except provider `id`, plus
 * every other root key, must read back exactly as before.
 */
function assertOnlyProviderChanged(before: string | undefined, written: string, id: string, pairs: number): void {
	const { providers: beforeProviders, ...beforeRoot } = parseRoot(before);
	const { providers: afterProviders, ...afterRoot } = parseRoot(written);
	if (Object.keys(asRecord(afterProviders)).length !== pairs) {
		throw new Error("models.yml has provider IDs that collapse into one entry when loaded; edit the file directly.");
	}
	const others = (providers: unknown) =>
		Object.fromEntries(Object.entries(asRecord(providers)).filter(([name]) => name !== id));
	if (
		!isDeepStrictEqual(beforeRoot, afterRoot) ||
		!isDeepStrictEqual(others(beforeProviders), others(afterProviders))
	) {
		throw new Error(`Refusing to write models.yml: the edit would change more than provider "${id}".`);
	}
}

/**
 * Edit only provider `id` in the `providers` map of `models.yml`. Comments, other entries, line
 * endings, BOM and indentation are kept; the result is proven to load exactly as OMP would load it and
 * to leave every other entry unchanged, and the write aborts if the file changed since it was read.
 * The write goes through a symlinked `models.yml` to its target.
 */
async function editModelsConfig(
	configFile: ConfigFile<ModelsConfig>,
	id: string,
	mutate: (providers: YAMLMap) => void,
): Promise<ModelsEdit> {
	const filePath = configFile.path();
	const previous = await readIfPresent(filePath);
	configFile.invalidate();
	const loaded = configFile.tryLoad();
	if (loaded.status === "error") throw loaded.error;

	const bom = previous?.startsWith("\uFEFF") ?? false;
	const source = (bom ? previous?.slice(1) : previous) ?? "";
	const doc = parseDocument(source);
	if (doc.errors.length > 0) throw doc.errors[0];
	const existing = doc.get("providers");
	const providers = isMap(existing) ? existing : new YAMLMap();
	if (providers !== existing) doc.set("providers", providers);
	mutate(providers);

	const crlf = (source.match(/\r\n/g)?.length ?? 0) * 2 > (source.match(/\n/g)?.length ?? 0);
	const indent = /^( +)[^\s#]/m.exec(source)?.[1].length ?? 2;
	let written: string;
	try {
		written = doc.toString({ lineWidth: 0, indent });
	} catch (error) {
		// e.g. deleting an anchored provider that another entry aliases.
		throw new Error(
			`models.yml uses a YAML alias this edit would break; edit the file directly. (${toError(error).message})`,
		);
	}
	if (crlf) written = written.replaceAll("\n", "\r\n");
	if (bom) written = `\uFEFF${written}`;

	const checked = configFile.check(written);
	if (checked.status === "error") throw new Error(`Invalid provider configuration: ${checked.error.message}`);
	assertOnlyProviderChanged(previous, written, id, providers.items.length);
	if (written === previous) return { previous, written };

	// Not locked: an editor that saves between this recheck and the rename still loses its change, but the
	// recheck runs after the new file is staged and synced, so the window is the rename itself.
	const { target, mode } = await writeTarget(filePath);
	await writeFileAtomically(target, written, {
		mode,
		beforePublish: async () => {
			if ((await readIfPresent(filePath)) !== previous) throw new Error(CHANGED_ON_DISK);
		},
	});
	configFile.invalidate();
	return { previous, written };
}

/** Undo {@link editModelsConfig}, but only if nothing else has touched the file since. */
async function restoreModelsConfig(
	configFile: ConfigFile<ModelsConfig>,
	expectedCurrent: string,
	previous: string | undefined,
): Promise<void> {
	const filePath = configFile.path();
	const recheck = async () => {
		if ((await readIfPresent(filePath)) !== expectedCurrent) throw new Error(CHANGED_ON_DISK);
	};
	await recheck();
	if (previous === undefined) await fs.rm(filePath, { force: true });
	else {
		const { target, mode } = await writeTarget(filePath);
		await writeFileAtomically(target, previous, { mode, beforePublish: recheck });
	}
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
	readonly config: ConfigFile<ModelsConfig>;
}

/** The live registry as the context every custom-provider write runs against, on the file it reads. */
export function customProviderContext(registry: ModelRegistry): CustomProviderContext {
	return {
		authStorage: registry.authStorage,
		config: registry.modelsConfigFile,
		refreshProvider: id => registry.refreshProvider(id, "online"),
		discoverySucceeded: id => registry.getProviderDiscoveryState(id)?.status === "ok",
		hasChatModels: id => registry.getAll("chat").some(model => model.provider === id),
	};
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

/** A change in flight: what to name it in errors, and what a failure has to put back. */
interface PendingChange {
	what: string;
	id: string;
	configFile: ConfigFile<ModelsConfig>;
	context: Pick<CustomProviderContext, "refreshProvider">;
	/** Set once `models.yml` was published. */
	edit?: ModelsEdit;
	/** Present once the stored credentials were changed. */
	undoCredential?: () => Promise<void>;
}

/**
 * Put back a failed change: the file first, then the credentials. Credentials are restored only when the
 * file was never published or its restore succeeded. If the restore is refused (a hand edit landed), the
 * published file still expects the new credential state — e.g. it dropped `auth: none` for the new key —
 * and reverting the credential would leave the provider unauthenticated. Failures are reported together.
 */
async function undoChange(change: PendingChange, cause: unknown): Promise<void> {
	const { what, id, configFile, context, edit, undoCredential } = change;
	const failures: string[] = [];
	let fileStuck = false;
	if (edit) {
		try {
			await restoreModelsConfig(configFile, edit.written, edit.previous);
		} catch (error) {
			fileStuck = true;
			failures.push(toError(error).message);
		}
	}
	if (undoCredential) {
		if (fileStuck) {
			failures.push("stored credentials were left as saved to match models.yml");
		} else {
			try {
				await undoCredential();
			} catch (error) {
				failures.push(toError(error).message);
			}
		}
	}
	configFile.invalidate();
	if (edit) await context.refreshProvider(id).catch(() => {});
	if (failures.length > 0) throw new Error(`Could not undo ${what}: ${failures.join("; ")}`, { cause });
}

/**
 * Undo for the credential write that just happened. It snapshots what this change stored and refuses to
 * undo once another login, logout or rotation (in this process or another) replaced it, so a failed edit
 * never overwrites newer credentials. A different key is stored as a new row, so any rotation changes the
 * snapshot; a concurrent login of the identical key is indistinguishable and is undone with this change.
 */
function undoUnlessReplaced(authStorage: AuthStorage, id: string, restore: () => Promise<void>): () => Promise<void> {
	const { credentials } = authStorage;
	const written = credentials.list(id);
	return async () => {
		await credentials.poll();
		if (!isDeepStrictEqual(credentials.list(id), written)) {
			throw new Error("credentials changed during provider editing; newer login/logout was preserved");
		}
		await restore();
	};
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

	const configFile = context.config;
	const { credentials } = context.authStorage;
	if (credentials.has(id)) throw new Error(`Provider "${id}" is already configured.`);

	const provider = {
		baseUrl,
		api: "openai-completions" as const,
		...(apiKey ? {} : { auth: "none" as const }),
		discovery: { type: "openai-models-list" as const },
	};
	let undoCredential: (() => Promise<void>) | undefined;
	let edit: ModelsEdit | undefined;
	try {
		// Credential first: a crash between the two steps leaves an unused key, not a provider without one.
		if (apiKey) {
			await credentials.set(id, { type: "api_key", key: apiKey, source: "login" });
			undoCredential = undoUnlessReplaced(context.authStorage, id, () => credentials.remove(id));
		}
		edit = await editModelsConfig(configFile, id, providers => {
			if (findPair(providers, id)) throw new Error(`Provider "${id}" is already configured.`);
			providers.set(id, provider);
		});
		await context.refreshProvider(id);
		if (!context.discoverySucceeded(id) || !context.hasChatModels(id)) {
			throw new Error("No chat models were discovered. Check the endpoint and API key, then try again.");
		}
	} catch (error) {
		await undoChange(
			{
				what: "failed provider setup",
				id,
				configFile,
				context,
				edit,
				undoCredential,
			},
			error,
		);
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
	/** Removing the declaration leaves the stored key: the ID is a built-in provider, whose key is the user's own login. */
	keepsKeyOnRemove: boolean;
}

function notDefined(id: string): Error {
	return new Error(`Provider "${id}" is not defined in models.yml.`);
}

type ProviderNode = NonNullable<ModelsConfig["providers"]>[string];

/** Own-property lookup, so inherited keys like `constructor` are never providers. */
function findProvider(config: ModelsConfig | null | undefined, id: string): ProviderNode | undefined {
	const providers = config?.providers;
	return providers && Object.hasOwn(providers, id) ? providers[id] : undefined;
}

/** Whether a provider ID is built into the catalog (auth policies or bundled models) rather than a user custom provider. */
export function isBuiltInProvider(id: string): boolean {
	return Boolean(authPolicyFor(id)) || (getBundledProviders() as readonly string[]).includes(id);
}

/** Read a provider declared in a successfully loaded `models.yml`. */
export function getCustomProvider(
	id: string,
	configFile: ConfigFile<ModelsConfig>,
	authStorage?: AuthStorage,
): CustomProviderInfo | undefined {
	const loaded = configFile.tryLoad();
	const node = loaded.status === "ok" ? findProvider(loaded.value, id) : undefined;
	if (!node) return undefined;
	return {
		id,
		baseUrl: node.baseUrl,
		hasKey: Boolean(node.apiKey) || (authStorage?.credentials.has(id) ?? false),
		keepsKeyOnRemove: isBuiltInProvider(id),
	};
}

/** Fail before touching credentials when the ID is absent or the file is unloadable. */
function requireProvider(id: string, configFile: ConfigFile<ModelsConfig>): ProviderNode {
	configFile.invalidate();
	const loaded = configFile.tryLoad();
	if (loaded.status === "error") throw loaded.error;
	const node = findProvider(loaded.value, id);
	if (!node) throw notDefined(id);
	return node;
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
	const configFile = context.config;
	const node = requireProvider(id, configFile);
	if (baseUrl === undefined && !apiKey && !clearApiKey) return;

	const { credentials } = context.authStorage;
	if ((apiKey || clearApiKey) && (node.auth === "oauth" || credentials.hasOAuth(id))) {
		throw new Error(
			`Provider "${id}" signs in with OAuth, so its credential cannot be changed here. Use /login or /logout instead.`,
		);
	}
	// A new key leaves the node (dropping `auth: none`), and custom models need the key in the file.
	if (apiKey && node.models?.length) {
		throw new Error(
			`Provider "${id}" defines its own models, so its API key must stay in models.yml. Edit the file directly.`,
		);
	}

	const previousCredentials = credentials.list(id).map(row => row.credential);
	let undoCredential: (() => Promise<void>) | undefined;
	let edit: ModelsEdit | undefined;
	// `set` replaces every stored row, so an undo restores the whole list.
	const restore = () =>
		previousCredentials.length > 0 ? credentials.set(id, previousCredentials) : credentials.remove(id);
	try {
		if (apiKey) {
			await credentials.set(id, { type: "api_key", key: apiKey, source: "login" });
			undoCredential = undoUnlessReplaced(context.authStorage, id, restore);
		} else if (clearApiKey) {
			await credentials.remove(id);
			undoCredential = undoUnlessReplaced(context.authStorage, id, restore);
		}
		edit = await editModelsConfig(configFile, id, providers => {
			const target = findPair(providers, id)?.value;
			if (!isMap(target)) throw notDefined(id);
			if (baseUrl !== undefined) target.set("baseUrl", baseUrl);
			if (apiKey) {
				target.delete("apiKey");
				if (target.get("auth") === "none") target.delete("auth");
			} else if (clearApiKey) {
				target.delete("apiKey");
				target.set("auth", "none");
			}
		});
		await context.refreshProvider(id);
		// Only a provider that declares discovery has a discovery result to check; static ones need their models.
		if ((node.discovery && !context.discoverySucceeded(id)) || !context.hasChatModels(id)) {
			throw new Error("No chat models were discovered. Check the endpoint and API key, then try again.");
		}
	} catch (error) {
		await undoChange(
			{
				what: "failed provider update",
				id,
				configFile,
				context,
				edit,
				undoCredential,
			},
			error,
		);
		throw error;
	}
}

/**
 * Delete a provider from `models.yml`, then its stored credential. A built-in provider ID keeps its
 * credential: a `models.yml` override must not wipe the user's own login.
 */
export async function removeCustomProvider(
	id: string,
	context: Pick<CustomProviderContext, "authStorage" | "refreshProvider" | "config">,
): Promise<void> {
	const configFile = context.config;
	requireProvider(id, configFile);
	const edit = await editModelsConfig(configFile, id, providers => {
		const pair = findPair(providers, id);
		if (!pair) throw notDefined(id);
		providers.delete(pair.key);
	});
	if (!isBuiltInProvider(id)) {
		try {
			await context.authStorage.credentials.remove(id);
		} catch (error) {
			await undoChange({ what: "provider removal", id, configFile, context, edit }, error);
			throw error;
		}
	}
	await context.refreshProvider(id);
}
