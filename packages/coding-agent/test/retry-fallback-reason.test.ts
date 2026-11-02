import { expect, test, vi } from "bun:test";
import { describeUsageFallback } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-reason";

test("does not describe plan-ineligible accounts as exhausted quota", () => {
	// Health drops plan-ineligible accounts before computing the depleted state.
	const reason = describeUsageFallback({ state: "depleted", accounts: [] }, 30);
	expect(reason).toMatch(/eligible.*plan/);
	expect(reason).not.toMatch(/quota-exhausted|temporarily blocked/);
});

test("reports the earliest future reset instead of an expired or invalid account reset", () => {
	const now = 1_900_000_000_000;
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	try {
		const reason = describeUsageFallback(
			{
				state: "depleted",
				accounts: [now - 60_000, Infinity, NaN, now + 120_000, now + 60_000].map((resetsAt, credentialId) => ({
					credentialId,
					credentialType: "oauth",
					state: "depleted",
					resetsAt,
				})),
			},
			30,
		);
		expect(reason).toMatch(/reset in 1m\b/);
		expect(reason).not.toMatch(/2m|0ms|NaN|Infinity/);
	} finally {
		clock.mockRestore();
	}
});
