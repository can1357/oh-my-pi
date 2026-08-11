import type {
	MCPConnectionProtocol,
	MCPExtensionCapabilities,
	MCPNegotiatedExtensionState,
	MCPServerConnection,
	MCPServerExtensionConfig,
} from "./types";

/** Protocol eras an extension definition can participate in. */
export type MCPExtensionEra = MCPConnectionProtocol["era"];

/** A method-scoped, connection-scoped nonstandard result envelope. */
export interface MCPExtensionResultTypeSpec {
	method: string;
	resultType: string;
	/** Returns a reason when this extension result envelope is malformed. */
	validate(result: Record<string, unknown>): string | undefined;
}

/** Hooks run only for a capability negotiated from this explicit registry. */
export interface MCPExtensionHooks {
	onNegotiated?(connection: MCPServerConnection, state: MCPNegotiatedExtensionState): void;
	onNotification?(connection: MCPServerConnection, method: string, params: unknown): void;
}

/**
 * A compiled-in MCP extension provider.
 *
 * Definitions are trusted host policy, not server-provided dispatch. Server
 * advertisements merely opt a registered definition into a connection.
 */
export interface MCPExtensionDefinition<TServerSettings = unknown, TClientSettings = Record<string, unknown>> {
	/** Reverse-DNS extension identifier, including its specification path. */
	id: string;
	/** Defaults to modern; legacy initialize capabilities are never extended by this foundation. */
	eras?: readonly MCPExtensionEra[];
	/** Defaults to true. False is only for pre-discovery extensions such as authentication. */
	requiresServerAdvertisement?: boolean;
	/** Validates local policy before a connection attempt. */
	validateConfig?(settings: Record<string, unknown>): string | undefined;
	/** Produces the exact capability record advertised to the server. */
	clientSettings(config: MCPServerExtensionConfig): TClientSettings;
	/** Strictly parses a server-advertised settings record. Undefined declines activation. */
	parseServerSettings(settings: Record<string, unknown>): TServerSettings | undefined;
	/** Optional explicit result envelopes accepted only after this definition negotiates. */
	resultTypes?: readonly MCPExtensionResultTypeSpec[];
	hooks?: MCPExtensionHooks;
}

export type MCPExtensionConfigMap = Readonly<Record<string, MCPServerExtensionConfig | undefined>>;

type ActiveExtension = {
	definition: MCPExtensionDefinition;
	clientSettings: Record<string, unknown>;
};

const RESERVED_RESULT_TYPES = new Set(["complete", "input_required"]);
const EXTENSION_ID = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9][a-z0-9._/-]*$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function freezeValue<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) freezeValue(child);
		Object.freeze(value);
	}
	return value;
}

function snapshotRecord(value: unknown): Record<string, unknown> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	try {
		return freezeValue(structuredClone(record));
	} catch {
		return undefined;
	}
}

function readOnlyExtensionMap(
	states: ReadonlyMap<string, MCPNegotiatedExtensionState>,
): ReadonlyMap<string, MCPNegotiatedExtensionState> {
	const snapshot = new Map(states);
	const view: ReadonlyMap<string, MCPNegotiatedExtensionState> = {
		get size() {
			return snapshot.size;
		},
		has: key => snapshot.has(key),
		get: key => snapshot.get(key),
		entries: () => snapshot.entries(),
		keys: () => snapshot.keys(),
		values: () => snapshot.values(),
		forEach: (callback, thisArg) => {
			snapshot.forEach((value, key) => {
				callback.call(thisArg, value, key, view);
			});
		},
		[Symbol.iterator]: () => snapshot[Symbol.iterator](),
	};
	return Object.freeze(view);
}

/** Static allowlist of trusted, compiled-in extension definitions. */
export class MCPExtensionRegistry {
	readonly #definitions: ReadonlyMap<string, MCPExtensionDefinition>;

	private constructor(definitions: readonly MCPExtensionDefinition[]) {
		const registered = new Map<string, MCPExtensionDefinition>();
		const registeredResultTypes = new Set<string>();
		for (const definition of definitions) {
			if (!EXTENSION_ID.test(definition.id)) {
				throw new Error(
					`MCP extension identifier ${JSON.stringify(definition.id)} must be reverse-DNS with a path`,
				);
			}
			if (registered.has(definition.id)) {
				throw new Error(`Duplicate MCP extension identifier: ${definition.id}`);
			}
			const resultTypesSpec = definition.resultTypes
				? Object.freeze(
						definition.resultTypes.map(resultType => {
							if (!resultType.method || !resultType.resultType) {
								throw new Error(`MCP extension ${definition.id} has an invalid result type registration`);
							}
							if (RESERVED_RESULT_TYPES.has(resultType.resultType)) {
								throw new Error(
									`MCP extension ${definition.id} cannot register reserved resultType ${resultType.resultType}`,
								);
							}
							const key = `${resultType.method}\0${resultType.resultType}`;
							if (registeredResultTypes.has(key)) {
								throw new Error(
									`Duplicate resultType registration for method "${resultType.method}" and resultType "${resultType.resultType}"`,
								);
							}
							registeredResultTypes.add(key);
							return Object.freeze({
								method: resultType.method,
								resultType: resultType.resultType,
								validate: resultType.validate,
							});
						}),
					)
				: undefined;
			const erasSpec = Object.freeze([...(definition.eras ?? ["modern"])]);
			const hooksSpec = definition.hooks
				? Object.freeze({
						onNegotiated: definition.hooks.onNegotiated,
						onNotification: definition.hooks.onNotification,
					})
				: undefined;
			const frozenDefinition: MCPExtensionDefinition = Object.freeze({
				id: definition.id,
				eras: erasSpec,
				requiresServerAdvertisement: definition.requiresServerAdvertisement,
				validateConfig: definition.validateConfig,
				clientSettings: definition.clientSettings,
				parseServerSettings: definition.parseServerSettings,
				...(resultTypesSpec !== undefined ? { resultTypes: resultTypesSpec } : {}),
				...(hooksSpec !== undefined ? { hooks: hooksSpec } : {}),
			});
			registered.set(definition.id, frozenDefinition);
		}
		this.#definitions = registered;
		Object.freeze(this);
	}

	static create(definitions: readonly MCPExtensionDefinition[] = []): MCPExtensionRegistry {
		return new MCPExtensionRegistry(definitions);
	}

	get(id: string): MCPExtensionDefinition | undefined {
		return this.#definitions.get(id);
	}

	entries(): IterableIterator<[string, MCPExtensionDefinition]> {
		return this.#definitions.entries();
	}
}

/** No shipped extension is enabled by this foundation. */
export const OFFICIAL_MCP_EXTENSIONS: readonly MCPExtensionDefinition[] = Object.freeze([]);

/** Empty allowlist used by hosts that did not install an extension registry. */
export const EMPTY_MCP_EXTENSION_REGISTRY = MCPExtensionRegistry.create(OFFICIAL_MCP_EXTENSIONS);

/** Fail-closed validation of local extension policy. */
export function validateMCPExtensionConfig(
	registry: MCPExtensionRegistry,
	serverName: string,
	config: MCPExtensionConfigMap | undefined,
): string[] {
	if (!config) return [];
	const errors: string[] = [];
	for (const [id, rawConfig] of Object.entries(config)) {
		const definition = registry.get(id);
		if (!definition) {
			errors.push(`MCP server "${serverName}" config enables unregistered extension "${id}"`);
			continue;
		}
		if (rawConfig !== undefined && !asRecord(rawConfig)) {
			errors.push(`MCP server "${serverName}" extension "${id}" config must be an object`);
			continue;
		}
		const settings = rawConfig?.settings;
		if (settings !== undefined && !asRecord(settings)) {
			errors.push(`MCP server "${serverName}" extension "${id}" settings must be an object`);
			continue;
		}
		const error = definition.validateConfig?.(settings ?? {});
		if (error) errors.push(`MCP server "${serverName}" extension "${id}": ${error}`);
	}
	return errors;
}

/**
 * Per-connect provider state. It derives wire capabilities once and never
 * treats an unregistered server extension as executable host behavior.
 */
export class MCPExtensionRuntime {
	readonly #active: ReadonlyMap<string, ActiveExtension>;

	constructor(
		readonly registry: MCPExtensionRegistry,
		config: MCPExtensionConfigMap | undefined = undefined,
	) {
		const active = new Map<string, ActiveExtension>();
		for (const [id, definition] of registry.entries()) {
			const extensionConfig = config?.[id];
			if (extensionConfig?.enabled !== true) continue;
			const settings = snapshotRecord(definition.clientSettings(extensionConfig));
			if (!settings) throw new Error(`MCP extension ${id} clientSettings must return an object`);
			active.set(id, { definition, clientSettings: settings });
		}
		this.#active = active;
		Object.freeze(this);
	}

	/** Undefined, not {}, deliberately preserves the stock no-extension snapshot. */
	clientExtensionCapabilities(): MCPExtensionCapabilities | undefined {
		const capabilities: MCPExtensionCapabilities = {};
		for (const [id, extension] of this.#active) {
			if (!(extension.definition.eras ?? ["modern"]).includes("modern")) continue;
			capabilities[id] = structuredClone(extension.clientSettings);
		}
		return Object.keys(capabilities).length > 0 ? freezeValue(capabilities) : undefined;
	}

	/** Intersect enabled trusted providers with this connection's server offer. */
	negotiate(protocol: MCPConnectionProtocol): ReadonlyMap<string, MCPNegotiatedExtensionState> {
		const states = new Map<string, MCPNegotiatedExtensionState>();
		for (const [id, extension] of this.#active) {
			const eras = extension.definition.eras ?? ["modern"];
			if (!eras.includes(protocol.era)) continue;
			const advertised = protocol.capabilities.extensions?.[id];
			let serverSettings: unknown;
			if (extension.definition.requiresServerAdvertisement !== false) {
				if (!advertised) continue;
				try {
					serverSettings = extension.definition.parseServerSettings(advertised);
				} catch {
					continue;
				}
				if (serverSettings === undefined) continue;
			}
			const clientSettings = snapshotRecord(extension.clientSettings);
			const serverSnapshot = serverSettings === undefined ? undefined : snapshotRecord(serverSettings);
			if (!clientSettings || (serverSettings !== undefined && !serverSnapshot)) continue;
			const state: MCPNegotiatedExtensionState = freezeValue({
				id,
				serverSettings: serverSnapshot,
				clientSettings,
			});
			states.set(id, state);
		}
		return readOnlyExtensionMap(states);
	}

	onNegotiated(connection: MCPServerConnection): void {
		for (const [id, state] of connection.extensions ?? []) {
			this.#active.get(id)?.definition.hooks?.onNegotiated?.(connection, state);
		}
	}

	/** Route only a negotiated provider's identifier namespace; never generic server dispatch. */
	onNotification(connection: MCPServerConnection, method: string, params: unknown): boolean {
		const matches: string[] = [];
		for (const [id] of connection.extensions ?? []) {
			if (method.startsWith(`${id}/`)) {
				matches.push(id);
			}
		}
		if (matches.length === 0) return false;
		matches.sort((a, b) => b.length - a.length || b.localeCompare(a));
		const longestMatchId = matches[0];
		this.#active.get(longestMatchId)?.definition.hooks?.onNotification?.(connection, method, params);
		return true;
	}

	/** Returns a validator only for a negotiated, method-scoped extension result type. */
	acceptedResultTypeValidator(
		connection: MCPServerConnection,
		method: string,
		resultType: unknown,
	): ((result: Record<string, unknown>) => string | undefined) | undefined {
		if (typeof resultType !== "string") return undefined;
		for (const [id] of connection.extensions ?? []) {
			const spec = this.#active
				.get(id)
				?.definition.resultTypes?.find(
					candidate => candidate.method === method && candidate.resultType === resultType,
				);
			if (spec) return spec.validate;
		}
		return undefined;
	}
}

export function createMCPExtensionRuntime(
	registry: MCPExtensionRegistry,
	config: MCPExtensionConfigMap | undefined = undefined,
): MCPExtensionRuntime {
	return new MCPExtensionRuntime(registry, config);
}
