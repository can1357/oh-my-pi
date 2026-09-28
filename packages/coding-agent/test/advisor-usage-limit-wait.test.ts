/**
 * Contract: `planAdvisorUsageLimitWait` decides whether an advisor waits out a
 * usage-limit credential block and retries, or declines so `AdvisorRuntime`
 * latches its permanent quota state. A regression here re-bricks the advisor on
 * a transient 429 (issue #11947) or, inverted, makes it sleep on a genuine
 * multi-hour quota window instead of pausing.
 */
import { describe, expect, it } from "bun:test";
import { planAdvisorUsageLimitWait } from "@oh-my-pi/pi-coding-agent/session/session-advisors";

const NOW = 1_000_000;
const RETRY = { enabled: true, baseDelayMs: 500, maxDelayMs: 5 * 60 * 1000, maxRetries: 10 };

describe("planAdvisorUsageLimitWait", () => {
	it("waits out a transient block within retry.maxDelayMs and retries", () => {
		// Google 429 whose credential is blocked for ~50s, no sibling, no fallback.
		const waitMs = planAdvisorUsageLimitWait({
			blockedUntilMs: NOW + 50_000,
			retryAfterMs: 50_000,
			retry: RETRY,
			attempt: 0,
			nowMs: NOW,
		});
		expect(waitMs).toBe(50_000);
	});

	it("floors an expired provider wait with the configured retry backoff", () => {
		const waitMs = planAdvisorUsageLimitWait({
			blockedUntilMs: NOW,
			retryAfterMs: 0,
			retry: { ...RETRY, baseDelayMs: 1_000 },
			attempt: 0,
			nowMs: NOW,
		});
		// Shared retry backoff applies 0–25% downward jitter to the 1s base.
		expect(waitMs).toBeGreaterThanOrEqual(750);
		expect(waitMs).toBeLessThanOrEqual(1_000);
	});

	it("uses a complete usage-report reset instead of a longer hintless heuristic block", () => {
		// AuthStorage's hintless fallback is 60s, but the complete usage report
		// says this exhausted window resets in 10s. A 30s cap must permit retry.
		const waitMs = planAdvisorUsageLimitWait({
			blockedUntilMs: NOW + 60_000,
			requestedBlockedUntilMs: NOW + 60_000,
			reportResetAtMs: NOW + 10_000,
			retry: { ...RETRY, maxDelayMs: 30_000 },
			attempt: 0,
			nowMs: NOW,
		});
		expect(waitMs).toBe(10_000);
	});

	it("honors a merged block longer than the current hintless mark", () => {
		// The current mark requested a 60s heuristic and the report says 10s,
		// but credential selection still enforces a shared/persisted 90s block.
		const waitMs = planAdvisorUsageLimitWait({
			blockedUntilMs: NOW + 90_000,
			requestedBlockedUntilMs: NOW + 60_000,
			reportResetAtMs: NOW + 10_000,
			retry: { ...RETRY, maxDelayMs: 120_000 },
			attempt: 0,
			nowMs: NOW,
		});
		expect(waitMs).toBe(90_000);
	});

	it("preserves a prior provider-timed block over a shorter usage-report reset", () => {
		const waitMs = planAdvisorUsageLimitWait({
			blockedUntilMs: NOW + 60_000,
			reportResetAtMs: NOW + 10_000,
			priorBlockedUntilMs: NOW + 40_000,
			priorBlockedUntilTimed: true,
			retry: { ...RETRY, maxDelayMs: 30_000 },
			attempt: 0,
			nowMs: NOW,
		});
		expect(waitMs).toBeUndefined();
	});

	it("declines (latch) when the block outlasts retry.maxDelayMs", () => {
		// A provider-stated 30-minute wait exceeds the 5-minute cap.
		const waitMs = planAdvisorUsageLimitWait({
			retryAfterMs: 30 * 60 * 1000,
			blockedUntilMs: NOW + 30 * 60 * 1000,
			retry: RETRY,
			attempt: 0,
			nowMs: NOW,
		});
		expect(waitMs).toBeUndefined();
	});

	it("declines (latch) once the retry budget is spent", () => {
		const waitMs = planAdvisorUsageLimitWait({
			blockedUntilMs: NOW + 50_000,
			retry: RETRY,
			attempt: RETRY.maxRetries,
			nowMs: NOW,
		});
		expect(waitMs).toBeUndefined();
	});

	it("declines (latch) immediately when maxRetries is 0", () => {
		// maxRetries=0 must mean no retries at all, matching the primary path.
		const waitMs = planAdvisorUsageLimitWait({
			blockedUntilMs: NOW + 50_000,
			retry: { ...RETRY, maxRetries: 0 },
			attempt: 0,
			nowMs: NOW,
		});
		expect(waitMs).toBeUndefined();
	});

	it("declines (latch) when retry is disabled", () => {
		const waitMs = planAdvisorUsageLimitWait({
			blockedUntilMs: NOW + 50_000,
			retry: { ...RETRY, enabled: false },
			attempt: 0,
			nowMs: NOW,
		});
		expect(waitMs).toBeUndefined();
	});

	it("retries as soon as a sibling frees, before the current credential unblocks", () => {
		// Sibling unblocks in 10s (+1s buffer); current provider-timed credential
		// not for 40s — the earliest wins.
		const waitMs = planAdvisorUsageLimitWait({
			retryAtMs: NOW + 10_000,
			retryAfterMs: 40_000,
			blockedUntilMs: NOW + 40_000,
			retry: RETRY,
			attempt: 0,
			nowMs: NOW,
		});
		expect(waitMs).toBe(11_000);
	});

	it("declines (latch) immediately on a hintless heuristic block with no sibling", () => {
		// A permanent 402 balance/spend cap: no retry hint, no complete report,
		// only AuthStorage's 60s default. Waiting on it would retry the dead
		// credential every minute until the budget drains, so decline now.
		const waitMs = planAdvisorUsageLimitWait({
			blockedUntilMs: NOW + 60_000,
			retry: RETRY,
			attempt: 0,
			nowMs: NOW,
		});
		expect(waitMs).toBeUndefined();
	});

	it("waits for a sibling even when the current block is a bare heuristic", () => {
		// The current credential's 60s block is only the heuristic default, but a
		// sibling frees in 5s (+1s buffer) — retry then rather than latch.
		const waitMs = planAdvisorUsageLimitWait({
			blockedUntilMs: NOW + 60_000,
			retryAtMs: NOW + 5_000,
			retry: RETRY,
			attempt: 0,
			nowMs: NOW,
		});
		expect(waitMs).toBe(6_000);
	});

	it("declines (latch) when the error carries no authoritative timing", () => {
		const waitMs = planAdvisorUsageLimitWait({
			retry: RETRY,
			attempt: 0,
			nowMs: NOW,
		});
		expect(waitMs).toBeUndefined();
	});
});
