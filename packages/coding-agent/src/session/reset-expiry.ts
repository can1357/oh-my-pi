/**
 * How soon an account's saved rate-limit resets expire, and whether anything
 * will spend them first. Shared by `omp usage` and the TUI status line so both
 * warn about the accounts the salvage planners would act on.
 */
import {
	resolveUsedFraction,
	type UsageLimit,
	type UsageReport,
	type UsageResetCredit,
	type UsageResetCreditDetail,
	type UsageResetCredits,
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
	type ClaudeResetWindow,
	claudeCoveredLimits,
	claudeResetPlanSettings,
	claudeResetWindowModes,
	fullestClaudeLimit,
	planClaudeResetRedemptions,
} from "./claude-auto-reset";
import {
	type CodexResetAction,
	type CodexResetSkip,
	DEBOUNCE_BUCKET_MS,
	fullestCodexChatWindow,
	IMMINENT_RESET_EXPIRY_MS,
	planCodexResetRedemptions,
	resetAccountLockKey,
	resetActionMode,
	resetPlanSettings,
	type ResetWindow,
	resetWindowModes,
	SALVAGE_MIN_USED_FRACTION,
	shouldEvaluateCodexAutoRedeem,
	shouldPromptCodexAutoRedeem,
} from "./codex-auto-reset";
import { cfgClaudeResets, cfgCodexResets, type ResetAutoRedeemMode } from "./settings";

const SOON_MS = 7 * 24 * 3_600_000;
const IMMINENT_MS = 24 * 3_600_000;
/** The TUI warns about a saved reset only in its final hours; the status line and `omp usage` flag it from 24h out. */
const NOTICE_LEAD_MS = 6 * 3_600_000;
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
		// A Fable grant restores only Fable weekly usage, so only that limit can make it worth salvaging.
		const fable = fableClaudeLimit(report.limits, credit);
		if (fable) {
			const used = resolveUsedFraction(fable);
			return used !== undefined && Number.isFinite(used) && used >= SALVAGE_MIN_USED_FRACTION
				? { limit: fable, usedFraction: Math.max(0, used) }
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

const FIVE_HOUR_LIMIT_ID = "anthropic:5h";

/** The settings key governing each provider window. */
const RESET_SETTING_KEY: {
	"openai-codex": Record<ResetWindow, string>;
	anthropic: Record<ClaudeResetWindow, string>;
} = {
	"openai-codex": { "5h": "codexResets.autoRedeem5h", weekly: "codexResets.autoRedeemWeekly" },
	anthropic: {
		"5h": "claudeResets.autoRedeem5h",
		weekly: "claudeResets.autoRedeemWeekly",
		fable: "claudeResets.autoRedeemFable",
	},
};

/** The Fable limit a Claude grant clears: its own weekly cap, outside the shared weekly window. */
function fableClaudeLimit(limits: readonly UsageLimit[], credit: UsageResetCreditDetail): UsageLimit | undefined {
	return claudeCoveredLimits(limits, credit).find(limit => limit.scope.tier === "fable");
}

/** Windows a credit restores: a Codex credit restores both, a Claude grant only its covered limits. */
function restorableResetWindows(report: UsageReport, warning: ResetExpiryWarning): readonly ClaudeResetWindow[] {
	if (warning.provider === "openai-codex") return ["5h", "weekly"];
	const credit = (report.resetCredits?.credits ?? []).find(
		candidate => bankedResetCreditExpiryMs(candidate) === warning.expiresAtMs,
	);
	// A Fable grant also clears the 5h window, but only the Fable key governs spending it.
	if (credit && fableClaudeLimit(report.limits, credit)) return ["fable"];
	const covered = credit ? claudeCoveredLimits(report.limits, credit) : [warning.limit];
	const windows = new Set<ClaudeResetWindow>(covered.map(claudeExpiryWindow));
	windows.add(claudeExpiryWindow(warning.limit));
	return [...windows];
}

/** The window a Claude limit belongs to; the Fable tier is its own window, never the shared weekly one. */
function claudeExpiryWindow(limit: UsageLimit): ClaudeResetWindow {
	if (limit.id === FIVE_HOUR_LIMIT_ID) return "5h";
	return limit.scope.tier === "fable" ? "fable" : "weekly";
}

/**
 * What an open interactive omp session does with an account's soonest expiring saved
 * reset once it reaches its last five minutes: `auto` spends it, `ask` prompts
 * first, `off` leaves it. `kind` follows the most permissive mode among the
 * windows the credit restores, and `setting` names the key or keys that decide
 * it. `eligibleNow` is the salvage planner's answer for this report today;
 * usage can change it before the reset expires.
 */
export interface ResetSpendVerdict {
	kind: "auto" | "ask" | "off";
	setting: string;
	mode: ResetAutoRedeemMode;
	eligibleNow: boolean;
}

export function resetSpendVerdict(
	report: UsageReport,
	warning: ResetExpiryWarning,
	settings: Settings,
	nowMs: number,
): ResetSpendVerdict {
	// Codex has no Fable window, so its mode never decides a verdict.
	const modes: Record<ClaudeResetWindow, ResetAutoRedeemMode> =
		warning.provider === "anthropic"
			? claudeResetWindowModes(cfgClaudeResets.get(settings))
			: { ...resetWindowModes(cfgCodexResets.get(settings)), fable: "no" };
	const restorable = restorableResetWindows(report, warning);
	// Last-chance spending happens at expiry, so judge consent by that moment's rule.
	const mode = resetActionMode(
		{ window: restorable[0] ?? "weekly", restorableWindows: restorable, expiresInMs: 0 },
		modes,
	);
	const kind = !shouldEvaluateCodexAutoRedeem(mode) ? "off" : shouldPromptCodexAutoRedeem(mode) ? "ask" : "auto";
	const deciding = restorable.filter(window => modes[window] === mode);
	const decidingWindows = deciding.length > 0 ? deciding : restorable;
	const setting =
		warning.provider === "anthropic"
			? decidingWindows.map(window => RESET_SETTING_KEY.anthropic[window]).join(" + ")
			: decidingWindows
					.filter((window): window is ResetWindow => window !== "fable")
					.map(window => RESET_SETTING_KEY["openai-codex"][window])
					.join(" + ");
	const plan = planAsLastChance(report, warning, settings, nowMs);
	// A stale report says nothing about eligibility: the sweep plans only after a fresh fetch.
	const eligibleNow =
		plan.actions[0]?.expiresInMs === IMMINENT_RESET_EXPIRY_MS || plan.skipped[0]?.reason === "stale-report";
	return {
		kind,
		setting,
		mode,
		eligibleNow,
	};
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
			settings: resetPlanSettings({
				...cfgCodexResets.get(settings),
				autoRedeem5h: "yes",
				autoRedeemWeekly: "yes",
			}),
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
		settings: claudeResetPlanSettings({
			...cfgClaudeResets.get(settings),
			autoRedeem5h: "yes",
			autoRedeemWeekly: "yes",
			autoRedeemFable: "yes",
		}),
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

/**
 * One-line TUI warning for saved resets across the pool within {@link NOTICE_LEAD_MS}
 * of expiry, naming only those `claim` accepts. Each account's soonest due reset is
 * offered under a key of provider, account, and expiry minute, so a `claim` that
 * accepts each key once warns about every saved reset once.
 */
export function claimResetExpiryNotice(
	reports: readonly UsageReport[],
	nowMs: number,
	claim: (key: string, expiresAtMs: number) => boolean,
): string | undefined {
	let soonest: { report: UsageReport; warning: ResetExpiryWarning } | undefined;
	let accounts = 0;
	for (const report of reports) {
		const warning = classifyResetExpiry(report, nowMs);
		if (!warning || warning.expiresAtMs - nowMs > NOTICE_LEAD_MS) continue;
		const account =
			resetAccountLockKey({ provider: warning.provider, ...usageReportIdentity(report) }) ?? warning.provider;
		const expiryMinute = Math.round(warning.expiresAtMs / DEBOUNCE_BUCKET_MS);
		if (!claim(`reset-expiry|${account}|${expiryMinute}`, warning.expiresAtMs)) continue;
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
