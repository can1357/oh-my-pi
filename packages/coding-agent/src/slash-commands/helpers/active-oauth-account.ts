import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { matchesUsageAccount } from "@oh-my-pi/pi-ai/auth/usage-report";
import type { OAuthAccountIdentity } from "../../session/auth-storage";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Codex's orgName is the login-time plan, not a workspace name. */
export function codexUsagePlan(report: UsageReport): string | undefined {
	if (report.provider !== "openai-codex") return undefined;
	const plan = report.metadata?.planType;
	if (typeof plan !== "string" || !plan.trim()) return undefined;
	return sanitizeText(plan.trim().replace(/[\r\n\t]+/g, " "));
}

/** OAuth identity a usage report is attributed to, from its metadata or its limits' scopes. */
export function usageReportIdentity(report: UsageReport): OAuthAccountIdentity {
	const metadata = report.metadata ?? {};
	const read = (key: keyof OAuthAccountIdentity): string | undefined => {
		const value = metadata[key];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	};
	const firstScoped = (key: "accountId" | "projectId" | "orgId"): string | undefined => {
		for (const limit of report.limits) {
			const value = limit.scope[key];
			if (value) return value;
		}
		return undefined;
	};
	return {
		email: read("email"),
		accountId: read("accountId") ?? firstScoped("accountId"),
		projectId: read("projectId") ?? firstScoped("projectId"),
		orgId: read("orgId") ?? firstScoped("orgId"),
		orgName: read("orgName"),
	};
}

/** Qualify Codex identities only when two reports have the same email. */
export function formatCodexUsageReportLabel(
	report: UsageReport,
	peers: readonly UsageReport[],
	base: string,
	redaction?: Map<string, string>,
	includePlan = true,
	orgStyle: "inline" | "parenthesized" = "parenthesized",
): string {
	const email = report.metadata?.email;
	const collision =
		typeof email === "string" && !!email && peers.some(peer => peer !== report && peer.metadata?.email === email);
	const rawOrg = collision
		? (report.metadata?.orgId ?? report.metadata?.accountId ?? `account ${peers.indexOf(report) + 1}`)
		: undefined;
	const clean = (value: string): string => sanitizeText((redaction?.get(value) ?? value).replace(/[\r\n\t]+/g, " "));
	const org =
		typeof rawOrg === "string" && rawOrg && rawOrg !== base
			? orgStyle === "inline"
				? ` · ${clean(rawOrg)}`
				: ` (${clean(rawOrg)})`
			: "";
	const identity = clean(base);
	const plan = includePlan ? codexUsagePlan(report) : undefined;
	return `${identity}${org}${plan ? ` · plan: ${plan}` : ""}`;
}

/**
 * Identity a usage limit is attributed to: an OAuth account identity, or —
 * when the account has no OAuth identifiers at all (API-key credentials) — a
 * durable credential row id. See {@link limitMatchesActiveAccount}.
 */
export type ActiveAccountIdentity = OAuthAccountIdentity & { credentialId?: number };

/**
 * Session marker label for an active OAuth identity: the base identifier
 * (email → accountId → projectId) suffixed with the organization when present
 * and distinct. Same-email Anthropic multi-org accounts share the base, so the
 * org suffix is the only field that tells the session's quota pool apart.
 * Codex usage labels instead use live report metadata via formatCodexUsageReportLabel.
 * Returns `undefined` when no identifier is recoverable.
 */
export function formatActiveAccountLabel(identity: OAuthAccountIdentity | undefined): string | undefined {
	if (!identity) return undefined;
	const base = identity.email || identity.accountId || identity.projectId;
	if (!base) return undefined;
	const org = identity.orgName || identity.orgId;
	return org && org !== base ? `${base} (${org})` : base;
}

/**
 * True when a usage column belongs to the active account. OAuth uses shared report attribution;
 * pinned API keys require a durable row ID, including IDs carried by merged same-account reports.
 */
export function limitMatchesActiveAccount(
	report: UsageReport,
	limit: UsageLimit,
	identity: ActiveAccountIdentity | undefined,
): boolean {
	if (!identity) return false;
	const metadata = report.metadata ?? {};
	if (identity.credentialId !== undefined) {
		// Merged same-account reports carry every contributing row id.
		const mergedIds = metadata.credentialIds;
		if (Array.isArray(mergedIds)) return mergedIds.includes(identity.credentialId);
		return metadata.credentialId === identity.credentialId;
	}
	return matchesUsageAccount(report, identity, { limit, allowOrgOnly: true });
}

/** True when any limit column in `report` belongs to the given OAuth identity. */
export function reportMatchesActiveAccount(report: UsageReport, identity: ActiveAccountIdentity | undefined): boolean {
	if (!identity) return false;
	return report.limits.some(limit => limitMatchesActiveAccount(report, limit, identity));
}
