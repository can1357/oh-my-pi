import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import type { OAuthAccountIdentity } from "../../session/auth-storage";
import { type AccountLabel, usageIdentityKey } from "../../modes/utils/usage-mask";

function normalizeIdentityValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

/**
 * Session marker label for an active OAuth identity: the base identifier
 * (email → accountId → projectId) suffixed with the organization when present
 * and distinct. Same-email Anthropic multi-org accounts share the base, so the
 * org suffix is the only field that tells the session's quota pool apart —
 * mirrors the account-list rows (`formatUsageReportAccount`) and login success.
 * Returns `undefined` when no identifier is recoverable.
 */
export function formatActiveAccountLabel(identity: OAuthAccountIdentity | undefined): string | undefined {
	const label = getActiveAccountLabelParts(identity);
	return label ? label.identity + (label.qualifier ?? "") : undefined;
}

export function getActiveAccountLabelParts(identity: OAuthAccountIdentity | undefined): AccountLabel | undefined {
	if (!identity) return undefined;
	const base = identity.email || identity.accountId || identity.projectId;
	if (!base) return undefined;
	const org = identity.orgName || identity.orgId;
	return {
		identity: base,
		qualifier: org && org !== base ? ` (${org})` : undefined,
		accountKey: usageIdentityKey(identity.accountId, identity.projectId, undefined, identity.orgId),
	};
}

/**
 * True when a single usage-limit column belongs to the given OAuth identity.
 *
 * Single definition of the matching rules for both `/usage` renderers:
 * - `orgId`     ↔ report metadata `orgId` — a GATE that QUALIFIES the base
 *   identity, never a replacement for it. Mismatched org presence or
 *   different orgs never match: two subscriptions (orgs) can share one
 *   email, so an org-scoped identity matches only its own org's reports and
 *   an org-less legacy identity never claims an org-attributed report via
 *   the shared email. A SHARED org still requires the base-identity match
 *   below — Anthropic Team seats have per-user pools yet share the org id
 *   in report metadata. Only an org-only identity (no base identifiers
 *   recovered at all) matches on the org alone. When neither side carries
 *   an org, the base fallback applies unchanged (providers without orgs
 *   keep their former behavior).
 * - `accountId` ↔ report metadata `accountId`/`account_id` or `limit.scope.accountId`
 * - `email`     ↔ report metadata `email`
 * - `projectId` ↔ report metadata `projectId` or `limit.scope.projectId`
 *   (Google-style providers key usage on the GCP project, not an account id)
 */
function matchesActiveAccount(
	report: UsageReport,
	limit: UsageLimit | undefined,
	identity: OAuthAccountIdentity | undefined,
): boolean {
	if (!identity) return false;
	const metadata = report.metadata ?? {};
	const activeAccountId = normalizeIdentityValue(identity.accountId);
	const activeEmail = normalizeIdentityValue(identity.email);
	const activeProjectId = normalizeIdentityValue(identity.projectId);
	const activeOrgId = normalizeIdentityValue(identity.orgId);
	const reportOrgId = normalizeIdentityValue(metadata.orgId);
	// Org gate (see doc comment above): different/mismatched-presence orgs
	// never match; a shared org falls through to the base checks unless the
	// identity is org-only.
	if (activeOrgId || reportOrgId) {
		if (activeOrgId !== reportOrgId) return false;
		if (!activeAccountId && !activeEmail && !activeProjectId) return true;
	} else {
		// Names qualify the identity only when neither side provides an org ID.
		const activeOrgName = normalizeIdentityValue(identity.orgName);
		const reportOrgName = normalizeIdentityValue(metadata.orgName);
		if (activeOrgName || reportOrgName) {
			if (activeOrgName !== reportOrgName) return false;
			if (!activeAccountId && !activeEmail && !activeProjectId) return true;
		}
	}
	const reportAccountId =
		normalizeIdentityValue(metadata.accountId) ??
		normalizeIdentityValue(metadata.account_id) ??
		normalizeIdentityValue(limit?.scope.accountId);
	const reportProjectId = normalizeIdentityValue(metadata.projectId) ?? normalizeIdentityValue(limit?.scope.projectId);
	let matchedStableId = false;
	if (activeAccountId && reportAccountId) {
		if (activeAccountId !== reportAccountId) return false;
		matchedStableId = true;
	}
	if (activeProjectId && reportProjectId) {
		if (activeProjectId !== reportProjectId) return false;
		matchedStableId = true;
	}
	return matchedStableId || !!(activeEmail && normalizeIdentityValue(metadata.email) === activeEmail);
}

/** True when a single usage-limit column belongs to the given OAuth identity. */
export function limitMatchesActiveAccount(
	report: UsageReport,
	limit: UsageLimit,
	identity: OAuthAccountIdentity | undefined,
): boolean {
	return matchesActiveAccount(report, limit, identity);
}

/** True when report metadata or any limit column belongs to the given OAuth identity. */
export function reportMatchesActiveAccount(report: UsageReport, identity: OAuthAccountIdentity | undefined): boolean {
	if (!identity) return false;
	return report.limits.length === 0
		? matchesActiveAccount(report, undefined, identity)
		: report.limits.some(limit => matchesActiveAccount(report, limit, identity));
}
