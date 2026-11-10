import { describe, expect, it } from "bun:test";
import type { UsageLimit, UsageReport, UsageResetCredit } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { actionConsent, classifyResetGrant } from "@oh-my-pi/pi-coding-agent/session/reset-consent";
import { classifyResetExpiry, resetSpendVerdict } from "@oh-my-pi/pi-coding-agent/session/reset-expiry";
import type { ResetAutoRedeemMode } from "@oh-my-pi/pi-coding-agent/session/settings";

const NOW = 1_700_000_040_000;
const HOUR = 3_600_000;
const FIVE_HOUR = "anthropic:5h";
const WEEKLY = "anthropic:7d";
const FABLE = "anthropic:7d:fable";
const KEY_5H = "codexResets.autoRedeem5h";
const KEY_WEEKLY = "codexResets.autoRedeemWeekly";

describe("actionConsent", () => {
	it.each<{
		name: string;
		window?: "5h" | "weekly";
		expiresInMs?: number;
		modes: Record<"5h" | "weekly", ResetAutoRedeemMode>;
		expected: { mode: ResetAutoRedeemMode; keys?: string[]; saveKeys?: string[] };
	}>([
		{
			name: "the governing window alone decides an ordinary spend",
			window: "weekly",
			modes: { "5h": "yes", weekly: "no" },
			expected: { mode: "no" },
		},
		{
			name: "an unknown window needs every window, and the answer is saved to both",
			modes: { "5h": "yes", weekly: "unset" },
			expected: { mode: "unset", keys: [KEY_WEEKLY], saveKeys: [KEY_5H, KEY_WEEKLY] },
		},
		{
			name: "an unknown window is refused when either window is off",
			modes: { "5h": "yes", weekly: "no" },
			expected: { mode: "no" },
		},
		{
			name: "a credit about to expire needs one restorable window, but saves only to the governing one",
			window: "weekly",
			expiresInMs: 4 * 60_000,
			modes: { "5h": "yes", weekly: "unset" },
			expected: { mode: "yes", keys: [KEY_5H], saveKeys: [KEY_WEEKLY] },
		},
	])("$name", ({ window, expiresInMs, modes, expected }) => {
		const action = {
			target: { provider: "openai-codex" },
			window,
			restorableWindows: ["5h", "weekly"] as const,
			expiresInMs,
		};
		expect(actionConsent(action, modes)).toMatchObject(expected);
	});
});

function limit(id: string, used: number): UsageLimit {
	return {
		id,
		label: id,
		scope: {
			provider: "anthropic",
			windowId: id === FIVE_HOUR ? "5h" : "7d",
			...(id === FABLE ? { tier: "fable" } : {}),
		},
		window: { id: id === FIVE_HOUR ? "5h" : "7d", label: id, resetsAt: NOW + 3 * 24 * HOUR },
		amount: { usedFraction: used, unit: "percent" },
	};
}

function claudeReport(used: Record<string, number>, credits: UsageResetCredit[] = []): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: NOW,
		limits: Object.entries(used).map(([id, fraction]) => limit(id, fraction)),
		resetCredits: {
			availableCount: credits.length,
			redeemableCount: credits.length,
			eligible: true,
			nextCreditId: credits[0]?.id,
			credits,
		},
	};
}

function credit(overrides: Partial<UsageResetCredit>): UsageResetCredit {
	return {
		id: "cedar",
		program: "cedar_ember",
		remainingCount: 1,
		usable: true,
		requiresLimit: true,
		clears: [FIVE_HOUR, WEEKLY],
		blocking: [],
		usedFractions: {},
		status: "available",
		...overrides,
	};
}

describe("classifyResetGrant", () => {
	it("restores only the 5h window for a Juniper grant, whatever it clears", () => {
		const grant = classifyResetGrant(
			credit({ program: "juniper_tide" }),
			claudeReport({ [FIVE_HOUR]: 1, [WEEKLY]: 1 }),
		);
		expect(grant).toMatchObject({ kind: "juniper", restorableWindows: ["5h"], fullest: { window: "5h", used: 1 } });
	});

	it.each<{ name: string; used: Record<string, number>; overrides: Partial<UsageResetCredit>; fable?: number }>([
		{ name: "the report row", used: { [FABLE]: 0.6 }, overrides: {}, fable: 0.6 },
		{
			name: "the grant's fraction over a stale zero row",
			used: { [FABLE]: 0 },
			overrides: { usedFractions: { [FABLE]: 0.6 } },
			fable: 0.6,
		},
		{ name: "a server blocker without any row", used: {}, overrides: { blocking: [FABLE] }, fable: 1 },
		{ name: "nothing at all", used: {}, overrides: {}, fable: undefined },
	])("measures a Fable grant on its Fable cap alone from $name", ({ used, overrides, fable }) => {
		const grant = classifyResetGrant(
			credit({ clears: [FIVE_HOUR, FABLE], ...overrides }),
			claudeReport({ [FIVE_HOUR]: 0.9, ...used }),
		);
		expect(grant.kind).toBe("fable");
		expect(grant.restorableWindows).toEqual(["fable"]);
		expect(grant.fullest?.used).toBe(fable);
	});
});

it("judges an expiry warning by the warned grant, not another grant expiring at the same moment", () => {
	const expiresAt = new Date(NOW + 6 * HOUR).toISOString();
	const report = claudeReport({ [FIVE_HOUR]: 0.1, [WEEKLY]: 0.8, [FABLE]: 0 }, [
		credit({ id: "fable", clears: [FIVE_HOUR, FABLE], expiresAt }),
		credit({ id: "cedar", expiresAt }),
	]);
	report.resetCredits!.nextCreditId = "cedar";
	const warning = classifyResetExpiry(report, NOW);
	expect(warning?.creditId).toBe("cedar");
	const settings = Settings.isolated({
		"claudeResets.autoRedeem5h": "no",
		"claudeResets.autoRedeemWeekly": "yes",
		"claudeResets.autoRedeemFable": "no",
	});
	expect(resetSpendVerdict(report, warning!, settings, NOW)).toMatchObject({
		kind: "auto",
		setting: "claudeResets.autoRedeemWeekly",
	});
});
