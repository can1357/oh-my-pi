/**
 * UI-agnostic MCP OAuth reauthorization engine.
 *
 * Both the interactive `McpCommandController` and the shared ACP/text
 * `/mcp` dispatcher drive `/mcp reauth` through this module so the flow can
 * never drift between clients: server lookup precedence (project over user —
 * matching runtime discovery's first-wins enumeration — plus standalone
 * `mcp.json`/`.mcp.json` fallbacks), the anonymous connection
 * probe, endpoint discovery, client-credential assembly (configured >
 * persisted > stored > metadata-advertised, DCR preferred), the browser flow
 * itself, and the persistence policy (url-keyed credential row, `auth` block
 * pointer, only user-supplied secrets written back) live here exactly once.
 * Callers supply only presentation: how the authorization URL and progress are
 * shown, and (TUI only) where manual code input comes from.
 */
import * as path from "node:path";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import type { OAuthController } from "@oh-my-pi/pi-ai/oauth/types";
import { expandEnvVarsDeep } from "../discovery/helpers";
import { connectToServer, disconnectServer } from "./client";
import { readMCPConfigFile, updateMCPServer } from "./config-writer";
import { MCPManager } from "./manager";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	type OAuthEndpoints,
} from "./oauth-discovery";
import {
	hasMcpAuthorizationHeader,
	lookupMcpOAuthCredentialForServer,
	removeManagedMcpOAuthCredential,
} from "./oauth-credentials";
import { MCPOAuthFlow, type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "./oauth-flow";
import type { AuthStorage } from "../session/auth-storage";
import type { MCPAuthChallenge, MCPAuthConfig, MCPServerConfig } from "./types";

export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
	onTimeout?: () => void,
): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => {
		onTimeout?.();
		reject(new Error(message));
	}, timeoutMs);
	return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Reject as soon as `signal` aborts, even when `promise` cannot observe it
 * (e.g. an in-flight `fetch` before the flow's own callback wait starts).
 * `promise` stays observed, so its later rejection is never unhandled.
 */
export function raceAbortSignal<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	createError: () => Error,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		void promise.catch(() => {});
		return Promise.reject(createError());
	}

	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => aborted.reject(createError());
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

type ActiveMCPOAuthFlow = {
	cancel: (reason: string) => void;
	completion: Promise<void>;
	complete: () => void;
};

type MCPOAuthFlowCoordinator = {
	active?: ActiveMCPOAuthFlow;
	transition: Promise<void>;
};

const mcpOAuthFlowCoordinators = new WeakMap<object, MCPOAuthFlowCoordinator>();
const MCP_OAUTH_SUPERSEDED_REASON = "MCP OAuth flow superseded by a new login";
/** Default single-flight key for hosts without a stable manual-input owner (ACP/RPC/text). */
const defaultMcpOAuthFlowOwner: object = {};

/**
 * Serialize MCP OAuth ownership across invocations: a new flow cancels the
 * active one, and concurrent starters queue behind the running transition.
 * The interactive TUI keys this on its manual-input manager (stable for the
 * session while command controllers are per-command); other hosts share the
 * module-level owner.
 */
async function claimMCPOAuthFlow(owner: object, cancel: (reason: string) => void): Promise<{ release: () => void }> {
	let coordinator = mcpOAuthFlowCoordinators.get(owner);
	if (!coordinator) {
		coordinator = { transition: Promise.resolve() };
		mcpOAuthFlowCoordinators.set(owner, coordinator);
	}

	const precedingTransition = coordinator.transition;
	const transition = Promise.withResolvers<void>();
	coordinator.transition = transition.promise;
	await precedingTransition;

	try {
		const active = coordinator.active;
		if (active) {
			active.cancel(MCP_OAUTH_SUPERSEDED_REASON);
			await active.completion;
		}

		const completion = Promise.withResolvers<void>();
		const flow: ActiveMCPOAuthFlow = {
			cancel,
			completion: completion.promise,
			complete: () => completion.resolve(),
		};
		coordinator.active = flow;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				if (coordinator.active === flow) coordinator.active = undefined;
				flow.complete();
			},
		};
	} finally {
		transition.resolve();
	}
}

export interface OAuthFlowResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

/**
 * Thrown when the user (or a caller-supplied {@link AbortSignal}) cancels the
 * in-flight flow. Distinct from network/timeout failures so callers can
 * surface a neutral "cancelled" status instead of an error banner.
 */
export class MCPOAuthCancelledError extends Error {
	constructor(message = "OAuth flow cancelled") {
		super(message);
		this.name = "MCPOAuthCancelledError";
	}
}

/**
 * User-actionable refusal (stdio transport, disabled server, anonymous
 * server, …): the message is the guidance itself, so non-interactive callers
 * surface it verbatim instead of wrapping it in a failure prefix.
 */
export class McpReauthRefusalError extends Error {}

export interface FoundMcpServer {
	filePath: string;
	scope: "user" | "project";
	config: MCPServerConfig;
	/** Live-manager entry that lives in no writable config file; writes go to user scope. */
	discovered: boolean;
	/**
	 * The manager entry belongs to an ACP-isolated session: the client declared
	 * this server at `session/new` and re-declares it (headers included) every
	 * session, so its definition is session-owned — never a candidate for
	 * user-config write-back.
	 */
	acpOwned?: boolean;
}

/**
 * Resolve a server for an auth/test operation. Project wins over user on a
 * name collision — runtime discovery enumerates project paths first and
 * deduplicates first-wins, so the project entry is the server actually
 * invoked — then falls back to standalone `mcp.json` / `.mcp.json` (the
 * mcp-json discovery paths), then to runtime-discovered servers (`/mcp list`
 * surfaces marketplace/Claude-Code-plugin entries that live in no writable
 * config). For a discovered server, persisted changes are written into the
 * user config under the same namespaced name; the native provider
 * (priority 100) shadows the discovered entry after the next reload.
 *
 * `preferManager` flips the first step — but only for ACP-isolated managers:
 * ACP declares servers at `session/new` (source `provider: "acp"`), and
 * isolation means the manager entry is the server actually active while a
 * same-named file entry is inert. Print/RPC managers enumerate the same files
 * the lookup below reads, and their entries are env-expanded copies with
 * synthesized user-config paths — preferring them would shadow the real
 * project/user source, serialize expanded `${...}` placeholders, and write
 * fresh bindings to the wrong file.
 */
export async function findMcpServerForAuth(
	name: string,
	cwd: string = getProjectDir(),
	mcpManager?: MCPManager,
	options?: { preferManager?: boolean; enableProjectConfig?: boolean },
): Promise<FoundMcpServer | null> {
	if (options?.preferManager) {
		const managerConfig = mcpManager?.getServerConfig(name);
		const managerSource = mcpManager?.getSource(name);
		if (managerConfig && managerSource?.provider === "acp") {
			return {
				filePath: getMCPConfigPath("user", cwd),
				scope: "user",
				config: managerConfig,
				discovered: true,
				acpOwned: true,
			};
		}
	}
	const userPath = getMCPConfigPath("user", cwd);
	const projectPath = getMCPConfigPath("project", cwd);

	// `mcp.enableProjectConfig: false` opts the project out of project-scoped
	// config at startup; the lookup must not resurrect an opted-out entry here
	// (a reauth would write a credential binding for a server that never loads).
	const enableProjectConfig = options?.enableProjectConfig ?? true;
	const [userConfig, projectConfig] = await Promise.all([
		readMCPConfigFile(userPath),
		enableProjectConfig ? readMCPConfigFile(projectPath) : Promise.resolve(null),
	]);

	// Project wins over user on a name collision: runtime discovery enumerates
	// project paths first and deduplicates first-wins, so the project entry is
	// the server users actually invoke. Refreshing the user shadow instead
	// would report success while the active project server keeps its stale
	// credential after the next reload.
	if (enableProjectConfig && projectConfig?.mcpServers?.[name]) {
		return { filePath: projectPath, scope: "project", config: projectConfig.mcpServers[name], discovered: false };
	}
	if (userConfig.mcpServers?.[name]) {
		return { filePath: userPath, scope: "user", config: userConfig.mcpServers[name], discovered: false };
	}

	// Standalone fallback files match the discovery paths used by the
	// mcp-json provider; precedence is preserved by iteration order. Both are
	// project-level sources, so the same `enableProjectConfig` opt-out applies.
	const standalonePaths = enableProjectConfig ? [path.join(cwd, "mcp.json"), path.join(cwd, ".mcp.json")] : [];
	const fallbackConfigs = await Promise.all(
		standalonePaths.map(async fallbackPath => {
			try {
				return await readMCPConfigFile(fallbackPath);
			} catch {
				// Malformed JSON in a standalone file — skip and continue lookup.
				return null;
			}
		}),
	);
	for (const [index, fallbackConfig] of fallbackConfigs.entries()) {
		const config = fallbackConfig?.mcpServers?.[name];
		if (config) {
			return { filePath: standalonePaths[index]!, scope: "project", config, discovered: false };
		}
	}

	const config = mcpManager?.getServerConfig(name);
	const source = mcpManager?.getSource(name);
	if (!config || !source) return null;

	return { filePath: userPath, scope: "user", config, discovered: true };
}

/** Strip the `auth` block so a probe or flow starts from the raw server config. */
export function stripMcpOAuthAuth(config: MCPServerConfig): MCPServerConfig {
	const next = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
	delete next.auth;
	return next;
}

/**
 * Drop a server definition's client-supplied auth surface so the next
 * `MCPManager` auth resolution picks up the fresh url-keyed credential row a
 * reauth just wrote: while an `Authorization` header is present the manager
 * disables the url-keyed credential fallback, and a stale `auth` block
 * answers first — either would keep the expired credential in charge of the
 * reconnect.
 */
export function clearMcpClientAuthSurface(config: MCPServerConfig): MCPServerConfig {
	const next = stripMcpOAuthAuth(config);
	if (next.type !== "http" && next.type !== "sse") return next;
	const headers: Record<string, string> = { ...next.headers };
	for (const header of Object.keys(headers)) {
		if (header.toLowerCase() === "authorization") delete headers[header];
	}
	return { ...next, headers };
}

/**
 * The host manager's entry for `name`, but only when it is the same server
 * definition a reauth just refreshed (`selected`). A name collision must not
 * reconnect an unrelated manager entry: file/config lookups deliberately
 * prefer user/project entries over the manager fallback, so an ACP client
 * declaring `foo` at URL B while a config file carries a different `foo` at
 * URL A would otherwise have its live entry torn down and reconnected with
 * no matching credential. Definitions correspond when both are http/sse with
 * the same URL (raw or env-expanded — the manager stores the expanded form).
 */
export function matchingManagerServerConfig(
	manager: MCPManager | undefined,
	name: string,
	selected: MCPServerConfig,
): MCPServerConfig | undefined {
	if (selected.type !== "http" && selected.type !== "sse") return undefined;
	const managerConfig = manager?.getServerConfig(name);
	if (!managerConfig || managerConfig.type !== selected.type) return undefined;
	const urls = [expandEnvVarsDeep(selected.url), selected.url];
	return urls.includes(managerConfig.url) ? managerConfig : undefined;
}

/**
 * Reconnect the host manager's entry for a reauthorized server and report the
 * post-reconnect state: `undefined` when the manager does not own the
 * selected definition (callers fall back to restart guidance).
 *
 * Clears the entry's client-supplied auth surface first (a preserved bearer
 * header would keep the fresh url-keyed credential row out of the reconnect),
 * awaits a pending automatic reconnect — it captured the old definition and
 * aborts on the identity check, and joining it would report "disconnected,
 * retries continue" with no retries left — then starts a fresh manual attempt
 * against the updated definition.
 */
export async function reconnectMcpManagerServer(
	manager: MCPManager | undefined,
	name: string,
	selected: MCPServerConfig,
): Promise<"connected" | "connecting" | "disconnected" | undefined> {
	if (!manager) return undefined;
	const managerConfig = matchingManagerServerConfig(manager, name, selected);
	if (!managerConfig) return undefined;
	const pending = manager.updateServerConfig(name, clearMcpClientAuthSurface(managerConfig));
	if (pending) await pending;
	await manager.reconnectServer(name, { manual: true });
	return manager.getConnectionStatus(name);
}

/**
 * Throwaway connection used to probe a server's auth requirements. Uses the
 * host's manager when available (its `prepareConfig` honors live state),
 * else a temporary manager bound to the caller's auth storage.
 */
export async function probeMcpConnection(
	config: MCPServerConfig,
	options: { oauth?: boolean; authStorage: AuthStorage; mcpManager?: MCPManager; cwd?: string },
): Promise<void> {
	let resolvedConfig: MCPServerConfig;
	if (options.mcpManager) {
		resolvedConfig = await options.mcpManager.prepareConfig(config, { oauth: options.oauth });
	} else {
		const tempManager = new MCPManager(options.cwd ?? getProjectDir());
		tempManager.setAuthStorage(options.authStorage);
		resolvedConfig = await tempManager.prepareConfig(config, { oauth: options.oauth });
	}

	const connection = await connectToServer(`mcp_probe_${Date.now()}`, resolvedConfig);
	await disconnectServer(connection);
}

/**
 * Resolve the OAuth endpoints a reauth needs from the server itself:
 * probe anonymously first (nothing destructive has happened yet), then either
 * take discovery metadata (a clean `initialize` is only weak evidence per the
 * MCP spec, so honor the explicit reauth when the server advertises OAuth) or
 * analyze the auth failure and discover from it. A tool-level challenge
 * overrides the clean probe result.
 */
export async function resolveMcpOAuthEndpointsFromServer(
	config: MCPServerConfig,
	opts: {
		authChallenge?: MCPAuthChallenge;
		signal?: AbortSignal;
		authStorage: AuthStorage;
		mcpManager?: MCPManager;
		cwd?: string;
	},
): Promise<OAuthEndpoints> {
	// Stdio servers manage credentials inside the child process; OMP's OAuth
	// flow only applies to http/sse transports. Without this guard the
	// unauthenticated preflight below spawns the child, which happily reuses
	// its own cached tokens (e.g. mcp-remote's machine-wide ~/.mcp-auth) and
	// produces the misleading "reauthorization is not required".
	if (config.type !== "http" && config.type !== "sse") {
		const remoteUrl = config.args?.find(arg => /^https?:\/\//.test(arg));
		const httpHint = `{ "type": "http", "url": ${JSON.stringify(remoteUrl ?? "<remote url>")} }`;
		const usesMcpRemote = [config.command, ...(config.args ?? [])].some(part => part?.includes("mcp-remote"));
		throw new McpReauthRefusalError(
			usesMcpRemote
				? `this server proxies OAuth through mcp-remote, which caches tokens machine-wide in ~/.mcp-auth (shared across every OMP profile). Clear ~/.mcp-auth to force a fresh login, or replace the proxy with ${httpHint} so OMP manages OAuth per profile.`
				: `stdio servers manage their own credentials, so OMP has no OAuth to reauthorize. If the service supports OAuth over HTTP, configure it as ${httpHint} instead.`,
		);
	}
	let connectionSucceeded = false;
	let connectionError: Error | undefined;
	try {
		await probeMcpConnection(stripMcpOAuthAuth(config), {
			oauth: false,
			authStorage: opts.authStorage,
			mcpManager: opts.mcpManager,
			cwd: opts.cwd,
		});
		connectionSucceeded = true;
	} catch (error) {
		connectionError = error instanceof Error ? error : new Error(String(error));
	}

	if (connectionSucceeded && !opts.authChallenge) {
		const discovered =
			"url" in config && config.url
				? await discoverOAuthEndpoints(config.url, undefined, undefined, { signal: opts.signal })
				: null;
		if (!discovered) {
			throw new McpReauthRefusalError("Server connection succeeded without OAuth; reauthorization is not required.");
		}
		return discovered;
	}

	// Tool calls can carry richer RFC 6750/RFC 9728 hints than the original
	// connection error. Feed those hints through the same analyzer so
	// resource_metadata and scope reach protected-resource discovery.
	const authError = opts.authChallenge
		? new Error(`${connectionError?.message ?? "HTTP 401"}\n${opts.authChallenge.wwwAuthenticate.join("\n")}`)
		: connectionError!;
	const authResult = analyzeAuthError(authError, "url" in config ? config.url : undefined);
	let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;

	if (!oauth && (config.type === "http" || config.type === "sse") && config.url) {
		oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl, authResult.resourceMetadataUrl, {
			protectedScopes: authResult.scopes,
			signal: opts.signal,
		});
	}
	if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
		// JSON-error-body path skips `discoverOAuthEndpoints`; fetch the
		// advertised protected-resource metadata for the required scopes.
		const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
		if (scopes) oauth = { ...oauth, scopes };
	}

	if (!oauth) {
		throw new Error("Could not discover OAuth endpoints from server response.");
	}

	return oauth;
}

export type McpOAuthFlowPresentation = Pick<OAuthController, "onAuth" | "onProgress" | "onManualCodeInput"> & {
	onFlowComplete?: () => void;
	/**
	 * Release the manual-input claim taken by {@link onManualCodeInput}. The
	 * engine calls this in its `finally` *before* the single-flight claim
	 * releases, so a superseding flow (which wakes on the single-flight
	 * completion) observes the pending manual input already gone instead of
	 * refusing to start.
	 */
	releaseManualInput?: () => void;
};

export interface McpOAuthFlowRunOptions extends McpOAuthFlowPresentation {
	authUrl: string;
	tokenUrl: string;
	clientId: string;
	clientSecret: string;
	scopes: string;
	serverUrl?: string;
	registrationUrl?: string;
	issuerUrl?: string;
	resource?: string;
	stripSameOriginResource?: boolean;
	callbackPort?: number;
	callbackPath?: string;
	redirectUri?: string;
	prompt?: string;
	authStorage: AuthStorage;
	/**
	 * External cancellation: host abort, Esc, or a wizard's controller. Aborts
	 * the in-flight flow and throws {@link MCPOAuthCancelledError}.
	 */
	signal?: AbortSignal;
	/** Single-flight lifecycle key; defaults to a module-level owner. */
	flowOwner?: object;
	/** Busy manual-input provider name, to fail fast before starting the flow. */
	pendingInput?: () => string | undefined;
	/**
	 * Fires once the flow's single-flight claim resolves, before any browser
	 * work starts. Hosts that install UI around the flow (the TUI's Esc hook)
	 * do it here, not before the claim: a flow superseded while queued must
	 * install — and later restore — nothing, or it resurrects a dead
	 * predecessor's UI over the live default.
	 */
	onClaimed?: () => void;
}

/**
 * Run one MCP OAuth browser flow and persist its credential row.
 * Normalizes the client secret (`""` means "none" so a DCR-issued secret
 * reaches the token exchange), races the login against the abort signal, and
 * tears the flow down on the 5-minute deadline.
 */
export async function runMcpOAuthFlow(opts: McpOAuthFlowRunOptions): Promise<OAuthFlowResult> {
	let parsedAuthUrl: URL;
	try {
		parsedAuthUrl = new URL(opts.authUrl);
		new URL(opts.tokenUrl);
	} catch {
		throw new Error(
			`Invalid OAuth URLs. Please check:\n  Authorization URL: ${opts.authUrl}\n  Token URL: ${opts.tokenUrl}`,
		);
	}

	const resolvedClientId = opts.clientId.trim() || parsedAuthUrl.searchParams.get("client_id")?.trim() || undefined;
	const resolvedClientSecret = opts.clientSecret.trim() || undefined;

	const oauthTimeout = new AbortController();
	// Esc, external aborts, and a replacement MCP flow route through here;
	// the timeout path sets its own reason and leaves this flag false so the
	// catch can distinguish cancellation (status) from deadline failure.
	let cancellationRequested = false;
	const requestCancellation = (reason: string): void => {
		cancellationRequested = true;
		if (!oauthTimeout.signal.aborted) oauthTimeout.abort(reason);
	};
	const flowClaim = await claimMCPOAuthFlow(opts.flowOwner ?? defaultMcpOAuthFlowOwner, requestCancellation);
	// Host UI installs here (TUI Esc): after the claim resolved, so a flow
	// superseded while queued installs — and restores — nothing.
	opts.onClaimed?.();
	const externalSignal = opts.signal;
	const onExternalAbort = (): void => {
		const reason = externalSignal?.reason;
		requestCancellation(typeof reason === "string" ? reason : "MCP OAuth flow cancelled by user");
	};
	if (externalSignal?.aborted) {
		onExternalAbort();
	} else {
		externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
	}
	try {
		const pendingProvider = opts.pendingInput?.();
		if (pendingProvider) {
			throw new Error(
				`OAuth login already in progress for ${pendingProvider}. Complete or cancel it before starting MCP OAuth.`,
			);
		}
		// Create OAuth flow
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: opts.authUrl,
				tokenUrl: opts.tokenUrl,
				registrationUrl: opts.registrationUrl,
				issuerUrl: opts.issuerUrl,
				clientId: resolvedClientId,
				clientSecret: resolvedClientSecret,
				scopes: opts.scopes || undefined,
				prompt: opts.prompt,
				redirectUri: opts.redirectUri,
				callbackPort: opts.callbackPort,
				callbackPath: opts.callbackPath,
				resource: opts.resource,
				stripSameOriginResource: opts.stripSameOriginResource,
			},
			{
				onAuth: opts.onAuth,
				onProgress: opts.onProgress,
				onManualCodeInput: opts.onManualCodeInput,
				signal: oauthTimeout.signal,
			},
		);

		const createAbortError = (): Error => {
			const reason = String(oauthTimeout.signal.reason ?? "MCP OAuth flow aborted");
			return cancellationRequested ? new MCPOAuthCancelledError() : new Error(reason);
		};
		if (oauthTimeout.signal.aborted) throw createAbortError();

		// Execute OAuth flow with 5 minute timeout. Race the login itself
		// against the abort signal because Esc/external abort may fire before
		// MCPOAuthFlow reaches OAuthCallbackFlow.#waitForCallback, where the
		// underlying callback server normally observes the signal.
		const credentials = await withTimeout(
			raceAbortSignal(flow.login(), oauthTimeout.signal, createAbortError),
			5 * 60 * 1000,
			"OAuth flow timed out after 5 minutes",
			() => oauthTimeout.abort("MCP OAuth flow timed out"),
		);

		// Deterministic per-URL id: every profile resolves its own credential row
		// under the same key, so shared project configs stay profile-isolated.
		// Random fallback only for flows that never knew the server URL.
		const credentialId = opts.serverUrl
			? mcpOAuthCredentialId(opts.serverUrl)
			: `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

		// Embed refresh material so the credential is self-contained: token
		// refresh must work for configs that carry no auth block at all.
		const oauthCredential: MCPStoredOAuthCredential = {
			type: "oauth",
			...credentials,
			tokenUrl: opts.tokenUrl,
			clientId: flow.resolvedClientId?.trim() || resolvedClientId,
			clientSecret: flow.registeredClientSecret ?? resolvedClientSecret,
			resource: flow.resource,
			authorizationUrl: flow.authorizationUrl,
		};

		await opts.authStorage.credentials.set(credentialId, oauthCredential);
		opts.onFlowComplete?.();

		return {
			credentialId,
			clientId: flow.resolvedClientId,
			resource: flow.resource,
		};
	} catch (error) {
		// Esc, an external abort, or a newer MCP flow are neutral
		// cancellations. The timeout path also aborts the controller but does
		// not set this flag, so it remains a surfaced error.
		if (cancellationRequested) {
			throw new MCPOAuthCancelledError();
		}

		const errorMsg = error instanceof Error ? error.message : String(error);

		// Provide helpful error messages based on failure type
		if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
			throw new Error("OAuth flow timed out. Please try again.");
		} else if (errorMsg.includes("403") || errorMsg.includes("unauthorized")) {
			throw new Error("OAuth authorization failed. Please check your client credentials.");
		} else if (errorMsg.includes("invalid_grant")) {
			throw new Error("OAuth authorization code is invalid or expired. Please try again.");
		} else if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("fetch failed")) {
			throw new Error("Could not connect to OAuth server. Please check the URLs and your network connection.");
		} else {
			throw new Error(`OAuth authentication failed: ${errorMsg}`);
		}
	} finally {
		opts.releaseManualInput?.();
		externalSignal?.removeEventListener("abort", onExternalAbort);
		flowClaim.release();
	}
}

/**
 * Fold a completed OAuth flow back into a server config. Owns the persistence
 * policy in one place: the auth block records the credential pointer plus
 * refresh material, the oauth block echoes the client id for pre-auth reuse,
 * and only a user-supplied client secret is ever written — DCR-issued secrets
 * stay embedded in the stored credential so they cannot leak into (possibly
 * shared/committed) config files.
 */
export function persistMcpOAuthResult(
	config: MCPServerConfig,
	result: OAuthFlowResult,
	opts: {
		tokenUrl: string;
		resource?: string;
		stripSameOriginResource?: boolean;
		clientId?: string;
		persistOAuthClientId?: boolean;
		userClientSecret?: string;
	},
): MCPServerConfig {
	const clientId = result.clientId?.trim() || opts.clientId?.trim() || config.oauth?.clientId?.trim();
	const oauthClientId = opts.persistOAuthClientId === false ? undefined : clientId;
	const resource =
		result.resource ?? (opts.stripSameOriginResource ? undefined : opts.resource) ?? config.auth?.resource;
	return {
		...config,
		auth: {
			type: "oauth",
			credentialId: result.credentialId,
			tokenUrl: opts.tokenUrl,
			clientId,
			clientSecret: opts.userClientSecret,
			resource,
		},
		oauth: {
			...config.oauth,
			clientId: oauthClientId,
		},
	};
}

export interface McpReauthOptions extends McpOAuthFlowPresentation {
	authStorage: AuthStorage;
	/** Host cancellation; wired before the anonymous probe so the whole reauth is abortable. */
	signal?: AbortSignal;
	/** Tool-level `_meta["mcp/www_authenticate"]` challenge that triggered an auto-reauth. */
	authChallenge?: MCPAuthChallenge;
	/** Host's live manager, used to prepare the anonymous probe config. */
	mcpManager?: MCPManager;
	cwd?: string;
	/** Suppresses the "Reauthorizing…" notice (auto-reauth on a 401 challenge). */
	silent?: boolean;
	/** Presentation for the pre-flow notice. */
	onReauthorizing?: () => void;
	flowOwner?: object;
	pendingInput?: () => string | undefined;
	/**
	 * Fires once the flow's single-flight claim resolves (see
	 * {@link McpOAuthFlowRunOptions.onClaimed}); hosts install flow UI here so
	 * a superseded flow installs — and restores — nothing.
	 */
	onClaimed?: () => void;
}

export interface McpReauthOutcome {
	/** Config with the fresh auth block (or the stripped base when no write-back was needed). */
	config: MCPServerConfig;
	/** Whether the server definition was written back to its config file. */
	persisted: boolean;
	oauth: OAuthEndpoints;
	credentialId: string;
}

/**
 * Reauthorize one configured MCP server end to end: strip the auth block,
 * resolve OAuth endpoints from the server, assemble client credentials
 * (configured > persisted > stored > metadata-advertised, with DCR preferred
 * whenever the authorization server offers it), run the browser flow, GC the
 * superseded credential row, and write the config back under the TUI's
 * persistence policy. Definition-only entries resolve through the url-keyed
 * credential binding alone, so a committed project mcp.json stays clean.
 *
 * Throws {@link McpReauthRefusalError} for actionable refusals (stdio
 * transport, disabled server, anonymous server) and
 * {@link MCPOAuthCancelledError} when the host aborts mid-flow.
 */
export async function reauthorizeMcpServer(
	name: string,
	found: FoundMcpServer,
	opts: McpReauthOptions,
): Promise<McpReauthOutcome> {
	const { authStorage } = opts;
	if (found.config.enabled === false) {
		throw new McpReauthRefusalError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
	}

	const currentAuth = found.config.auth;
	const baseConfig = stripMcpOAuthAuth(found.config);
	const runtimeBaseConfig = expandEnvVarsDeep(baseConfig);
	// Resolve endpoints first: this fails fast for stdio transports and
	// probes http/sse with { oauth: false }, so nothing destructive has
	// happened yet if the server turns out not to need (or support) OAuth.
	// Use the same env-expanded config shape runtime discovery passes to
	// MCPManager; the raw file value may contain `${...}` placeholders.
	// Race the whole pre-flow phase against the host signal: the probe and
	// discovery fetches cannot observe it on their own.
	const oauth = await raceAbortSignal(
		resolveMcpOAuthEndpointsFromServer(runtimeBaseConfig, {
			authChallenge: opts.authChallenge,
			signal: opts.signal,
			authStorage,
			mcpManager: opts.mcpManager,
			cwd: opts.cwd,
		}),
		opts.signal,
		() => new MCPOAuthCancelledError(),
	);
	const serverUrl =
		runtimeBaseConfig.type === "http" || runtimeBaseConfig.type === "sse" ? runtimeBaseConfig.url : undefined;
	// Client credentials drive the token exchange, so they must come from the
	// env-expanded runtime config; `found.config`/`currentAuth` may still hold
	// `${...}` placeholders (the wizard writes the secret to auth.clientSecret).
	// DCR secrets are embedded in the stored credential and never echoed back
	// into config files.
	const runtimeAuth = currentAuth ? expandEnvVarsDeep(currentAuth) : undefined;
	const configuredClientId = runtimeBaseConfig.oauth?.clientId?.trim() || undefined;
	const configuredClientSecret = runtimeBaseConfig.oauth?.clientSecret;
	const existingCredential = lookupMcpOAuthCredentialForServer(authStorage, currentAuth, serverUrl)?.credential;
	const persistedClientId = runtimeAuth?.clientId?.trim() || undefined;
	const storedClientId = existingCredential?.clientId?.trim() || undefined;
	const discoveredClientId = oauth.clientId?.trim() || undefined;
	// A metadata-advertised client is only a fallback. Prefer DCR when the
	// authorization server explicitly offers it, while retaining configured
	// and previously registered client credentials above.
	const flowClientId =
		configuredClientId ??
		persistedClientId ??
		storedClientId ??
		(oauth.registrationUrl ? undefined : discoveredClientId) ??
		"";
	const storedClientSecret = storedClientId === flowClientId ? existingCredential?.clientSecret : undefined;
	const flowClientSecret =
		(configuredClientId === flowClientId ? configuredClientSecret : undefined) ??
		(persistedClientId === flowClientId ? runtimeAuth?.clientSecret : undefined) ??
		storedClientSecret ??
		"";
	// Persisted separately below: keep the raw `${...}` placeholder in the file
	// rather than writing the resolved secret back to (possibly shared) config.
	const userClientSecret =
		(configuredClientId === flowClientId ? found.config.oauth?.clientSecret : undefined) ??
		(persistedClientId === flowClientId ? currentAuth?.clientSecret : undefined);
	const hasConfiguredOnlySecret = configuredClientId === undefined && configuredClientSecret !== undefined;

	if (!opts.silent) opts.onReauthorizing?.();

	const currentAuthResource = currentAuth?.resource ? expandEnvVarsDeep(currentAuth.resource) : undefined;
	const oauthResource =
		oauth.resource ?? currentAuthResource ?? ("url" in runtimeBaseConfig ? runtimeBaseConfig.url : undefined);
	const oauthResourceIsFallback = !oauth.resource && !currentAuthResource;

	const oauthResult = await runMcpOAuthFlow({
		authUrl: oauth.authorizationUrl,
		tokenUrl: oauth.tokenUrl,
		clientId: flowClientId,
		clientSecret: flowClientSecret,
		scopes: oauth.scopes || runtimeBaseConfig.oauth?.scope || "",
		callbackPort: found.config.oauth?.callbackPort,
		callbackPath: found.config.oauth?.callbackPath,
		redirectUri: found.config.oauth?.redirectUri,
		prompt: found.config.oauth?.prompt,
		registrationUrl: oauth.registrationUrl,
		issuerUrl: oauth.issuerUrl,
		serverUrl,
		resource: oauthResource,
		stripSameOriginResource: oauthResourceIsFallback,
		authStorage,
		signal: opts.signal,
		flowOwner: opts.flowOwner,
		pendingInput: opts.pendingInput,
		onClaimed: opts.onClaimed,
		onAuth: opts.onAuth,
		onProgress: opts.onProgress,
		onManualCodeInput: opts.onManualCodeInput,
		onFlowComplete: opts.onFlowComplete,
		releaseManualInput: opts.releaseManualInput,
	});

	// The flow overwrote (or minted) this profile's row; a superseded
	// pointer row from the legacy random-id era is now orphaned. GC only
	// after success so cancelling the browser step leaves the previous
	// session signed in.
	if (currentAuth?.type === "oauth" && currentAuth.credentialId !== oauthResult.credentialId) {
		await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
	}

	// Definition-only entries resolve through the url-keyed binding alone;
	// skip the write-back so a committed project mcp.json stays clean. A
	// client-supplied bearer header is the one exception: at startup
	// `lookupMcpOAuthCredential` disables the url-keyed fallback while the
	// header is present, so without an explicit `auth` block the fresh
	// credential never wins again and the next process reuses the stale
	// bearer despite the reported success.
	//
	// ACP-owned manager entries never persist at all: the client re-declares
	// the definition (header included) on every `session/new`, so a
	// user-file copy could never override it — it would only leak a
	// session-owned server definition and its bearer into the global user
	// config. The fresh url-keyed credential row the flow just wrote to
	// authStorage is the binding, and the live reconnect applies it now.
	const hadClientBearerHeader = hasMcpAuthorizationHeader(found.config);
	const urlKeyedId = serverUrl ? mcpOAuthCredentialId(serverUrl) : undefined;
	const shouldPersist =
		found.acpOwned !== true &&
		(currentAuth !== undefined || hadClientBearerHeader || oauthResult.credentialId !== urlKeyedId);
	const updatedConfig = shouldPersist
		? // Strip the client-supplied auth surface (an `Authorization` header
			// would both leak the bearer into the file and disable the url-keyed
			// fallback on the next load) before the fresh auth block is added.
			persistMcpOAuthResult(clearMcpClientAuthSurface(baseConfig), oauthResult, {
				tokenUrl: oauth.tokenUrl,
				// Do not turn a configured-only secret into a persisted oauth
				// client pair by echoing the discovered client id.
				clientId: oauth.clientId,
				persistOAuthClientId: !hasConfiguredOnlySecret,
				userClientSecret,
				resource: oauthResource,
				stripSameOriginResource: oauthResourceIsFallback,
			})
		: baseConfig;
	if (shouldPersist) {
		await updateMCPServer(found.filePath, name, updatedConfig);
	}

	return { config: updatedConfig, persisted: shouldPersist, oauth, credentialId: oauthResult.credentialId };
}
