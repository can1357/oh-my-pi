/**
 * One description of which saved-reset windows a banked credit restores, and
 * one consent rule deciding whether, how, and where a spend is approved.
 * Both providers' planners, the expiry verdict and the session prompt read
 * only these, so a policy change cannot drift between them.
 */
import {
	resolveUsedFraction,
	type ResetCreditTarget,
	type UsageLimit,
	type UsageReport,
	type UsageResetCreditDetail,
} from "@oh-my-pi/pi-ai";
import type { ResetAutoRedeemMode } from "./settings";

/** Last-chance horizon: bypasses salvage thresholds and headless unset consent, never an explicit refusal. */
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
	/** Window whose policy governs this spend. */
	window: W;
	/** Windows the spent credit restores. */
	restorableWindows: readonly W[];
	/** Remaining credit lifetime at planning time; imminent spends use every restorable window. */
	expiresInMs?: number;
}

export interface ResetActionConsent {
	mode: ResetAutoRedeemMode;
	/** The settings keys whose mode decides this spend. */
	keys: ResetSettingKey[];
	/** The only key a prompt answer may be saved to: the governing window's, never its restorable siblings. */
	saveKey: ResetSettingKey;
}

/**
 * The single consent rule for saved-reset spending: the governing window's
 * mode, or for an imminent credit the most permissive restorable window's.
 * `saveKey` stays the governing window even then, so a one-off salvage cannot
 * permanently enable every window the credit happened to restore.
 */
export function actionConsent<W extends ResetConsentWindow>(
	action: ResetConsentAction<W>,
	modes: Record<W, ResetAutoRedeemMode>,
): ResetActionConsent {
	const settings = RESET_SETTING_KEYS[resetProvider(action.target.provider)];
	const saveKey = settings[action.window];
	if (saveKey === undefined) throw new Error(`Saved-reset window has no setting: ${action.window}`);
	const windows =
		action.expiresInMs !== undefined && action.expiresInMs <= IMMINENT_RESET_EXPIRY_MS
			? action.restorableWindows
			: [action.window];
	let mode: ResetAutoRedeemMode = "no";
	for (const window of windows) {
		if (modes[window] === "yes") {
			mode = "yes";
			break;
		}
		if (modes[window] === "unset") mode = "unset";
	}
	const keys: ResetSettingKey[] = [];
	for (const window of windows) {
		const key = settings[window];
		if (key !== undefined && modes[window] === mode && !keys.includes(key)) keys.push(key);
	}
	return { mode, keys, saveKey };
}

/** Whether at least one window allows planning, including consent prompts for unset modes. */
export function shouldEvaluateResetAutoRedeem<W extends string>(modes: Record<W, ResetAutoRedeemMode>): boolean {
	for (const mode of Object.values(modes)) {
		if (mode !== "no") return true;
	}
	return false;
}

/**
 * Planned spends a host with no prompt UI may make: an imminent credit nobody
 * can be asked about, whose consent is not an explicit refusal. The approved
 * target names that credit, so redeem cannot pick a later one.
 */
export function headlessApprovedResetActions<
	T extends ResetConsentAction & { creditId?: string; target: ResetCreditTarget },
>(actions: readonly T[], modes: Record<string, ResetAutoRedeemMode>): readonly T[] {
	const approved: T[] = [];
	for (const action of actions) {
		if (action.expiresInMs === undefined || action.expiresInMs > IMMINENT_RESET_EXPIRY_MS) continue;
		if (actionConsent(action, modes).mode === "no") continue;
		approved.push(action.creditId ? { ...action, target: { ...action.target, creditId: action.creditId } } : action);
	}
	return approved;
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

export interface ResetGrant {
	kind: "codex" | "claude-regular" | "juniper" | "fable";
	/** Windows the grant restores, classified from the grant itself and never from a report row's tier label. */
	restorableWindows: ResetConsentWindow[];
	/** Reported limits the grant clears, plus a Fable cap evidenced only by the grant's own usage. */
	coveredLimits: UsageLimit[];
	/** The fullest covered limit: what a salvage spend restores. */
	fullest?: { limit: UsageLimit; used: number; window: ResetConsentWindow };
	/** A Fable grant's measured usage; `undefined` when neither the report row nor the grant reports any. */
	fableUsed?: number;
}

const HISTORY_WINDOW_MS = 7 * 24 * 3_600_000;

/**
 * Identify a credit from the grant itself: Fable iff it clears
 * {@link FABLE_RESET_LIMIT_ID}, then Juniper, else an ordinary grant. Fable
 * usage comes from the report's row first and the grant's own used fraction
 * second, so a Fable grant stays spendable when the report omits the row.
 */
export function classifyResetGrant(
	provider: ResetProvider,
	credit: UsageResetCreditDetail,
	report: UsageReport,
	scopedLimits: readonly UsageLimit[] = report.limits,
): ResetGrant {
	if (provider === "openai-codex") return { kind: "codex", restorableWindows: ["5h", "weekly"], coveredLimits: [] };
	const clears = credit.clears ?? [];
	const kind: ResetGrant["kind"] = clears.includes(FABLE_RESET_LIMIT_ID)
		? "fable"
		: credit.program === "juniper_tide"
			? "juniper"
			: "claude-regular";
	const coveredLimits = scopedLimits.filter(
		limit => clears.includes(limit.id) && (kind !== "juniper" || limit.id === "anthropic:5h"),
	);
	if (kind === "fable") {
		const row = report.limits.find(limit => limit.id === FABLE_RESET_LIMIT_ID);
		const measured = row ? resolveUsedFraction(row) : undefined;
		const server = credit.usedFractions?.[FABLE_RESET_LIMIT_ID];
		const observed = measured !== undefined && Number.isFinite(measured) ? measured : server;
		const fableUsed = observed !== undefined && Number.isFinite(observed) ? Math.max(0, observed) : undefined;
		const limit =
			row ??
			({
				id: FABLE_RESET_LIMIT_ID,
				label: "Claude 7 Day (Fable)",
				scope: { provider: "anthropic", tier: "fable", windowId: "7d" },
				window: { id: "7d", label: "7 Day", durationMs: HISTORY_WINDOW_MS },
				amount: { usedFraction: fableUsed ?? 0, unit: "percent" },
			} satisfies UsageLimit);
		if (!coveredLimits.includes(limit)) coveredLimits.push(limit);
		if (fableUsed === undefined) return { kind, restorableWindows: ["fable"], coveredLimits };
		return {
			kind,
			restorableWindows: ["fable"],
			coveredLimits,
			fableUsed,
			fullest: { limit, used: fableUsed, window: "fable" },
		};
	}
	const restorableWindows: ResetConsentWindow[] = [];
	for (const id of clears) {
		if (kind === "juniper" && id !== "anthropic:5h") continue;
		const window: ResetConsentWindow = id === "anthropic:5h" ? "5h" : "weekly";
		if (!restorableWindows.includes(window)) restorableWindows.push(window);
	}
	const grant: ResetGrant = { kind, restorableWindows, coveredLimits };
	for (const limit of coveredLimits) {
		const resolved = resolveUsedFraction(limit);
		const observed = resolved === undefined || !Number.isFinite(resolved) ? 0 : Math.max(0, resolved);
		const server = credit.usedFractions?.[limit.id];
		const used = Math.max(observed, typeof server === "number" && Number.isFinite(server) ? server : 0);
		if (!grant.fullest || used > grant.fullest.used) {
			grant.fullest = { limit, used, window: limit.id === "anthropic:5h" ? "5h" : "weekly" };
		}
	}
	return grant;
}
