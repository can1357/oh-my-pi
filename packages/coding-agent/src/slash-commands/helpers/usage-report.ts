import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { OAuthAccountIdentity } from "../../session/auth-storage";
import { collapseSharedUsageReports, summarizeUsageResetCredits } from "@oh-my-pi/pi-tui/overlays/usage-display";
import type { SlashCommandRuntime } from "../types";
import { formatCodexUsageReportLabel, reportMatchesActiveAccount } from "./active-oauth-account";
import { formatCoarseDuration, formatProviderName, renderAsciiBar } from "@oh-my-pi/pi-tui/chrome/format";

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
	return ["```", ...lines, "```"].join("\n");
}

/**
 * Build the `/usage` ACP-mode text. Prefers provider-reported limits when the
 * session exposes `fetchUsageReports`; otherwise falls back to the local
 * session-manager tallies.
 */
export async function buildUsageReportText(runtime: SlashCommandRuntime): Promise<string> {
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
				Date.now(),
				providerId => (providerId === currentProvider ? activeAccount : undefined),
				usageModelSelectors,
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
	].join("\n");
}
