/**
 * One description of which saved-reset windows a banked credit restores, and
 * one consent rule deciding whether, how, and where a spend is approved.
 * Both providers' planners, the expiry verdict and the session prompt read
 * only these, so a policy change cannot drift between them.
 */
import { resolveUsedFraction, type UsageLimit, type UsageReport, type UsageResetCreditDetail } from "@oh-my-pi/pi-ai";
import type { ResetAutoRedeemMode } from "./settings";

/** Last-chance horizon: bypasses salvage thresholds, and any restorable window's consent suffices. */
export const IMMINENT_RESET_EXPIRY_MS = 5 * 60_000;
/** The Fable weekly cap: a grant clearing it restores only that window. */
export const FABLE_RESET_LIMIT_ID = "anthropic:7d:fable";
export type ResetWindow = "5h" | "weekly";
export type ResetConsentWindow = ResetWindow | "fable";
export type ResetProvider = "openai-codex" | "anthropic";
export type ResetSettingKey =
	| "codexResets.autoRedeem5h"
	| "codexResets.autoRedeemWeekly"
	| "claudeResets.autoRedeem5h"
	| "claudeResets.autoRedeemWeekly"
	| "claudeResets.autoRedeemFable";

/** The settings key that governs each window; Codex has no Fable window. */
const RESET_SETTING_KEYS: Record<ResetProvider, Partial<Record<ResetConsentWindow, ResetSettingKey>>> = {
	"openai-codex": { "5h": "codexResets.autoRedeem5h", weekly: "codexResets.autoRedeemWeekly" },
	anthropic: {
		"5h": "claudeResets.autoRedeem5h",
		weekly: "claudeResets.autoRedeemWeekly",
		fable: "claudeResets.autoRedeemFable",
	},
};

function resetProvider(provider: string): ResetProvider {
	if (provider === "openai-codex" || provider === "anthropic") return provider;
	throw new Error(`Unsupported saved-reset provider: ${provider}`);
}

/** A planned spend, as far as consent is concerned. */
export interface ResetConsentAction<W extends ResetConsentWindow = ResetConsentWindow> {
	target: { provider: string };
	/** Window whose policy governs this spend; absent when the blocked window is unknown, so every restorable window governs. */
	window?: W;
	/** Windows the spent credit restores. */
	restorableWindows: readonly W[];
	/** Remaining credit lifetime at planning time; imminent spends need only one restorable window's permission. */
	expiresInMs?: number;
}

export interface ResetActionConsent {
	mode: ResetAutoRedeemMode;
	/** The settings keys whose mode decides this spend. */
	keys: ResetSettingKey[];
	/** Keys a prompt answer may be saved to: the governing windows', never an imminent credit's other restorable windows. */
	saveKeys: ResetSettingKey[];
}

const MODE_RANK: Record<ResetAutoRedeemMode, number> = { no: 0, unset: 1, yes: 2 };

/**
 * The single consent rule for saved-reset spending. A spend needs every
 * governing window's permission (the least permissive mode wins); a credit
 * about to expire needs only one restorable window's (the most permissive
 * wins). Answers are saved to the governing windows only, so a one-off
 * salvage cannot permanently enable every window the credit happened to restore.
 */
export function actionConsent<W extends ResetConsentWindow>(
	action: ResetConsentAction<W>,
	modes: Record<W, ResetAutoRedeemMode>,
): ResetActionConsent {
	const settings = RESET_SETTING_KEYS[resetProvider(action.target.provider)];
	const keyOf = (window: W): ResetSettingKey => {
		const key = settings[window];
		if (key === undefined) throw new Error(`Saved-reset window has no setting: ${window}`);
		return key;
	};
	const governing = action.window === undefined ? action.restorableWindows : [action.window];
	const imminent = action.expiresInMs !== undefined && action.expiresInMs <= IMMINENT_RESET_EXPIRY_MS;
	const deciding = imminent ? action.restorableWindows : governing;
	let mode: ResetAutoRedeemMode | undefined;
	for (const window of deciding) {
		const rank = MODE_RANK[modes[window]];
		if (mode === undefined || (imminent ? rank > MODE_RANK[mode] : rank < MODE_RANK[mode])) mode = modes[window];
	}
	const decided = mode ?? "no";
	return {
		mode: decided,
		keys: deciding.filter(window => modes[window] === decided).map(keyOf),
		saveKeys: governing.map(keyOf),
	};
}

/** Whether at least one window allows planning, including consent prompts for unset modes. */
export function shouldEvaluateResetAutoRedeem<W extends string>(modes: Record<W, ResetAutoRedeemMode>): boolean {
	for (const mode of Object.values(modes)) {
		if (mode !== "no") return true;
	}
	return false;
}

export interface ResetPlanSettings<W extends ResetConsentWindow = ResetConsentWindow> {
	modes: Record<W, ResetAutoRedeemMode>;
	/** `blocked-account`: skip when the natural unblock is closer than this. */
	minBlockedMinutes: number;
	/** `blocked-account`: never spend below this many remaining credits. */
	keepCredits: number;
	/** `expiring-credit`: broader salvage window; `<= 0` leaves only the five-minute fallback. */
	salvageHorizonMs: number;
}

/** Planner settings from a provider's `codexResets.*` or `claudeResets.*` group. */
export function resetPlannerSettings<W extends ResetConsentWindow>(
	modes: Record<W, ResetAutoRedeemMode>,
	cfg: { minBlockedMinutes: number; keepCredits: number; salvageHorizonHours: number },
): ResetPlanSettings<W> {
	return {
		modes,
		minBlockedMinutes: Math.max(0, cfg.minBlockedMinutes),
		keepCredits: Math.max(0, Math.trunc(cfg.keepCredits)),
		salvageHorizonMs: Math.max(0, cfg.salvageHorizonHours) * 3_600_000,
	};
}

/** Every Codex credit restores both chat windows. */
export const CODEX_RESET_WINDOWS: readonly ResetWindow[] = ["5h", "weekly"];

export interface ResetGrant {
	kind: "claude-regular" | "juniper" | "fable";
	/** Windows the grant restores, classified from the grant itself and never from a report row's tier label. */
	restorableWindows: ResetConsentWindow[];
	/** Reported limits the grant clears, plus a Fable cap evidenced only by the grant itself. */
	coveredLimits: UsageLimit[];
	/** The fullest covered limit: what a salvage spend restores. A Fable grant has none while its Fable usage is unknown. */
	fullest?: { limit: UsageLimit; used: number; window: ResetConsentWindow };
}

const FIVE_HOUR_LIMIT_ID = "anthropic:5h";
const HISTORY_WINDOW_MS = 7 * 24 * 3_600_000;

/**
 * A limit's usage from the strongest evidence available: the report row, the
 * grant's own used fraction, or the server naming the limit as blocking.
 * `undefined` when nothing measures it.
 */
function grantLimitUsage(credit: UsageResetCreditDetail, id: string, row: UsageLimit | undefined): number | undefined {
	let used: number | undefined;
	for (const value of [
		row ? resolveUsedFraction(row) : undefined,
		credit.usedFractions?.[id],
		credit.blocking?.includes(id) ? 1 : undefined,
	]) {
		if (value !== undefined && Number.isFinite(value)) used = Math.max(used ?? 0, value);
	}
	return used;
}

/**
 * Identify a Claude credit from the grant itself: Fable iff it clears
 * {@link FABLE_RESET_LIMIT_ID}, then Juniper, else an ordinary grant. A Fable
 * grant is measured on its Fable cap alone, so its five-hour coverage never
 * makes ordinary 5h usage look like a Fable spend.
 */
export function classifyResetGrant(
	credit: UsageResetCreditDetail,
	report: UsageReport,
	scopedLimits: readonly UsageLimit[] = report.limits,
): ResetGrant {
	const clears = credit.clears ?? [];
	const kind: ResetGrant["kind"] = clears.includes(FABLE_RESET_LIMIT_ID)
		? "fable"
		: credit.program === "juniper_tide"
			? "juniper"
			: "claude-regular";
	const coveredLimits = scopedLimits.filter(
		limit => clears.includes(limit.id) && (kind !== "juniper" || limit.id === FIVE_HOUR_LIMIT_ID),
	);
	if (kind === "fable") {
		const row = report.limits.find(limit => limit.id === FABLE_RESET_LIMIT_ID);
		const used = grantLimitUsage(credit, FABLE_RESET_LIMIT_ID, row);
		const limit =
			row ??
			({
				id: FABLE_RESET_LIMIT_ID,
				label: "Claude 7 Day (Fable)",
				scope: { provider: "anthropic", tier: "fable", windowId: "7d" },
				window: { id: "7d", label: "7 Day", durationMs: HISTORY_WINDOW_MS },
				amount: { usedFraction: used ?? 0, unit: "percent" },
			} satisfies UsageLimit);
		if (!coveredLimits.includes(limit)) coveredLimits.push(limit);
		const fullest = used === undefined ? undefined : { limit, used, window: "fable" as const };
		return { kind, restorableWindows: ["fable"], coveredLimits, fullest };
	}
	const restorableWindows: ResetConsentWindow[] = [];
	for (const id of clears) {
		if (kind === "juniper" && id !== FIVE_HOUR_LIMIT_ID) continue;
		const window: ResetConsentWindow = id === FIVE_HOUR_LIMIT_ID ? "5h" : "weekly";
		if (!restorableWindows.includes(window)) restorableWindows.push(window);
	}
	let fullest: ResetGrant["fullest"];
	for (const limit of coveredLimits) {
		const used = grantLimitUsage(credit, limit.id, limit) ?? 0;
		if (!fullest || used > fullest.used) {
			fullest = { limit, used, window: limit.id === FIVE_HOUR_LIMIT_ID ? "5h" : "weekly" };
		}
	}
	return { kind, restorableWindows, coveredLimits, fullest };
}
