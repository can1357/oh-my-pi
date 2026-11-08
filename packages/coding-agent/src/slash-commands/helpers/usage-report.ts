import type {
	GovernorApi,
	OAuthAccountSummary,
	UsageGovernorBankedResets,
	UsageGovernorStatus,
	UsageGovernorWaitRecord,
	UsageGovernorWaitReason,
	UsageGovernorWindowStatus,
	UsageLimit,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { OAuthAccountIdentity } from "../../session/auth-storage";
import { collapseSharedUsageReports, summarizeUsageResetCredits } from "@oh-my-pi/pi-tui/overlays/usage-display";
import type { SlashCommandRuntime } from "../types";
import { formatCodexUsageReportLabel, reportMatchesActiveAccount } from "./active-oauth-account";
import { accountIdentityLabel, type UsageAccountIdentity } from "./usage-accounts";
import { formatCoarseDuration, formatProviderName, renderAsciiBar } from "@oh-my-pi/pi-tui/chrome/format";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";

function formatWindowSuffix(label: string, windowLabel: string | undefined): string {
	if (!windowLabel) return "";
	const normalizedLabel = label.toLowerCase();
	const normalizedWindow = windowLabel.toLowerCase();
	if (normalizedWindow === "quota window" || normalizedLabel.includes(normalizedWindow)) return "";
	return ` — ${windowLabel}`;
}

function formatUsageAmount(limit: UsageLimit): string {
	const amount = limit.amount;
	const used = amount.used ?? (amount.usedFraction !== undefined ? amount.usedFraction * 100 : undefined);
	const remainingFraction =
		amount.remainingFraction ??
		(amount.usedFraction !== undefined ? Math.max(0, 1 - amount.usedFraction) : undefined);
	const unit = amount.unit === "percent" ? "%" : ` ${amount.unit}`;
	const usedText = used === undefined ? "unknown used" : `${used.toFixed(2)}${unit} used`;
	const remainingText = remainingFraction === undefined ? "" : ` (${(remainingFraction * 100).toFixed(1)}% left)`;
	return `${usedText}${remainingText}`;
}

function formatUsageReportAccount(
	report: UsageReport,
	peers: readonly UsageReport[],
	limit: UsageLimit,
	index: number,
): string {
	const codex = report.provider === "openai-codex";
	const metaOrgName = report.metadata?.orgName;
	const metaOrgId = report.metadata?.orgId;
	const org = typeof metaOrgName === "string" && metaOrgName ? metaOrgName : metaOrgId;
	const label = (identity: string, includeOrg: boolean): string => {
		if (codex) return formatCodexUsageReportLabel(report, peers, identity);
		return includeOrg && typeof org === "string" && org && org !== identity ? `${identity} (${org})` : identity;
	};
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return label(email, true);
	// Empty metadata must not hide a valid scoped identity.
	const metaAccountId = report.metadata?.accountId;
	const accountId = typeof metaAccountId === "string" && metaAccountId ? metaAccountId : limit.scope.accountId;
	if (typeof accountId === "string" && accountId) return label(accountId, true);
	const metaProjectId = report.metadata?.projectId;
	const projectId = typeof metaProjectId === "string" && metaProjectId ? metaProjectId : limit.scope.projectId;
	return label(typeof projectId === "string" && projectId ? projectId : `account ${index + 1}`, false);
}

function renderUsageReports(
	reports: UsageReport[],
	nowMs: number,
	resolveActiveAccount?: (provider: string) => OAuthAccountIdentity | undefined,
	usageModelSelectors: readonly string[] = [],
	extraLines: readonly string[] = [],
): string {
	const displayReports = collapseSharedUsageReports(reports);
	const latestFetchedAt = Math.max(...displayReports.map(report => report.fetchedAt ?? 0));
	const lines = [`Usage${latestFetchedAt ? ` (${formatCoarseDuration(nowMs - latestFetchedAt)} ago)` : ""}`];
	const grouped = new Map<string, UsageReport[]>();
	for (const report of displayReports) {
		const providerReports = grouped.get(report.provider) ?? [];
		providerReports.push(report);
		grouped.set(report.provider, providerReports);
	}

	for (const [provider, providerReports] of [...grouped.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		lines.push("", formatProviderName(provider));
		const reportingModels = usageModelSelectors.filter(selector => selector.startsWith(`${provider}/`));
		if (reportingModels.length > 0) {
			lines.push("  Models with usage data");
			for (const selector of reportingModels) lines.push(`    ${sanitizeText(selector)}`);
		}
		const activeAccount = resolveActiveAccount?.(provider);
		// Provider-wide disclaimers render once per provider, not per limit.
		const providerNotes = [...new Set(providerReports.flatMap(report => report.notes ?? []))];
		for (const note of providerNotes)
			lines.push(`  ${sanitizeText(note.replace(/[\r\n]+/g, " ").replace(/\t/g, "  "))}`);
		for (const report of providerReports) {
			const inUse = reportMatchesActiveAccount(report, activeAccount);
			const resets = summarizeUsageResetCredits(report.resetCredits, nowMs);
			if (resets && resets.bankedCount > 0) {
				const resetIdentity =
					typeof report.metadata?.email === "string"
						? report.metadata.email
						: typeof report.metadata?.accountId === "string"
							? report.metadata.accountId
							: "account";
				let resetLabel: string;
				if (report.provider === "openai-codex") {
					resetLabel = formatCodexUsageReportLabel(report, providerReports, resetIdentity);
				} else {
					const orgName = report.metadata?.orgName;
					const orgId = report.metadata?.orgId;
					const org =
						typeof orgName === "string" && orgName ? orgName : typeof orgId === "string" ? orgId : undefined;
					const raw = org && org !== resetIdentity ? `${resetIdentity} (${org})` : resetIdentity;
					resetLabel = sanitizeText(raw.replace(/[\r\n\t]+/g, " "));
				}
				const availability =
					resets.redeemableCount === resets.bankedCount ? "available" : `${resets.redeemableCount} usable now`;
				lines.push(
					`- ${resetLabel}: ${resets.bankedCount} saved rate-limit reset${resets.bankedCount === 1 ? "" : "s"} — ${availability} — /usage reset to spend`,
				);
				if (resets.soonestExpiry) {
					const expiryMs = Date.parse(resets.soonestExpiry);
					const remaining = expiryMs - nowMs;
					if (remaining > 0) {
						lines.push(
							`  soonest expires in ${formatCoarseDuration(remaining)} (${resets.soonestExpiry.slice(0, 10)})`,
						);
					} else {
						lines.push(`  expired (${resets.soonestExpiry.slice(0, 10)})`);
					}
				}
				if (resets.redeemableCount === 0 && resets.unavailableReason) {
					const reason = sanitizeText(resets.unavailableReason.replace(/[\r\n\t]+/g, " "));
					lines.push(`  unavailable: ${reason}`);
				}
			}
			if (report.limits.length === 0) {
				const email = typeof report.metadata?.email === "string" ? report.metadata.email : "account";
				const label =
					report.provider === "openai-codex" ? formatCodexUsageReportLabel(report, providerReports, email) : email;
				lines.push(`- ${label}: no limits reported`);
				continue;
			}
			for (let index = 0; index < report.limits.length; index++) {
				const limit = report.limits[index]!;
				const window = limit.window?.label ?? limit.scope.windowId;
				// Skip the tier suffix when the label already names it (e.g. Anthropic's
				// "Claude 7 Day (Fable)" with scope.tier "fable") — mirrors limitTitle in usage-cli.
				const tier =
					limit.scope.tier && !limit.label.toLowerCase().includes(limit.scope.tier.toLowerCase())
						? ` (${limit.scope.tier})`
						: "";
				lines.push(`- ${limit.label}${tier}${formatWindowSuffix(limit.label, window)}`);
				lines.push(
					`  ${formatUsageReportAccount(report, providerReports, limit, index)}: ${formatUsageAmount(limit)}${inUse ? "  ← in use by this session" : ""}`,
				);
				lines.push(`  ${renderAsciiBar(limit.amount.usedFraction)}`);
				if (limit.window?.resetsAt && limit.window.resetsAt > nowMs) {
					lines.push(
						`  ${limit.window.resetLabel ?? "resets"} in ${formatCoarseDuration(limit.window.resetsAt - nowMs)}`,
					);
				}
				if (limit.notes && limit.notes.length > 0)
					lines.push(
						`  ${limit.notes.map(n => sanitizeText(n.replace(/[\r\n]+/g, " ").replace(/\t/g, "  "))).join(" • ")}`,
					);
			}
		}
	}
	if (extraLines.length > 0) lines.push("", ...extraLines);
	return ["```", ...lines, "```"].join("\n");
}

/**
 * Cached governor status for display. Undefined while the governor is off, so a disabled
 * install opens no ledger and reads no status.
 */
export function readUsageGovernorStatus(governor: GovernorApi, provider?: string): UsageGovernorStatus | undefined {
	if (!governor.config.enabled) return undefined;
	return governor.status({ provider, waitLimit: USAGE_GOVERNOR_WAIT_LIMIT });
}

/** Recent wait records requested per status read; the ledger keeps more than it displays. */
const USAGE_GOVERNOR_WAIT_LIMIT = 20;

/** Label for one stored credential row; `redaction` masks identity parts. */
export type UsageGovernorAccountLabeler = (provider: string, credentialId: number | undefined) => string;

/**
 * Labels governor rows through each provider's stored OAuth accounts. A row the store no
 * longer holds falls back to its credential id, which carries no identity.
 */
export function usageGovernorAccountLabeler(
	accountsFor: (provider: string) => readonly OAuthAccountSummary[],
	redaction?: Map<string, string>,
): UsageGovernorAccountLabeler {
	const accountsByProvider = new Map<string, readonly OAuthAccountSummary[]>();
	return (provider, credentialId) => {
		const providerName = formatProviderName(provider);
		if (credentialId === undefined) return `${providerName} account`;
		let accounts = accountsByProvider.get(provider);
		if (!accounts) {
			accounts = accountsFor(provider);
			accountsByProvider.set(provider, accounts);
		}
		const account = accounts.find(entry => entry.credentialId === credentialId);
		if (!account) return `${providerName} credential ${credentialId}`;
		return sanitizeText(
			accountIdentityLabel(
				{
					provider,
					type: "oauth",
					email: account.email,
					accountId: account.accountId,
					projectId: account.projectId,
					enterpriseUrl: account.enterpriseUrl,
					orgId: account.orgId,
					orgName: account.orgName,
				},
				redaction,
			),
		);
	};
}

/** Identity rows of every stored account behind the governor's windows and waits, for `--redact`. */
export function usageGovernorAccountIdentities(
	status: UsageGovernorStatus,
	accountsFor: (provider: string) => readonly OAuthAccountSummary[],
): UsageAccountIdentity[] {
	const providers = new Set([...status.windows, ...status.waits].map(row => row.provider));
	return [...providers].flatMap(provider =>
		accountsFor(provider).map((account): UsageAccountIdentity => ({
			provider,
			type: "oauth",
			email: account.email,
			accountId: account.accountId,
			projectId: account.projectId,
			enterpriseUrl: account.enterpriseUrl,
			orgId: account.orgId,
			orgName: account.orgName,
		})),
	);
}

/** Display text for one governor field: masked when redacting, sanitized, bounded to `max` columns. */
function governorText(value: string, max: number, mask?: (text: string) => string): string {
	return truncateToWidth(replaceTabs(sanitizeText(mask ? mask(value) : value)).replace(/[\r\n]+/g, " "), max);
}

type GovernorTextFn = (value: string, max?: number) => string;

function formatGovernorPercent(fraction: number, digits = 1): string {
	return `${Number((fraction * 100).toFixed(digits))}%`;
}

function formatGovernorClock(ms: number): string {
	return new Date(ms).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** `81% used, 64% allowed`, with the separator the caller's line uses; unknown shares read as unknown. */
function describeGovernorShare(used: number | undefined, allowed: number | undefined, separator: string): string {
	const usedText = used === undefined ? "used unknown" : `${formatGovernorPercent(used)} used`;
	const allowedText = allowed === undefined ? "allowed unknown" : `${formatGovernorPercent(allowed)} allowed`;
	return `${usedText}${separator}${allowedText}`;
}

function describeGovernorReset(windowStatus: UsageGovernorWindowStatus, nowMs: number): string {
	if (windowStatus.resetsAtMs === undefined) return "reset unknown";
	if (windowStatus.resetsAtMs > nowMs) {
		const remaining = formatCoarseDuration(windowStatus.resetsAtMs - nowMs);
		return `resets in ${remaining} (${formatGovernorClock(windowStatus.resetsAtMs)})`;
	}
	return `reset passed at ${formatGovernorClock(windowStatus.resetsAtMs)}`;
}

function describeGovernorGate(windowStatus: UsageGovernorWindowStatus, nowMs: number): string {
	if (windowStatus.state === "stale" || windowStatus.state === "unknown") return "does not gate";
	const admissibleAt = windowStatus.admissibleAtMs;
	if (admissibleAt === undefined || admissibleAt <= nowMs) return "admissible now";
	return `next admissible ${formatGovernorClock(admissibleAt)} (in ${formatCoarseDuration(admissibleAt - nowMs)})`;
}

export interface UsageGovernorRenderOptions {
	nowMs: number;
	accountLabel: UsageGovernorAccountLabeler;
	/** Identity masker for free text under `--redact`. */
	maskText?: (text: string) => string;
}

const GOVERNOR_WAIT_REASON: Record<UsageGovernorWaitReason, string> = {
	"over-allowance": "over its allowance",
	"reserve-held": "held by the reserve",
	exhausted: "exhausted",
};

function formatGovernorWindow(windowStatus: UsageGovernorWindowStatus, nowMs: number, text: GovernorTextFn): string[] {
	const share = describeGovernorShare(windowStatus.usedFraction, windowStatus.allowedFraction, " · ");
	const reserve = formatGovernorPercent(windowStatus.reserveFraction);
	const counts = `pending ${windowStatus.pendingRequests} · in flight ${windowStatus.inFlightRequests}`;
	const observed =
		windowStatus.observedAtMs === undefined
			? "never observed"
			: `observed ${formatCoarseDuration(Math.max(0, nowMs - windowStatus.observedAtMs))} ago`;
	const cost =
		windowStatus.costPerRequest === undefined
			? "uncalibrated"
			: `${formatGovernorPercent(windowStatus.costPerRequest, 2)} per request`;
	return [
		`    ${text(windowStatus.label, TRUNCATE_LENGTHS.TITLE)}  ${windowStatus.state}  ${share} · reserve ${reserve}`,
		`      ${describeGovernorReset(windowStatus, nowMs)} · ${observed}`,
		`      ${counts} · cost ${cost} · ${describeGovernorGate(windowStatus, nowMs)}`,
	];
}

function describeGovernorBankedResets(banked: UsageGovernorBankedResets, nowMs: number, text: GovernorTextFn): string {
	const parts = [`banked resets (not counted): ${banked.available} available`];
	if (banked.redeemable !== undefined) parts.push(`${banked.redeemable} redeemable`);
	if (banked.eligible === true) {
		parts.push("eligible");
	} else if (banked.eligible === false) {
		parts.push(banked.reason ? `not eligible: ${text(banked.reason)}` : "not eligible");
	} else if (banked.reason) {
		parts.push(text(banked.reason));
	}
	const expiresAt = banked.soonestExpiresAtMs;
	if (expiresAt !== undefined && expiresAt > nowMs) {
		parts.push(`soonest expires in ${formatCoarseDuration(expiresAt - nowMs)} (${formatGovernorClock(expiresAt)})`);
	} else if (expiresAt !== undefined) {
		parts.push(`soonest expired ${formatGovernorClock(expiresAt)}`);
	}
	return parts.join(" · ");
}

function describeGovernorWaitVerb(wait: UsageGovernorWaitRecord, nowMs: number): string {
	const duration = formatCoarseDuration(Math.max(0, (wait.endedAtMs ?? nowMs) - wait.startedAtMs));
	if (wait.outcome === "aborted") return `aborted after ${duration}`;
	if (wait.endedAtMs === undefined) return `waiting ${duration}`;
	return `waited ${duration}`;
}

function formatGovernorWait(
	wait: UsageGovernorWaitRecord,
	nowMs: number,
	text: GovernorTextFn,
	accountLabel: UsageGovernorAccountLabeler,
): string {
	const verb = describeGovernorWaitVerb(wait, nowMs);
	const share = describeGovernorShare(wait.usedFraction, wait.allowedFraction, ", ");
	const bindingLabel = wait.bindingLabel === undefined ? undefined : text(wait.bindingLabel, TRUNCATE_LENGTHS.TITLE);
	const binding = [bindingLabel, GOVERNOR_WAIT_REASON[wait.reason]].filter(Boolean).join(" ");
	const until = wait.untilMs === undefined ? "" : ` until ${formatGovernorClock(wait.untilMs)}`;
	const shortId = wait.sessionId?.slice(0, 8);
	const session = shortId === undefined ? "" : ` · session ${text(shortId, TRUNCATE_LENGTHS.TITLE)}`;
	const role = text(wait.role ?? "unattributed", TRUNCATE_LENGTHS.TITLE);
	const source = text(wait.source, TRUNCATE_LENGTHS.TITLE);
	const provider = text(wait.provider, TRUNCATE_LENGTHS.TITLE);
	const account = text(accountLabel(wait.provider, wait.credentialId));
	const started = formatGovernorClock(wait.startedAtMs);
	const who = `${role} (${source}) ${verb} on ${provider} · ${account}`;
	const detail = `${binding}${until} (${share})`;
	return `${who}: ${detail} · started ${started}${session}`;
}

/**
 * Text lines for the governor block of `/usage` and `omp usage`: ledger health, each account's
 * windows against their allowance, banked resets (shown, never counted), and recent waits.
 * Empty while the governor is off. Renders the status it is given and nothing else.
 */
export function formatUsageGovernorLines(status: UsageGovernorStatus, options: UsageGovernorRenderOptions): string[] {
	if (!status.config.enabled) return [];
	const { nowMs, accountLabel, maskText } = options;
	const text: GovernorTextFn = (value, max = TRUNCATE_LENGTHS.LONG) => governorText(value, max, maskText);
	const lead = formatGovernorPercent(status.config.lead, 0);
	const lines = [`Usage governor · lead ${lead} · interactive reserve ${status.config.interactiveReserve}`];
	if (status.ledger === "ok") {
		lines.push("  ledger ok");
	} else if (status.ledger === "closed") {
		lines.push("  ledger closed");
	} else {
		const reason = text(status.degradedReason ?? "reason not recorded");
		lines.push(`  ledger degraded: ${reason} · requests are not governed until it recovers`);
	}

	const groups = new Map<
		string,
		{ provider: string; credentialId: number | undefined; windows: UsageGovernorWindowStatus[] }
	>();
	for (const windowStatus of status.windows) {
		const key = `${windowStatus.provider}\u0000${windowStatus.credentialId ?? ""}`;
		let group = groups.get(key);
		if (!group) {
			group = { provider: windowStatus.provider, credentialId: windowStatus.credentialId, windows: [] };
			groups.set(key, group);
		}
		group.windows.push(windowStatus);
	}
	if (groups.size === 0) lines.push("  no windows governed yet");
	for (const group of groups.values()) {
		const label = text(accountLabel(group.provider, group.credentialId));
		lines.push(`  ${formatProviderName(group.provider)} · ${label}`);
		for (const windowStatus of group.windows) lines.push(...formatGovernorWindow(windowStatus, nowMs, text));
		const banked = group.windows.find(windowStatus => windowStatus.bankedResets !== undefined)?.bankedResets;
		if (banked) lines.push(`      ${describeGovernorBankedResets(banked, nowMs, text)}`);
	}

	lines.push("  recent waits");
	if (status.waits.length === 0) lines.push("    none recorded");
	for (const wait of status.waits) lines.push(`    ${formatGovernorWait(wait, nowMs, text, accountLabel)}`);
	return lines;
}

/**
 * Build the `/usage` ACP-mode text. Prefers provider-reported limits when the
 * session exposes `fetchUsageReports`; otherwise falls back to the local
 * session-manager tallies. The governor block, when on, follows the provider
 * sections and reads cached status only.
 */
export async function buildUsageReportText(runtime: SlashCommandRuntime): Promise<string> {
	const nowMs = Date.now();
	// A runtime without a model registry has no governor to show.
	const authStorage = runtime.session.modelRegistry?.authStorage;
	const governorStatus = authStorage ? readUsageGovernorStatus(authStorage.governor) : undefined;
	const governorLines =
		authStorage && governorStatus
			? formatUsageGovernorLines(governorStatus, {
					nowMs,
					accountLabel: usageGovernorAccountLabeler(providerId => authStorage.oauth.accounts(providerId)),
				})
			: [];
	const provider = runtime.session as SlashCommandRuntime["session"] & {
		fetchUsageReports?: () => Promise<UsageReport[] | null>;
		getUsageReportingModelSelectors?: (reports: readonly UsageReport[]) => string[];
	};
	if (provider.fetchUsageReports) {
		const reports = await provider.fetchUsageReports();
		if (reports && reports.length > 0) {
			const currentProvider = runtime.session.model?.provider;
			const activeAccount = currentProvider
				? runtime.session.modelRegistry.authStorage.oauth.identity(currentProvider, runtime.session.sessionId)
				: undefined;
			const usageModelSelectors = provider.getUsageReportingModelSelectors?.(reports) ?? [];
			return renderUsageReports(
				reports,
				nowMs,
				providerId => (providerId === currentProvider ? activeAccount : undefined),
				usageModelSelectors,
				governorLines,
			);
		}
	}

	const stats = runtime.session.sessionManager.getUsageStatistics();
	const orchestrationTokens = stats.orchestrationInput + stats.orchestrationOutput + stats.orchestrationCacheRead;
	return [
		"Usage",
		`Input tokens: ${stats.input}`,
		`Output tokens: ${stats.output}`,
		`Cache read tokens: ${stats.cacheRead}`,
		`Cache write tokens: ${stats.cacheWrite}`,
		`Total tokens: ${stats.totalTokens}`,
		...(orchestrationTokens > 0 ? [`Orchestration tokens: ${orchestrationTokens}`] : []),
		`Premium requests: ${stats.premiumRequests}`,
		`Cost: $${stats.cost.toFixed(6)}`,
		...(governorLines.length > 0 ? ["", ...governorLines] : []),
	].join("\n");
}
