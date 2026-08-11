import { getActiveProfile } from "@pk-nerdsaver-ai/pi-utils/dirs";
import { expandEnvVarsDeep } from "../discovery/helpers";
import type { AuthStorage } from "../session/auth-storage";
import { canonicalizeOAuthIssuer } from "./oauth-discovery";
import {
	isManagedMCPOAuthCredentialId,
	type MCPStoredOAuthCredential,
	mcpOAuthCredentialId,
	mcpOAuthCredentialProfile,
} from "./oauth-flow";
import type { MCPAuthConfig, MCPServerConfig } from "./types";

export interface MCPOAuthCredentialLookup {
	credentialId: string;
	credential: MCPStoredOAuthCredential;
}

export type MCPOAuthRefreshMaterial = MCPStoredOAuthCredential | MCPAuthConfig | undefined;
/**
 * Issuer-bound lookup policy. Legacy credentials without `issuer`, credentials
 * whose issuer is not already canonical, and credentials minted by a different
 * issuer all fail closed. The legacy `authorizationUrl` field is deliberately
 * ignored because it stored an authorization endpoint, not an issuer.
 */
export function mcpOAuthCredentialMatchesIssuer(credential: MCPStoredOAuthCredential, issuer: string): boolean {
	const expectedIssuer = canonicalizeOAuthIssuer(issuer);
	const storedIssuer = credential.issuer ? canonicalizeOAuthIssuer(credential.issuer) : undefined;
	return (
		expectedIssuer !== undefined &&
		expectedIssuer === issuer &&
		storedIssuer !== undefined &&
		storedIssuer === credential.issuer &&
		storedIssuer === expectedIssuer
	);
}

export function mcpOAuthCredentialIdsForServerUrl(serverUrl: string | undefined): string[] {
	if (!serverUrl) return [];
	const ids: string[] = [];
	for (const url of [expandEnvVarsDeep(serverUrl), serverUrl]) {
		const id = mcpOAuthCredentialId(url);
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}

export function hasMcpAuthorizationHeader(config: MCPServerConfig): boolean {
	if (config.type !== "http" && config.type !== "sse") return false;
	return Object.keys(config.headers ?? {}).some(header => header.toLowerCase() === "authorization");
}

export function lookupMcpOAuthCredentialForServer(
	authStorage: AuthStorage | null | undefined,
	auth: MCPAuthConfig | undefined,
	serverUrl: string | undefined,
	options: { allowUrlKeyedFallback?: boolean; issuer?: string } = {},
): MCPOAuthCredentialLookup | undefined {
	if (!authStorage) return undefined;
	if (auth && auth.type !== "oauth") return undefined;
	const urlKeyedCredentialIds = mcpOAuthCredentialIdsForServerUrl(serverUrl);
	if (
		auth?.credentialId &&
		(!auth.credentialId.startsWith("mcp_oauth:profile:") || urlKeyedCredentialIds.includes(auth.credentialId))
	) {
		const credential = authStorage.get(auth.credentialId);
		if (
			credential?.type === "oauth" &&
			(options.issuer === undefined || mcpOAuthCredentialMatchesIssuer(credential, options.issuer))
		) {
			return { credentialId: auth.credentialId, credential };
		}
	}
	if (options.allowUrlKeyedFallback === false) return undefined;
	for (const credentialId of urlKeyedCredentialIds) {
		const credential = authStorage.get(credentialId);
		if (credential?.type === "oauth") {
			if (options.issuer !== undefined && !mcpOAuthCredentialMatchesIssuer(credential, options.issuer)) continue;
			return { credentialId, credential };
		}
	}
	return undefined;
}

export function lookupMcpOAuthCredential(
	authStorage: AuthStorage | null | undefined,
	config: MCPServerConfig,
): MCPOAuthCredentialLookup | undefined {
	const auth = config.auth;
	if (config.type !== "http" && config.type !== "sse") {
		return lookupMcpOAuthCredentialForServer(authStorage, auth, undefined);
	}
	if (hasMcpAuthorizationHeader(config)) {
		return lookupMcpOAuthCredentialForServer(authStorage, auth, config.url, { allowUrlKeyedFallback: false });
	}
	return lookupMcpOAuthCredentialForServer(authStorage, auth, config.url);
}

export function selectMcpOAuthRefreshMaterial(
	credential: MCPStoredOAuthCredential,
	auth: MCPAuthConfig | undefined,
): MCPOAuthRefreshMaterial {
	return credential.tokenUrl ? credential : auth;
}

export async function removeManagedMcpOAuthCredential(
	authStorage: AuthStorage,
	credentialId: string | undefined,
): Promise<boolean> {
	if (!isManagedMCPOAuthCredentialId(credentialId)) return false;
	const scopedProfile = mcpOAuthCredentialProfile(credentialId);
	if (scopedProfile !== undefined && scopedProfile !== (getActiveProfile() ?? "default")) return false;
	if (authStorage.get(credentialId)?.type !== "oauth") return false;
	await authStorage.remove(credentialId);
	return true;
}

export async function removeManagedMcpOAuthCredentials(
	authStorage: AuthStorage,
	credentialIds: readonly (string | undefined)[],
): Promise<boolean> {
	let removed = false;
	for (const credentialId of credentialIds) {
		removed = (await removeManagedMcpOAuthCredential(authStorage, credentialId)) || removed;
	}
	return removed;
}
