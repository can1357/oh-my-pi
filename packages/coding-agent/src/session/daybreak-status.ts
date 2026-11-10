import type { AuthStorage } from "@oh-my-pi/pi-ai";

/** The OAuth account this session has actually selected, if any. */
export function selectedOAuthAccountId(
	authStorage: AuthStorage,
	provider: string,
	sessionId: string,
): string | undefined {
	return authStorage.oauth.accounts(provider, sessionId).find(account => account.active)?.accountId;
}

/** Non-secret identity of the auth state used to resolve a session request. */
export function daybreakAuthKey(authStorage: AuthStorage, provider: string, sessionId: string): string | undefined {
	const source = authStorage.keys.source(provider, { fresh: true });
	if (!source) return undefined;
	const selectedAccountId =
		source.kind === "oauth" ? selectedOAuthAccountId(authStorage, provider, sessionId) : undefined;
	return `${provider}\0${sessionId}\0${source.kind}\0${authStorage.keys.overrideRevision(provider)}\0${authStorage.credentials.generationOf(provider)}\0${selectedAccountId ?? ""}`;
}
