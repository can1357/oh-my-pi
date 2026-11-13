/**
 * How soon an account's saved rate-limit resets expire, and whether anything
 * will spend them first. Shared by `omp usage` and the TUI status line so both
 * warn about the accounts the salvage planners would act on.
 */
import type {
	ResetCreditAccountStatus,
	UsageLimit,
	UsageReport,
	UsageResetCredit,
	UsageResetCreditDetail,
	UsageResetCredits,
} from "@oh-my-pi/pi-ai";
import { zaiResetTypeFromCreditId, zaiResetUsageCredit } from "@oh-my-pi/pi-ai/usage/zai-reset";
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
	claudeResetWindow,
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
	resetPlanSettings,
	resetWindowMode,
	SALVAGE_MIN_USED_FRACTION,
} from "./codex-auto-reset";
import { fullestZaiTokenWindow, type ZaiResetAction, type ZaiResetSkip, planZaiResetClaims } from "./zai-auto-reset";
import {
	cfgClaudeResets,
	cfgCodexResets,
	type ResetAutoRedeemMode,
	type ResetWindow,
	resetWindowModes,
	resetWindowSettings,
} from "./settings";

/** A Z.AI planner action that spends a banked offer (opportunity claims carry no expiry). */
type ZaiResetUseAction = Extract<ZaiResetAction, { kind: "use" }>;

const SOON_MS = 7 * 24 * 3_600_000;
const IMMINENT_MS = 24 * 3_600_000;
/** The TUI warns about a saved reset only in its final hours; the status line and `omp usage` flag it from 24h out. */
const NOTICE_LEAD_MS = 6 * 3_600_000;
const NOTICE_LABEL_MAX = 80;

/** Saved resets close to expiry on an account whose fullest chat window is worth restoring. */
export interface ResetExpiryWarning {
	provider: "openai-codex" | "anthropic" | "zai";
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
	/** Window whose consent governs spending the warned reset; absent when either chat window could. */
	window: ResetWindow | undefined;
}

/**
 * Classify an account's banked saved resets by expiry, including ones the
 * provider will not let it spend yet. An account whose fullest chat window is
 * below {@link SALVAGE_MIN_USED_FRACTION} gets no warning: the salvage
 * planners skip it as well.
 */
export function classifyResetExpiry(report: UsageReport, nowMs: number): ResetExpiryWarning | undefined {
	const provider = report.provider;
	if (provider !== "openai-codex" && provider !== "anthropic" && provider !== "zai") return undefined;
	const credits: { credit: UsageResetCreditDetail; expiresAtMs: number }[] = [];
	for (const credit of report.resetCredits?.credits ?? []) {
		const expiresAtMs = bankedResetCreditExpiryMs(credit);
		if (expiresAtMs !== undefined && expiresAtMs > nowMs) credits.push({ credit, expiresAtMs });
	}
	if (credits.length === 0) return undefined;
	credits.sort((a, b) => a.expiresAtMs - b.expiresAtMs);

	// Codex measures one account-wide chat window; each Claude grant and Z.AI
	// offer clears its own windows, so only grants whose covered windows are
	// worth restoring warn and count.
	const codexWindow = provider === "openai-codex" ? fullestCodexChatWindow(report) : undefined;
	const worth = (credit: UsageResetCreditDetail): { limit: UsageLimit; usedFraction: number } | undefined => {
		if (provider === "openai-codex") {
			return codexWindow?.usedFraction !== undefined && codexWindow.usedFraction >= SALVAGE_MIN_USED_FRACTION
				? { limit: codexWindow.limit, usedFraction: codexWindow.usedFraction }
				: undefined;
		}
		if (provider === "zai") {
			// Measure only the token windows the offer clears, exactly as the
			// planner does; with none present, the fullest token window.
			const cleared = report.limits.filter(
				limit => limit.id.startsWith("zai:tokens:") && (credit.clears ?? []).includes(limit.id),
			);
			const window = fullestZaiTokenWindow(cleared.length > 0 ? { ...report, limits: cleared } : report);
			return window && window.usedFraction >= SALVAGE_MIN_USED_FRACTION ? window : undefined;
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
	const windowOf = (credit: UsageResetCreditDetail, limit: UsageLimit): ResetWindow | undefined => {
		if (provider === "openai-codex") return codexWindow?.window;
		// A Z.AI offer's credit id names the window it clears (`five_hour:*` / `week:*`).
		if (provider === "zai") return zaiResetTypeFromCreditId(credit.id ?? "") === "WEEK" ? "weekly" : "5h";
		return claudeResetWindow(credit, [limit.id]);
	};
	const window = windowOf(warned.credit, fullest.limit);
	// Count only resets the warned one's setting decides, so the count and the verdict agree.
	let count = 0;
	for (const { credit, expiresAtMs } of credits) {
		if (expiresAtMs - nowMs > horizonMs) continue;
		const worthy = worth(credit);
		if (worthy && windowOf(credit, worthy.limit) === window) count += credit.remainingCount ?? 1;
	}
	return {
		provider,
		tier,
		count,
		expiresAtMs: warned.expiresAtMs,
		usableNow: spendableNow(provider, report.resetCredits, warned.credit, nowMs),
		...fullest,
		window,
	};
}

/**
 * Whether `/usage reset` would spend this grant now: the account must be eligible with a
 * redeemable count, the grant itself available, and for Claude or Z.AI the provider-side
 * pick must name this very grant (the reset command spends only that one).
 */
function spendableNow(
	provider: ResetExpiryWarning["provider"],
	inventory: UsageResetCredits | undefined,
	credit: UsageResetCreditDetail,
	nowMs: number,
): boolean {
	if (!inventory || inventory.eligible === false) return false;
	if ((inventory.redeemableCount ?? inventory.availableCount) <= 0) return false;
	if ((credit.status ?? "available") !== "available" || credit.usable === false) return false;
	if (provider === "anthropic") {
		return inventory.nextCreditId !== undefined && inventory.nextCreditId === credit.id;
	}
	if (provider === "zai") {
		// `/usage reset` spends the soonest-expiring available Z.AI offer.
		const chosen = zaiResetUsageCredit(inventory.credits ?? [], nowMs);
		return chosen !== undefined && chosen.id !== undefined && chosen.id === credit.id;
	}
	return true;
}

/**
 * What an open interactive omp session does with an account's soonest expiring saved
 * reset, from the consent of the window that governs it: `auto` spends it by its
 * last five minutes if the provider still allows it then, `ask` prompts first,
 * `off` leaves it. `eligibleNow` is the salvage planner's answer for this report
 * today; usage can change it before the reset expires.
 */
export interface ResetSpendVerdict {
	kind: "auto" | "ask" | "off";
	/** The setting key or keys that decide it. */
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
	const mode = resetWindowMode(resetWindowModes(warning.provider, settings), warning.window);
	const kind = mode === "no" ? "off" : mode === "unset" ? "ask" : "auto";
	const windows: readonly ResetWindow[] = warning.window ? [warning.window] : ["5h", "weekly"];
	const setting = windows.map(window => resetWindowSettings[warning.provider][window]?.id).join(" + ");
	const plan = planAsLastChance(report, warning, settings, nowMs);
	// A stale report says nothing about eligibility: the sweep plans only after a fresh fetch.
	// Z.AI plans can open with an opportunity claim, so any planned use answers.
	const imminent = IMMINENT_RESET_EXPIRY_MS;
	const eligibleNow =
		plan.actions.some(action => action.expiresInMs === imminent) || plan.skipped[0]?.reason === "stale-report";
	return { kind, setting, mode, eligibleNow };
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
	actions: readonly (CodexResetAction | ClaudeResetAction | ZaiResetUseAction)[];
	skipped: readonly (CodexResetSkip | ClaudeResetSkip | ZaiResetSkip)[];
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
			settings: resetPlanSettings({ "5h": "yes", weekly: "yes" }, cfgCodexResets.get(settings)),
			identity: undefined,
			reports: [{ ...lastChance, metadata: { ...report.metadata, resetCreditCredentialId: credentialId } }],
			...episodes,
		});
	}
	const text = (value: unknown) => (typeof value === "string" ? value : undefined);
	const status: ResetCreditAccountStatus = {
		...inventory,
		provider: warning.provider,
		credentialId,
		accountId: text(report.metadata?.accountId),
		email: text(report.metadata?.email),
		orgId: text(report.metadata?.orgId),
		credits: credits.filter((credit): credit is UsageResetCredit => typeof credit.id === "string"),
		active: false,
		report: lastChance,
	};
	if (warning.provider === "zai") {
		// Park the opportunity claim so only banked-offer uses can answer.
		const accountKey = resetAccountLockKey(status) ?? "zai";
		const plan = planZaiResetClaims({
			nowMs,
			trigger: "sweep",
			settings: { enabled: true },
			reports: [lastChance],
			statuses: [status],
			nextTryAtByAccount: new Map<string, number>([[accountKey, nowMs + 1]]),
			lastOpportunityAtByAccount: new Map<string, number>([[accountKey, nowMs]]),
			...episodes,
		});
		return {
			actions: plan.actions.filter((action): action is ZaiResetUseAction => action.kind === "use"),
			skipped: plan.skipped,
		};
	}
	return planClaudeResetRedemptions({
		nowMs,
		trigger: "sweep",
		provider: "",
		modelId: "",
		settings: resetPlanSettings({ "5h": "yes", weekly: "yes", fable: "yes" }, cfgClaudeResets.get(settings)),
		reports: [lastChance],
		statuses: [status],
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
