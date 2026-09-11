import { getSegmenter, replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

export const MASK_STARS = "***";

/** Identity and an explicitly attributed organization qualifier are distinct data. */
export interface AccountLabel {
	identity: string;
	qualifier?: string;
	placeholder?: boolean;
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

export function formatAccountLabelText(label: AccountLabel): string {
	return normalizeUsageAccountLabel(label.identity + (label.qualifier ?? ""));
}

export function maskAccountLabel(label: AccountLabel, enabled: boolean): string {
	const identity = normalizeUsageAccountLabel(label.identity);
	const qualifier = normalizeUsageAccountLabel(label.qualifier ?? "");
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
	return JSON.stringify([label.accountKey ?? "", label.identity, label.qualifier ?? "", label.placeholder === true]);
}

export function createAccountMasker(labels: Iterable<AccountLabel>, enabled: boolean): AccountMasker {
	const resolved = new Map<string, string>();
	const seen = new Map<string, number>();
	for (const label of labels) {
		const key = accountLabelKey(label);
		if (resolved.has(key)) continue;
		const masked = maskAccountLabel(label, enabled);
		const count = (seen.get(masked) ?? 0) + 1;
		seen.set(masked, count);
		const qualifier = normalizeUsageAccountLabel(label.qualifier ?? "");
		const base = masked.slice(0, masked.length - qualifier.length);
		resolved.set(key, count === 1 ? masked : `${base} (${count})${qualifier}`);
	}
	return label => resolved.get(accountLabelKey(label)) ?? maskAccountLabel(label, enabled);
}
