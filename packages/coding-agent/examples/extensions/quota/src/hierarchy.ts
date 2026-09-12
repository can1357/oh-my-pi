import { classifyHealth, formatDuration, type HealthInfo } from "./format";

export interface LocalUsageWindow {
	id?: string;
	label?: string;
	resetsAt?: number;
}

export interface LocalUsageAmount {
	used?: number;
	limit?: number;
	remaining?: number;
	usedFraction?: number;
	remainingFraction?: number;
	/** "percent" | "tokens" | "requests" | "usd" | "minutes" | "bytes" | "unknown" */
	unit: string;
}

export interface LocalUsageScope {
	accountId?: string;
	projectId?: string;
	orgId?: string;
	tier?: string;
	windowId?: string;
}

export interface LocalUsageLimit {
	id: string;
	label: string;
	scope: LocalUsageScope;
	window?: LocalUsageWindow;
	amount: LocalUsageAmount;
	status?: "ok" | "warning" | "exhausted" | "unknown";
}

export interface LocalResetCreditDetail {
	expiresAt?: string;
}

export interface LocalUsageReport {
	provider: string;
	fetchedAt: number;
	limits: LocalUsageLimit[];
	resetCredits?: { availableCount: number; credits?: LocalResetCreditDetail[] };
	metadata?: Record<string, unknown>;
}

export interface LocalActiveIdentity {
	email?: string;
	accountId?: string;
	projectId?: string;
	orgId?: string;
}

export function resolveUsedFraction(limit: LocalUsageLimit): number | undefined {
	const amount = limit.amount;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		return amount.used / amount.limit;
	}
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
	return undefined;
}

export interface QuotaWindowRow {
	id: string;
	label: string;
	health: HealthInfo;
	remainingFraction?: number;
	usedText?: string;
	resetCountdown?: string;
}

export interface QuotaPoolGroup {
	id: string;
	/** undefined => flat under account */
	label?: string;
	rows: QuotaWindowRow[];
}

export interface QuotaAccountGroup {
	id: string;
	label: string;
	cleanOrgName?: string;
	planBadge?: string;
	isActive: boolean;
	savedResets?: { count: number; detailLines: string[] };
	pools: QuotaPoolGroup[];
	noLimits: boolean;
	healthSummary: {
		exhaustedCount: number;
		criticalCount: number;
		lowCount: number;
		healthyCount: number;
		unknownCount: number;
		summaryText: string;
		hasIssues: boolean;
	};
}

export interface QuotaProviderGroup {
	provider: string;
	label: string;
	accounts: QuotaAccountGroup[];
}

export interface AttentionItem {
	providerLabel: string;
	accountLabel: string;
	poolLabel?: string;
	windowLabel: string;
	health: HealthInfo;
	remainingFraction?: number;
	resetCountdown?: string;
}

export interface QuotaDashboardModel {
	providers: QuotaProviderGroup[];
	refreshedAt: number;
	summary: {
		healthyCount: number;
		lowCount: number;
		criticalCount: number;
		exhaustedCount: number;
		unknownCount: number;
		totalCount: number;
		allHealthy: boolean;
	};
	attentionItems: AttentionItem[];
}

const ANTIGRAVITY_PROVIDER = "google-antigravity";

const KNOWN_COUNTER_LABELS: Record<string, string> = {
	google: "Google",
	anthropic: "Anthropic",
	openai: "OpenAI",
};

function titleCase(s: string): string {
	return s.replace(/(^|[\s-])([a-z])/g, (_, sep, ch) => `${sep}${ch.toUpperCase()}`);
}

const KNOWN_PROVIDER_WORDS: Record<string, string> = {
	openai: "OpenAI",
};

export function formatProviderName(provider: string): string {
	return provider
		.split(/[-_]/)
		.filter(part => part.length > 0)
		.map(part => KNOWN_PROVIDER_WORDS[part.toLowerCase()] ?? part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function derivePoolLabel(provider: string, limit: LocalUsageLimit): string | undefined {
	if (provider !== ANTIGRAVITY_PROVIDER) return undefined;
	const parts = limit.id.split(":");
	if (parts.length >= 4 && parts[0] === provider && parts[1] && parts[1] !== "default") {
		return KNOWN_COUNTER_LABELS[parts[1].toLowerCase()] ?? titleCase(parts[1]);
	}
	const match = /^Usage \(([^)]+)\)$/.exec(limit.label);
	if (match) return match[1];
	return "Other";
}

function isNeutral(limit: LocalUsageLimit): boolean {
	const amount = limit.amount;
	return (
		amount.used !== undefined &&
		amount.unit !== "percent" &&
		amount.unit !== "unknown" &&
		amount.limit === undefined &&
		amount.remaining === undefined &&
		resolveUsedFraction(limit) === undefined
	);
}

function buildRowLabel(limit: LocalUsageLimit, underPool: boolean): string {
	let base = underPool ? (limit.window?.label ?? limit.scope.windowId ?? limit.label) : limit.label;
	const tier = limit.scope.tier;
	if (tier && !base.toLowerCase().includes(tier.toLowerCase())) {
		base = `${base} (${tier})`;
	}
	return base;
}

export function buildWindowRow(limit: LocalUsageLimit, nowMs: number, underPool: boolean): QuotaWindowRow {
	const label = buildRowLabel(limit, underPool);

	if (isNeutral(limit)) {
		const amount = limit.amount;
		const usedText =
			amount.unit === "usd" ? `$${amount.used!.toFixed(2)} used` : `${amount.used} ${amount.unit} used`;
		return {
			id: limit.id,
			label,
			health: { status: "neutral", symbol: "", color: "dim", label: "neutral" },
			usedText,
		};
	}

	const usedFraction = resolveUsedFraction(limit);
	const rawRemaining =
		limit.amount.remainingFraction ?? (usedFraction !== undefined ? Math.max(0, 1 - usedFraction) : undefined);

	const resetsAt = limit.window?.resetsAt;
	const resetCountdown = resetsAt !== undefined && resetsAt > nowMs ? formatDuration(resetsAt - nowMs) : undefined;

	const isExhaustedFlag = limit.status === "exhausted";
	const health = classifyHealth(rawRemaining, isExhaustedFlag);

	return {
		id: limit.id,
		label,
		health,
		remainingFraction: rawRemaining !== undefined ? Math.min(Math.max(rawRemaining, 0), 1) : undefined,
		resetCountdown,
	};
}

/**
 * Clean up redundant organization names.
 * e.g. "alice@example.com's Organization" -> "Organization"
 * Returns undefined if the org is entirely identical to the email/account ID.
 */
export function cleanOrgName(rawOrg: string | undefined, emailOrAccount: string | undefined): string | undefined {
	if (!rawOrg) return undefined;
	const trimmed = rawOrg.trim();
	if (!trimmed) return undefined;

	if (emailOrAccount) {
		const cleanAccount = emailOrAccount.trim().toLowerCase();
		const cleanRaw = trimmed.toLowerCase();
		if (cleanRaw === cleanAccount) return undefined;

		const aposIdx = cleanRaw.lastIndexOf("'s ");
		if (aposIdx > 0) {
			const prefix = cleanRaw.slice(0, aposIdx).trim();
			const orgType = trimmed.slice(aposIdx + 3).trim();
			const userPart = cleanAccount.split("@")[0]!;
			if (prefix === cleanAccount || prefix === userPart) {
				return titleCase(orgType);
			}
		}
	}

	return trimmed;
}

export function buildAccountLabel(report: LocalUsageReport, indexWithinProvider: number): string {
	const metadata = report.metadata ?? {};
	const email = typeof metadata.email === "string" && metadata.email ? metadata.email : undefined;
	const accountId = typeof metadata.accountId === "string" && metadata.accountId ? metadata.accountId : undefined;
	const projectId = typeof metadata.projectId === "string" && metadata.projectId ? metadata.projectId : undefined;

	return email ?? accountId ?? projectId ?? `account ${indexWithinProvider + 1}`;
}

export function extractPlanBadge(report: LocalUsageReport): string | undefined {
	const metadata = report.metadata ?? {};
	const planType = typeof metadata.planType === "string" && metadata.planType ? metadata.planType : undefined;
	if (planType && planType.toLowerCase() !== "default") {
		return planType.toUpperCase();
	}
	return undefined;
}

export function isActiveAccount(report: LocalUsageReport, identity: LocalActiveIdentity | undefined): boolean {
	if (!identity) return false;
	const metadata = report.metadata ?? {};
	const metaEmail = typeof metadata.email === "string" ? metadata.email.toLowerCase() : undefined;
	const metaAccountId = typeof metadata.accountId === "string" ? metadata.accountId.toLowerCase() : undefined;
	const metaProjectId = typeof metadata.projectId === "string" ? metadata.projectId.toLowerCase() : undefined;
	const metaOrgId = typeof metadata.orgId === "string" ? metadata.orgId.toLowerCase() : undefined;

	const idEmail = typeof identity.email === "string" ? identity.email.toLowerCase() : undefined;
	const idAccountId = typeof identity.accountId === "string" ? identity.accountId.toLowerCase() : undefined;
	const idProjectId = typeof identity.projectId === "string" ? identity.projectId.toLowerCase() : undefined;
	const idOrgId = typeof identity.orgId === "string" ? identity.orgId.toLowerCase() : undefined;

	if (idOrgId !== undefined && metaOrgId !== undefined && idOrgId !== metaOrgId) {
		return false;
	}

	if (idEmail !== undefined && metaEmail !== undefined && idEmail === metaEmail) return true;
	if (idAccountId !== undefined && metaAccountId !== undefined && idAccountId === metaAccountId) return true;
	if (idProjectId !== undefined && metaProjectId !== undefined && idProjectId === metaProjectId) return true;
	return false;
}

export function buildSavedResets(
	report: LocalUsageReport,
	nowMs: number,
): { count: number; detailLines: string[] } | undefined {
	const resetCredits = report.resetCredits;
	if (!resetCredits || resetCredits.availableCount <= 0) return undefined;

	const detailLines: string[] = [];
	for (const credit of resetCredits.credits ?? []) {
		const expiresAt = credit.expiresAt;
		if (!expiresAt) continue;
		const expiryMs = new Date(expiresAt).getTime();
		if (Number.isFinite(expiryMs) && expiryMs > nowMs) {
			detailLines.push(`expires in ${formatDuration(expiryMs - nowMs)} (${expiresAt.slice(0, 10)})`);
		} else {
			detailLines.push(`expired (${expiresAt.slice(0, 10)})`);
		}
	}

	return { count: resetCredits.availableCount, detailLines };
}

export function buildPools(provider: string, report: LocalUsageReport, nowMs: number): QuotaPoolGroup[] {
	const limits = report.limits;
	const poolLabels = limits.map(limit => derivePoolLabel(provider, limit));
	const anyPooled = poolLabels.some(label => label !== undefined);

	if (!anyPooled) {
		return [
			{
				id: `${provider}:flat`,
				label: undefined,
				rows: limits.map(limit => buildWindowRow(limit, nowMs, false)),
			},
		];
	}

	const order: string[] = [];
	const buckets = new Map<string, LocalUsageLimit[]>();
	for (let i = 0; i < limits.length; i++) {
		const label = poolLabels[i] ?? "Other";
		let bucket = buckets.get(label);
		if (!bucket) {
			bucket = [];
			buckets.set(label, bucket);
			order.push(label);
		}
		bucket.push(limits[i]!);
	}

	return order.map(label => ({
		id: `${provider}:${label.toLowerCase()}`,
		label,
		rows: buckets.get(label)!.map(limit => buildWindowRow(limit, nowMs, true)),
	}));
}

export function buildQuotaDashboardModel(
	reports: LocalUsageReport[],
	nowMs: number,
	activeIdentityByProvider: Map<string, LocalActiveIdentity>,
): QuotaDashboardModel {
	const byProvider = new Map<string, LocalUsageReport[]>();
	const reportsFetched = reports.map(r => r.fetchedAt).filter((t): t is number => typeof t === "number" && t > 0);
	const latestFetchedAt = reportsFetched.length > 0 ? Math.max(...reportsFetched) : nowMs;

	for (const report of reports) {
		let bucket = byProvider.get(report.provider);
		if (!bucket) {
			bucket = [];
			byProvider.set(report.provider, bucket);
		}
		bucket.push(report);
	}

	const providersSorted = Array.from(byProvider.keys()).sort((a, b) => a.localeCompare(b));

	let totalHealthy = 0;
	let totalLow = 0;
	let totalCritical = 0;
	let totalExhausted = 0;
	let totalUnknown = 0;
	let totalCount = 0;

	const attentionItems: AttentionItem[] = [];

	const providers: QuotaProviderGroup[] = providersSorted.map(provider => {
		const providerReports = byProvider.get(provider)!;
		const providerLabel = formatProviderName(provider);
		const identity = activeIdentityByProvider.get(provider);

		const accounts: QuotaAccountGroup[] = providerReports.map((report, index) => {
			const accountLabel = buildAccountLabel(report, index);
			const metadata = report.metadata ?? {};
			const rawOrg =
				typeof metadata.orgName === "string"
					? metadata.orgName
					: typeof metadata.orgId === "string"
						? metadata.orgId
						: undefined;
			const cleanOrg = cleanOrgName(rawOrg, accountLabel);
			const planBadge = extractPlanBadge(report);
			const noLimits = report.limits.length === 0;

			const pools = noLimits ? [] : buildPools(provider, report, nowMs);

			let exhaustedCount = 0;
			let criticalCount = 0;
			let lowCount = 0;
			let healthyCount = 0;
			let unknownCount = 0;

			for (const pool of pools) {
				for (const row of pool.rows) {
					if (row.health.status === "neutral") continue;
					totalCount++;
					switch (row.health.status) {
						case "exhausted":
							exhaustedCount++;
							totalExhausted++;
							attentionItems.push({
								providerLabel,
								accountLabel,
								poolLabel: pool.label,
								windowLabel: row.label,
								health: row.health,
								remainingFraction: row.remainingFraction,
								resetCountdown: row.resetCountdown,
							});
							break;
						case "critical":
							criticalCount++;
							totalCritical++;
							attentionItems.push({
								providerLabel,
								accountLabel,
								poolLabel: pool.label,
								windowLabel: row.label,
								health: row.health,
								remainingFraction: row.remainingFraction,
								resetCountdown: row.resetCountdown,
							});
							break;
						case "low":
							lowCount++;
							totalLow++;
							attentionItems.push({
								providerLabel,
								accountLabel,
								poolLabel: pool.label,
								windowLabel: row.label,
								health: row.health,
								remainingFraction: row.remainingFraction,
								resetCountdown: row.resetCountdown,
							});
							break;
						case "healthy":
							healthyCount++;
							totalHealthy++;
							break;
						case "unknown":
							unknownCount++;
							totalUnknown++;
							break;
					}
				}
			}

			const hasIssues = exhaustedCount > 0 || criticalCount > 0 || lowCount > 0;
			let summaryText = "all healthy";
			if (exhaustedCount > 0) {
				summaryText = `${exhaustedCount} exhausted`;
			} else if (criticalCount > 0) {
				summaryText = `${criticalCount} critical`;
			} else if (lowCount > 0) {
				summaryText = `${lowCount} low`;
			} else if (unknownCount > 0 && healthyCount === 0) {
				summaryText = "unknown";
			} else if (noLimits) {
				summaryText = "no limits";
			}

			const orgId = typeof metadata.orgId === "string" ? metadata.orgId : undefined;
			const projectId = typeof metadata.projectId === "string" ? metadata.projectId : undefined;
			const uniqueAccountId = `${provider}:${accountLabel}:${orgId ?? projectId ?? index}`;

			return {
				id: uniqueAccountId,
				label: accountLabel,
				cleanOrgName: cleanOrg,
				planBadge,
				isActive: isActiveAccount(report, identity),
				savedResets: buildSavedResets(report, nowMs),
				pools,
				noLimits,
				healthSummary: {
					exhaustedCount,
					criticalCount,
					lowCount,
					healthyCount,
					unknownCount,
					summaryText,
					hasIssues,
				},
			};
		});

		return {
			provider,
			label: providerLabel,
			accounts,
		};
	});

	return {
		providers,
		refreshedAt: latestFetchedAt,
		summary: {
			healthyCount: totalHealthy,
			lowCount: totalLow,
			criticalCount: totalCritical,
			exhaustedCount: totalExhausted,
			unknownCount: totalUnknown,
			totalCount,
			allHealthy:
				totalHealthy > 0 && totalUnknown === 0 && totalLow === 0 && totalCritical === 0 && totalExhausted === 0,
		},
		attentionItems,
	};
}

export { buildQuotaDashboardModel as buildQuotaHierarchy };
