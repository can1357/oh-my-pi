import type { AuthStorage, DisabledCredentialSummary } from "@oh-my-pi/pi-ai";
import type { OAuthAccountIdentity, StoredAuthCredential } from "../../session/auth-storage";

import type { LogoutAccount } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";

interface LogoutAccountOptions {
	activeIdentity?: OAuthAccountIdentity;
	activeApiKey?: boolean;
}

/** Identity-only view shared by logout surfaces; never contains token material or disable causes. */
export interface LogoutCredentialSummary {
	id: number;
	provider: string;
	type: StoredAuthCredential["credential"]["type"];
	email?: string;
	accountId?: string;
	projectId?: string;
	enterpriseUrl?: string;
	orgId?: string;
	orgName?: string;
	disabled: boolean;
}

function summarizeCredential(row: StoredAuthCredential | DisabledCredentialSummary): LogoutCredentialSummary {
	const credential = "credential" in row ? row.credential : row;
	return {
		id: row.id,
		provider: row.provider,
		type: credential.type,
		disabled: !("credential" in row),
		...(credential.type === "oauth"
			? {
					email: credential.email,
					accountId: credential.accountId,
					projectId: credential.projectId,
					enterpriseUrl:
						"credential" in row && row.credential.type === "oauth" ? row.credential.enterpriseUrl : undefined,
					orgId: credential.orgId,
					orgName: credential.orgName,
				}
			: {}),
	};
}

export async function collectLogoutCredentials(
	storage: AuthStorage,
	provider?: string,
): Promise<LogoutCredentialSummary[]> {
	const active = storage.credentials.list(provider).map(summarizeCredential);
	const disabled = (await storage.credentials.listDisabled(provider)).map(summarizeCredential);
	return [...active, ...disabled];
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function logoutCredentialLabel(credential: LogoutCredentialSummary): string {
	if (credential.type !== "oauth") return `API key #${credential.id}`;
	const base =
		nonEmpty(credential.email) ??
		nonEmpty(credential.accountId) ??
		nonEmpty(credential.projectId) ??
		nonEmpty(credential.enterpriseUrl) ??
		`OAuth credential #${credential.id}`;
	// Two subscriptions (orgs) can share one email — the org is the only
	// user-visible way to tell which row a logout will remove.
	const org = nonEmpty(credential.orgName) ?? nonEmpty(credential.orgId);
	return org && org !== base ? `${base} (${org})` : base;
}

function oauthDetail(credential: LogoutCredentialSummary, label: string): string {
	if (credential.type === "api_key") return `stored API key #${credential.id}`;
	const parts: string[] = [];
	const email = nonEmpty(credential.email);
	const accountId = nonEmpty(credential.accountId);
	const projectId = nonEmpty(credential.projectId);
	const enterpriseUrl = nonEmpty(credential.enterpriseUrl);
	if (email && email !== label) parts.push(email);
	if (accountId && accountId !== label) parts.push(`account ${accountId}`);
	if (projectId && projectId !== label) parts.push(`project ${projectId}`);
	if (enterpriseUrl && enterpriseUrl !== label) parts.push(enterpriseUrl);
	parts.push(`oauth #${credential.id}`);
	return parts.join(" · ");
}

function oauthMatchesActiveIdentity(
	row: StoredAuthCredential,
	activeIdentity: OAuthAccountIdentity | undefined,
): boolean {
	if (!activeIdentity || row.credential.type !== "oauth") return false;
	const credential = row.credential;
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
	return (
		(activeIdentity.accountId !== undefined && credential.accountId === activeIdentity.accountId) ||
		(activeIdentity.email !== undefined && credential.email === activeIdentity.email) ||
		(activeIdentity.projectId !== undefined && credential.projectId === activeIdentity.projectId)
	);
}

export function toLogoutAccounts(
	provider: string,
	credentials: StoredAuthCredential[],
	options: LogoutAccountOptions = {},
): LogoutAccount[] {
	return credentials
		.map(row => {
			const summary = summarizeCredential(row);
			const label = logoutCredentialLabel(summary);
			const active =
				row.credential.type === "oauth"
					? oauthMatchesActiveIdentity(row, options.activeIdentity)
					: options.activeApiKey === true;
			return {
				credentialId: row.id,
				provider,
				label,
				detail: oauthDetail(summary, label),
				type: row.credential.type,
				active,
			} satisfies LogoutAccount;
		})
		.sort((left, right) => {
			if (left.active !== right.active) return left.active ? -1 : 1;
			return left.label.localeCompare(right.label) || left.credentialId - right.credentialId;
		});
}
