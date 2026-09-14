import type { AgentOptions } from "@oh-my-pi/pi-agent-core";
import { AUTHENTICATED_SENTINEL, type Api, type Model, type OAuthAccessResolution } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import type { AuthStorage } from "../session/auth-storage";
import type { SecurityAccountRef, SecurityOAuthAccountRef, SecurityProviderNativeAccountRef } from "./contracts";

export interface ExactSecurityOAuthOptions {
	authStorage: AuthStorage;
	account: SecurityOAuthAccountRef;
}

export interface ProviderNativeSecurityOptions {
	modelRegistry: {
		resolver(model: Pick<Model<Api>, "provider" | "baseUrl" | "id">, sessionId?: string): ApiKeyResolver;
	};
	account: SecurityProviderNativeAccountRef;
	sessionId: string;
}

export function assertSecurityIdentityMatches(
	account: SecurityOAuthAccountRef,
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

const PROVIDER_NATIVE_SECURITY_PATHS: Record<string, true> = {
	"amazon-bedrock\u0000bedrock-converse-stream": true,
	"bedrock-mantle\u0000openai-responses": true,
};

export function isProviderNativeSecurityModel(model: Pick<Model<Api>, "provider" | "api">): boolean {
	return PROVIDER_NATIVE_SECURITY_PATHS[`${model.provider}\u0000${model.api}`] === true;
}

function providerNativeAccount(provider: string): SecurityProviderNativeAccountRef {
	if (provider !== "amazon-bedrock" && provider !== "bedrock-mantle") {
		throw new Error(`Unsupported provider-native security provider: ${provider}`);
	}
	return { provider, authMode: "provider-native", credentialSource: "aws" };
}

export function selectSecurityAccount(
	authStorage: AuthStorage,
	provider: string,
	requestedCredentialId?: number,
	sessionId?: string,
): SecurityOAuthAccountRef {
	const accounts = authStorage.listOAuthAccounts(provider, sessionId);
	const selected =
		requestedCredentialId !== undefined
			? accounts.find(account => account.credentialId === requestedCredentialId)
			: (accounts.find(account => account.active) ?? (accounts.length === 1 ? accounts[0] : undefined));
	if (!selected) {
		if (accounts.length === 0) throw new Error(`Security scans require a stored OAuth account for ${provider}`);
		if (requestedCredentialId !== undefined) {
			throw new Error(`Security OAuth credential ${requestedCredentialId} is not available for ${provider}`);
		}
		throw new Error(
			`Multiple OAuth accounts are available for ${provider}; supply credentialId to pin one exact account`,
		);
	}
	const account: SecurityOAuthAccountRef = { provider, authMode: "oauth", credentialId: selected.credentialId };
	if (selected.accountId !== undefined) account.accountId = selected.accountId;
	if (selected.email !== undefined) account.email = selected.email;
	if (selected.orgId !== undefined) account.organizationId = selected.orgId;
	if (selected.orgName !== undefined) account.organizationName = selected.orgName;
	return account;
}

export async function selectSecurityAccountForModel(options: {
	authStorage: AuthStorage;
	model: Pick<Model<Api>, "provider" | "api">;
	requestedCredentialId?: number;
	sessionId?: string;
	resolveApiKey: () => Promise<string | undefined>;
}): Promise<SecurityAccountRef> {
	if (options.requestedCredentialId === undefined && isProviderNativeSecurityModel(options.model)) {
		const apiKey = await options.resolveApiKey();
		if (apiKey === AUTHENTICATED_SENTINEL) return providerNativeAccount(options.model.provider);
	}
	return selectSecurityAccount(
		options.authStorage,
		options.model.provider,
		options.requestedCredentialId,
		options.sessionId,
	);
}

export async function resolveExactSecurityOAuthAccess(
	authStorage: AuthStorage,
	account: SecurityOAuthAccountRef,
	options: { forceRefresh: boolean; signal?: AbortSignal },
): Promise<Extract<OAuthAccessResolution, { ok: true }>> {
	const resolution = await authStorage.getOAuthAccessByCredentialId(account.provider, account.credentialId, options);
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

export function createProviderNativeSecurityResolver(
	options: ProviderNativeSecurityOptions,
): NonNullable<AgentOptions["getApiKey"]> {
	const { account, modelRegistry, sessionId } = options;
	return model => {
		if (model.provider !== account.provider) {
			throw new Error("Security scan authentication provider mismatch");
		}
		if (!isProviderNativeSecurityModel(model)) {
			throw new Error("Unsupported provider-native security model");
		}
		return modelRegistry.resolver(model, sessionId);
	};
}
