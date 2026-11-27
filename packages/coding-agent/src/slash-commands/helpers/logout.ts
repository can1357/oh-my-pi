import type { StoredCredentialSummary } from "@oh-my-pi/pi-ai";
import { getOAuthCredentialProvider } from "@oh-my-pi/pi-ai/oauth";
import { connectedProviderName } from "../../modes/view-model/chrome/format";
import type { LogoutAccount } from "../../modes/view-model/overlays/logout-account-selector";
import type { AgentSession } from "../../session/agent-session";
import type { AuthStorage, OAuthAccountIdentity } from "../../session/auth-storage";

interface LogoutAccountOptions {
	activeIdentity?: OAuthAccountIdentity;
	activeApiKey?: boolean;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function oauthLabel(row: StoredCredentialSummary): string {
	if (row.type === "api_key") return `API key #${row.id}`;
	const base =
		nonEmpty(row.email) ??
		nonEmpty(row.accountId) ??
		nonEmpty(row.projectId) ??
		nonEmpty(row.enterpriseUrl) ??
		`OAuth credential #${row.id}`;
	// Two subscriptions (orgs) can share one email — the org is the only
	// user-visible way to tell which row a logout will remove.
	const org = nonEmpty(row.orgName) ?? nonEmpty(row.orgId);
	return org && org !== base ? `${base} (${org})` : base;
}

function oauthDetail(provider: string, row: StoredCredentialSummary, label: string): string {
	if (row.type === "api_key") return `stored API key #${row.id}`;
	const parts: string[] = [];
	if (row.accessOff) parts.push(`${connectedProviderName(provider)} off`);
	const email = nonEmpty(row.email);
	const accountId = nonEmpty(row.accountId);
	const projectId = nonEmpty(row.projectId);
	const enterpriseUrl = nonEmpty(row.enterpriseUrl);
	if (email && email !== label) parts.push(email);
	if (accountId && accountId !== label) parts.push(`account ${accountId}`);
	if (projectId && projectId !== label) parts.push(`project ${projectId}`);
	if (enterpriseUrl && enterpriseUrl !== label) parts.push(enterpriseUrl);
	parts.push(`oauth #${row.id}`);
	return parts.join(" · ");
}

function oauthMatchesActiveIdentity(
	credential: OAuthAccountIdentity,
	activeIdentity: OAuthAccountIdentity | undefined,
): boolean {
	if (!activeIdentity) return false;
	// The org GATES the base identity rather than replacing it: mismatched org
	// presence or different orgs never match — an org-scoped active session
	// must not preselect the bare-email legacy row, and a bare-email active
	// row must not mark org-scoped siblings active via the shared email. A
	// SHARED org still requires the base-identity match below: two Team seats
	// share one orgId yet own distinct rows. Only an org-only active identity
	// (no base identifiers recovered at all) matches on the org alone.
	if (activeIdentity.orgId !== undefined || credential.orgId !== undefined) {
		if (credential.orgId !== activeIdentity.orgId) return false;
		if (
			activeIdentity.accountId === undefined &&
			activeIdentity.email === undefined &&
			activeIdentity.projectId === undefined
		) {
			return true;
		}
	}
	// When both sides carry an email it decides: Codex Team seats share an
	// account id.
	if (activeIdentity.email !== undefined && credential.email !== undefined) {
		return credential.email === activeIdentity.email;
	}
	return (
		(activeIdentity.accountId !== undefined && credential.accountId === activeIdentity.accountId) ||
		(activeIdentity.projectId !== undefined && credential.projectId === activeIdentity.projectId)
	);
}

export function toLogoutAccounts(
	provider: string,
	credentials: readonly StoredCredentialSummary[],
	options: LogoutAccountOptions = {},
): LogoutAccount[] {
	return credentials
		.map(row => {
			const label = oauthLabel(row);
			const active =
				row.type === "oauth"
					? oauthMatchesActiveIdentity(row, options.activeIdentity)
					: options.activeApiKey === true;
			return {
				credentialId: row.id,
				provider,
				label,
				detail: oauthDetail(provider, row, label),
				type: row.type,
				active,
			} satisfies LogoutAccount;
		})
		.sort((left, right) => {
			if (left.active !== right.active) return left.active ? -1 : 1;
			return left.label.localeCompare(right.label) || left.credentialId - right.credentialId;
		});
}

/** Stored accounts `/logout` can remove for `provider`, active first. Reloads the store to see other processes' changes. */
export async function listLogoutAccounts(
	authStorage: AuthStorage,
	loginProvider: string,
	sessionId: string,
): Promise<LogoutAccount[]> {
	const provider = getOAuthCredentialProvider(loginProvider);
	await authStorage.credentials.reload();
	return toLogoutAccounts(provider, authStorage.credentials.summaries(provider), {
		activeIdentity: authStorage.oauth.identity(provider, sessionId),
		activeApiKey: authStorage.keys.source(provider)?.kind === "api_key",
	});
}

/**
 * Removes one stored credential (its provider forgets the account's secrets on
 * this machine and revokes its grant upstream) and refreshes the provider's
 * models. `removed: false` means the credential was already gone;
 * `remainingSource` names the auth source that still authenticates the
 * provider, if any; `signOutError` says why the provider's sign-out failed
 * (the credential is removed regardless).
 */
export async function logoutCredential(
	session: Pick<AgentSession, "modelRegistry" | "sessionId" | "refreshScopedModels">,
	loginProvider: string,
	credentialId: number,
): Promise<{ removed: boolean; remainingSource?: string; signOutError?: string }> {
	const provider = getOAuthCredentialProvider(loginProvider);
	const modelRegistry = session.modelRegistry;
	const authStorage = modelRegistry.authStorage;
	// Reload so an id stored by another process is found, not reported missing.
	await authStorage.credentials.reload();
	const { removed, signOutError } = await authStorage.oauth.signOut(provider, credentialId);
	if (!removed) return { removed: false };
	// Provider-scoped online refresh so the removed credential's stale
	// endpoint/deployment models are invalidated deterministically; the
	// default all-provider `online-if-uncached` would reuse the fresh
	// authoritative cache row and keep showing models the credential
	// unlocked (#5780). Other providers are left untouched.
	await modelRegistry.refreshProvider(provider, "online");
	await session.refreshScopedModels();
	return {
		removed: true,
		remainingSource: authStorage.keys.describe(provider, session.sessionId),
		...(signOutError === undefined ? {} : { signOutError }),
	};
}
