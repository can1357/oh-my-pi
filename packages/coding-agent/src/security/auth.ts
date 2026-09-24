import type { AgentOptions } from "@oh-my-pi/pi-agent-core";
import type { OAuthAccessResolution } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { AuthStorage } from "../session/auth-storage";
import type { SecurityAccountRef, SecurityAuthRef } from "./contracts";

/** Inputs required to resolve one immutable OAuth account reference. */
export interface ExactSecurityOAuthOptions {
	authStorage: AuthStorage;
	account: SecurityAccountRef;
}

/** Model identity fields used to select a supported scan authentication route. */
export interface SecurityAuthModel {
	provider: string;
	api: string;
}

/** Inputs required to enforce a scan authentication reference at request time. */
export interface SecurityAuthResolverOptions {
	authStorage: AuthStorage;
	auth: SecurityAuthRef;
	providerResolver: NonNullable<AgentOptions["getApiKey"]>;
}

function isOAuthAccount(auth: SecurityAuthRef): auth is SecurityAccountRef {
	return "credentialId" in auth;
}

function supportsProviderAuth(model: SecurityAuthModel): boolean {
	return getProviderDefinition(model.provider)?.nativeAuthApis?.includes(model.api) ?? false;
}

/** Rejects changes to any durable OAuth identity field captured by preflight. */
export function assertSecurityIdentityMatches(
	account: SecurityAccountRef,
	resolution: {
		credentialId?: number;
		accountId?: string;
		email?: string;
		orgId?: string;
		orgName?: string;
	},
): void {
	if (
		account.credentialId !== resolution.credentialId ||
		(account.accountId !== undefined && account.accountId !== resolution.accountId) ||
		(account.email !== undefined && account.email !== resolution.email) ||
		(account.organizationId !== undefined && account.organizationId !== resolution.orgId) ||
		(account.organizationName !== undefined && account.organizationName !== resolution.orgName)
	) {
		throw new Error("Security scan authentication identity mismatch");
	}
}

function selectOAuthAccount(
	authStorage: AuthStorage,
	provider: string,
	requestedCredentialId?: number,
	sessionId?: string,
): SecurityAccountRef | undefined {
	const accounts = authStorage.oauth.accounts(provider, sessionId);
	const selected =
		requestedCredentialId !== undefined
			? accounts.find(account => account.credentialId === requestedCredentialId)
			: (accounts.find(account => account.active) ?? (accounts.length === 1 ? accounts[0] : undefined));
	if (selected) {
		const account: SecurityAccountRef = { provider, credentialId: selected.credentialId };
		if (selected.accountId !== undefined) account.accountId = selected.accountId;
		if (selected.email !== undefined) account.email = selected.email;
		if (selected.orgId !== undefined) account.organizationId = selected.orgId;
		if (selected.orgName !== undefined) account.organizationName = selected.orgName;
		return account;
	}
	if (requestedCredentialId !== undefined) {
		throw new Error(`Security OAuth credential ${requestedCredentialId} is not available for ${provider}`);
	}
	if (accounts.length > 0) {
		throw new Error(
			`Multiple OAuth accounts are available for ${provider}; supply credentialId to pin one exact account`,
		);
	}
	return undefined;
}

/** Selects one exact OAuth row for native or Codex Security cloud scans. */
export function selectSecurityOAuthAccount(
	authStorage: AuthStorage,
	provider: string,
	requestedCredentialId?: number,
	sessionId?: string,
): SecurityAccountRef {
	const account = selectOAuthAccount(authStorage, provider, requestedCredentialId, sessionId);
	if (!account) throw new Error(`Security scans require a stored OAuth account for ${provider}`);
	return account;
}

/** Selects either one exact OAuth row or an explicitly supported provider-owned auth route. */
export function selectSecurityAuth(
	authStorage: AuthStorage,
	model: SecurityAuthModel,
	requestedCredentialId?: number,
	sessionId?: string,
): SecurityAuthRef {
	const account = selectOAuthAccount(authStorage, model.provider, requestedCredentialId, sessionId);
	if (account) return account;
	if (supportsProviderAuth(model)) return { provider: model.provider, api: model.api };
	const nativeApis = getProviderDefinition(model.provider)?.nativeAuthApis;
	if (nativeApis) {
		throw new Error(`Security scans do not support provider authentication for ${model.provider}/${model.api}`);
	}
	throw new Error(`Security scans require a stored OAuth account for ${model.provider}`);
}

/** Resolves one pinned OAuth row and verifies that its durable identity has not changed. */
export async function resolveExactSecurityOAuthAccess(
	authStorage: AuthStorage,
	account: SecurityAccountRef,
	options: { forceRefresh: boolean; signal?: AbortSignal },
): Promise<Extract<OAuthAccessResolution, { ok: true }>> {
	const resolution = await authStorage.oauth.accessById(account.provider, account.credentialId, options);
	if (!resolution) throw new Error("The pinned security OAuth credential is unavailable");
	assertSecurityIdentityMatches(account, resolution);
	if (!resolution.ok) throw new Error("The pinned security OAuth credential could not be resolved");
	return resolution;
}

/**
 * Build a request credential resolver pinned to one durable OAuth row.
 *
 * Initial resolution and refresh both target the same row. The auth driver's
 * final sibling-rotation step returns `undefined`, so an unavailable account
 * fails the scan rather than crossing an account/workspace boundary.
 */
export function createExactSecurityOAuthResolver(
	options: ExactSecurityOAuthOptions,
): NonNullable<AgentOptions["getApiKey"]> {
	const { account, authStorage } = options;
	return model => {
		if (model.provider !== account.provider) {
			throw new Error("Security scan authentication provider mismatch");
		}
		const resolver: ApiKeyResolver = async context => {
			if (context.lastChance) return undefined;
			const resolution = await resolveExactSecurityOAuthAccess(authStorage, account, {
				forceRefresh: context.error !== undefined,
				signal: context.signal,
			});
			return resolution.accessToken;
		};
		return resolver;
	};
}

/**
 * Builds the scan resolver while preserving either its exact OAuth row or provider-owned auth boundary.
 */
export function createSecurityAuthResolver(
	options: SecurityAuthResolverOptions,
): NonNullable<AgentOptions["getApiKey"]> {
	const { auth, authStorage, providerResolver } = options;
	if (isOAuthAccount(auth)) return createExactSecurityOAuthResolver({ authStorage, account: auth });
	return model => {
		if (model.provider !== auth.provider) {
			throw new Error("Security scan authentication provider mismatch");
		}
		if (model.api !== auth.api) {
			throw new Error("Security scan authentication API mismatch");
		}
		if (!supportsProviderAuth(model)) {
			throw new Error(`Security scans do not support provider authentication for ${model.provider}/${model.api}`);
		}
		return providerResolver(model);
	};
}
