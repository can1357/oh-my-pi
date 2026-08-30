import type { DisabledCredentialSummary, UsageReport } from "@oh-my-pi/pi-ai";
import type { UsageAccountIdentity } from "@oh-my-pi/pi-coding-agent/usage/usage-breakdown";

export const USAGE_FIXTURE_NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const FIVE_HOURS = 5 * HOUR;
const SEVEN_DAYS = 7 * 24 * HOUR;

function limit(id: string, usedFraction: number, durationMs: number, windowId: string, resetsAt?: number) {
	return {
		id,
		label: id,
		scope: { provider: "anthropic", windowId },
		window: { id: windowId, label: windowId, durationMs, ...(resetsAt === undefined ? {} : { resetsAt }) },
		amount: { unit: "percent", usedFraction },
	} satisfies UsageReport["limits"][number];
}

export const USAGE_FIXTURE_REPORTS: UsageReport[] = [
	{
		provider: "anthropic",
		fetchedAt: USAGE_FIXTURE_NOW,
		metadata: { email: "active@example.test" },
		limits: [
			limit("Claude 5 Hour", 0.25, FIVE_HOURS, "5h", USAGE_FIXTURE_NOW + HOUR),
			limit("Claude 7 Day", 0.4, SEVEN_DAYS, "7d"),
		],
	},
	{
		provider: "anthropic",
		fetchedAt: USAGE_FIXTURE_NOW,
		metadata: { email: "sibling@example.test" },
		limits: [limit("Claude 5 Hour", 0.5, FIVE_HOURS, "5h")],
	},
];

export const USAGE_FIXTURE_ACCOUNTS: UsageAccountIdentity[] = [
	{ provider: "anthropic", type: "oauth", email: "active@example.test" },
	{ provider: "anthropic", type: "oauth", email: "sibling@example.test" },
];

export const USAGE_FIXTURE_DISABLED: DisabledCredentialSummary[] = [
	{
		id: 41,
		provider: "anthropic",
		type: "oauth",
		email: "disabled@example.test",
		cause: "oauth refresh failed: token expired",
		disabledAtMs: USAGE_FIXTURE_NOW - HOUR,
	},
];

export const USAGE_FIXTURE_MODEL_SELECTORS = ["anthropic/claude-sonnet-4-6"] as const;
export const USAGE_FIXTURE_CONTEXT_LINES = [
	"  in use by this session: active@example.test",
	"  Models with usage data",
	"    anthropic/claude-sonnet-4-6",
] as const;

export const EXPECTED_USAGE_BREAKDOWN = `Usage · fetched 0ms ago

Anthropic — 2 accounts
  ● active@example.test
      ● Claude 5 Hour (5h)  ███████░░░░░░░░░░░░░░░░░░░░░  25.0% used · resets in 1h
      ● Claude 7 Day (7d)   ███████████░░░░░░░░░░░░░░░░░  40.0% used
  ● sibling@example.test
      ● Claude 5 Hour (5h)  ██████████████░░░░░░░░░░░░░░  50.0% used
      ○ Claude 7 Day (7d)   ····························  not reported
  ✗ disabled@example.test — disabled 1h ago: token expired (re-login to restore)
  capacity: 5h → 0.75/2 accounts used (1.25× quota left) · 7d → 0.40/1 account used (0.60× quota left)`;
