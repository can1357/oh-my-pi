import type { OAuthController } from "@oh-my-pi/pi-ai/oauth/types";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import { openPath } from "../utils/open";
import { loadAllMCPConfigs } from "./config";
import { updateMCPServer } from "./config-writer";
import { discoverOAuthEndpoints } from "./oauth-discovery";
import { MCPOAuthFlow, mcpOAuthCredentialId, type MCPStoredOAuthCredential } from "./oauth-flow";
import { cfgMcpEnableProjectConfig } from "./settings";
import type { MCPServerConfig } from "./types";

export interface ReauthorizeMCPServerOptions {
	cwd?: string;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

function isRemoteServer(config: MCPServerConfig): config is MCPServerConfig & { url: string; type: "http" | "sse" } {
	return (config.type === "http" || config.type === "sse") && typeof config.url === "string" && config.url.length > 0;
}

function persistOAuthResult(
	config: MCPServerConfig,
	credentialId: string,
	tokenUrl: string,
	clientId: string | undefined,
	resource: string | undefined,
): MCPServerConfig {
	return {
		...config,
		auth: {
			type: "oauth",
			credentialId,
			tokenUrl,
			clientId,
			clientSecret: config.oauth?.clientSecret,
			resource,
		},
		oauth: {
			...config.oauth,
			clientId,
		},
	};
}

/** Reauthorize one configured MCP server using its standard OAuth flow. */
export async function reauthorizeMCPServer(
	name: string,
	options: ReauthorizeMCPServerOptions = {},
): Promise<{ configPath: string; credentialId: string }> {
	const cwd = options.cwd ?? getProjectDir();
	const settings = await Settings.init({ cwd });
	const loaded = await loadAllMCPConfigs(cwd, {
		enableProjectConfig: cfgMcpEnableProjectConfig.get(settings),
		filterExa: false,
		filterBrowser: false,
	});
	const config = loaded.configs[name];
	const source = loaded.sources[name];
	if (!config || !source) throw new Error(`MCP server not found: ${name}`);
	if (source.level === "native") throw new Error(`MCP server configuration is not writable: ${name}`);
	if (config.enabled === false) throw new Error(`MCP server is disabled: ${name}`);
	if (!isRemoteServer(config)) throw new Error(`MCP server does not support OAuth reauthorization: ${name}`);

	const authStorage = await discoverAuthStorage(undefined, { settings });
	try {
		const oauth = await discoverOAuthEndpoints(config.url, undefined, undefined, {
			protectedResource: config.auth?.resource,
			signal: options.signal,
		});
		if (!oauth) throw new Error(`OAuth endpoints not found for MCP server: ${name}`);

		const controller: OAuthController = {
			onAuth: info => {
				openPath(info.url);
				process.stdout.write(`Authorize ${name} in your browser:\n${info.url}\n`);
			},
			onProgress: message => {
				options.onProgress?.(message);
				process.stdout.write(`${message}\n`);
			},
		};
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: oauth.authorizationUrl,
				tokenUrl: oauth.tokenUrl,
				issuerUrl: oauth.issuerUrl,
				registrationUrl: oauth.registrationUrl,
				clientId: config.oauth?.clientId ?? oauth.clientId,
				clientSecret: config.oauth?.clientSecret,
				scopes: config.oauth?.scope ?? oauth.scopes,
				redirectUri: config.oauth?.redirectUri,
				callbackPort: config.oauth?.callbackPort,
				callbackPath: config.oauth?.callbackPath,
				prompt: config.oauth?.prompt,
				resource: oauth.resource ?? config.auth?.resource,
			},
			controller,
		);
		const credentials = await flow.login();
		const credentialId = mcpOAuthCredentialId(config.url);
		const stored: MCPStoredOAuthCredential = {
			type: "oauth",
			...credentials,
			tokenUrl: oauth.tokenUrl,
			clientId: flow.resolvedClientId,
			clientSecret: flow.registeredClientSecret ?? config.oauth?.clientSecret,
			resource: flow.resource,
			authorizationUrl: flow.authorizationUrl,
		};
		await authStorage.credentials.set(credentialId, stored);

		const updated = persistOAuthResult(config, credentialId, oauth.tokenUrl, flow.resolvedClientId, flow.resource);
		await updateMCPServer(source.path, name, updated);
		return { configPath: source.path, credentialId };
	} finally {
		authStorage.close();
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runMCPReauthCommand(name: string, options: ReauthorizeMCPServerOptions = {}): Promise<void> {
	try {
		const result = await reauthorizeMCPServer(name, options);
		process.stdout.write(`Reauthorized MCP server "${name}". Updated ${result.configPath}.\n`);
	} catch (error) {
		process.stderr.write(`MCP reauthorization failed: ${formatError(error)}\n`);
		throw error;
	}
}
