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
const RETRY = { enabled: true, maxDelayMs: 5 * 60 * 1000, maxRetries: 10 };

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

	it("uses a complete usage-report reset instead of a longer hintless heuristic block", () => {
		// AuthStorage's hintless fallback is 60s, but the complete usage report
		// says this exhausted window resets in 10s. A 30s cap must permit retry.
		const waitMs = planAdvisorUsageLimitWait({
			blockedUntilMs: NOW + 60_000,
			reportResetAtMs: NOW + 10_000,
			retry: { ...RETRY, maxDelayMs: 30_000 },
			attempt: 0,
			nowMs: NOW,
		});
		expect(waitMs).toBe(10_000);
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
		// Genuine 30-minute quota exhaustion exceeds the 5-minute cap.
		const waitMs = planAdvisorUsageLimitWait({
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
		// Sibling unblocks in 10s (+1s buffer); current credential not for 40s.
		const waitMs = planAdvisorUsageLimitWait({
			retryAtMs: NOW + 10_000,
			blockedUntilMs: NOW + 40_000,
			retry: RETRY,
			attempt: 0,
			nowMs: NOW,
		});
		expect(waitMs).toBe(11_000);
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
