import { REMOTE_REFRESH_SENTINEL, type StoredOAuthRefreshResult } from "@oh-my-pi/pi-ai";
import { isDefinitiveOAuthFailure } from "@oh-my-pi/pi-ai/error";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import { expandEnvVarsDeep } from "../discovery/helpers";
import type { AuthStorage } from "../session/auth-storage";
import {
	isManagedMCPOAuthCredentialId,
	type MCPStoredOAuthCredential,
	mcpOAuthCredentialId,
	mcpOAuthCredentialProfile,
	mcpOAuthServerUrlFromCredentialId,
	refreshMCPOAuthToken,
} from "./oauth-flow";
import type { MCPAuthConfig, MCPServerConfig } from "./types";

export interface MCPOAuthCredentialLookup {
	credentialId: string;
	credential: MCPStoredOAuthCredential;
}

export type MCPOAuthRefreshMaterial = MCPStoredOAuthCredential | MCPAuthConfig | undefined;

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

function mcpOAuthCredentialCandidatesForServer(
	auth: MCPAuthConfig | undefined,
	serverUrl: string | undefined,
	allowUrlKeyedFallback: boolean,
): string[] {
	if (auth && auth.type !== "oauth") return [];
	const candidates = mcpOAuthCredentialIdsForServerUrl(serverUrl);
	const pointer = auth?.credentialId;
	const eligiblePointer =
		pointer && (!pointer.startsWith("mcp_oauth:profile:") || candidates.includes(pointer)) ? pointer : undefined;
	if (!allowUrlKeyedFallback) return eligiblePointer ? [eligiblePointer] : [];
	if (eligiblePointer) {
		const duplicate = candidates.indexOf(eligiblePointer);
		if (duplicate !== -1) candidates.splice(duplicate, 1);
		candidates.unshift(eligiblePointer);
	}
	return candidates;
}

export function mcpOAuthCredentialCandidates(config: MCPServerConfig): string[] {
	const serverUrl = config.type === "http" || config.type === "sse" ? config.url : undefined;
	return mcpOAuthCredentialCandidatesForServer(config.auth, serverUrl, !hasMcpAuthorizationHeader(config));
}

/** Provider keys can contain configured URLs and must not be sent over the auth daemon link. */
export function mcpOAuthProviderDigest(provider: string): string {
	return Bun.SHA256.hash(provider, "hex");
}

function lookupMcpOAuthCredentialCandidates(
	authStorage: AuthStorage,
	candidates: readonly string[],
): MCPOAuthCredentialLookup | undefined {
	for (const credentialId of candidates) {
		const credential = authStorage.credentials.get(credentialId);
		if (credential?.type === "oauth") return { credentialId, credential };
	}
	return undefined;
}

export function lookupMcpOAuthCredentialForServer(
	authStorage: AuthStorage | null | undefined,
	auth: MCPAuthConfig | undefined,
	serverUrl: string | undefined,
	options: { allowUrlKeyedFallback?: boolean } = {},
): MCPOAuthCredentialLookup | undefined {
	if (!authStorage) return undefined;
	const candidates = mcpOAuthCredentialCandidatesForServer(auth, serverUrl, options.allowUrlKeyedFallback !== false);
	return lookupMcpOAuthCredentialCandidates(authStorage, candidates);
}

export function lookupMcpOAuthCredential(
	authStorage: AuthStorage | null | undefined,
	config: MCPServerConfig,
): MCPOAuthCredentialLookup | undefined {
	if (!authStorage) return undefined;
	return lookupMcpOAuthCredentialCandidates(authStorage, mcpOAuthCredentialCandidates(config));
}

export function selectMcpOAuthRefreshMaterial(
	credential: MCPStoredOAuthCredential,
	auth: MCPAuthConfig | undefined,
): MCPOAuthRefreshMaterial {
	return credential.tokenUrl ? credential : auth;
}

/**
 * Refresh a stored MCP OAuth credential via the standard `refresh_token` grant.
 *
 * Refresh material is taken from the credential itself (self-contained modern
 * credentials embed `tokenUrl`/`clientId`/`clientSecret`/`resource`) or, for
 * legacy credentials that carry none, the server's `auth` block. Shared by the
 * local MCP manager and the `omp auth-broker serve` refresh path so a broker
 * with no access to the MCP config can still refresh `mcp_oauth:*` credentials
 * from the vault.
 *
 * `serverUrl` supplies the RFC 8707 fallback resource indicator when neither
 * the credential nor the auth block advertised one; the manager passes the
 * configured server URL, the broker recovers it from the credential id via
 * {@link mcpOAuthServerUrlFromCredentialId}.
 *
 * @throws when no usable refresh token or token endpoint is available.
 */
export function refreshManagedMcpOAuthCredential(
	credential: MCPStoredOAuthCredential,
	opts: { serverUrl?: string; auth?: MCPAuthConfig; signal?: AbortSignal } = {},
): Promise<OAuthCredentials> {
	const material = selectMcpOAuthRefreshMaterial(credential, opts.auth);
	const tokenUrl = material?.tokenUrl;
	if (!credential.refresh || !tokenUrl) {
		throw new Error("MCP OAuth credential is missing refresh material");
	}
	const authorizationUrl = material && "authorizationUrl" in material ? material.authorizationUrl : undefined;
	const resourceIsFallback = !material?.resource && Boolean(opts.serverUrl);
	const resource = material?.resource ?? (resourceIsFallback ? opts.serverUrl : undefined);
	return refreshMCPOAuthToken(tokenUrl, credential.refresh, material?.clientId, material?.clientSecret, resource, {
		authorizationUrl,
		stripSameOriginResource: resourceIsFallback,
		scope: credential.scope,
		signal: opts.signal,
	});
}

async function refreshBrokeredMcpOAuthCredential(
	authStorage: AuthStorage,
	credentialId: number,
	provider: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const entry = await authStorage.oauth.refresh(credentialId, signal);
	if (entry.credential.type !== "oauth") {
		throw new Error(`Broker returned non-OAuth credential for ${provider}`);
	}
	const refreshed = entry.credential;
	return {
		access: refreshed.access,
		refresh: REMOTE_REFRESH_SENTINEL,
		expires: refreshed.expires,
		accountId: refreshed.accountId,
		email: refreshed.email,
		projectId: refreshed.projectId,
		enterpriseUrl: refreshed.enterpriseUrl,
	};
}

/**
 * Resolve and refresh one stored MCP OAuth row through the durable credential owner.
 *
 * Local rows use their embedded OAuth metadata; broker-redacted rows delegate the
 * grant to the broker. The MCP manager and standalone credential consumers share
 * this path so rotating refresh tokens are persisted before callers receive them.
 *
 * `serverUrl` supplies the RFC 8707 fallback resource indicator; the manager passes
 * the configured server URL for http/sse servers and `undefined` for stdio servers,
 * whose refresh must NOT advertise a resource. Standalone consumers that hold only
 * the credential id (`omp token`) set `recoverServerUrlFromCredentialId` to derive
 * the same fallback resource the http/sse client would use.
 */
export async function refreshStoredManagedMcpOAuthCredential(
	authStorage: AuthStorage,
	provider: string,
	opts: {
		credentialId?: number;
		serverUrl?: string;
		recoverServerUrlFromCredentialId?: boolean;
		auth?: MCPAuthConfig;
		forceRefresh?: boolean;
		keepCredentialOnRefreshFailure?: boolean;
		/** Reject a grant when the current stored row would need runtime-only material. */
		allowRefresh?: (credential: MCPStoredOAuthCredential) => boolean;
		onRefreshFailure?: (error: unknown) => void;
	} = {},
): Promise<StoredOAuthRefreshResult<MCPStoredOAuthCredential>> {
	const row = authStorage.credentials
		.list(provider)
		.find(
			entry =>
				entry.credential.type === "oauth" && (opts.credentialId === undefined || entry.id === opts.credentialId),
		);
	if (row?.credential.type !== "oauth") {
		return { credential: undefined, refreshed: false, removed: false };
	}
	const observedCredential: MCPStoredOAuthCredential = row.credential;
	const serverUrl =
		opts.serverUrl ??
		(opts.recoverServerUrlFromCredentialId ? mcpOAuthServerUrlFromCredentialId(provider) : undefined);
	return authStorage.oauth.refreshStored<MCPStoredOAuthCredential>(provider, {
		credentialId: row.id,
		observedCredential,
		credentialFromRow: credential => credential,
		forceRefresh: opts.forceRefresh,
		refreshSkewMs: 5 * 60_000,
		canRefresh: current => {
			if (opts.allowRefresh?.(current) === false) return false;
			const material = selectMcpOAuthRefreshMaterial(current, opts.auth);
			return Boolean(current.refresh && material?.tokenUrl);
		},
		refresh: (current, signal) =>
			current.refresh === REMOTE_REFRESH_SENTINEL
				? refreshBrokeredMcpOAuthCredential(authStorage, row.id, provider, signal)
				: refreshManagedMcpOAuthCredential(current, {
						serverUrl,
						auth: opts.auth,
						signal,
					}),
		mergeRefreshedCredential: (current, refreshed) => {
			const material = selectMcpOAuthRefreshMaterial(current, opts.auth);
			const resourceIsFallback = !material?.resource && Boolean(serverUrl);
			return {
				...current,
				...refreshed,
				tokenUrl: material?.tokenUrl,
				clientId: material?.clientId,
				clientSecret: material?.clientSecret,
				resource: resourceIsFallback ? undefined : material?.resource,
				authorizationUrl: material && "authorizationUrl" in material ? material.authorizationUrl : undefined,
			};
		},
		isDefinitiveFailure: error => isDefinitiveOAuthFailure(error instanceof Error ? error.message : String(error)),
		disabledCause: error => `oauth refresh failed: ${error instanceof Error ? error.message : String(error)}`,
		keepCredentialOnRefreshFailure: opts.keepCredentialOnRefreshFailure ?? true,
		onRefreshFailure: opts.onRefreshFailure,
	});
}

export async function removeManagedMcpOAuthCredential(
	authStorage: AuthStorage,
	credentialId: string | undefined,
): Promise<boolean> {
	if (!isManagedMCPOAuthCredentialId(credentialId)) return false;
	const scopedProfile = mcpOAuthCredentialProfile(credentialId);
	if (scopedProfile !== undefined && scopedProfile !== (getActiveProfile() ?? "default")) return false;
	if (authStorage.credentials.get(credentialId)?.type !== "oauth") return false;
	await authStorage.credentials.remove(credentialId);
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
