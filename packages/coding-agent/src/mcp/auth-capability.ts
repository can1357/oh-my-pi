import type { SourceMeta } from "../capability/types";
import type { AuthStorage } from "../session/auth-storage";
import { hasMcpAuthorizationHeader, lookupMcpOAuthCredential } from "./oauth-credentials";
import type { MCPServerConfig } from "./types";

export type MCPAuthenticationMode = "managed-oauth" | "external-proxy" | "static-header" | "api-key" | "none";

export interface MCPServerCapabilities {
	authenticationMode: MCPAuthenticationMode;
	authenticationSummary: string;
	canTest: boolean;
	canReconnect: boolean;
	canReauthenticate: boolean;
	canClearAuthentication: boolean;
	canToggle: boolean;
	reauthenticateUnavailableReason?: string;
}

export interface ClassifyMCPServerOptions {
	config: MCPServerConfig;
	source?: Pick<SourceMeta, "provider" | "path" | "level">;
	authStorage?: AuthStorage | null;
	disabled?: boolean;
	shadowed?: boolean;
}

function isLoopbackOrPrivateHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (normalized === "localhost" || normalized === "::1" || normalized.endsWith(".localhost")) return true;
	const octets = normalized.split(".").map(Number);
	if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
		return false;
	}
	return (
		octets[0] === 10 ||
		octets[0] === 127 ||
		(octets[0] === 169 && octets[1] === 254) ||
		(octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31) ||
		(octets[0] === 192 && octets[1] === 168)
	);
}

function isNetworkConfig(config: MCPServerConfig): config is MCPServerConfig & { type: "http" | "sse"; url: string } {
	return config.type === "http" || config.type === "sse";
}

function isMcpRemoteSpecifier(value: string): boolean {
	const basename = value.split(/[\\/]/).at(-1) ?? value;
	return basename === "mcp-remote" || basename === "mcp-remote.cmd" || basename.startsWith("mcp-remote@");
}

function isExternalAuthProxy(config: MCPServerConfig): boolean {
	if (config.type !== "http" && config.type !== "sse") {
		return isMcpRemoteSpecifier(config.command) || config.args?.some(isMcpRemoteSpecifier) === true;
	}
	try {
		return isLoopbackOrPrivateHostname(new URL(config.url).hostname) && hasMcpAuthorizationHeader(config);
	} catch {
		return false;
	}
}

export function classifyMCPServer(options: ClassifyMCPServerOptions): MCPServerCapabilities {
	const { config, authStorage, disabled = false, shadowed = false } = options;
	const actionBlocked = disabled || shadowed;
	const managedCredential = lookupMcpOAuthCredential(authStorage, config);
	const externalProxy = isExternalAuthProxy(config);
	const staticAuthorization = hasMcpAuthorizationHeader(config);

	let authenticationMode: MCPAuthenticationMode;
	let authenticationSummary: string;
	if (managedCredential) {
		authenticationMode = "managed-oauth";
		authenticationSummary = "OMP-managed OAuth credential";
	} else if (externalProxy) {
		authenticationMode = "external-proxy";
		authenticationSummary = "Authentication is owned by an external proxy";
	} else if (config.auth?.type === "apikey") {
		authenticationMode = "api-key";
		authenticationSummary = "API key authentication";
	} else if (staticAuthorization) {
		authenticationMode = "static-header";
		authenticationSummary = "Static Authorization header";
	} else {
		authenticationMode = "none";
		authenticationSummary = "No managed authentication detected";
	}

	let reauthenticateUnavailableReason: string | undefined;
	if (actionBlocked) {
		reauthenticateUnavailableReason = shadowed ? "Shadowed rows cannot be managed" : "Enable the server first";
	} else if (!isNetworkConfig(config)) {
		reauthenticateUnavailableReason = externalProxy
			? "Authentication is owned by the proxy process"
			: "Reauthentication is available only for HTTP and SSE servers";
	} else if (externalProxy) {
		reauthenticateUnavailableReason = "Authentication is owned by the external proxy";
	} else if (config.auth?.type === "apikey") {
		reauthenticateUnavailableReason = "This server uses an API key, not OAuth";
	} else if (staticAuthorization) {
		reauthenticateUnavailableReason = "Remove the static Authorization header before using managed OAuth";
	}

	return {
		authenticationMode,
		authenticationSummary,
		canTest: !actionBlocked,
		canReconnect: !actionBlocked,
		canReauthenticate: reauthenticateUnavailableReason === undefined,
		canClearAuthentication: !actionBlocked && managedCredential !== undefined,
		canToggle: !shadowed,
		reauthenticateUnavailableReason,
	};
}
