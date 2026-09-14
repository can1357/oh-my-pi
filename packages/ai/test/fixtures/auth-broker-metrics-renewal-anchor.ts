import { nextRenewalSeconds, renderUsageMetrics } from "@oh-my-pi/pi-ai/auth-broker/prometheus-metrics";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";

// A scrape whose subscription lookup returns a non-representable renewal anchor.
// `SubscriptionLookup` is an interface an embedder implements, so `renewsAtSeconds`
// is only nominally a number — `NaN`, `±Infinity`, and out-of-`Date`-range
// magnitudes all reach the renderer. Run out-of-process: the pre-fix renderer
// searched forward month-by-month for a candidate `>= now`, and with a NaN
// anchor every comparison is false, so the scrape never returns and the event
// loop is wedged. An in-process assertion could only hang the whole test file;
// out-of-process, the parent's timeout turns the wedge into a failure.
const report: UsageReport = {
	provider: "anthropic",
	fetchedAt: 1_700_000_000_000,
	metadata: { accountId: "acct-claude-1", email: "a@example.com" },
	limits: [
		{
			id: "anthropic:5h",
			label: "Claude 5 Hour",
			scope: { provider: "anthropic", windowId: "5h" },
			amount: { usedFraction: 0.42, unit: "percent" },
			status: "ok",
		},
	],
};

const anchors: ReadonlyArray<readonly [string, number]> = [
	["nan", Number.NaN],
	["infinity", Number.POSITIVE_INFINITY],
	["negative-infinity", Number.NEGATIVE_INFINITY],
	// Finite, but 8.64e15 ms is the whole `Date` range, so this is an Invalid Date.
	["out-of-range", 1e15],
];

const renewalLines: Record<string, string[]> = {};
for (const [name, renewsAtSeconds] of anchors) {
	const out = renderUsageMetrics([report], {
		subscriptions: { lookup: () => ({ plan: "max_20x", renewsAtSeconds }), plans: [] },
		now: () => Date.UTC(2026, 7, 5),
	});
	renewalLines[name] = out.split("\n").filter(line => line.startsWith("llm_subscription_renews_at_seconds{"));
	// The rest of the scrape must still render: one bad anchor drops its own
	// gauge, never the account's usage series.
	if (!out.includes('llm_subscription_info{provider="anthropic"')) {
		throw new Error(`${name}: subscription info series was lost`);
	}
	if (!out.includes('llm_usage_limit_used_fraction{provider="anthropic"')) {
		throw new Error(`${name}: usage series was lost`);
	}
}

// `nextRenewalSeconds` is probed here too, not in-process: it is the function
// that actually searches, so a regression hangs on the FIRST call and the
// in-process arms would never reach this subprocess at all. A bad clock is the
// symmetric case and must not wedge either.
const goodAnchor = Date.UTC(2026, 0, 15) / 1000;
const nowSec = Date.UTC(2026, 7, 5) / 1000;
const direct: Array<readonly [string, number, number]> = [
	["anchor-nan", Number.NaN, nowSec],
	["anchor-infinity", Number.POSITIVE_INFINITY, nowSec],
	["anchor-negative-infinity", Number.NEGATIVE_INFINITY, nowSec],
	["anchor-out-of-range", 1e15, nowSec],
	["anchor-negative-out-of-range", -1e15, nowSec],
	["now-nan", goodAnchor, Number.NaN],
	["now-out-of-range", goodAnchor, 1e15],
];
for (const [name, anchor, now] of direct) {
	const result = nextRenewalSeconds(anchor, now);
	if (result !== undefined) throw new Error(`${name}: expected no renewal, got ${result}`);
}
// A representable pair must still resolve, so "returns undefined" cannot pass
// by refusing every input.
if (nextRenewalSeconds(goodAnchor, nowSec) !== Date.UTC(2026, 7, 15) / 1000) {
	throw new Error("a representable anchor must still roll forward");
}

process.stdout.write(`${JSON.stringify(renewalLines)}\n`);
