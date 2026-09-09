import type { OAuthAccountIdentity, StoredAuthCredential } from "../../session/auth-storage";

export interface LogoutAccount {
	credentialId: number;
	provider: string;
	label: string;
	detail: string;
	type: "api_key" | "oauth";
	active: boolean;
}

interface LogoutAccountOptions {
	activeIdentity?: OAuthAccountIdentity;
	activeApiKey?: boolean;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function oauthLabel(row: StoredAuthCredential): string {
	const credential = row.credential;
	if (credential.type !== "oauth") return `API key #${row.id}`;
	const base =
		nonEmpty(credential.email) ??
		nonEmpty(credential.accountId) ??
		nonEmpty(credential.projectId) ??
		nonEmpty(credential.enterpriseUrl) ??
		`OAuth credential #${row.id}`;
	// Two subscriptions (orgs) can share one email — the org is the only
	// user-visible way to tell which row a logout will remove.
	const org = nonEmpty(credential.orgName) ?? nonEmpty(credential.orgId);
	return org && org !== base ? `${base} (${org})` : base;
}

function oauthDetail(row: StoredAuthCredential, label: string): string {
	const credential = row.credential;
	if (credential.type === "api_key") return `stored API key #${row.id}`;
	const parts: string[] = [];
	const email = nonEmpty(credential.email);
	const accountId = nonEmpty(credential.accountId);
	const projectId = nonEmpty(credential.projectId);
	const enterpriseUrl = nonEmpty(credential.enterpriseUrl);
	if (email && email !== label) parts.push(email);
	if (accountId && accountId !== label) parts.push(`account ${accountId}`);
	if (projectId && projectId !== label) parts.push(`project ${projectId}`);
	if (enterpriseUrl && enterpriseUrl !== label) parts.push(enterpriseUrl);
	parts.push(`oauth #${row.id}`);
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
			const label = oauthLabel(row);
			const active =
				row.credential.type === "oauth"
					? oauthMatchesActiveIdentity(row, options.activeIdentity)
					: options.activeApiKey === true;
			return {
				credentialId: row.id,
				provider,
				label,
				detail: oauthDetail(row, label),
				type: row.credential.type,
				active,
			} satisfies LogoutAccount;
		})
		.sort((left, right) => {
			if (left.active !== right.active) return left.active ? -1 : 1;
			return left.label.localeCompare(right.label) || left.credentialId - right.credentialId;
		});
}
