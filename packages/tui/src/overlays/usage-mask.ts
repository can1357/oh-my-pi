import type { UsageReport } from "@oh-my-pi/pi-ai";
import { getSegmenter, replaceTabs } from "../utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";

export const MASK_STARS = "***";

/** Identity and an explicitly attributed organization qualifier are distinct data. */
export interface AccountLabel {
	identity: string;
	qualifier?: string;
	/** The provider-attributed organization name, never parsed out of opaque identifiers. */
	organizationName?: string;
	organizationId?: string;
	placeholder?: boolean;
	/** Provider partition for display-mask collision ordinals. */
	provider?: string;
	/** Provider identity used to distinguish accounts sharing one display name. */
	accountKey?: string;
}

export function usageIdentityKey(
	accountId: unknown,
	projectId: unknown,
	fallback?: { accountId?: string; projectId?: string },
	organizationId?: unknown,
): string | undefined {
	const account = typeof accountId === "string" && accountId ? accountId : fallback?.accountId;
	const project = typeof projectId === "string" && projectId ? projectId : fallback?.projectId;
	const organization = typeof organizationId === "string" ? organizationId : "";
	return account || project || organization ? JSON.stringify([account ?? "", project ?? "", organization]) : undefined;
}

export function normalizeUsageAccountLabel(label: string): string {
	return replaceTabs(sanitizeText(label)).replace(/[\r\n]+/g, " ");
}

export interface UsageOrganizationIdentity {
	name: string;
	id?: string;
	provider?: string;
}

/** Stable visual aliases: no organization name or identifier is included in the display token. */
export function formatUsageOrganizationAlias(name: string, organizationId?: unknown, provider = ""): string {
	const normalized = normalizeUsageAccountLabel(name).replace(/\s+/g, " ").trim();
	const identity = typeof organizationId === "string" && organizationId ? organizationId : normalized;
	return `Org-${Bun.hash(JSON.stringify([provider, identity]))
		.toString(16)
		.padStart(16, "0")}`;
}

export function formatAccountQualifier(label: AccountLabel, maskOrganizationNames = false): string {
	const qualifier = normalizeUsageAccountLabel(label.qualifier ?? "");
	if (!maskOrganizationNames || !label.organizationName) return qualifier;
	const name = normalizeUsageAccountLabel(label.organizationName);
	return name
		? qualifier.replaceAll(name, formatUsageOrganizationAlias(name, label.organizationId, label.provider))
		: qualifier;
}

export function formatAccountLabelText(label: AccountLabel): string {
	return normalizeUsageAccountLabel(label.identity + (label.qualifier ?? ""));
}

export function maskAccountLabel(label: AccountLabel, enabled: boolean, maskOrganizationNames = false): string {
	const identity = normalizeUsageAccountLabel(label.identity);
	const qualifier = formatAccountQualifier(label, maskOrganizationNames);
	if (!enabled || label.placeholder || identity.length === 0) return identity + qualifier;
	const at = identity.indexOf("@");
	const identityEnd = at > 0 ? at : identity.length;
	let visible = "";
	let count = 0;
	let lastStart = 0;
	for (const { segment } of getSegmenter().segment(identity.slice(0, identityEnd))) {
		count++;
		if (count > 3) break;
		lastStart = visible.length;
		visible += segment;
	}
	if (at <= 0 && count <= 3) visible = visible.slice(0, lastStart);
	return `${visible}${MASK_STARS}${qualifier}`;
}

export type AccountMasker = (label: AccountLabel) => string;

function accountLabelKey(label: AccountLabel): string {
	return JSON.stringify([
		label.provider ?? "",
		label.accountKey ?? "",
		label.identity,
		label.qualifier ?? "",
		label.organizationName ?? "",
		label.organizationId ?? "",
		label.placeholder === true,
	]);
}

export function createAccountMasker(
	labels: Iterable<AccountLabel>,
	enabled: boolean,
	maskOrganizationNames = false,
): AccountMasker {
	const resolved = new Map<string, string>();
	const seen = new Map<string, number>();
	for (const label of labels) {
		const key = accountLabelKey(label);
		if (resolved.has(key)) continue;
		const masked = maskAccountLabel(label, enabled, maskOrganizationNames);
		const qualifier = formatAccountQualifier(label, maskOrganizationNames);
		const base = masked.slice(0, masked.length - qualifier.length);
		const collisionKey = JSON.stringify([label.provider ?? "", masked]);
		const count = (seen.get(collisionKey) ?? 0) + 1;
		seen.set(collisionKey, count);
		resolved.set(key, count === 1 ? masked : `${base} (${count})${qualifier}`);
	}
	return label => resolved.get(accountLabelKey(label)) ?? maskAccountLabel(label, enabled, maskOrganizationNames);
}

/** Mask identities embedded in usage notes, error details and qualified labels. */
export function createUsageTextMasker(
	reports: readonly UsageReport[],
	enabled: boolean,
	additional: readonly string[] = [],
	replacements?: ReadonlyMap<string, string>,
	options: { maskOrganizationNames?: boolean; organizations?: readonly UsageOrganizationIdentity[] } = {},
): (text: string) => string {
	if (!enabled && !options.maskOrganizationNames) return text => text;
	const identities = new Set(enabled ? additional : []);
	const organizationAliases = new Map<string, Set<string>>();
	const addOrganization = ({ name, id, provider }: UsageOrganizationIdentity): void => {
		if (!options.maskOrganizationNames || provider === "openai-codex") return;
		const normalized = normalizeUsageAccountLabel(name).replace(/\s+/g, " ").trim();
		if (!normalized) return;
		const aliases = organizationAliases.get(normalized) ?? new Set<string>();
		aliases.add(formatUsageOrganizationAlias(name, id, provider));
		organizationAliases.set(normalized, aliases);
		identities.add(name);
		identities.add(normalizeUsageAccountLabel(name));
		identities.add(normalized);
	};
	for (const report of reports) {
		if (enabled) {
			for (const key of ["email", "accountId", "account_id", "projectId", "orgId"] as const) {
				const value = report.metadata?.[key];
				if (typeof value === "string" && value) identities.add(value);
			}
			for (const limit of report.limits) {
				if (limit.scope.accountId) identities.add(limit.scope.accountId);
				if (limit.scope.projectId) identities.add(limit.scope.projectId);
				if (limit.scope.orgId) identities.add(limit.scope.orgId);
			}
		}
		const name = report.metadata?.orgName;
		const id = report.metadata?.orgId;
		if (typeof name === "string" && name)
			addOrganization({ name, id: typeof id === "string" ? id : undefined, provider: report.provider });
	}
	for (const organization of options.organizations ?? []) addOrganization(organization);
	const values = [...identities].filter(Boolean).sort((a, b) => b.length - a.length);
	const expression = values.length
		? new RegExp(
				`(?<![\\p{L}\\p{N}_@.-])(?:${values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}_@.-])`,
				"gu",
			)
		: undefined;
	const maskIdentity = (identity: string): string => {
		const organizations = organizationAliases.get(normalizeUsageAccountLabel(identity).replace(/\s+/g, " ").trim());
		return organizations
			? [...organizations].sort().join(" / ")
			: (replacements?.get(identity) ?? (enabled ? maskAccountLabel({ identity }, true) : identity));
	};
	return text => {
		const masked = expression ? text.replace(expression, maskIdentity) : text;
		return enabled ? masked.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, maskIdentity) : masked;
	};
}
