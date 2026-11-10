/**
 * One table for saved-reset grant classification and consent: grant kind,
 * blocked windows, per-window modes, and imminence decide a spend in exactly
 * one place, so the planners and the `omp usage` verdict cannot drift.
 */
import { describe, expect, it } from "bun:test";
import type { ResetCreditAccountStatus, UsageLimit, UsageReport, UsageResetCredit } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	claudeResetPlanSettings,
	claudeResetWindowModes,
	planClaudeResetRedemptions,
} from "@oh-my-pi/pi-coding-agent/session/claude-auto-reset";
import {
	type CodexResetPlanInput,
	planCodexResetRedemptions,
	resetPlanSettings,
	resetWindowModes,
} from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { actionConsent, type ResetConsentWindow } from "@oh-my-pi/pi-coding-agent/session/reset-consent";
import { classifyResetExpiry, resetSpendVerdict } from "@oh-my-pi/pi-coding-agent/session/reset-expiry";
import type { ResetAutoRedeemMode } from "@oh-my-pi/pi-coding-agent/session/settings";

const NOW = 1_700_000_040_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const FIVE_HOUR_ID = "anthropic:5h";
const WEEKLY_ID = "anthropic:7d";
const FABLE_ID = "anthropic:7d:fable";

interface Outcome {
	actions: string[];
	skipped: string[];
	warning: boolean;
	verdict: string;
	warned: string;
}

interface PlannedAction<W extends string> {
	accountKey: string;
	window?: W;
	restorableWindows: readonly W[];
	target: { provider: string };
	expiresInMs?: number;
}

/** One action as consumers observe it: governing window, restorable set, and resolved consent. */
function planOutcome<W extends ResetConsentWindow>(
	actions: readonly PlannedAction<W>[],
	skipped: readonly { rule: string; reason: string }[],
	modes: Record<W, ResetAutoRedeemMode>,
): Partial<Outcome> {
	return {
		actions: actions.map(action => {
			const consent = actionConsent(action, modes);
			return [
				action.accountKey,
				action.window ?? "?",
				action.restorableWindows.join(","),
				consent.mode,
				consent.keys.join(","),
				consent.saveKeys.join(","),
			].join("|");
		}),
		skipped: skipped.map(skip => `${skip.rule}|${skip.reason}`),
	};
}

interface CodexOptions {
	weeklyUsed?: number;
	primaryUsed?: number;
	creditExpiresInMs?: number;
	credits?: number;
}

function codexReport({
	weeklyUsed = 1,
	primaryUsed = 0.1,
	creditExpiresInMs = 30 * DAY,
	credits = 1,
}: CodexOptions = {}): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: NOW,
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 Hour",
				scope: { provider: "openai-codex", accountId: "acct" },
				window: { id: "5h", label: "5 Hour", resetsAt: NOW + 2 * HOUR },
				amount: { usedFraction: primaryUsed, unit: "percent" },
			},
			{
				id: "openai-codex:secondary",
				label: "Weekly",
				scope: { provider: "openai-codex", accountId: "acct" },
				window: { id: "7d", label: "Weekly", resetsAt: NOW + 3 * DAY },
				amount: { usedFraction: weeklyUsed, unit: "percent" },
			},
		],
		resetCredits: {
			availableCount: credits,
			credits: [
				{ id: "codex-credit", status: "available", expiresAt: new Date(NOW + creditExpiresInMs).toISOString() },
			],
		},
		metadata: {
			accountId: "acct",
			email: "user@example.com",
			resetCreditCredentialId: 1,
			resetCreditActive: true,
			limitReached: true,
		},
	};
}

function codexPlan(
	autoRedeem5h: ResetAutoRedeemMode,
	autoRedeemWeekly: ResetAutoRedeemMode,
	report: UsageReport,
	overrides: Partial<CodexResetPlanInput> = {},
): Partial<Outcome> {
	const modes = resetWindowModes({ autoRedeem5h, autoRedeemWeekly });
	const plan = planCodexResetRedemptions({
		nowMs: NOW,
		trigger: "blocked",
		provider: "openai-codex",
		modelId: "gpt-5.3-codex",
		settings: resetPlanSettings({
			autoRedeem5h,
			autoRedeemWeekly,
			minBlockedMinutes: 60,
			keepCredits: 0,
			salvageHorizonHours: 12,
		}),
		identity: undefined,
		reports: [report],
		attemptedKeys: new Set(),
		deferredUntilByKey: new Map(),
		lastAttemptAtByAccount: new Map(),
		...overrides,
	});
	return planOutcome(plan.actions, plan.skipped, modes);
}

interface ClaudeUsage {
	fiveHourUsed?: number;
	weeklyUsed?: number;
	/** `null` models a reported Fable row with no used fraction at all. */
	fableUsed?: number | null;
	includeFable?: boolean;
	email?: string;
	orgId?: string;
}

function anthropicLimit(
	id: string,
	used: number | null,
	options: { windowId: string; durationMs: number; resetsInMs: number; tier?: string; shared?: boolean },
): UsageLimit {
	return {
		id,
		label: id,
		scope: {
			provider: "anthropic",
			windowId: options.windowId,
			...(options.tier === undefined ? {} : { tier: options.tier }),
			...(options.shared === undefined ? {} : { shared: options.shared }),
		},
		window: { id: options.windowId, label: id, durationMs: options.durationMs, resetsAt: NOW + options.resetsInMs },
		amount: used === null ? { unit: "percent" } : { usedFraction: used, unit: "percent" },
	};
}

function claudeReport({
	fiveHourUsed = 0.4,
	weeklyUsed = 1,
	fableUsed = 0,
	includeFable = true,
	email = "user@example.com",
	orgId = "org-a",
}: ClaudeUsage = {}): UsageReport {
	const limits: UsageLimit[] = [
		anthropicLimit(FIVE_HOUR_ID, fiveHourUsed, {
			windowId: "5h",
			durationMs: 5 * HOUR,
			resetsInMs: 2 * HOUR,
			shared: true,
		}),
		anthropicLimit(WEEKLY_ID, weeklyUsed, {
			windowId: "7d",
			durationMs: WEEK,
			resetsInMs: 3 * DAY,
			shared: true,
		}),
	];
	if (includeFable) {
		limits.push(
			anthropicLimit(FABLE_ID, fableUsed, {
				windowId: "7d",
				durationMs: WEEK,
				resetsInMs: 5 * DAY,
				tier: "fable",
			}),
		);
	}
	return { provider: "anthropic", fetchedAt: NOW, limits, metadata: { email, orgId } };
}

function regularCredit(credit: Partial<UsageResetCredit> = {}): UsageResetCredit {
	return {
		id: "cedar",
		program: "cedar_ember",
		title: "Saved reset",
		remainingCount: 1,
		usable: true,
		requiresLimit: true,
		clears: [FIVE_HOUR_ID, WEEKLY_ID],
		blocking: [WEEKLY_ID],
		usedFractions: { [FIVE_HOUR_ID]: 0.4, [WEEKLY_ID]: 1 },
		status: "available",
		expiresAt: new Date(NOW + 30 * DAY).toISOString(),
		...credit,
	};
}

function juniperCredit(credit: Partial<UsageResetCredit> = {}): UsageResetCredit {
	return regularCredit({
		id: "juniper",
		program: "juniper_tide",
		clears: [FIVE_HOUR_ID],
		blocking: [FIVE_HOUR_ID],
		usedFractions: { [FIVE_HOUR_ID]: 1 },
		...credit,
	});
}

function fableCredit(credit: Partial<UsageResetCredit> = {}): UsageResetCredit {
	return regularCredit({
		id: "fable-launch",
		title: "Fable launch reset",
		clears: [FIVE_HOUR_ID, FABLE_ID],
		blocking: [],
		usedFractions: {},
		...credit,
	});
}

function claudeStatus(
	credit: UsageResetCredit,
	report: UsageReport,
	overrides: Partial<ResetCreditAccountStatus> = {},
): ResetCreditAccountStatus {
	return {
		provider: "anthropic",
		credentialId: 11,
		email: "user@example.com",
		orgId: "org-a",
		active: true,
		availableCount: 1,
		redeemableCount: 1,
		eligible: true,
		nextCreditId: credit.id,
		credits: [credit],
		report,
		...overrides,
	};
}

interface ClaudeOptions {
	trigger?: "blocked" | "sweep";
	modelId?: string;
	activeBlockUnblockAtMs?: number;
}

function claudePlan(
	cfg: {
		autoRedeem5h: ResetAutoRedeemMode;
		autoRedeemWeekly: ResetAutoRedeemMode;
		autoRedeemFable: ResetAutoRedeemMode;
	},
	report: UsageReport,
	status: ResetCreditAccountStatus,
	overrides: ClaudeOptions = {},
): Partial<Outcome> {
	const modes = claudeResetWindowModes(cfg);
	const plan = planClaudeResetRedemptions({
		nowMs: NOW,
		trigger: overrides.trigger ?? "blocked",
		provider: "anthropic",
		modelId: overrides.modelId ?? "claude-sonnet-4-6",
		settings: claudeResetPlanSettings({ ...cfg, minBlockedMinutes: 60, keepCredits: 0, salvageHorizonHours: 12 }),
		reports: [report],
		statuses: [status],
		attemptedKeys: new Set(),
		deferredUntilByKey: new Map(),
		lastAttemptAtByAccount: new Map(),
		activeBlockUnblockAtMs: overrides.activeBlockUnblockAtMs,
	});
	return planOutcome(plan.actions, plan.skipped, modes);
}

function iso(expiresInMs: number): string {
	return new Date(NOW + expiresInMs).toISOString();
}

function claudeVerdict(report: UsageReport, settings: Record<string, string>): Partial<Outcome> {
	const warning = classifyResetExpiry(report, NOW);
	if (!warning) return { warning: false };
	const verdict = resetSpendVerdict(report, warning, Settings.isolated(settings), NOW);
	return {
		warning: true,
		verdict: `${verdict.kind}|${verdict.setting}|${verdict.mode}`,
		warned: warning.creditId ?? "",
	};
}

const codexKey = (window: "5h" | "weekly") => `codexResets.autoRedeem${window === "5h" ? "5h" : "Weekly"}`;
const claudeKey = (window: ResetConsentWindow) =>
	`claudeResets.autoRedeem${window === "5h" ? "5h" : window === "weekly" ? "Weekly" : "Fable"}`;

const rows: { name: string; run: () => Partial<Outcome>; expected: Partial<Outcome> }[] = [
	{
		name: "codex: weekly block, approved weekly window spends",
		run: () => codexPlan("yes", "yes", codexReport()),
		expected: {
			actions: [`openai-codex|-|1|weekly|5h,weekly|yes|${codexKey("weekly")}|${codexKey("weekly")}`],
			skipped: [],
		},
	},
	{
		name: "codex: weekly block with its governing window off is skipped",
		run: () => codexPlan("yes", "no", codexReport()),
		expected: { actions: [], skipped: ["blocked-account|window-disabled", "expiring-credit|no-expiring-credit"] },
	},
	{
		name: "codex: weekly block awaiting consent plans an unset spend",
		run: () => codexPlan("yes", "unset", codexReport()),
		expected: {
			actions: [`openai-codex|-|1|weekly|5h,weekly|unset|${codexKey("weekly")}|${codexKey("weekly")}`],
			skipped: [],
		},
	},
	{
		name: "codex: imminent weekly block consents over both restorable windows but saves only the governing one",
		run: () => codexPlan("unset", "unset", codexReport({ creditExpiresInMs: 4 * MINUTE })),
		expected: {
			actions: [
				`openai-codex|-|1|weekly|5h,weekly|unset|${codexKey("5h")},${codexKey("weekly")}|${codexKey("weekly")}`,
			],
			skipped: [],
		},
	},
	{
		name: "codex: an imminent credit spends on its approved restorable window though its governing window is off",
		run: () => codexPlan("yes", "no", codexReport({ creditExpiresInMs: 4 * MINUTE })),
		expected: {
			actions: [`openai-codex|-|1|weekly|5h,weekly|yes|${codexKey("5h")}|${codexKey("weekly")}`],
			skipped: [],
		},
	},
	{
		name: "codex: an expiring credit salvages the fullest chat window",
		run: () =>
			codexPlan("yes", "yes", codexReport({ weeklyUsed: 0.8, creditExpiresInMs: 2 * HOUR }), { trigger: "sweep" }),
		expected: {
			actions: [`openai-codex|-|1|weekly|5h,weekly|yes|${codexKey("weekly")}|${codexKey("weekly")}`],
			skipped: [],
		},
	},
	{
		name: "codex: every window off disables planning",
		run: () => codexPlan("no", "no", codexReport()),
		expected: { actions: [], skipped: ["account|disabled"] },
	},
	{
		name: "codex: a live-only block within one 5h span asks for the unset window and saves both",
		run: () =>
			codexPlan("yes", "unset", codexReport({ weeklyUsed: 0.5 }), { activeBlockUnblockAtMs: NOW + 2 * HOUR }),
		expected: {
			actions: [`openai-codex|-|1|?|5h,weekly|unset|${codexKey("weekly")}|${codexKey("5h")},${codexKey("weekly")}`],
			skipped: [],
		},
	},
	{
		name: "codex: a live-only block within one 5h span is skipped when either window is off",
		run: () => codexPlan("yes", "no", codexReport({ weeklyUsed: 0.5 }), { activeBlockUnblockAtMs: NOW + 2 * HOUR }),
		expected: { actions: [], skipped: ["blocked-account|window-disabled", "expiring-credit|no-expiring-credit"] },
	},
	{
		name: "claude: a weekly block spends under weekly consent",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "yes", autoRedeemWeekly: "yes", autoRedeemFable: "no" },
				claudeReport(),
				claudeStatus(regularCredit(), claudeReport()),
			),
		expected: {
			actions: [`anthropic|org-a|11|weekly|5h,weekly|yes|${claudeKey("weekly")}|${claudeKey("weekly")}`],
			skipped: [],
		},
	},
	{
		name: "claude: a weekly block with weekly off is skipped",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "yes", autoRedeemWeekly: "no", autoRedeemFable: "no" },
				claudeReport(),
				claudeStatus(regularCredit(), claudeReport()),
			),
		expected: { actions: [], skipped: ["blocked-account|window-disabled", "expiring-credit|no-expiring-credit"] },
	},
	{
		name: "claude: a weekly block awaiting weekly consent plans an unset spend",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "yes", autoRedeemWeekly: "unset", autoRedeemFable: "no" },
				claudeReport(),
				claudeStatus(regularCredit(), claudeReport()),
			),
		expected: {
			actions: [`anthropic|org-a|11|weekly|5h,weekly|unset|${claudeKey("weekly")}|${claudeKey("weekly")}`],
			skipped: [],
		},
	},
	{
		name: "claude: juniper restoring only 5h stays off with weekly consent",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "no", autoRedeemWeekly: "yes", autoRedeemFable: "no" },
				claudeReport({ fiveHourUsed: 1, weeklyUsed: 0.5 }),
				claudeStatus(juniperCredit(), claudeReport({ fiveHourUsed: 1, weeklyUsed: 0.5 })),
			),
		expected: {
			actions: [],
			skipped: ["blocked-account|window-disabled", "expiring-credit|unsupported-program"],
		},
	},
	{
		name: "claude: juniper spends a 5h block under 5h consent",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "yes", autoRedeemWeekly: "no", autoRedeemFable: "no" },
				claudeReport({ fiveHourUsed: 1, weeklyUsed: 0.5 }),
				claudeStatus(juniperCredit(), claudeReport({ fiveHourUsed: 1, weeklyUsed: 0.5 })),
			),
		expected: {
			actions: [`anthropic|org-a|11|5h|5h|yes|${claudeKey("5h")}|${claudeKey("5h")}`],
			skipped: [],
		},
	},
	{
		name: "claude: a two-window block is governed by its weekly window",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "yes", autoRedeemWeekly: "unset", autoRedeemFable: "no" },
				claudeReport({ fiveHourUsed: 1, weeklyUsed: 1 }),
				claudeStatus(regularCredit(), claudeReport({ fiveHourUsed: 1, weeklyUsed: 1 })),
			),
		expected: {
			actions: [`anthropic|org-a|11|weekly|5h,weekly|unset|${claudeKey("weekly")}|${claudeKey("weekly")}`],
			skipped: [],
		},
	},
	{
		name: "claude: a Fable grant spends an exhausted Fable cap under Fable consent",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "no", autoRedeemWeekly: "no", autoRedeemFable: "yes" },
				claudeReport({ fableUsed: 1, weeklyUsed: 0.5 }),
				claudeStatus(fableCredit(), claudeReport({ fableUsed: 1, weeklyUsed: 0.5 })),
				{ modelId: "claude-fable-5" },
			),
		expected: {
			actions: [`anthropic|org-a|11|fable|fable|yes|${claudeKey("fable")}|${claudeKey("fable")}`],
			skipped: [],
		},
	},
	{
		name: "claude: a Fable cap block with the Fable setting off is skipped",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "yes", autoRedeemWeekly: "yes", autoRedeemFable: "no" },
				claudeReport({ fableUsed: 1, weeklyUsed: 0.5 }),
				claudeStatus(fableCredit(), claudeReport({ fableUsed: 1, weeklyUsed: 0.5 })),
				{ modelId: "claude-fable-5" },
			),
		expected: { actions: [], skipped: ["blocked-account|window-disabled", "expiring-credit|no-expiring-credit"] },
	},
	{
		name: "claude: a Fable grant never spends a 5h-only block",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "yes", autoRedeemWeekly: "no", autoRedeemFable: "yes" },
				claudeReport({ fiveHourUsed: 1, weeklyUsed: 0.5, fableUsed: 0.3 }),
				claudeStatus(fableCredit(), claudeReport({ fiveHourUsed: 1, weeklyUsed: 0.5, fableUsed: 0.3 })),
				{ modelId: "claude-fable-5" },
			),
		expected: { actions: [], skipped: ["blocked-account|fable-only", "expiring-credit|no-expiring-credit"] },
	},
	{
		name: "claude: a server-reported Fable blocker is Fable usage without a row or used fraction",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "yes", autoRedeemWeekly: "no", autoRedeemFable: "yes" },
				claudeReport({ includeFable: false, weeklyUsed: 0.5 }),
				claudeStatus(
					fableCredit({ blocking: [FABLE_ID], usedFractions: {} }),
					claudeReport({ includeFable: false, weeklyUsed: 0.5 }),
				),
				{ modelId: "claude-fable-5", activeBlockUnblockAtMs: NOW + 5 * DAY },
			),
		expected: {
			actions: [`anthropic|org-a|11|fable|fable|yes|${claudeKey("fable")}|${claudeKey("fable")}`],
			skipped: [],
		},
	},
	{
		name: "claude: a stale zero Fable row yields to the grant's own used fraction",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "no", autoRedeemWeekly: "no", autoRedeemFable: "yes" },
				claudeReport({ fableUsed: 0, weeklyUsed: 0.5 }),
				claudeStatus(
					fableCredit({ requiresLimit: false, expiresAt: iso(2 * HOUR), usedFractions: { [FABLE_ID]: 0.6 } }),
					claudeReport({ fableUsed: 0, weeklyUsed: 0.5 }),
				),
				{ trigger: "sweep", modelId: "claude-fable-5" },
			),
		expected: {
			actions: [`anthropic|org-a|11|fable|fable|yes|${claudeKey("fable")}|${claudeKey("fable")}`],
			skipped: [],
		},
	},
	{
		name: "claude: an expiring Fable grant salvages from its used fraction when the row is missing",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "yes", autoRedeemWeekly: "no", autoRedeemFable: "yes" },
				claudeReport({ includeFable: false, weeklyUsed: 0.5 }),
				claudeStatus(
					fableCredit({ requiresLimit: false, expiresAt: iso(2 * HOUR), usedFractions: { [FABLE_ID]: 0.6 } }),
					claudeReport({ includeFable: false, weeklyUsed: 0.5 }),
				),
				{ trigger: "sweep", modelId: "claude-fable-5" },
			),
		expected: {
			actions: [`anthropic|org-a|11|fable|fable|yes|${claudeKey("fable")}|${claudeKey("fable")}`],
			skipped: [],
		},
	},
	{
		name: "claude: an expiring Fable grant with no measured usage never spends",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "yes", autoRedeemWeekly: "no", autoRedeemFable: "yes" },
				claudeReport({ includeFable: false, weeklyUsed: 0.5 }),
				claudeStatus(
					fableCredit({ requiresLimit: false, expiresAt: iso(2 * HOUR), usedFractions: {} }),
					claudeReport({ includeFable: false, weeklyUsed: 0.5 }),
				),
				{ trigger: "sweep", modelId: "claude-fable-5" },
			),
		expected: { actions: [], skipped: ["account|no-fable-usage"] },
	},
	{
		name: "claude: an expiring Fable grant with zero Fable usage never spends",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "yes", autoRedeemWeekly: "yes", autoRedeemFable: "yes" },
				claudeReport({ fableUsed: 0, fiveHourUsed: 0.6, weeklyUsed: 0.5 }),
				claudeStatus(
					fableCredit({ requiresLimit: false, expiresAt: iso(30_000), usedFractions: {} }),
					claudeReport({ fableUsed: 0, fiveHourUsed: 0.6, weeklyUsed: 0.5 }),
				),
				{ trigger: "sweep", modelId: "claude-fable-5" },
			),
		expected: { actions: [], skipped: ["account|no-fable-usage"] },
	},
	{
		name: "claude: a Fable grant cannot cover a shared weekly block it does not clear",
		run: () =>
			claudePlan(
				{ autoRedeem5h: "no", autoRedeemWeekly: "no", autoRedeemFable: "yes" },
				claudeReport({ weeklyUsed: 1, fableUsed: 1 }),
				claudeStatus(fableCredit(), claudeReport({ weeklyUsed: 1, fableUsed: 1 })),
				{ modelId: "claude-fable-5" },
			),
		expected: { actions: [], skipped: ["blocked-account|incomplete-coverage", "expiring-credit|no-expiring-credit"] },
	},
	{
		name: "claude: an approved sibling outranks the active account awaiting consent",
		run: () => {
			const cfg = { autoRedeem5h: "yes", autoRedeemWeekly: "unset", autoRedeemFable: "no" } as const;
			const modes = claudeResetWindowModes(cfg);
			const activeReport = claudeReport({ weeklyUsed: 1 });
			const siblingReport = claudeReport({
				fiveHourUsed: 1,
				weeklyUsed: 0.5,
				email: "sibling@example.com",
				orgId: "org-b",
			});
			const plan = planClaudeResetRedemptions({
				nowMs: NOW,
				trigger: "blocked",
				provider: "anthropic",
				modelId: "claude-sonnet-4-6",
				settings: claudeResetPlanSettings({
					...cfg,
					minBlockedMinutes: 60,
					keepCredits: 0,
					salvageHorizonHours: 12,
				}),
				reports: [activeReport, siblingReport],
				statuses: [
					claudeStatus(regularCredit(), activeReport),
					claudeStatus(juniperCredit(), siblingReport, {
						credentialId: 22,
						orgId: "org-b",
						email: "sibling@example.com",
						active: false,
					}),
				],
				attemptedKeys: new Set(),
				deferredUntilByKey: new Map(),
				lastAttemptAtByAccount: new Map(),
			});
			return planOutcome(plan.actions, plan.skipped, modes);
		},
		expected: {
			actions: [`anthropic|org-b|22|5h|5h|yes|${claudeKey("5h")}|${claudeKey("5h")}`],
			skipped: ["expiring-credit|no-expiring-credit"],
		},
	},
	{
		name: "claude: same-expiry grants let the verdict use the warned grant",
		run: () => {
			const base = claudeReport({ fiveHourUsed: 0.1, weeklyUsed: 0.8, fableUsed: 0 });
			const report: UsageReport = {
				...base,
				resetCredits: {
					availableCount: 2,
					redeemableCount: 2,
					eligible: true,
					nextCreditId: "cedar",
					credits: [
						fableCredit({ id: "fable", expiresAt: iso(6 * HOUR), usedFractions: {} }),
						regularCredit({ id: "cedar", expiresAt: iso(6 * HOUR) }),
					],
				},
			};
			return claudeVerdict(report, {
				"claudeResets.autoRedeem5h": "no",
				"claudeResets.autoRedeemWeekly": "yes",
				"claudeResets.autoRedeemFable": "no",
			});
		},
		expected: { warning: true, verdict: `auto|${claudeKey("weekly")}|yes`, warned: "cedar" },
	},
	{
		name: "claude: the verdict warns about Fable usage the grant alone reports",
		run: () => {
			const base = claudeReport({ fiveHourUsed: 0.1, weeklyUsed: 0.2, includeFable: false });
			const report: UsageReport = {
				...base,
				resetCredits: {
					availableCount: 1,
					redeemableCount: 1,
					eligible: true,
					nextCreditId: "fable",
					credits: [fableCredit({ id: "fable", expiresAt: iso(6 * HOUR), usedFractions: { [FABLE_ID]: 0.6 } })],
				},
			};
			return claudeVerdict(report, {
				"claudeResets.autoRedeem5h": "no",
				"claudeResets.autoRedeemWeekly": "no",
				"claudeResets.autoRedeemFable": "yes",
			});
		},
		expected: { warning: true, verdict: `auto|${claudeKey("fable")}|yes`, warned: "fable" },
	},
	{
		name: "claude: a Fable grant with no measured usage never warns",
		run: () => {
			const base = claudeReport({ fiveHourUsed: 0.8, weeklyUsed: 0.9, includeFable: false });
			const report: UsageReport = {
				...base,
				resetCredits: {
					availableCount: 1,
					redeemableCount: 1,
					eligible: true,
					nextCreditId: "fable",
					credits: [fableCredit({ id: "fable", expiresAt: iso(6 * HOUR), usedFractions: {} })],
				},
			};
			return claudeVerdict(report, {
				"claudeResets.autoRedeem5h": "yes",
				"claudeResets.autoRedeemWeekly": "yes",
				"claudeResets.autoRedeemFable": "yes",
			});
		},
		expected: { warning: false },
	},
];

describe("saved-reset grant classification and consent", () => {
	for (const row of rows) {
		it(row.name, () => {
			expect({ actions: [], skipped: [], warning: false, verdict: "", warned: "", ...row.run() }).toEqual({
				actions: [],
				skipped: [],
				warning: false,
				verdict: "",
				warned: "",
				...row.expected,
			});
		});
	}
});
