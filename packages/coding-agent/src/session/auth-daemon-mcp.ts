import { type } from "@oh-my-pi/omptype";
import { REMOTE_REFRESH_SENTINEL } from "@oh-my-pi/pi-ai";
import type { AuthDaemonRequestHandler } from "../daemon/modules/auth";
import { mcpOAuthProviderDigest, refreshStoredManagedMcpOAuthCredential } from "../mcp/oauth-credentials";
import { isManagedMCPOAuthCredentialId, mcpOAuthServerUrlFromCredentialId } from "../mcp/oauth-flow";
import { isAuthDaemonCredentialId } from "./auth-daemon-contract";
import type { AuthDaemonLease } from "./auth-daemon-owner";

const McpOAuthFind = type({
	providerDigests: type("string")
		.narrow(digest => /^[0-9a-f]{64}$/.test(digest))
		.array()
		.narrow(digests => digests.length >= 1 && digests.length <= 3),
	"+": "reject",
});

const McpOAuthAccess = type({
	credentialId: type("number").narrow(isAuthDaemonCredentialId),
	"forceRefresh?": "boolean",
	resourceMode: "'from-row-id' | 'none'",
	"+": "reject",
});

export interface AuthDaemonMcpFindResult {
	credentialId: number;
	candidateIndex: number;
	requiresLocal: boolean;
}

export type AuthDaemonMcpAccessResult =
	| { kind: "access"; accessToken: string; expires: number; refreshed: boolean; refreshFailed?: true }
	| { kind: "missing"; removed: boolean }
	| { kind: "requires-local" };

function mcpGrantRequiresLocal(provider: string): boolean {
	// The binding carries no profile. An explicit legacy pointer may also name
	// a provider unsupported by the daemon's managed MCP grant.
	return !isManagedMCPOAuthCredentialId(provider) || provider.startsWith("mcp_oauth:profile:");
}

async function mcpOAuthFind(lease: AuthDaemonLease, value: unknown): Promise<AuthDaemonMcpFindResult | null> {
	const request = McpOAuthFind(value);
	if (request instanceof type.errors) throw new Error("auth: invalid MCP OAuth find params");
	const { providerDigests } = request;
	const { credentials } = lease.storage;
	await credentials.poll();

	let match: AuthDaemonMcpFindResult | null = null;
	for (const provider of lease.storage.storedAuthProviders()) {
		const candidateIndex = providerDigests.indexOf(mcpOAuthProviderDigest(provider));
		if (candidateIndex === -1 || (match && match.candidateIndex <= candidateIndex)) continue;
		const row = credentials.list(provider)[0];
		if (row?.credential.type !== "oauth") continue;
		match = { credentialId: row.id, candidateIndex, requiresLocal: mcpGrantRequiresLocal(provider) };
		if (candidateIndex === 0) break;
	}
	return match;
}

async function mcpOAuthAccess(lease: AuthDaemonLease, value: unknown): Promise<AuthDaemonMcpAccessResult> {
	const request = McpOAuthAccess(value);
	if (request instanceof type.errors) throw new Error("auth: invalid MCP OAuth access params");
	const { credentialId, forceRefresh, resourceMode } = request;
	const { storage } = lease;
	await storage.credentials.poll();
	for (const provider of storage.storedAuthProviders()) {
		if (!isManagedMCPOAuthCredentialId(provider)) continue;
		const row = storage.credentials.list(provider).find(entry => entry.id === credentialId);
		if (row?.credential.type !== "oauth") continue;
		if (mcpGrantRequiresLocal(provider)) return { kind: "requires-local" };
		const serverUrl = resourceMode === "from-row-id" ? mcpOAuthServerUrlFromCredentialId(provider) : undefined;
		let requiresLocal = false;
		let refreshFailed = false;
		const result = await refreshStoredManagedMcpOAuthCredential(storage, provider, {
			credentialId,
			serverUrl,
			forceRefresh,
			allowRefresh: current => {
				// This runs on the current row, including after acquiring its refresh lease.
				// A broker sentinel still follows the existing token endpoint gate and
				// delegates its own resource resolution to the broker.
				const needsRuntimeResource =
					current.refresh !== REMOTE_REFRESH_SENTINEL &&
					resourceMode === "from-row-id" &&
					serverUrl === undefined &&
					(current.resource === undefined || current.resource === null);
				requiresLocal = Boolean(current.refresh) && (!current.tokenUrl || needsRuntimeResource);
				return !requiresLocal;
			},
			onRefreshFailure: () => {
				refreshFailed = true;
			},
		});
		if (!result.credential) return { kind: "missing", removed: result.removed };
		if (requiresLocal) return { kind: "requires-local" };
		const { access, expires } = result.credential;
		if (typeof access !== "string" || access.length === 0 || !Number.isFinite(expires)) {
			throw new Error("auth: invalid MCP OAuth access credential");
		}
		return {
			kind: "access",
			accessToken: access,
			expires,
			refreshed: result.refreshed,
			...(refreshFailed ? { refreshFailed: true } : {}),
		};
	}
	return { kind: "missing", removed: false };
}

export const authDaemonMcpHandlers: ReadonlyMap<string, AuthDaemonRequestHandler> = new Map<
	string,
	AuthDaemonRequestHandler
>([
	["mcp-oauth-access", mcpOAuthAccess],
	["mcp-oauth-find", mcpOAuthFind],
]);
