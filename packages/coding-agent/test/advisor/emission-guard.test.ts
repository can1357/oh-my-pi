import { describe, expect, it } from "bun:test";
import { AdvisorEmissionGuard, normalizeAdvisorNote } from "../../src/advisor/emission-guard";

describe("normalizeAdvisorNote", () => {
	it("collapses punctuation, casing, and surrounding whitespace into one canonical key", () => {
		// The reporter's three top duplicates all key to the same canonical form
		// regardless of trailing punctuation or casing — that's what makes the
		// dedupe + suppression checks single-membership.
		expect(normalizeAdvisorNote("Stop.")).toBe("stop");
		expect(normalizeAdvisorNote("  STOP!  ")).toBe("stop");
		expect(normalizeAdvisorNote("*Stop*")).toBe("stop");
		expect(normalizeAdvisorNote("Done.")).toBe("done");
		expect(normalizeAdvisorNote("No issue; continue.")).toBe("no issue continue");
	});

	it("returns empty string for whitespace-only input so callers can short-circuit", () => {
		expect(normalizeAdvisorNote("")).toBe("");
		expect(normalizeAdvisorNote("   ")).toBe("");
		expect(normalizeAdvisorNote("...")).toBe("");
	});

	it("preserves internal letters/digits but folds non-alphanumeric runs to one space", () => {
		expect(normalizeAdvisorNote("Refactor `auth-flow.ts`: drop legacy branch.")).toBe(
			"refactor auth flow ts drop legacy branch",
		);
	});
});

describe("AdvisorEmissionGuard", () => {
	it("drops the exact content-free filler the reporter observed flooding the chat", () => {
		// Issue #3520: 114× "Stop.", 52× "No issue; continue.", 41× "Done." —
		// none of these carry a concrete reason and they cannot be acted on, so
		// the guard suppresses them regardless of severity.
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("Stop.")).toBe("suppressed_noise");
		expect(guard.accept("Done.")).toBe("suppressed_noise");
		expect(guard.accept("No issue; continue.")).toBe("suppressed_noise");
		expect(guard.accept("LGTM")).toBe("suppressed_noise");
		expect(guard.accept("No further watcher input needed.")).toBe("suppressed_noise");
	});

	it("dedupes by normalized text across the session, ignoring casing and trailing punctuation", () => {
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("Move retries into the queue, not the request path.")).toBe("accepted");
		// Same advice with different casing and trailing punctuation must NOT
		// land twice in the primary transcript.
		expect(guard.accept("move retries into the queue, not the request path")).toBe("duplicate");
		expect(guard.accept("Move retries into the queue, not the request path!")).toBe("duplicate");
	});

	it("rate-limits to one accepted advise per advisor update cycle", () => {
		// The advisor system prompt says "at most one `advise` per update". Real
		// models violate this; the guard enforces it at the boundary so the
		// primary transcript never receives two advisories from one model cycle.
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("First concern: missing await in #handleRetry.")).toBe("accepted");
		expect(guard.accept("Second concern: wrong env var name.")).toBe("rate_limited");
		guard.beginUpdate();
		// New cycle: budget reset.
		expect(guard.accept("Second concern: wrong env var name.")).toBe("accepted");
	});

	it("exempts blockers from the per-update budget so they always interrupt", () => {
		// A nit emitted first in an update must never rate-limit a blocker that
		// follows it: blockers are the always-interrupt severity. Noise and dedupe
		// still apply to blockers.
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("Minor naming nit.", "nit")).toBe("accepted");
		expect(guard.accept("Destructive migration will drop user data.", "blocker")).toBe("accepted");
		// A repeat blocker is still deduped, not waved through by the exemption.
		expect(guard.accept("Destructive migration will drop user data.", "blocker")).toBe("duplicate");
		expect(guard.accept("Stop.", "blocker")).toBe("suppressed_noise");
	});

	it("does not let a suppressed call consume the per-update budget", () => {
		// A noise call like "Stop." must never displace a real concern that
		// follows in the same advisor model cycle.
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("Stop.")).toBe("suppressed_noise");
		expect(guard.accept("Concrete: read race in #handleRetry.")).toBe("accepted");
	});

	it("does not let a deduped call consume the per-update budget", () => {
		// A repeat of a prior session note is dropped, but the model can still
		// follow it with a fresh concrete concern in the same cycle.
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("Concrete: read race in #handleRetry.")).toBe("accepted");
		guard.beginUpdate();
		expect(guard.accept("Concrete: read race in #handleRetry.")).toBe("duplicate");
		expect(guard.accept("New concern: cache eviction never fires.")).toBe("accepted");
	});

	it("reset clears dedupe and the per-update gate so a re-primed advisor can re-raise old issues", () => {
		// Compaction / session-switch rewrites the primary transcript. The
		// advisor is re-primed from scratch and may legitimately re-raise the
		// same concerns — they're new context for a freshly-primed reviewer.
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("Race in #handleRetry.")).toBe("accepted");
		expect(guard.accept("Race in #handleRetry.")).toBe("duplicate");
		guard.reset();
		expect(guard.accept("Race in #handleRetry.")).toBe("accepted");
	});

	it("evicts oldest entries when dedupe history exceeds capacity", () => {
		// Bounded so very long sessions cannot grow the dedupe state without
		// bound. Pre-eviction unique notes are remembered; post-eviction the
		// oldest one is forgotten and can resurface.
		const guard = new AdvisorEmissionGuard({ capacity: 3 });
		expect(guard.accept("first")).toBe("accepted");
		guard.beginUpdate();
		expect(guard.accept("second")).toBe("accepted");
		guard.beginUpdate();
		expect(guard.accept("third")).toBe("accepted");
		guard.beginUpdate();
		// "first" still in history.
		expect(guard.accept("first")).toBe("duplicate");
		guard.beginUpdate();
		// Fourth unique entry evicts "first".
		expect(guard.accept("fourth")).toBe("accepted");
		guard.beginUpdate();
		expect(guard.accept("first")).toBe("accepted");
	});

	it("rejects empty / whitespace-only notes without consuming the budget", () => {
		const guard = new AdvisorEmissionGuard();
		expect(guard.accept("")).toBe("suppressed_noise");
		expect(guard.accept("   ")).toBe("suppressed_noise");
		expect(guard.accept("Concrete advice.")).toBe("accepted");
	});

	it("end-to-end: the reporter's 309-call spam log produces ≤1 accepted note across many updates", () => {
		// Mimic the issue's distribution: 114× "Stop.", 52× "No issue; continue.",
		// 41× "Done.", plus 102 copies of one concrete-but-repeated nit. Spread
		// the calls across 50 advisor update cycles. Each cycle is allowed at
		// most one accepted note, and identical-text repeats never escape the
		// guard. After all calls, exactly the concrete nit has been accepted
		// — and only once.
		const guard = new AdvisorEmissionGuard();
		const accepted: string[] = [];
		const stream: string[] = [
			...Array(114).fill("Stop."),
			...Array(52).fill("No issue; continue."),
			...Array(41).fill("Done."),
			...Array(102).fill("Concrete-but-repeated nit: x"),
		];
		// Interleave across 50 update cycles.
		const cycles = 50;
		const perCycle = Math.ceil(stream.length / cycles);
		for (let c = 0; c < cycles; c++) {
			guard.beginUpdate();
			for (let i = 0; i < perCycle; i++) {
				const note = stream[c * perCycle + i];
				if (note === undefined) break;
				if (guard.accept(note) === "accepted") accepted.push(note);
			}
		}
		expect(accepted).toEqual(["Concrete-but-repeated nit: x"]);
	});
});
