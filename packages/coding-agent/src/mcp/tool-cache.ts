/**
 * MCP tool cache.
 *
 * Stores tool definitions per server in agent.db for fast startup.
 */
import { isRecord, logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { AgentStorageApi } from "../session/agent-storage";
import { DEFAULT_MCP_TIMEOUT_MS } from "./timeout";
import { MCP_CONFIG_AS_WRITTEN, type MCPRequestIdFormat, type MCPServerConfig, type MCPToolDefinition } from "./types";

const CACHE_VERSION = 1;
const CACHE_PREFIX = "mcp_tools:";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type MCPToolCachePayload = {
	version: number;
	configHash: string;
	tools: MCPToolDefinition[];
};

/** A JSON field of {@link MCPServerConfig} (the as-written identity rides on a symbol key). */
type ConfigField = Extract<keyof MCPServerConfig, string>;

/**
 * Fields excluded from cache-identity hashing because they are connection
 * *policy* (when to connect, whether to connect at all, how long to wait
 * for a response, how outgoing request ids are encoded on the wire, whether
 * the server's instructions reach the system prompt), not part of the
 * server's identity — flipping any of them on an already-cached server must
 * still hit the cache, or an eager-to-lazy transition (or a
 * `timeout`/`requestIdFormat`/`instructions` tweak on an already-lazy
 * server) orphans the cache and starts the server tool-less.
 *
 * `instructions` has no exclusion-set history of its own: only released
 * builds hashed it, inside the full config (upstream v18.3.1 onward), so
 * {@link hashLegacyConfigs} enumerates it for that tier alone (see
 * {@link RELEASED_TIER_POLICY_KEYS}).
 */
const CURRENT_IDENTITY_EXCLUDED_KEYS: readonly ConfigField[] = [
	"lazy",
	"enabled",
	"timeout",
	"requestIdFormat",
	"instructions",
];

/**
 * Policy keys enumerated across every value they could hold at legacy
 * cache-write time (see {@link policyVariants}): each is two-valued, so
 * enumeration is exhaustive. `timeout` and `requestIdFormat` are
 * deliberately excluded from this set — neither is boolean, so their legacy
 * candidates in {@link hashLegacyConfigs} enumerate the field's own
 * documented value space (see {@link timeoutCandidates} and
 * {@link requestIdFormatCandidates}) instead of reusing `policyVariants`.
 */
const ENUMERATED_LEGACY_POLICY_KEYS: readonly ConfigField[] = ["lazy", "enabled"];

/**
 * Boolean policy keys enumerated only for the full-config tier (the empty
 * exclusion set released builds write). `instructions` reached
 * `MCPServerConfig` in upstream v18.3.1, so a released cache for a server
 * that sets it carries its value in the hash, while no earlier revision of
 * the exclusion sets ever saw the key.
 */
const RELEASED_TIER_POLICY_KEYS: readonly ConfigField[] = ["instructions"];

/**
 * Identity-exclusion sets of every earlier hashing scheme, recent first.
 * The last, excluding nothing, is the full-config hash released builds
 * write. The others come from earlier revisions of this lazy-connect
 * change: excluding `lazy`, `enabled`, and `timeout` (before
 * `requestIdFormat` joined the exclusion set), excluding `lazy` and
 * `enabled` (before `timeout` joined), and excluding only `lazy` (before
 * `enabled` was added). Checked on a miss so a cache written by any of
 * them still hits. This is required, not an optimization: an eager server
 * that misses just reconnects in the background and repopulates its cache,
 * but a *lazy* server with no cache registers no tools at all and stays
 * dormant until a manual `/mcp reconnect` (see `connectServers` in
 * `manager.ts`) — every algorithm change here would otherwise strand every
 * already-lazy server on upgrade.
 */
const LEGACY_IDENTITY_EXCLUDED_KEYS: ReadonlyArray<readonly ConfigField[]> = [
	["lazy", "enabled", "timeout"],
	["lazy", "enabled"],
	["lazy"],
	[],
];

function stripKeys(config: MCPServerConfig, keys: readonly ConfigField[]): Record<string, unknown> {
	const identity: Record<string, unknown> = { ...config };
	for (const key of keys) delete identity[key];
	return identity;
}

function hashIdentity(identity: Record<string, unknown>): string {
	return Bun.SHA256.hash(stableStringifyJson(identity), "hex");
}

/**
 * `oauth` members excluded from identity for the same reason as
 * {@link CURRENT_IDENTITY_EXCLUDED_KEYS}: they configure the *interactive
 * browser login* — what the authorization request asks to be prompted for,
 * and where the loopback listener that catches the redirect binds. Their
 * only consumer is `resolveCallbackOptions` in `oauth-flow.ts`; none of them
 * reaches the MCP connection, so toggling one serves no different tools and
 * spawns no different process. The rest of `oauth` stays: `clientId` and
 * `clientSecret` are the credentials the login presents, and `scope` is the
 * grant it asks for.
 */
const OAUTH_LOGIN_POLICY_KEYS = ["prompt", "redirectUri", "callbackPort", "callbackPath"] as const;

/**
 * `config` without its policy keys, and with every member that carries no
 * order put into one — identity is a question about the connection, so two
 * spellings of the same connection have to hash alike.
 *
 * - `envLiteralKeys` is consumed as a set (`new Set(...)` in
 *   `MCPManager.#prepareConfig`) but built in the `env` object's key order
 *   (`resolveMarketplaceEnv` in `discovery/claude-plugins.ts`), so swapping
 *   two expanded entries in a plugin's `.mcp.json` reorders an array without
 *   changing one resolved value. Membership still decides whether a value is
 *   resolved again, so it is sorted and deduped, never dropped. This is the
 *   partition `isSameMCPConnection` already applies in `capability/mcp.ts`.
 * - `oauth.scope` is a space-delimited scope list, and RFC 6749 §3.3 says the
 *   order of its values is not significant.
 * - {@link OAUTH_LOGIN_POLICY_KEYS} are deleted, and an `oauth` left empty by
 *   that goes with them: `oauth: { prompt: "login" }` and no `oauth` at all
 *   describe the same connection.
 *
 * Nothing else needs it. `env`, `headers` and `auth` are objects, and
 * {@link stableStringifyJson} already sorts object keys; `args` is argv, whose
 * order is the program's input and not a set; `type` is written by
 * `buildLegacyConfig` for every discovered server, so it never varies between
 * two readings of one entry.
 */
function identityRecord(config: MCPServerConfig): Record<string, unknown> {
	const identity = stripKeys(config, CURRENT_IDENTITY_EXCLUDED_KEYS);
	const literalKeys = identity.envLiteralKeys;
	if (Array.isArray(literalKeys)) identity.envLiteralKeys = [...new Set<unknown>(literalKeys)].sort();
	const oauth = identity.oauth;
	if (isRecord(oauth)) {
		const connection: Record<string, unknown> = { ...oauth };
		for (const key of OAUTH_LOGIN_POLICY_KEYS) delete connection[key];
		const scope = connection.scope;
		if (typeof scope === "string") connection.scope = scope.split(/\s+/).filter(Boolean).sort().join(" ");
		if (Object.keys(connection).length === 0) delete identity.oauth;
		else identity.oauth = connection;
	}
	return identity;
}

/** {@link identityRecord} as stable JSON. */
function identityJson(config: MCPServerConfig): string {
	return stableStringifyJson(identityRecord(config));
}

/**
 * Whether `a` and `b` are the same server: the same connection, differing at
 * most in {@link CURRENT_IDENTITY_EXCLUDED_KEYS} and
 * {@link OAUTH_LOGIN_POLICY_KEYS} — when to connect, whether to connect at
 * all, how long to wait, how request ids are encoded, whether the
 * instructions reach the prompt, how the browser login is driven — or in the
 * written order of something {@link identityRecord} normalises.
 *
 * Shared with the manager's crash-burst breaker, which retires a server's
 * window when the definition it was filled against is replaced. The two ask
 * slightly different questions — the cache asks whether this would serve
 * different tools, the breaker whether this is a different process to crash —
 * but they partition the fields the same way, because every excluded key is
 * policy applied to one unchanged endpoint or process and every other key
 * names the endpoint, the executable, its arguments, its environment, its
 * directory or the credentials it presents. One definition of "a different
 * server", so a rewrite cannot be identity for one of them and not the other.
 *
 * The effective config is the right input here, not the as-written one: "is
 * this a different process" is a question about what will be spawned or
 * dialled, and a symbol-keyed as-written record is invisible to JSON anyway.
 */
export function sameMcpServerIdentity(a: MCPServerConfig, b: MCPServerConfig): boolean {
	return identityJson(a) === identityJson(b);
}

/**
 * Give a discovered config its cache identity: `asWritten`, the same server
 * built from its config-file entry before the provider expanded `${VAR}`
 * placeholders (or read an env-forwarded value, a `{file:...}` reference or a
 * plugin root). A rotated credential then keeps the server's catalog, and an
 * edited literal still drops it. A lazy server depends on this: on a miss it
 * starts with no tools, so nothing can call it and connect it.
 */
export function attachConfigAsWritten(config: MCPServerConfig, asWritten: MCPServerConfig): void {
	config[MCP_CONFIG_AS_WRITTEN] = { config: asWritten, attachedTo: identityJson(config) };
}

/**
 * The config a cache entry is keyed on: the as-written form discovery attached
 * ({@link attachConfigAsWritten}), or `config` itself when it has none or is a
 * copy whose connection fields changed since. A policy edit (`enabled`,
 * `lazy`, ...) keeps the as-written form.
 */
function cacheIdentityConfig(config: MCPServerConfig): MCPServerConfig {
	const asWritten = config[MCP_CONFIG_AS_WRITTEN];
	return asWritten && asWritten.attachedTo === identityJson(config) ? asWritten.config : config;
}

/**
 * Every boolean-policy-value combination a legacy scheme could have baked
 * into its hash for `keys`: each key absent, `true`, or `false`. Legacy
 * hashes must enumerate these rather than reuse the *current* config's
 * policy values — a version-1 cache written from `{ command, enabled: true
 * }` has to match today's `{ command, lazy: true }` (user dropped the
 * redundant `enabled` while adopting `lazy`), because policy fields are by
 * definition not part of the server's identity. Values are booleans only:
 * discovery coerces the accepted string forms before an `MCPServerConfig`
 * ever reaches hashing. Only {@link ENUMERATED_LEGACY_POLICY_KEYS}, plus
 * {@link RELEASED_TIER_POLICY_KEYS} for the full-config tier, are ever
 * passed in; see {@link hashLegacyConfigs} for the non-boolean policy keys.
 */
function policyVariants(keys: readonly ConfigField[]): Record<string, boolean>[] {
	let variants: Record<string, boolean>[] = [{}];
	for (const key of keys) {
		variants = variants.flatMap(variant => [variant, { ...variant, [key]: true }, { ...variant, [key]: false }]);
	}
	return variants;
}

/**
 * Timeout values enumerated for legacy migration, alongside the *current*
 * config's own value (the common "value unchanged since caching" case):
 * the field's own documented sentinels — its default (a config that never
 * set `timeout` resolves to this) and `0` ("disable") — plus omission
 * (never set at all). These are the field's whole documented value space,
 * not a guess at arbitrary history: an explicit timeout outside this small
 * set that also changed value across the same upgrade can't be recovered
 * without the literal historical number, which no digest keeps — that
 * residual case costs one self-healing miss, same as any other
 * unrecognized identity change already does for a lazy server.
 */
function timeoutCandidates(current: number | undefined): Array<number | undefined> {
	return [...new Set([undefined, 0, DEFAULT_MCP_TIMEOUT_MS, current])];
}

/**
 * `requestIdFormat` candidates enumerated for legacy migration: the field's
 * whole documented value space (unset, meaning the runtime default of
 * numeric ids, plus the two explicit encodings) alongside the *current*
 * config's own value. Unlike `timeout` this space is already exhaustive —
 * there is no unbounded historical value to miss — but `current` is kept
 * for symmetry with {@link timeoutCandidates} and because the `Set` below
 * dedupes it for free.
 */
function requestIdFormatCandidates(current: MCPRequestIdFormat | undefined): Array<MCPRequestIdFormat | undefined> {
	return [...new Set([undefined, "number", "string", current] as const)];
}

/**
 * Hashes of `config` under every retired identity scheme, for cache-miss
 * migration. Every one of them hashed the *expanded* config, un-normalised,
 * which is why this starts from {@link stripKeys} and not
 * {@link identityRecord}: the first entry is the scheme just before
 * {@link identityRecord} and {@link attachConfigAsWritten} (policy keys
 * excluded, nothing normalised), and {@link LEGACY_IDENTITY_EXCLUDED_KEYS}
 * lists the ones before that, ending with the empty set — the full-config
 * hash released builds write.
 *
 * A released cache keyed on a plugin's or a codex server's expanded config
 * therefore survives this change without a `CACHE_VERSION` bump, through the
 * released tier this already enumerates (the `[]` entry, which reconstructs
 * the whole effective config), not through the first tier, which excludes
 * policy. What it cannot recover is an entry whose newly normalised or
 * newly excluded value *also* changed across the upgrade — a reordered
 * `envLiteralKeys`, an edited `oauth.prompt` — since no digest keeps the
 * historical text. That costs one self-healing miss, the same residual
 * {@link timeoutCandidates} already documents.
 */
function hashLegacyConfigs(config: MCPServerConfig): string[] {
	const identity = stripKeys(config, CURRENT_IDENTITY_EXCLUDED_KEYS);
	const hashes = new Set<string>([hashIdentity(identity)]);
	for (const excluded of LEGACY_IDENTITY_EXCLUDED_KEYS) {
		// Policy keys the legacy scheme still hashed (did not yet exclude).
		const hashedPolicyKeys = CURRENT_IDENTITY_EXCLUDED_KEYS.filter(key => !excluded.includes(key));
		const enumeratedKeys = hashedPolicyKeys.filter(
			key =>
				ENUMERATED_LEGACY_POLICY_KEYS.includes(key) ||
				(excluded.length === 0 && RELEASED_TIER_POLICY_KEYS.includes(key)),
		);
		const timeoutValues = hashedPolicyKeys.includes("timeout") ? timeoutCandidates(config.timeout) : [undefined];
		const requestIdFormatValues = hashedPolicyKeys.includes("requestIdFormat")
			? requestIdFormatCandidates(config.requestIdFormat)
			: [undefined];
		for (const timeoutValue of timeoutValues) {
			for (const requestIdFormatValue of requestIdFormatValues) {
				const base: Record<string, unknown> = { ...identity };
				if (timeoutValue !== undefined) base.timeout = timeoutValue;
				if (requestIdFormatValue !== undefined) base.requestIdFormat = requestIdFormatValue;
				for (const variant of policyVariants(enumeratedKeys)) {
					hashes.add(hashIdentity({ ...base, ...variant }));
				}
			}
		}
	}
	return [...hashes];
}

function cacheKey(serverName: string): string {
	return `${CACHE_PREFIX}${serverName}`;
}

export class MCPToolCache {
	constructor(private storage: AgentStorageApi) {}

	async get(serverName: string, config: MCPServerConfig): Promise<MCPToolDefinition[] | null> {
		const key = cacheKey(serverName);
		const raw = this.storage.getCache(key);
		if (!raw) return null;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			logger.warn("MCP tool cache parse failed", { serverName, error: String(error) });
			return null;
		}

		if (!isRecord(parsed)) return null;
		if (parsed.version !== CACHE_VERSION) return null;
		if (typeof parsed.configHash !== "string") return null;
		if (!Array.isArray(parsed.tools)) return null;

		let currentHash: string;
		try {
			currentHash = hashIdentity(identityRecord(cacheIdentityConfig(config)));
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return null;
		}

		if (parsed.configHash !== currentHash) {
			let legacyHashes: string[];
			try {
				legacyHashes = hashLegacyConfigs(config);
			} catch (error) {
				logger.warn("MCP tool cache legacy hash failed", { serverName, error: String(error) });
				return null;
			}
			if (!legacyHashes.includes(parsed.configHash)) return null;
		}

		return parsed.tools as MCPToolDefinition[];
	}

	async set(serverName: string, config: MCPServerConfig, tools: MCPToolDefinition[]): Promise<void> {
		let configHash: string;
		try {
			configHash = hashIdentity(identityRecord(cacheIdentityConfig(config)));
		} catch (error) {
			logger.warn("MCP tool cache hash failed", { serverName, error: String(error) });
			return;
		}

		const payload: MCPToolCachePayload = {
			version: CACHE_VERSION,
			configHash,
			tools,
		};

		let serialized: string;
		try {
			serialized = JSON.stringify(payload);
		} catch (error) {
			logger.warn("MCP tool cache serialize failed", { serverName, error: String(error) });
			return;
		}

		const expiresAtSec = Math.floor((Date.now() + CACHE_TTL_MS) / 1000);
		this.storage.setCache(cacheKey(serverName), serialized, expiresAtSec);
	}
}
