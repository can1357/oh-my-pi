import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { clearCache as clearFsCache } from "../capability/fs";
import type { EffectiveExtensionRoots, SourceMeta } from "../capability/types";
import { expandEnvVarsDeep } from "../discovery/helpers";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AuthStorage } from "../session/auth-storage";
import { raceAbortSignal, withTimeout } from "./action-utils";
import { classifyMCPServer } from "./auth-capability";
import { connectToServer, disconnectServer, listTools } from "./client";
import { setMcpServerEnabled, updateMCPServer } from "./config-writer";
import {
	MCPOAuthCancelledError,
	runMCPInteractiveOAuth,
	type MCPInteractiveOAuthInteraction,
} from "./interactive-oauth";
import { MCPManager as TemporaryMCPManager, type MCPDiscoverOptions, type MCPManager } from "./manager";
import {
	lookupMcpOAuthCredential,
	lookupMcpOAuthCredentialForServer,
	mcpOAuthCredentialIdsForServerUrl,
	removeManagedMcpOAuthCredential,
	removeManagedMcpOAuthCredentials,
} from "./oauth-credentials";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	type OAuthEndpoints,
} from "./oauth-discovery";
import { mcpOAuthCredentialId } from "./oauth-flow";
import type { McpConnectionStatusEvent } from "./startup-events";
import type { MCPAuthChallenge, MCPAuthConfig, MCPServerConfig, MCPServerConnection, MCPToolDefinition } from "./types";

export type MCPServerActionName =
	| "test"
	| "reconnect"
	| "reauthenticate"
	| "clear-authentication"
	| "enable"
	| "disable";

export interface MCPServerActionTarget {
	name: string;
	config: MCPServerConfig;
	source?: SourceMeta;
	shadowed?: boolean;
	disabled?: boolean;
}

export interface MCPServerActionResult {
	action: MCPServerActionName;
	message: string;
	tools?: MCPToolDefinition[];
	connectionErrors?: ReadonlyMap<string, string>;
}

export interface MCPServerActionsOptions {
	cwd: string;
	manager?: MCPManager;
	authStorage?: AuthStorage;
	enableProjectConfig?: boolean;
	filterExa?: boolean;
	filterBrowser?: boolean;
	getExtensionRoots?: () => EffectiveExtensionRoots;
	onStatus?: (event: McpConnectionStatusEvent) => void;
	refreshMCPTools(tools: CustomTool[]): Promise<void> | void;
	clearMCPPromptCommands?(): void;
}

function serverUrl(config: MCPServerConfig): string | undefined {
	return config.type === "http" || config.type === "sse" ? config.url : undefined;
}

function writableSourcePath(source: SourceMeta | undefined): string | undefined {
	return source?.provider === "omp" || source?.provider === "mcp-json" ? source.path : undefined;
}

function getServerTimeout(config: MCPServerConfig): number {
	return config.timeout ?? 30_000;
}

function stripOAuthAuth(config: MCPServerConfig): MCPServerConfig {
	const next = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
	delete next.auth;
	return next;
}

async function testMCPConfig(options: {
	cwd: string;
	authStorage?: AuthStorage;
	config: MCPServerConfig;
	signal?: AbortSignal;
	oauth?: boolean;
}): Promise<MCPToolDefinition[]> {
	const manager = new TemporaryMCPManager(options.cwd);
	if (options.authStorage) manager.setAuthStorage(options.authStorage);
	const resolvedConfig = await manager.prepareConfig(options.config, { oauth: options.oauth });
	let connection: MCPServerConnection | undefined;
	try {
		connection = await connectToServer(
			`__mcp_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
			resolvedConfig,
			{
				signal: options.signal,
			},
		);
		return await listTools(connection, { signal: options.signal });
	} finally {
		if (connection) await disconnectServer(connection).catch(() => undefined);
		await manager.disconnectAll().catch(() => undefined);
	}
}

async function resolveOAuthEndpointsFromServer(options: {
	cwd: string;
	authStorage?: AuthStorage;
	config: MCPServerConfig;
	authChallenge?: MCPAuthChallenge;
	signal?: AbortSignal;
}): Promise<OAuthEndpoints> {
	const { config, authChallenge } = options;
	if (config.type !== "http" && config.type !== "sse") {
		const remoteUrl = config.args?.find(arg => /^https?:\/\//.test(arg));
		const httpHint = `{ "type": "http", "url": ${JSON.stringify(remoteUrl ?? "<remote url>")} }`;
		const usesMcpRemote = [config.command, ...(config.args ?? [])].some(part => part?.includes("mcp-remote"));
		throw new Error(
			usesMcpRemote
				? `This server proxies OAuth through mcp-remote, which owns its credential cache. Clear the proxy cache or replace it with ${httpHint} so OMP can manage OAuth.`
				: `Stdio servers manage their own credentials. Configure an HTTP transport such as ${httpHint} for OMP-managed OAuth.`,
		);
	}

	let connectionSucceeded = false;
	let connectionError: Error | undefined;
	try {
		await testMCPConfig({ ...options, oauth: false });
		connectionSucceeded = true;
	} catch (error) {
		connectionError = error instanceof Error ? error : new Error(String(error));
	}
	if (connectionSucceeded && !authChallenge) {
		const discovered = await discoverOAuthEndpoints(config.url);
		if (!discovered) throw new Error("Server connection succeeded without OAuth; reauthentication is not required.");
		return discovered;
	}

	const authError = authChallenge
		? new Error(`${connectionError?.message ?? "HTTP 401"}\n${authChallenge.wwwAuthenticate.join("\n")}`)
		: connectionError!;
	const authResult = analyzeAuthError(authError, config.url);
	let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
	if (!oauth) {
		oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl, authResult.resourceMetadataUrl, {
			protectedScopes: authResult.scopes,
		});
	}
	if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
		const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
		if (scopes) oauth = { ...oauth, scopes };
	}
	if (!oauth) throw new Error("Could not discover OAuth endpoints from server response.");
	return oauth;
}

export class MCPServerActions {
	readonly #options: MCPServerActionsOptions;

	constructor(options: MCPServerActionsOptions) {
		this.#options = options;
	}

	async test(target: MCPServerActionTarget, signal?: AbortSignal): Promise<MCPServerActionResult> {
		this.#assertActionAvailable(target, "test");
		const manager = this.#options.manager;
		if (manager) {
			const state = manager.getConnectionStatus(target.name);
			const connection = manager.getConnection(target.name);
			if (state === "connected" && connection) {
				const tools = await listTools(connection, { signal });
				return {
					action: "test",
					message:
						tools.length > 0 ? `Connected. ${tools.length} tool(s) available.` : "Connected. No tools reported.",
					tools,
				};
			}
		}

		const tools = await testMCPConfig({
			cwd: this.#options.cwd,
			authStorage: this.#options.authStorage,
			config: target.config,
			signal,
		});
		return {
			action: "test",
			message:
				tools.length > 0
					? `Connection successful. ${tools.length} tool(s) available.`
					: "Connection successful. No tools reported.",
			tools,
		};
	}

	async reconnect(target: MCPServerActionTarget, signal?: AbortSignal): Promise<MCPServerActionResult> {
		this.#assertActionAvailable(target, "reconnect");
		const manager = this.#options.manager;
		if (!manager) throw new Error("MCP runtime manager is unavailable");
		const timeout = getServerTimeout(target.config);
		const connection = await withTimeout(
			raceAbortSignal(manager.reconnectServer(target.name, { manual: true }), signal),
			timeout,
			`Reconnect timed out after ${timeout}ms`,
		);
		if (!connection) throw new Error("Reconnect failed");
		const tools = await listTools(connection, { signal });
		await this.#options.refreshMCPTools(manager.getTools());
		return {
			action: "reconnect",
			message:
				tools.length > 0 ? `Reconnected. ${tools.length} tool(s) available.` : "Reconnected. No tools reported.",
			tools,
		};
	}

	async reauthenticate(
		target: MCPServerActionTarget,
		interaction: MCPInteractiveOAuthInteraction,
		signal?: AbortSignal,
	): Promise<MCPServerActionResult> {
		this.#assertActionAvailable(target, "reauthenticate");
		const authStorage = this.#requireAuthStorage();
		const currentAuth = target.config.auth;
		const baseConfig = stripOAuthAuth(target.config);
		const runtimeBaseConfig = expandEnvVarsDeep(baseConfig);
		const oauth = await raceAbortSignal(
			resolveOAuthEndpointsFromServer({
				cwd: this.#options.cwd,
				authStorage,
				config: runtimeBaseConfig,
				signal,
			}),
			signal,
		);
		const url = serverUrl(runtimeBaseConfig);
		if (!url) throw new Error("Reauthentication is available only for HTTP and SSE servers");

		const runtimeAuth = currentAuth ? expandEnvVarsDeep(currentAuth) : undefined;
		const configuredClientId = runtimeBaseConfig.oauth?.clientId?.trim() || undefined;
		const configuredClientSecret = runtimeBaseConfig.oauth?.clientSecret;
		const existingCredential = lookupMcpOAuthCredentialForServer(authStorage, currentAuth, url)?.credential;
		const persistedClientId = runtimeAuth?.clientId?.trim() || undefined;
		const storedClientId = existingCredential?.clientId?.trim() || undefined;
		const discoveredClientId = oauth.clientId?.trim() || undefined;
		const flowClientId =
			configuredClientId ??
			persistedClientId ??
			storedClientId ??
			(oauth.registrationUrl ? undefined : discoveredClientId);
		const storedClientSecret = storedClientId === flowClientId ? existingCredential?.clientSecret : undefined;
		const flowClientSecret =
			(configuredClientId === flowClientId ? configuredClientSecret : undefined) ??
			(persistedClientId === flowClientId ? runtimeAuth?.clientSecret : undefined) ??
			storedClientSecret;
		const userClientSecret =
			(configuredClientId === flowClientId ? target.config.oauth?.clientSecret : undefined) ??
			(persistedClientId === flowClientId ? currentAuth?.clientSecret : undefined);
		const hasConfiguredOnlySecret = configuredClientId === undefined && configuredClientSecret !== undefined;
		const currentAuthResource = currentAuth?.resource ? expandEnvVarsDeep(currentAuth.resource) : undefined;
		const oauthResource = oauth.resource ?? currentAuthResource ?? url;
		const oauthResourceIsFallback = !oauth.resource && !currentAuthResource;

		const result = await runMCPInteractiveOAuth({
			serverName: target.name,
			serverUrl: url,
			configured: {
				clientId: flowClientId,
				clientSecret: flowClientSecret,
				scope: oauth.scopes ?? runtimeBaseConfig.oauth?.scope,
				callbackPort: target.config.oauth?.callbackPort,
				callbackPath: target.config.oauth?.callbackPath,
				redirectUri: target.config.oauth?.redirectUri,
				prompt: target.config.oauth?.prompt,
			},
			oauthEndpoints: oauth,
			resource: oauthResource,
			stripSameOriginResource: oauthResourceIsFallback,
			authStorage,
			interaction,
			owner: authStorage,
			signal,
		});
		if (currentAuth?.type === "oauth" && currentAuth.credentialId !== result.credentialId) {
			await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
		}
		await removeManagedMcpOAuthCredentials(
			authStorage,
			mcpOAuthCredentialIdsForServerUrl(url).filter(id => id !== result.credentialId),
		);

		const sourcePath = writableSourcePath(target.source);
		const shouldPersist = Boolean(currentAuth) || result.credentialId !== mcpOAuthCredentialId(url);
		if (sourcePath && shouldPersist) {
			const clientId = result.credentials.clientId?.trim() || oauth.clientId?.trim();
			await updateMCPServer(sourcePath, target.name, {
				...baseConfig,
				auth: {
					type: "oauth",
					credentialId: result.credentialId,
					tokenUrl: oauth.tokenUrl,
					clientId,
					clientSecret: userClientSecret,
					resource: result.credentials.resource,
				},
				oauth: {
					...baseConfig.oauth,
					clientId: hasConfiguredOnlySecret ? undefined : clientId,
				},
			});
		}
		if (this.#options.manager) await this.reload();
		return { action: "reauthenticate", message: "Authentication successful. MCP runtime reloaded." };
	}

	async clearAuthentication(target: MCPServerActionTarget): Promise<MCPServerActionResult> {
		this.#assertActionAvailable(target, "clear-authentication");
		const url = serverUrl(target.config);
		const authStorage = this.#requireAuthStorage();
		const credential = lookupMcpOAuthCredential(authStorage, target.config);
		const removed = await removeManagedMcpOAuthCredentials(authStorage, [
			credential?.credentialId,
			target.config.auth?.credentialId,
			...mcpOAuthCredentialIdsForServerUrl(url),
		]);
		const sourcePath = writableSourcePath(target.source);
		let patchedConfig = false;
		if (sourcePath && target.config.auth?.type === "oauth") {
			const updated = { ...target.config };
			delete updated.auth;
			await updateMCPServer(sourcePath, target.name, updated);
			patchedConfig = true;
		}
		if (!removed && !patchedConfig) throw new Error("No OMP-managed OAuth credential found");
		await this.reload();
		return { action: "clear-authentication", message: "Stored authentication cleared." };
	}

	async setEnabled(target: MCPServerActionTarget, enabled: boolean): Promise<MCPServerActionResult> {
		this.#assertActionAvailable(target, enabled ? "enable" : "disable");
		const cwd = this.#options.cwd;
		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", cwd),
			projectPath: getMCPConfigPath("project", cwd),
			sourcePath: writableSourcePath(target.source),
			name: target.name,
			enabled,
		});
		await this.reload();
		return { action: enabled ? "enable" : "disable", message: `${target.name} ${enabled ? "enabled" : "disabled"}.` };
	}

	async reload(): Promise<MCPServerActionResult> {
		const manager = this.#options.manager;
		if (!manager) throw new Error("MCP runtime manager is unavailable");
		await manager.disconnectAll();
		this.#options.clearMCPPromptCommands?.();
		clearFsCache();
		const discoverOptions: MCPDiscoverOptions = {
			enableProjectConfig: this.#options.enableProjectConfig,
			filterExa: this.#options.filterExa,
			filterBrowser: this.#options.filterBrowser,
			extensionRoots: this.#options.getExtensionRoots?.(),
			onStatus: this.#options.onStatus,
		};
		const result = await manager.discoverAndConnect(discoverOptions);
		await this.#options.refreshMCPTools(manager.getTools());
		return {
			action: "reconnect",
			message:
				result.errors.size > 0
					? `Reloaded with ${result.errors.size} connection error(s).`
					: "MCP servers reloaded.",
			connectionErrors: result.errors,
		};
	}

	#requireAuthStorage(): AuthStorage {
		const authStorage = this.#options.authStorage;
		if (!authStorage) throw new Error("MCP authentication storage is unavailable");
		return authStorage;
	}

	#assertActionAvailable(target: MCPServerActionTarget, action: MCPServerActionName): void {
		const capabilities = classifyMCPServer({
			config: target.config,
			source: target.source,
			authStorage: this.#options.authStorage,
			disabled: target.disabled,
			shadowed: target.shadowed,
		});
		if (action === "enable" || action === "disable") {
			if (!capabilities.canToggle) throw new Error("Shadowed MCP rows cannot be changed");
			return;
		}
		if (action === "test" && !capabilities.canTest) throw new Error("Enable the MCP server before testing it");
		if (action === "reconnect" && !capabilities.canReconnect)
			throw new Error("Enable the MCP server before reconnecting it");
		if (action === "reauthenticate" && !capabilities.canReauthenticate) {
			throw new Error(capabilities.reauthenticateUnavailableReason ?? "Reauthentication is unavailable");
		}
		if (action === "clear-authentication" && !capabilities.canClearAuthentication) {
			throw new Error("No OMP-managed OAuth credential found");
		}
	}
}

export { MCPOAuthCancelledError };
