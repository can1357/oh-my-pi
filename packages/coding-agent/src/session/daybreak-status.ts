import type { AuthStorage } from "@oh-my-pi/pi-ai";

/** The OAuth account this session has actually selected, if any. */
export function selectedOAuthAccountId(
	authStorage: AuthStorage,
	provider: string,
	sessionId: string,
): string | undefined {
	return authStorage.oauth.accounts(provider, sessionId).find(account => account.active)?.accountId;
}
