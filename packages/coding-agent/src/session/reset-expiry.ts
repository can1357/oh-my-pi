/**
 * How soon an account's saved rate-limit resets expire, and whether anything
 * will spend them first. Shared by `omp usage` and the TUI status line so both
 * warn about the accounts the salvage planners would act on.
 */
import type {
	UsageLimit,
	UsageReport,
	UsageResetCredit,
	UsageResetCreditDetail,
	UsageResetCredits,
} from "@oh-my-pi/pi-ai";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { bankedResetCreditExpiryMs } from "@oh-my-pi/pi-tui/overlays/usage-display";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { formatActiveAccountLabel, usageReportIdentity } from "../slash-commands/helpers/active-oauth-account";
import { formatResetProviderName } from "../slash-commands/helpers/reset-usage";
import {
	type ClaudeResetAction,
	type ClaudeResetSkip,
	claudeCoveredLimits,
	fullestClaudeLimit,
	planClaudeResetRedemptions,
} from "./claude-auto-reset";
import {
	type CodexResetAction,
	type CodexResetSkip,
	fullestCodexChatWindow,
	IMMINENT_RESET_EXPIRY_MS,
	planCodexResetRedemptions,
	resetPlanSettings,
	SALVAGE_MIN_USED_FRACTION,
	shouldEvaluateCodexAutoRedeem,
	shouldPromptCodexAutoRedeem,
} from "./codex-auto-reset";
import {
	cfgClaudeResets,
	cfgClaudeResetsAutoRedeem,
	cfgCodexResets,
	cfgCodexResetsAutoRedeem,
	type ResetAutoRedeemMode,
} from "./settings";

const SOON_MS = 7 * 24 * 3_600_000;
const IMMINENT_MS = 24 * 3_600_000;
const NOTICE_LABEL_MAX = 80;

/** Saved resets close to expiry on an account whose fullest chat window is worth restoring. */
export interface ResetExpiryWarning {
	provider: "openai-codex" | "anthropic";
	/** `soon`: the soonest reset expires within 7 days; `imminent`: within 24 hours. */
	tier: "soon" | "imminent";
	/** Banked resets that expire within the tier's horizon, usable now or not. */
	count: number;
	/** Soonest expiry among them (epoch ms). */
	expiresAtMs: number;
	/** Whether the provider lets the soonest one be spent now. */
	usableNow: boolean;
	/** The chat window the salvage planner measures for this account. */
	limit: UsageLimit;
	usedFraction: number;
}

/**
 * Classify an account's banked saved resets by expiry, including ones the
 * provider will not let it spend yet. An account whose fullest chat window is
 * below {@link SALVAGE_MIN_USED_FRACTION} gets no warning: the salvage
 * planners skip it as well.
 */
export function classifyResetExpiry(report: UsageReport, nowMs: number): ResetExpiryWarning | undefined {
	const provider = report.provider;
	if (provider !== "openai-codex" && provider !== "anthropic") return undefined;
	const credits: { credit: UsageResetCreditDetail; expiresAtMs: number }[] = [];
	for (const credit of report.resetCredits?.credits ?? []) {
		const expiresAtMs = bankedResetCreditExpiryMs(credit);
		if (expiresAtMs !== undefined && expiresAtMs > nowMs) credits.push({ credit, expiresAtMs });
	}
	if (credits.length === 0) return undefined;
	credits.sort((a, b) => a.expiresAtMs - b.expiresAtMs);

	// Codex measures one account-wide chat window; each Claude grant clears its own windows,
	// so only Claude grants whose covered windows are worth restoring warn and count.
	const codexWindow = provider === "openai-codex" ? fullestCodexChatWindow(report) : undefined;
	const worth = (credit: UsageResetCreditDetail): { limit: UsageLimit; usedFraction: number } | undefined => {
		if (provider === "openai-codex") {
			return codexWindow?.usedFraction !== undefined && codexWindow.usedFraction >= SALVAGE_MIN_USED_FRACTION
				? { limit: codexWindow.limit, usedFraction: codexWindow.usedFraction }
				: undefined;
		}
		const covered = fullestClaudeLimit(claudeCoveredLimits(report.limits, credit), credit);
		return covered && covered.used >= SALVAGE_MIN_USED_FRACTION
			? { limit: covered.limit, usedFraction: covered.used }
			: undefined;
	};
	let warned: { credit: UsageResetCreditDetail; expiresAtMs: number } | undefined;
	let fullest: { limit: UsageLimit; usedFraction: number } | undefined;
	for (const entry of credits) {
		if (entry.expiresAtMs - nowMs > SOON_MS) break;
		fullest = worth(entry.credit);
		if (fullest) {
			warned = entry;
			break;
		}
	}
	if (!warned || !fullest) return undefined;
	const remainingMs = warned.expiresAtMs - nowMs;

	const tier = remainingMs <= IMMINENT_MS ? "imminent" : "soon";
	const horizonMs = tier === "imminent" ? IMMINENT_MS : SOON_MS;
	let count = 0;
	for (const { credit, expiresAtMs } of credits) {
		if (expiresAtMs - nowMs <= horizonMs && worth(credit)) count += credit.remainingCount ?? 1;
	}
	return {
		provider,
		tier,
		count,
		expiresAtMs: warned.expiresAtMs,
		usableNow: spendableNow(provider, report.resetCredits, warned.credit),
		...fullest,
	};
}

/**
 * Whether `/usage reset` would spend this grant now: the account must be eligible with a
 * redeemable count, the grant itself available, and for Claude the provider must have
 * selected this very grant (the reset command only spends the server-selected one).
 */
function spendableNow(
	provider: ResetExpiryWarning["provider"],
	inventory: UsageResetCredits | undefined,
	credit: UsageResetCreditDetail,
): boolean {
	if (!inventory || inventory.eligible === false) return false;
	if ((inventory.redeemableCount ?? inventory.availableCount) <= 0) return false;
	if ((credit.status ?? "available") !== "available" || credit.usable === false) return false;
	return provider !== "anthropic" || (inventory.nextCreditId !== undefined && inventory.nextCreditId === credit.id);
}

/**
 * What an open interactive omp session does with an account's soonest expiring saved
 * reset. `kind` comes from the provider's `autoRedeem` setting alone: `auto`
 * spends it by its last five minutes if the provider still allows it then,
 * `ask` prompts first, `off` leaves it. `eligibleNow` is the salvage planner's
 * answer for this report today; usage can change it before the reset expires.
 */
export interface ResetSpendVerdict {
	kind: "auto" | "ask" | "off";
	setting: "codexResets.autoRedeem" | "claudeResets.autoRedeem";
	mode: ResetAutoRedeemMode;
	eligibleNow: boolean;
}

export function resetSpendVerdict(
	report: UsageReport,
	warning: ResetExpiryWarning,
	settings: Settings,
	nowMs: number,
): ResetSpendVerdict {
	const autoRedeem = warning.provider === "anthropic" ? cfgClaudeResetsAutoRedeem : cfgCodexResetsAutoRedeem;
	const mode = autoRedeem.get(settings);
	const kind = !shouldEvaluateCodexAutoRedeem(mode) ? "off" : shouldPromptCodexAutoRedeem(mode) ? "ask" : "auto";
	const plan = planAsLastChance(report, warning, settings, nowMs);
	// A stale report says nothing about eligibility: the sweep plans only after a fresh fetch.
	const eligibleNow =
		plan.actions[0]?.expiresInMs === IMMINENT_RESET_EXPIRY_MS || plan.skipped[0]?.reason === "stale-report";
	return { kind, setting: autoRedeem.id, mode, eligibleNow };
}

/**
 * The salvage sweep's plan for this report now, with every credit moved by
 * the same amount so the warning's reset is in its last five minutes and
 * consent granted: only the provider's eligibility and the planner's
 * coverage rules can refuse it.
 */
function planAsLastChance(
	report: UsageReport,
	warning: ResetExpiryWarning,
	settings: Settings,
	nowMs: number,
): {
	actions: readonly (CodexResetAction | ClaudeResetAction)[];
	skipped: readonly (CodexResetSkip | ClaudeResetSkip)[];
} {
	const shiftMs = warning.expiresAtMs - (nowMs + IMMINENT_RESET_EXPIRY_MS);
	const credits = (report.resetCredits?.credits ?? []).map(credit => {
		const expiresAtMs = credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN;
		return Number.isFinite(expiresAtMs)
			? { ...credit, expiresAt: new Date(expiresAtMs - shiftMs).toISOString() }
			: credit;
	});
	const inventory = { ...(report.resetCredits ?? { availableCount: 0 }), credits };
	const lastChance: UsageReport = { ...report, resetCredits: inventory };
	const episodes = {
		attemptedKeys: new Set<string>(),
		deferredUntilByKey: new Map<string, number>(),
		lastAttemptAtByAccount: new Map<string, number>(),
	};
	// The planners key accounts by credential id, which none of their rules read.
	const credentialId = 0;
	if (warning.provider === "openai-codex") {
		return planCodexResetRedemptions({
			nowMs,
			trigger: "sweep",
			provider: "",
			modelId: "",
			settings: resetPlanSettings({ ...cfgCodexResets.get(settings), autoRedeem: "yes" }),
			identity: undefined,
			reports: [{ ...lastChance, metadata: { ...report.metadata, resetCreditCredentialId: credentialId } }],
			...episodes,
		});
	}
	const text = (value: unknown) => (typeof value === "string" ? value : undefined);
	return planClaudeResetRedemptions({
		nowMs,
		trigger: "sweep",
		provider: "",
		modelId: "",
		settings: resetPlanSettings({ ...cfgClaudeResets.get(settings), autoRedeem: "yes" }),
		reports: [lastChance],
		statuses: [
			{
				...inventory,
				provider: warning.provider,
				credentialId,
				accountId: text(report.metadata?.accountId),
				email: text(report.metadata?.email),
				orgId: text(report.metadata?.orgId),
				credits: credits.filter((credit): credit is UsageResetCredit => typeof credit.id === "string"),
				active: false,
				report: lastChance,
			},
		],
		...episodes,
	});
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
	// Email and organization come from the provider; keep escapes and layout characters out of the TUI.
	const label = sanitizeText(formatActiveAccountLabel(usageReportIdentity(report)) ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const account = label ? ` on ${truncateToWidth(label, NOTICE_LABEL_MAX)}` : "";
	const due = formatDuration(warning.expiresAtMs - nowMs);
	const resets =
		warning.count === 1
			? `Saved ${provider} reset${account} expires in ${due}`
			: `${warning.count} saved ${provider} resets${account} expire, soonest in ${due}`;
	const others = accounts > 1 ? ` (and ${accounts - 1} more account${accounts === 2 ? "" : "s"})` : "";
	return `${resets}${others} · /usage`;
}
