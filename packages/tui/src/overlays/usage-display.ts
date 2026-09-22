import { resolveUsedFraction, type UsageLimit, type UsageReport, type UsageResetCredits } from "@oh-my-pi/pi-ai";

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * Account identity slice of a report, shared by dashboard, detail, CLI, and
 * slash-command surfaces so one account reads the same name everywhere.
 * Metadata wins; scope is the fallback for providers that key usage on a
 * project/account id without echoing it back in metadata.
 */
export interface UsageReportIdentity {
	accountId?: string;
	email?: string;
	projectId?: string;
	orgId?: string;
	orgName?: string;
}

export function reportIdentity(report: UsageReport): UsageReportIdentity {
	const metadata = report.metadata ?? {};
	return {
		accountId: [metadata.accountId, ...report.limits.map(limit => limit.scope.accountId)].find(isNonEmptyString),
		email: [metadata.email].find(isNonEmptyString),
		projectId: [metadata.projectId, ...report.limits.map(limit => limit.scope.projectId)].find(isNonEmptyString),
		orgId: [metadata.orgId, ...report.limits.map(limit => limit.scope.orgId)].find(isNonEmptyString),
		orgName: [metadata.orgName].find(isNonEmptyString),
	};
}

function identityBase(identity: UsageReportIdentity): { kind: string; value: string } | undefined {
	if (identity.accountId) return { kind: "account", value: identity.accountId };
	if (identity.projectId) return { kind: "project", value: identity.projectId };
	if (identity.email) return { kind: "email", value: identity.email };
	return undefined;
}

/** Stable per-account key: identity plus org so same-email subscriptions stay split. */
export function reportIdentityKey(report: UsageReport): string | undefined {
	const identity = reportIdentity(report);
	const base = identityBase(identity);
	if (!base) return undefined;
	const org = identity.orgId ?? identity.orgName;
	return `${report.provider}\0${base.kind}\0${base.value}\0${org ?? ""}`;
}

function accountBaseLabel(report: UsageReport): string | undefined {
	const identity = reportIdentity(report);
	return [identity.email, identity.accountId, identity.projectId].find(isNonEmptyString);
}

function accountOrgLabel(report: UsageReport): string | undefined {
	const identity = reportIdentity(report);
	return identity.orgName ?? identity.orgId;
}

function accountLabelSuffix(identity: UsageReportIdentity, base: string | undefined): string[] | undefined {
	const parts = [identity.accountId, identity.projectId, identity.orgId].filter(
		(part): part is string => isNonEmptyString(part) && part !== base,
	);
	return parts.length > 0 ? [...new Set(parts)] : undefined;
}

/**
 * Structured account label. Kept as parts rather than a finished string so a
 * redacting caller (CLI `--redact`) can mask each identity string before
 * composition — masking a composite would leave the parts inside it readable.
 */
export interface AccountLabelParts {
	/** email → accountId → projectId. */
	base?: string;
	/** Organization name or id, rendered only when distinct from the base. */
	org?: string;
	/** Identity parts that disambiguate a colliding label. */
	suffix?: string[];
	/** `#N` fallback when disambiguation has no distinct identity to show. */
	ordinal?: string;
}

/** Render {@link AccountLabelParts}; the single label composition rule. */
export function composeAccountLabel(parts: AccountLabelParts, index: number): string {
	const label =
		parts.base && parts.org && parts.org !== parts.base
			? `${parts.base} (${parts.org})`
			: (parts.base ?? parts.org ?? `account ${index + 1}`);
	const suffix = parts.suffix?.join(" / ");
	if (suffix && !label.endsWith(`(${suffix})`)) return `${label} (${suffix})`;
	if (parts.ordinal !== undefined) return `${label} ${parts.ordinal}`;
	return label;
}

function composeBaseLabel(parts: AccountLabelParts, index: number): string {
	return composeAccountLabel({ base: parts.base, org: parts.org }, index);
}

/**
 * Resolve one report's label parts. Disambiguation is opt-in: pass true only
 * for a report whose plain label collides with a sibling, so unrelated rows
 * keep the short form.
 */
export function accountLabelParts(report: UsageReport, index: number, disambiguate = false): AccountLabelParts {
	const identity = reportIdentity(report);
	const base = accountBaseLabel(report);
	const org = accountOrgLabel(report);
	const parts: AccountLabelParts = {};
	if (base !== undefined) parts.base = base;
	if (org !== undefined) parts.org = org;
	if (!disambiguate) return parts;
	const suffix = accountLabelSuffix(identity, base);
	if (suffix && !composeBaseLabel(parts, index).endsWith(`(${suffix.join(" / ")})`)) parts.suffix = suffix;
	else parts.ordinal = `#${index + 1}`;
	return parts;
}

/**
 * Account label with opt-in collision disambiguation. Pass `disambiguate`
 * when sibling reports render the same base label; unrelated identity parts
 * are appended, and an ordinal guarantees uniqueness when even those agree.
 */
export function accountLabel(report: UsageReport, index: number, disambiguate = false): string {
	return composeAccountLabel(accountLabelParts(report, index, disambiguate), index);
}

/** Base labels rendered more than once — the rows that need disambiguation. */
export function duplicateAccountLabels(reports: readonly UsageReport[]): Set<string> {
	const labels = reports.map((report, index) => accountLabel(report, index));
	const counts = new Map<string, number>();
	for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
	return new Set(labels.filter(label => (counts.get(label) ?? 0) > 1));
}

/** Labels for a provider's reports, each disambiguated only when it collides. */
export function accountLabelsFor(reports: readonly UsageReport[]): string[] {
	return accountLabelPartsFor(reports).map((parts, index) => composeAccountLabel(parts, index));
}

/**
 * {@link accountLabelParts} for a whole provider, disambiguating only the
 * rows whose plain label collides. Redacting callers need this shape: they
 * must mask each identity string before composing the label.
 */
export function accountLabelPartsFor(reports: readonly UsageReport[]): AccountLabelParts[] {
	const duplicates = duplicateAccountLabels(reports);
	return reports.map((report, index) => accountLabelParts(report, index, duplicates.has(accountLabel(report, index))));
}

/** Rewrite a limit's shared pool key with its report identity so distinct accounts never merge. */
export function aggregationLimit(report: UsageReport, limit: UsageLimit): UsageLimit {
	if (limit.scope.shared !== true) return limit;
	const identity = reportIdentityKey(report);
	if (identity === undefined) return limit;
	const sharedGroup = `${identity}\0${limit.scope.sharedGroup ?? "shared"}`;
	return { ...limit, scope: { ...limit.scope, sharedGroup } };
}

function mergeReportMetadata(
	left: UsageReport["metadata"],
	right: UsageReport["metadata"],
): UsageReport["metadata"] | undefined {
	if (left === undefined && right === undefined) return undefined;
	const metadata = { ...left, ...right };
	for (const [key, value] of Object.entries(left ?? {})) {
		if (metadata[key] === undefined) metadata[key] = value;
	}
	return metadata;
}

function sharedLimitKey(limit: UsageLimit): string {
	return `${limit.id}|${limit.window?.id ?? limit.scope.windowId ?? ""}|${limit.scope.tier ?? ""}`;
}

function preferNewerSharedLimit(
	left: UsageLimit,
	right: UsageLimit,
	leftFetchedAt: number,
	rightFetchedAt: number,
): UsageLimit | undefined {
	if (leftFetchedAt === rightFetchedAt) return undefined;
	return rightFetchedAt > leftFetchedAt ? right : left;
}

function preferSharedLimit(
	left: UsageLimit,
	right: UsageLimit,
	leftFetchedAt: number,
	rightFetchedAt: number,
): UsageLimit {
	const newer = preferNewerSharedLimit(left, right, leftFetchedAt, rightFetchedAt);
	if (newer !== undefined) return newer;
	const leftRemaining = left.amount.remaining;
	const rightRemaining = right.amount.remaining;
	if (leftRemaining !== undefined && rightRemaining !== undefined) {
		return rightRemaining > leftRemaining ? right : left;
	}
	const leftUsed = resolveUsedFraction(left);
	const rightUsed = resolveUsedFraction(right);
	return rightUsed !== undefined && (leftUsed === undefined || rightUsed > leftUsed) ? right : left;
}

/**
 * Merge two reports for the same shared pool: newest snapshot wins per limit,
 * metadata merges oldest→newest so a dropped plan survives. Equal timestamps
 * keep the max-remaining tie-break so probe order cannot flip the value.
 */
export function mergeSharedReports(left: UsageReport, right: UsageReport): UsageReport {
	const limits = [...left.limits];
	const indexByKey = new Map(limits.map((limit, index) => [sharedLimitKey(limit), index]));
	for (const limit of right.limits) {
		const key = sharedLimitKey(limit);
		const index = indexByKey.get(key);
		if (index === undefined) {
			indexByKey.set(key, limits.length);
			limits.push(limit);
		} else {
			limits[index] = preferSharedLimit(limits[index]!, limit, left.fetchedAt, right.fetchedAt);
		}
	}
	const latest = right.fetchedAt >= left.fetchedAt ? right : left;
	const older = latest === right ? left : right;
	return {
		...latest,
		limits,
		metadata: mergeReportMetadata(older.metadata, latest.metadata),
	};
}

function sharedAccountKey(report: UsageReport): string | undefined {
	if (report.limits.length === 0 || report.limits.some(limit => limit.scope.shared !== true)) return undefined;
	const identity = reportIdentityKey(report);
	if (identity !== undefined) return identity;
	const sharedGroups = [
		...new Set(report.limits.map(limit => limit.scope.sharedGroup).filter(isNonEmptyString)),
	].sort();
	// No identity anywhere: the reports are indistinguishable and `shared`
	// asserts one account-wide pool, so merging is the only reading that cannot
	// double-count. The endpoint keeps proxy-scoped credentials (Charm Hyper)
	// in separate pools.
	const endpoint = isNonEmptyString(report.metadata?.endpoint) ? report.metadata.endpoint : "";
	return `${report.provider}\0pool\0${sharedGroups.join(",")}\0${endpoint}`;
}

/**
 * Merge per-credential probes of one account-wide pool into a single report.
 * Identity-keyed first; pool+endpoint fallback for providers (Charm Hyper)
 * that expose no account identity at all.
 */
export function collapseSharedAccountReports(reports: UsageReport[]): UsageReport[] {
	const collapsed: UsageReport[] = [];
	const indexByKey = new Map<string, number>();
	for (const report of reports) {
		const key = sharedAccountKey(report);
		if (key === undefined) {
			collapsed.push(report);
			continue;
		}
		const existingIndex = indexByKey.get(key);
		if (existingIndex === undefined) {
			indexByKey.set(key, collapsed.length);
			collapsed.push(report);
		} else {
			collapsed[existingIndex] = mergeSharedReports(collapsed[existingIndex]!, report);
		}
	}
	return collapsed;
}

/** Include the usage tier in a limit title unless its label already names it. */
export function formatLimitTitle(limit: UsageLimit): string {
	const tier = limit.scope.tier;
	if (tier && !limit.label.toLowerCase().includes(tier.toLowerCase())) {
		return `${limit.label} (${tier})`;
	}
	return limit.label;
}

function collapseSharedLimits(limits: UsageLimit[]): UsageLimit[] {
	const seenGroups = new Set<string>();
	let collapsed: UsageLimit[] | undefined;

	for (let index = 0; index < limits.length; index++) {
		const limit = limits[index]!;
		const group = limit.scope.sharedGroup;
		if (group !== undefined && seenGroups.has(group)) {
			collapsed ??= limits.slice(0, index);
			continue;
		}
		if (group !== undefined) seenGroups.add(group);
		collapsed?.push(limit);
	}

	return collapsed ?? limits;
}

/** Human-readable quota scope for a normalized saved-reset window ID. */
export function formatUsageResetWindow(windowId: string): string {
	switch (windowId) {
		case "anthropic:5h":
			return "Claude 5h";
		case "anthropic:7d":
			return "Claude weekly";
		case "anthropic:7d:opus":
			return "Claude Opus weekly";
		case "anthropic:7d:sonnet":
			return "Claude Sonnet weekly";
		default:
			return windowId;
	}
}

/** Saved inventory and current eligibility shared by every usage display. */
export interface UsageResetSummary {
	bankedCount: number;
	redeemableCount: number;
	soonestExpiry?: string;
	unavailableReason?: string;
}

/**
 * Normalize old count-only and current provider reset metadata for display.
 * `availableCount` is banked inventory; `redeemableCount` is the subset that
 * may be spent now. Older providers used `availableCount` for both.
 */
export function summarizeUsageResetCredits(
	reset: UsageResetCredits | undefined,
	nowMs = Date.now(),
): UsageResetSummary | undefined {
	if (!reset) return undefined;
	const bankedCount = Math.max(0, Math.trunc(reset.availableCount));
	const redeemableCount = Math.max(0, Math.trunc(reset.redeemableCount ?? reset.availableCount));
	let soonestExpiry: string | undefined;
	let soonestExpiryMs = Number.POSITIVE_INFINITY;
	let latestExpired: string | undefined;
	let latestExpiredMs = Number.NEGATIVE_INFINITY;
	for (const credit of reset.credits ?? []) {
		if (!credit.expiresAt || credit.remainingCount === 0 || credit.status === "redeemed") continue;
		const expiryMs = Date.parse(credit.expiresAt);
		if (!Number.isFinite(expiryMs)) continue;
		if (expiryMs > nowMs && expiryMs < soonestExpiryMs) {
			soonestExpiryMs = expiryMs;
			soonestExpiry = credit.expiresAt;
		} else if (expiryMs <= nowMs && expiryMs > latestExpiredMs) {
			latestExpiredMs = expiryMs;
			latestExpired = credit.expiresAt;
		}
	}
	soonestExpiry ??= latestExpired;
	const selectedCredit = reset.nextCreditId
		? reset.credits?.find(credit => credit.id === reset.nextCreditId)
		: (reset.credits?.find(credit => credit.usable !== false) ?? reset.credits?.[0]);
	const unavailableReason =
		reset.reason ??
		(reset.cooldownUntil ? `cooldown until ${reset.cooldownUntil}` : undefined) ??
		(selectedCredit?.blocking?.length
			? `blocked by ${selectedCredit.blocking.map(formatUsageResetWindow).join(", ")}`
			: undefined) ??
		(selectedCredit?.status && selectedCredit.status !== "available" ? selectedCredit.status : undefined) ??
		(reset.eligible === false ? "not eligible" : undefined) ??
		(bankedCount > 0 && redeemableCount === 0 ? "not usable right now" : undefined);
	return {
		bankedCount,
		redeemableCount,
		soonestExpiry,
		unavailableReason,
	};
}

/** Collapse routing-specific copies of a shared quota for user-facing usage views. */
export function collapseSharedUsageReports(reports: UsageReport[]): UsageReport[] {
	let collapsed: UsageReport[] | undefined;

	for (let index = 0; index < reports.length; index++) {
		const report = reports[index]!;
		const limits = collapseSharedLimits(report.limits);
		const displayReport = limits === report.limits ? report : { ...report, limits };
		if (displayReport !== report) {
			collapsed ??= reports.slice(0, index);
		}
		collapsed?.push(displayReport);
	}

	return collapsed ?? reports;
}
