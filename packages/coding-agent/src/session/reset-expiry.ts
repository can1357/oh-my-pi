/**
 * How soon an account's saved rate-limit resets expire, and whether anything
 * will spend them first. Shared by `omp usage` and the TUI status line so both
 * warn about the accounts the salvage planners would act on.
 */
import type { AuthAccountPolicy, UsageLimit, UsageReport, UsageResetCreditDetail } from "@oh-my-pi/pi-ai";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { formatActiveAccountLabel, usageReportIdentity } from "../slash-commands/helpers/active-oauth-account";
import { formatResetProviderName } from "../slash-commands/helpers/reset-usage";
import { claudeCoveredLimits, fullestClaudeLimit } from "./claude-auto-reset";
import {
	fullestCodexChatWindow,
	SALVAGE_MIN_USED_FRACTION,
	shouldEvaluateCodexAutoRedeem,
	shouldPromptCodexAutoRedeem,
} from "./codex-auto-reset";
import { cfgClaudeResetsAutoRedeem, cfgCodexResetsAutoRedeem, type ResetAutoRedeemMode } from "./settings";

const SOON_MS = 7 * 24 * 3_600_000;
const IMMINENT_MS = 24 * 3_600_000;

/** Saved resets close to expiry on an account whose fullest chat window is worth restoring. */
export interface ResetExpiryWarning {
	provider: "openai-codex" | "anthropic";
	/** `soon`: the soonest reset expires within 7 days; `imminent`: within 24 hours. */
	tier: "soon" | "imminent";
	/** Resets that expire within the tier's horizon. */
	count: number;
	/** Soonest expiry among them (epoch ms). */
	expiresAtMs: number;
	/** The chat window the salvage planner measures for this account. */
	limit: UsageLimit;
	usedFraction: number;
}

/**
 * Classify an account's saved resets by expiry. An account whose fullest chat
 * window is below {@link SALVAGE_MIN_USED_FRACTION} gets no warning: the
 * salvage planners skip it as well.
 */
export function classifyResetExpiry(report: UsageReport, nowMs: number): ResetExpiryWarning | undefined {
	const provider = report.provider;
	if (provider !== "openai-codex" && provider !== "anthropic") return undefined;
	const credits: { credit: UsageResetCreditDetail; expiresAtMs: number }[] = [];
	for (const credit of report.resetCredits?.credits ?? []) {
		if ((credit.status ?? "available") !== "available" || credit.remainingCount === 0 || !credit.expiresAt) continue;
		const expiresAtMs = Date.parse(credit.expiresAt);
		if (Number.isFinite(expiresAtMs) && expiresAtMs > nowMs) credits.push({ credit, expiresAtMs });
	}
	if (credits.length === 0) return undefined;
	const soonest = credits.reduce((best, entry) => (entry.expiresAtMs < best.expiresAtMs ? entry : best));
	const remainingMs = soonest.expiresAtMs - nowMs;
	if (remainingMs > SOON_MS) return undefined;

	let fullest: { limit: UsageLimit; usedFraction: number } | undefined;
	if (provider === "openai-codex") {
		const window = fullestCodexChatWindow(report);
		if (window?.usedFraction !== undefined) fullest = { limit: window.limit, usedFraction: window.usedFraction };
	} else {
		const covered = fullestClaudeLimit(claudeCoveredLimits(report.limits, soonest.credit), soonest.credit);
		if (covered) fullest = { limit: covered.limit, usedFraction: covered.used };
	}
	if (!fullest || fullest.usedFraction < SALVAGE_MIN_USED_FRACTION) return undefined;

	const tier = remainingMs <= IMMINENT_MS ? "imminent" : "soon";
	const horizonMs = tier === "imminent" ? IMMINENT_MS : SOON_MS;
	let count = 0;
	for (const { credit, expiresAtMs } of credits) {
		if (expiresAtMs - nowMs <= horizonMs) count += credit.remainingCount ?? 1;
	}
	return { provider, tier, count, expiresAtMs: soonest.expiresAtMs, ...fullest };
}

/**
 * Who spends an imminent saved reset under the session consent rules. `auto`
 * and `ask` both need an interactive omp session: its usage refresh runs the
 * salvage sweep. `off` (the provider setting) and `account-off` (the account's
 * `autoRedeem: false` policy) mean nothing spends it.
 */
export interface ResetSpendVerdict {
	kind: "auto" | "ask" | "off" | "account-off";
	setting: "codexResets.autoRedeem" | "claudeResets.autoRedeem";
	mode: ResetAutoRedeemMode;
}

export function resetSpendVerdict(
	provider: "openai-codex" | "anthropic",
	settings: Settings,
	policy: AuthAccountPolicy | undefined,
): ResetSpendVerdict {
	const setting = provider === "anthropic" ? cfgClaudeResetsAutoRedeem : cfgCodexResetsAutoRedeem;
	const mode = setting.get(settings);
	const kind = !shouldEvaluateCodexAutoRedeem(mode)
		? "off"
		: policy?.autoRedeem === false
			? "account-off"
			: shouldPromptCodexAutoRedeem(mode)
				? "ask"
				: "auto";
	return { kind, setting: setting.id, mode };
}

/** One-line TUI warning for the soonest saved reset expiring within 24 hours across the pool. */
export function formatResetExpiryNotice(reports: readonly UsageReport[], nowMs: number): string | undefined {
	let soonest: { report: UsageReport; warning: ResetExpiryWarning } | undefined;
	let accounts = 0;
	for (const report of reports) {
		const warning = classifyResetExpiry(report, nowMs);
		if (warning?.tier !== "imminent") continue;
		accounts++;
		if (!soonest || warning.expiresAtMs < soonest.warning.expiresAtMs) soonest = { report, warning };
	}
	if (!soonest) return undefined;
	const { report, warning } = soonest;
	const provider = formatResetProviderName(warning.provider);
	const label = formatActiveAccountLabel(usageReportIdentity(report));
	const account = label ? ` on ${label}` : "";
	const due = formatDuration(warning.expiresAtMs - nowMs);
	const resets =
		warning.count === 1
			? `Saved ${provider} reset${account} expires in ${due}`
			: `${warning.count} saved ${provider} resets${account} expire, soonest in ${due}`;
	const others = accounts > 1 ? ` (and ${accounts - 1} more account${accounts === 2 ? "" : "s"})` : "";
	return `${resets}${others} · /usage`;
}
