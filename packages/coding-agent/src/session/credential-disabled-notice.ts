import { type CredentialDisabledEvent, getOAuthProviders } from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** `notice` source of an automatic credential disable; print mode writes these to stderr. */
export const CREDENTIAL_DISABLED_NOTICE_SOURCE = "auth";

/**
 * Warning for a credential the auth layer signed out on its own, or `undefined` when the
 * provider has no `/login` entry (MCP OAuth servers re-authorize through their own flow).
 *
 * The provider's failure text is left out on purpose: it is provider-controlled, and it
 * stays in the log line and the stored disable cause.
 */
export function formatCredentialDisabledNotice(event: CredentialDisabledEvent): string | undefined {
	const providers = getOAuthProviders();
	const login =
		providers.find(provider => provider.id === event.provider) ??
		providers.find(provider => provider.storeCredentialsAs === event.provider);
	if (!login) return undefined;
	const account = sanitizeText(event.email ?? event.accountId ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const subject = account ? `${login.name} account ${account}` : `A ${login.name} account`;
	return `${subject} was signed out automatically. Run /login to sign in again.`;
}
