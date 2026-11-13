/**
 * Behavioral coverage for the durable one-shot wakeup state machine: input
 * bounds, quota, conditional baselines and polling, cancellation durability,
 * in-flight races, and exact-owner suspend/resume against both a scripted
 * journal and a real persisted SessionManager.
 *
 * Time is driven through the host's injected clock and timer seam; tests wait
 * on observable state (deliveries, check invocations, journal entries) by
 * yielding event-loop turns, never on wall-clock sleeps.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	MAX_WAKEUPS,
	validateWakeupInput,
	WAKEUP_CHECK_TIMEOUT_MS,
	WAKEUP_ENTRY_TYPE,
	type WakeupCheckResult,
	type WakeupDelivery,
	type WakeupHost,
	type WakeupInput,
	WakeupManager,
	type WakeupReason,
	type WakeupRecord,
} from "@oh-my-pi/pi-coding-agent/async/wakeup-manager";
import type { CustomEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

type Journal = WakeupHost["journal"];

const START = 1_700_000_000_000;
const ok = (hash: string): WakeupCheckResult => ({ hash, exitCode: 0 });

function nextTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await nextTurn();
	}
}

/** Drain queued promise chains and journal writes before a negative assertion. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await nextTurn();
}

interface FakeTimer {
	at: number;
	callback: () => void;
}

/** Injected wall clock and timer queue; timers fire only when a test advances time. */
class FakeClock {
	now = START;
	readonly #timers = new Set<FakeTimer>();

	setTimer = (callback: () => void, delayMs: number): unknown => {
		const timer: FakeTimer = { at: this.now + delayMs, callback };
		this.#timers.add(timer);
		return timer;
	};

	clearTimer = (timer: unknown): void => {
		this.#timers.delete(timer as FakeTimer);
	};

	get pending(): number {
		return this.#timers.size;
	}

	advance(ms: number): void {
		this.now += ms;
		for (;;) {
			const due = [...this.#timers].filter(timer => timer.at <= this.now).sort((a, b) => a.at - b.at)[0];
			if (!due) return;
			this.#timers.delete(due);
			due.callback();
		}
	}
}

/** Scripted journal whose flushes can be held open or failed to expose ordering. */
class FakeJournal {
	sessionId = `session-${Bun.randomUUIDv7()}`;
	flushError: Error | undefined;
	onFlush: (() => void) | undefined;
	leaseError: Error | undefined;
	onClaim: (() => void) | undefined;
	onRefresh: (() => Promise<void>) | undefined;
	readonly entries: SessionEntry[] = [];
	readonly #events: string[];
	#gate: PromiseWithResolvers<void> | undefined;

	constructor(events: string[]) {
		this.#events = events;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getEntries(): SessionEntry[] {
		return [...this.entries];
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const id = `entry-${this.entries.length + 1}`;
		const entry: CustomEntry = {
			type: "custom",
			id,
			parentId: this.entries.at(-1)?.id ?? null,
			timestamp: new Date(0).toISOString(),
			customType,
			data: structuredClone(data),
		};
		this.entries.push(entry);
		if (customType === WAKEUP_ENTRY_TYPE) this.#events.push(`append:${(data as WakeupRecord).state}`);
		return id;
	}

	async ensureOnDisk(): Promise<void> {}

	async flush(): Promise<void> {
		const gate = this.#gate;
		if (gate) await gate.promise;
		const hook = this.onFlush;
		this.onFlush = undefined;
		hook?.();
		if (this.flushError) throw this.flushError;
		this.#events.push("flushed");
	}

	hold(): void {
		this.#gate = Promise.withResolvers<void>();
	}

	release(): void {
		const gate = this.#gate;
		this.#gate = undefined;
		gate?.resolve();
	}
}

interface CheckCall {
	command: string;
	cwd: string;
	timeoutMs: number;
	signal: AbortSignal;
	result: PromiseWithResolvers<WakeupCheckResult>;
}

class Harness {
	readonly clock = new FakeClock();
	readonly events: string[] = [];
	readonly checks: CheckCall[] = [];
	readonly deliveries: WakeupDelivery[] = [];
	enabled = true;
	#taken = 0;
	readonly #managers: WakeupManager[] = [];

	journal(): FakeJournal {
		return new FakeJournal(this.events);
	}

	manager(journal: Journal, cwd = "/work/project"): WakeupManager {
		const manager = new WakeupManager({
			journal,
			cwd: () => cwd,
			enabled: () => this.enabled,
			claimOwnership: () => {
				this.events.push("leased");
				if (journal instanceof FakeJournal) {
					const hook = journal.onClaim;
					journal.onClaim = undefined;
					hook?.();
					if (journal.leaseError) throw journal.leaseError;
				}
				return () => {};
			},
			refreshJournal: async () => {
				if (journal instanceof FakeJournal) await journal.onRefresh?.();
			},
			check: (command, checkCwd, timeoutMs, signal) => {
				const result = Promise.withResolvers<WakeupCheckResult>();
				this.checks.push({ command, cwd: checkCwd, timeoutMs, signal, result });
				this.events.push("check");
				return result.promise;
			},
			deliver: async delivery => {
				this.events.push(`deliver:${delivery.reason}`);
				this.deliveries.push(delivery);
			},
			now: () => this.clock.now,
			setTimer: this.clock.setTimer,
			clearTimer: this.clock.clearTimer,
		});
		this.#managers.push(manager);
		return manager;
	}

	/** The next check invocation not yet handed to the test, left unresolved. */
	async nextCheck(): Promise<CheckCall> {
		const index = this.#taken++;
		await waitFor(() => this.checks.length > index, `check invocation #${index + 1}`);
		return this.checks[index];
	}

	async answer(result: WakeupCheckResult | Error): Promise<CheckCall> {
		const call = await this.nextCheck();
		if (result instanceof Error) call.result.reject(result);
		else call.result.resolve(result);
		return call;
	}

	teardown(): void {
		for (const manager of this.#managers) manager.suspend();
	}
}

function wakeupStates(journal: Journal, id?: string): WakeupRecord[] {
	return journal.getEntries().flatMap(entry => {
		if (entry.type !== "custom" || entry.customType !== WAKEUP_ENTRY_TYPE) return [];
		const record = entry.data as WakeupRecord;
		return id === undefined || record.id === id ? [record] : [];
	});
}

function conditional(delaySeconds: number, maxWaitSeconds: number, command = "git status --porcelain"): WakeupInput {
	return { delaySeconds, prompt: "Check whether the working tree changed", check: { command, maxWaitSeconds } };
}

/** A well-formed overdue journal record, as a previous process would have written it. */
function fixtureRecord(owner: string, overrides: Partial<WakeupRecord> = {}): WakeupRecord {
	return {
		version: 1,
		id: `wake_${Bun.randomUUIDv7().replaceAll("-", "")}`,
		owner,
		cwd: "/work/project",
		createdAt: START - 120_000,
		dueAt: START - 60_000,
		delaySeconds: 60,
		prompt: "Restored",
		state: "scheduled",
		...overrides,
	};
}

let currentHarness: Harness | undefined;
const sessions: SessionManager[] = [];

afterEach(async () => {
	currentHarness?.teardown();
	currentHarness = undefined;
	await Promise.all(sessions.splice(0).map(session => session.close()));
});

function setup(): Harness {
	const harness = new Harness();
	currentHarness = harness;
	return harness;
}

async function activeManager(harness: Harness): Promise<{ journal: FakeJournal; manager: WakeupManager }> {
	const journal = harness.journal();
	const manager = harness.manager(journal);
	await manager.activate();
	return { journal, manager };
}

async function scheduleConditional(
	harness: Harness,
	manager: WakeupManager,
	input: WakeupInput,
	baseline: WakeupCheckResult = ok("baseline"),
): Promise<WakeupRecord> {
	const scheduled = manager.schedule(input);
	await harness.answer(baseline);
	return scheduled;
}

describe("wakeup input bounds", () => {
	it("rejects out-of-range, fractional, non-finite, and oversized input before any shell or durable record", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const base = { delaySeconds: 60, prompt: "Check the deploy" };
		const command = "git status";
		const invalid: unknown[] = [
			{ ...base, delaySeconds: 0 },
			{ ...base, delaySeconds: 86_401 },
			{ ...base, delaySeconds: 1.5 },
			{ ...base, delaySeconds: Number.NaN },
			{ ...base, delaySeconds: Number.POSITIVE_INFINITY },
			{ ...base, delaySeconds: "60" },
			{ ...base, prompt: "" },
			{ ...base, prompt: " \n\t " },
			{ ...base, prompt: "x".repeat(8_001) },
			{ ...base, prompt: 42 },
			{ ...base, check: { command: "", maxWaitSeconds: 60 } },
			{ ...base, check: { command: "   ", maxWaitSeconds: 60 } },
			{ ...base, check: { command: "x".repeat(4_001), maxWaitSeconds: 60 } },
			{ ...base, check: { command, maxWaitSeconds: 59 } },
			{ ...base, check: { command, maxWaitSeconds: 86_401 } },
			{ ...base, check: { command, maxWaitSeconds: 90.5 } },
			{ ...base, check: { command, maxWaitSeconds: Number.NaN } },
		];
		for (const input of invalid) {
			expect(() => validateWakeupInput(input as WakeupInput)).toThrow();
			await expect(manager.schedule(input as WakeupInput)).rejects.toThrow();
		}
		expect(h.checks).toHaveLength(0);
		expect(wakeupStates(journal)).toEqual([]);
		expect(h.clock.pending).toBe(0);
	});

	it("accepts every inclusive boundary and persists only canonical fields", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const shortest = await manager.schedule({
			delaySeconds: 1,
			prompt: "x".repeat(8_000),
			injected: "not part of the contract",
		} as WakeupInput);
		const longest = await manager.schedule({ delaySeconds: 86_400, prompt: "Check tomorrow" });
		const tight = await scheduleConditional(h, manager, conditional(30, 30, "x".repeat(4_000)));
		const widest = await scheduleConditional(h, manager, conditional(30, 86_400));

		expect(shortest.dueAt).toBe(START + 1_000);
		expect(longest.dueAt).toBe(START + 86_400_000);
		expect(tight.deadline).toBe(tight.dueAt);
		expect(widest.deadline).toBe(START + 86_400_000);
		expect(h.clock.pending).toBe(4);
		expect(Object.keys(shortest)).not.toContain("injected");
		expect(Object.keys(wakeupStates(journal, shortest.id)[0])).not.toContain("injected");
	});
});

describe("one-shot delivery", () => {
	it("fires exactly once at the due time, after the claim is flushed", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const record = await manager.schedule({ delaySeconds: 60, prompt: "Check CI" });
		expect(wakeupStates(journal, record.id).map(state => state.state)).toEqual(["scheduled"]);

		h.clock.advance(59_999);
		await settle();
		expect(h.deliveries).toHaveLength(0);

		h.clock.advance(1);
		await waitFor(() => h.deliveries.length === 1, "delivery");
		const [delivery] = h.deliveries;
		expect(delivery.reason).toBe("delay");
		expect(delivery.record).toMatchObject({ id: record.id, state: "claimed", reason: "delay", prompt: "Check CI" });
		expect(h.events.slice(h.events.lastIndexOf("append:claimed"))).toEqual([
			"append:claimed",
			"flushed",
			"deliver:delay",
		]);
		expect(manager.isCurrent(delivery)).toBe(true);

		h.clock.advance(86_400_000);
		await settle();
		expect(h.deliveries).toHaveLength(1);
		expect(h.clock.pending).toBe(0);
		expect(wakeupStates(journal, record.id).map(state => state.state)).toEqual(["scheduled", "claimed"]);
	});
});

describe("wakeup quota", () => {
	it("reserves a slot while a baseline runs and releases it when the baseline is denied", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const pending = Array.from({ length: MAX_WAKEUPS }, () => manager.schedule(conditional(60, 600)));
		const first = await h.nextCheck();
		await settle();
		// Baselines run serially, yet all eight reserved capacity before running.
		expect(h.checks).toHaveLength(1);
		await expect(manager.schedule({ delaySeconds: 60, prompt: "One too many" })).rejects.toThrow(/quota/i);
		expect(h.checks).toHaveLength(1);

		first.result.reject(new Error("approval denied"));
		await expect(pending[0]).rejects.toThrow("approval denied");
		const accepted = await manager.schedule({ delaySeconds: 60, prompt: "Freed slot" });
		expect(accepted.state).toBe("scheduled");

		for (let i = 1; i < MAX_WAKEUPS; i++) await h.answer(ok(`baseline-${i}`));
		const scheduled = await Promise.all(pending.slice(1));
		await expect(manager.schedule({ delaySeconds: 60, prompt: "Full again" })).rejects.toThrow(/quota/i);

		const durable = wakeupStates(journal);
		expect(durable.map(state => state.state)).toEqual(Array(MAX_WAKEUPS).fill("scheduled"));
		expect(new Set(durable.map(state => state.id))).toEqual(new Set([accepted.id, ...scheduled.map(r => r.id)]));
	});

	it("is per session and is released by delivery and by cancellation", async () => {
		const h = setup();
		const { manager } = await activeManager(h);
		const records: WakeupRecord[] = [];
		for (let i = 0; i < MAX_WAKEUPS; i++) {
			records.push(await manager.schedule({ delaySeconds: i === 0 ? 10 : 1_000, prompt: `Timer ${i}` }));
		}
		await expect(manager.schedule({ delaySeconds: 60, prompt: "Over quota" })).rejects.toThrow(/quota/i);

		const other = h.manager(h.journal());
		await other.activate();
		expect((await other.schedule({ delaySeconds: 60, prompt: "Other session" })).state).toBe("scheduled");

		h.clock.advance(10_000);
		await waitFor(() => h.deliveries.length === 1, "first timer delivery");
		await manager.schedule({ delaySeconds: 60, prompt: "After delivery" });
		await expect(manager.schedule({ delaySeconds: 60, prompt: "Over quota" })).rejects.toThrow(/quota/i);

		expect(await manager.cancel(records[1].id)).toBe(true);
		expect((await manager.schedule({ delaySeconds: 60, prompt: "After cancel" })).state).toBe("scheduled");
	});

	it("durably cancels restored schedules beyond the quota instead of leaving invisible timers", async () => {
		const h = setup();
		const journal = h.journal();
		const seeded = Array.from({ length: MAX_WAKEUPS + 2 }, () => fixtureRecord(journal.sessionId));
		for (const record of seeded) journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, record);

		const manager = h.manager(journal);
		await manager.activate();
		expect(h.clock.pending).toBe(MAX_WAKEUPS);
		const states = Object.fromEntries(manager.list().map(listed => [listed.id, listed.state]));
		const overflow = seeded.filter(record => states[record.id] === "cancelled");
		expect(overflow).toHaveLength(2);
		for (const record of overflow) expect(wakeupStates(journal, record.id).at(-1)?.state).toBe("cancelled");

		h.clock.advance(0);
		await waitFor(() => h.deliveries.length === MAX_WAKEUPS, "restored deliveries");
		await settle();
		const delivered = new Set(h.deliveries.map(delivery => delivery.record.id));
		expect(delivered.size).toBe(MAX_WAKEUPS);
		for (const record of overflow) expect(delivered.has(record.id)).toBe(false);
	});
});

describe("conditional wakeups", () => {
	it("captures the baseline with the bounded check contract before durable acceptance", async () => {
		const h = setup();
		const { manager } = await activeManager(h);
		const scheduled = manager.schedule(conditional(60, 600, "kubectl rollout status deploy/api"));
		const call = await h.answer(ok("hash-a"));
		const record = await scheduled;

		expect(call).toMatchObject({
			command: "kubectl rollout status deploy/api",
			cwd: "/work/project",
			timeoutMs: WAKEUP_CHECK_TIMEOUT_MS,
		});
		expect(record).toMatchObject({
			state: "scheduled",
			baseline: "0:hash-a",
			dueAt: START + 60_000,
			deadline: START + 600_000,
		});
		expect(h.events.filter(event => event === "check" || event.startsWith("append:"))).toEqual([
			"check",
			"append:scheduled",
		]);
	});

	it("re-arms unchanged checks to min(now + delay, deadline) without journal writes, then fires the deadline without the shell", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const record = await scheduleConditional(h, manager, conditional(60, 150), ok("same"));
		h.clock.advance(60_000);
		await h.answer(ok("same"));
		await waitFor(() => manager.list()[0]?.dueAt === START + 120_000, "first re-arm");
		h.clock.advance(59_999);
		await settle();
		expect(h.checks).toHaveLength(2);

		h.clock.advance(1);
		await h.answer(ok("same"));
		await waitFor(() => manager.list()[0]?.dueAt === START + 150_000, "re-arm clamped to the deadline");
		expect(h.deliveries).toHaveLength(0);
		// Unchanged polls must not grow the journal.
		expect(wakeupStates(journal, record.id).map(state => state.state)).toEqual(["scheduled"]);

		h.clock.advance(30_000);
		await waitFor(() => h.deliveries.length === 1, "deadline delivery");
		expect(h.deliveries[0].reason).toBe("deadline");
		expect(h.checks).toHaveLength(3);
		expect(wakeupStates(journal, record.id).map(state => state.state)).toEqual(["scheduled", "claimed"]);
	});

	const followUps: [string, WakeupCheckResult | Error, WakeupReason][] = [
		["changed output", { hash: "different", exitCode: 0 }, "changed"],
		["nonzero exit", { hash: "baseline", exitCode: 3 }, "check_error"],
		["timeout", { hash: "baseline", exitCode: 0, timedOut: true }, "check_timeout"],
		["output overflow", { hash: "baseline", exitCode: 0, overflow: true }, "check_output_limit"],
		["thrown error", new Error("denied: secret-token-value"), "check_error"],
	];
	for (const [label, result, reason] of followUps) {
		it(`delivers exactly one ${reason} follow-up for a later ${label}`, async () => {
			const h = setup();
			const { journal, manager } = await activeManager(h);
			const record = await scheduleConditional(h, manager, conditional(60, 600));

			h.clock.advance(60_000);
			await h.answer(result);
			await waitFor(() => h.deliveries.length === 1, `${reason} delivery`);
			expect(h.deliveries[0]).toMatchObject({ reason, record: { id: record.id, state: "claimed", reason } });
			expect(wakeupStates(journal, record.id).at(-1)).toMatchObject({ state: "claimed", reason });
			expect(JSON.stringify(journal.getEntries())).not.toContain("secret-token-value");

			h.clock.advance(86_400_000);
			await settle();
			expect(h.deliveries).toHaveLength(1);
			expect(h.checks).toHaveLength(2);
		});
	}

	const baselineFailures: [string, WakeupCheckResult, WakeupReason][] = [
		["nonzero exit", { hash: "x", exitCode: 2 }, "check_error"],
		["timeout", { hash: "x", exitCode: 0, timedOut: true }, "check_timeout"],
		["output overflow", { hash: "x", exitCode: 0, overflow: true }, "check_output_limit"],
	];
	for (const [label, baseline, reason] of baselineFailures) {
		it(`turns a baseline ${label} into an immediate forced ${reason} follow-up`, async () => {
			const h = setup();
			const { manager } = await activeManager(h);
			const record = await scheduleConditional(h, manager, conditional(600, 3_600), baseline);
			expect(record).toMatchObject({ state: "scheduled", reason, dueAt: START });

			h.clock.advance(0);
			await waitFor(() => h.deliveries.length === 1, "forced follow-up");
			expect(h.deliveries[0].reason).toBe(reason);
			expect(h.checks).toHaveLength(1);
		});
	}

	it("reports the deadline when the baseline itself outlasts maxWait", async () => {
		const h = setup();
		const { manager } = await activeManager(h);
		const scheduled = manager.schedule(conditional(1, 1));
		const call = await h.nextCheck();
		h.clock.now += 1_000;
		call.result.resolve(ok("late"));
		const record = await scheduled;
		expect(record).toMatchObject({ state: "scheduled", reason: "deadline", dueAt: START + 1_000 });

		h.clock.advance(0);
		await waitFor(() => h.deliveries.length === 1, "deadline follow-up");
		expect(h.deliveries[0].reason).toBe("deadline");
		expect(h.checks).toHaveLength(1);
	});

	it("rejects scheduling when the baseline check throws, leaving no durable record or timer", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const scheduled = manager.schedule(conditional(60, 600));
		await h.answer(new Error("approval denied by user"));
		await expect(scheduled).rejects.toThrow("approval denied by user");
		expect(wakeupStates(journal)).toEqual([]);
		expect(h.clock.pending).toBe(0);
	});

	it("lets the deadline win over a check result that arrives after it", async () => {
		const h = setup();
		const { manager } = await activeManager(h);
		await scheduleConditional(h, manager, conditional(60, 70), ok("same"));

		h.clock.advance(60_000);
		const call = await h.nextCheck();
		h.clock.now += 20_000;
		call.result.resolve(ok("changed"));
		await waitFor(() => h.deliveries.length === 1, "deadline delivery");
		expect(h.deliveries[0].reason).toBe("deadline");
	});

	it("bounds a hung check by the time left before the deadline and reports a timeout", async () => {
		const h = setup();
		const { manager } = await activeManager(h);
		await scheduleConditional(h, manager, conditional(60, 61));

		// The check bound is a platform timer inside the manager, not the injected
		// clock; leaving 1 ms before the deadline keeps that real wait negligible.
		h.clock.advance(60_999);
		const call = await h.nextCheck();
		expect(call.timeoutMs).toBe(1);
		await waitFor(() => h.deliveries.length === 1, "timeout follow-up");
		expect(call.signal.aborted).toBe(true);
		expect(h.deliveries[0].reason).toBe("check_timeout");
	});
});

describe("serial check execution", () => {
	it("never overlaps checks, even after a cancelled check whose approval settles late", async () => {
		const h = setup();
		const { manager } = await activeManager(h);
		const first = await scheduleConditional(h, manager, conditional(60, 3_600), ok("a"));
		await scheduleConditional(h, manager, conditional(60, 3_600), ok("b"));

		h.clock.advance(60_000);
		const firstTick = await h.nextCheck();
		await settle();
		expect(h.checks).toHaveLength(3);
		firstTick.result.resolve(ok("a"));
		await h.answer(ok("b"));
		await waitFor(() => h.clock.pending === 2, "both unchanged polls to re-arm");

		h.clock.advance(60_000);
		const lateApproval = await h.nextCheck();
		expect(await manager.cancel(first.id)).toBe(true);
		expect(lateApproval.signal.aborted).toBe(true);
		await settle();
		// The cancelled operation has not settled, so the second check must still wait.
		expect(h.checks).toHaveLength(5);

		lateApproval.result.resolve(ok("changed-after-cancel"));
		await h.answer(ok("b"));
		await settle();
		expect(h.checks).toHaveLength(6);
		expect(h.deliveries).toHaveLength(0);
	});
});

describe("cancellation", () => {
	it("reports success only after the tombstone flushes, and the timer never fires", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const record = await manager.schedule({ delaySeconds: 60, prompt: "Cancel me" });

		journal.hold();
		let resolved = false;
		const cancelled = manager.cancel(record.id).then(result => {
			resolved = true;
			return result;
		});
		await settle();
		expect(resolved).toBe(false);
		expect(wakeupStates(journal, record.id).map(state => state.state)).toEqual(["scheduled", "cancelled"]);

		h.clock.advance(120_000);
		await settle();
		expect(h.deliveries).toHaveLength(0);

		journal.release();
		expect(await cancelled).toBe(true);
		expect(h.clock.pending).toBe(0);
		expect(await manager.cancel(`wake_${"0".repeat(32)}`)).toBe(false);
	});

	it("surfaces a tombstone flush failure, lets a retry confirm the tombstone, and never delivers", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const record = await manager.schedule({ delaySeconds: 60, prompt: "Cancel me" });

		journal.flushError = new Error("disk full");
		await expect(manager.cancel(record.id)).rejects.toThrow("disk full");
		journal.flushError = undefined;

		const before = h.events.length;
		expect(await manager.cancel(record.id)).toBe(false);
		expect(h.events.slice(before)).toEqual(["append:cancelled", "flushed"]);

		h.clock.advance(120_000);
		await settle();
		expect(h.deliveries).toHaveLength(0);
		expect(h.clock.pending).toBe(0);
	});

	it("aborts an in-flight conditional check and drops its result", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const record = await scheduleConditional(h, manager, conditional(60, 600));

		h.clock.advance(60_000);
		const call = await h.nextCheck();
		expect(await manager.cancel(record.id)).toBe(true);
		expect(call.signal.aborted).toBe(true);
		call.result.resolve(ok("changed"));
		await settle();

		expect(h.deliveries).toHaveLength(0);
		expect(wakeupStates(journal, record.id).at(-1)?.state).toBe("cancelled");
	});

	it("refuses cancellation once a claim is in flight, without rewriting its terminal state", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const record = await manager.schedule({ delaySeconds: 60, prompt: "Race me" });

		journal.hold();
		h.clock.advance(60_000);
		await waitFor(() => wakeupStates(journal, record.id).length === 2, "claim append");
		await expect(manager.cancel(record.id)).rejects.toThrow(/already claimed/);
		journal.release();
		await settle();

		expect(h.deliveries).toHaveLength(1);
		expect(wakeupStates(journal, record.id).map(state => state.state)).toEqual(["scheduled", "claimed"]);
	});

	it("does not pretend to cancel a queued or already delivered attempt", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const record = await manager.schedule({ delaySeconds: 60, prompt: "Queued" });
		h.clock.advance(60_000);
		await waitFor(() => h.deliveries.length === 1, "delivery");
		const [delivery] = h.deliveries;
		expect(manager.isCurrent(delivery)).toBe(true);

		await expect(manager.cancel(record.id)).rejects.toThrow(/already claimed/);
		expect(manager.isCurrent(delivery)).toBe(true);
		expect(wakeupStates(journal, record.id).map(state => state.state)).toEqual(["scheduled", "claimed"]);
	});

	it("rejects a schedule aborted during its baseline without a durable record", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const controller = new AbortController();
		const scheduled = manager.schedule(conditional(60, 600), controller.signal);
		const call = await h.nextCheck();
		controller.abort(new Error("tool call aborted"));

		await expect(scheduled).rejects.toThrow();
		expect(call.signal.aborted).toBe(true);
		expect(wakeupStates(journal)).toEqual([]);
		expect(h.clock.pending).toBe(0);
	});
});

describe("session lifecycle", () => {
	it("does not write to a timer-free session on activation, and leases it before the first baseline shell", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		expect(journal.entries).toEqual([]);
		expect(h.events).toEqual(["leased"]);

		const scheduled = manager.schedule(conditional(60, 600));
		await h.answer(ok("a"));
		await scheduled;
		expect(h.events.indexOf("leased")).toBeLessThan(h.events.indexOf("check"));
	});

	it("retries a transient activation failure on schedule with a fresh strict lease and journal", async () => {
		const h = setup();
		const journal = h.journal();
		journal.leaseError = new Error("Previous process still owns the journal");
		const manager = h.manager(journal);
		await expect(manager.activate()).rejects.toThrow("Previous process");
		expect(h.clock.pending).toBe(0);
		journal.leaseError = undefined;
		const restored = fixtureRecord(journal.sessionId, { dueAt: START + 60_000 });
		journal.onRefresh = async () => {
			expect(h.events.at(-1)).toBe("leased");
			journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, restored);
		};
		const scheduled = manager.schedule(conditional(60, 600));
		await h.answer(ok("fresh-baseline"));
		await scheduled;
		expect(h.events.filter(event => event === "leased")).toHaveLength(2);
		expect(manager.list("scheduled")).toHaveLength(2);
		expect(h.clock.pending).toBe(2);
	});

	it("does not retry a failed activation while startup or authorization disables the host", async () => {
		const h = setup();
		const journal = h.journal();
		journal.leaseError = new Error("Lease unavailable");
		const manager = h.manager(journal);
		await expect(manager.activate()).rejects.toThrow("Lease unavailable");
		h.enabled = false;
		journal.leaseError = undefined;
		await expect(manager.schedule(conditional(60, 600))).rejects.toThrow();
		expect(h.events.filter(event => event === "leased")).toHaveLength(1);
		expect(h.checks).toEqual([]);
		expect(h.clock.pending).toBe(0);
	});

	it("filters pending listings without dropping durable cancellation or claim records", async () => {
		const h = setup();
		const journal = h.journal();
		for (let i = 0; i < 40; i++) {
			journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, fixtureRecord(journal.sessionId, { state: "cancelled" }));
			journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, fixtureRecord(journal.sessionId, { state: "claimed" }));
		}
		for (let i = 0; i < MAX_WAKEUPS; i++)
			journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, fixtureRecord(journal.sessionId));
		const manager = h.manager(journal);
		await manager.activate();
		expect(manager.list("scheduled")).toHaveLength(MAX_WAKEUPS);
		expect(manager.list()).toHaveLength(80 + MAX_WAKEUPS);
		expect(wakeupStates(journal)).toHaveLength(80 + MAX_WAKEUPS);
	});

	it("refreshes the durable journal under lease before reducing cancellation or claims", async () => {
		for (const state of ["cancelled", "claimed"] as const) {
			const h = setup();
			const journal = h.journal();
			const record = fixtureRecord(journal.sessionId, { dueAt: START });
			journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, record);
			h.events.length = 0;
			journal.onRefresh = async () => {
				expect(h.events).toEqual(["leased"]);
				journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, { ...record, state });
			};
			const manager = h.manager(journal);
			await manager.activate();
			expect(manager.list().map(saved => saved.state)).toEqual([state]);
			expect(h.clock.pending).toBe(0);
			h.clock.advance(1);
			await settle();
			expect(h.deliveries).toEqual([]);
			h.teardown();
		}
	});

	it("discovers timers saved after this manager loaded even when its stale journal was timer-free", async () => {
		const h = setup();
		const journal = h.journal();
		const record = fixtureRecord(journal.sessionId, { dueAt: START });
		journal.onRefresh = async () => {
			journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, record);
		};
		const manager = h.manager(journal);
		await manager.activate();
		expect(h.clock.pending).toBe(1);
		h.clock.advance(0);
		await waitFor(() => h.deliveries.length === 1, "newly discovered wakeup");
		expect(h.deliveries[0].record.id).toBe(record.id);
	});

	it("does not arm a refreshed journal after suspension invalidated its activation", async () => {
		const h = setup();
		const journal = h.journal();
		journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, fixtureRecord(journal.sessionId, { dueAt: START }));
		const refreshed = Promise.withResolvers<void>();
		journal.onRefresh = () => refreshed.promise;
		const manager = h.manager(journal);
		const activation = manager.activate();
		manager.suspend();
		refreshed.resolve();
		await activation;
		expect(manager.list()).toEqual([]);
		expect(h.clock.pending).toBe(0);
		h.clock.advance(1);
		await settle();
		expect(h.deliveries).toEqual([]);
	});

	it("suspend stops timers and checks but keeps accepted records for exact-owner resume", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const watched = await scheduleConditional(h, manager, conditional(60, 86_400), ok("a"));
		const plain = await manager.schedule({ delaySeconds: 30, prompt: "Plain" });

		h.clock.advance(60_000);
		await waitFor(() => h.deliveries.length === 1, "plain delivery");
		const inFlight = await h.nextCheck();

		manager.suspend();
		expect(inFlight.signal.aborted).toBe(true);
		expect(h.clock.pending).toBe(0);
		inFlight.result.resolve(ok("changed"));
		await settle();
		expect(h.deliveries.map(delivery => delivery.record.id)).toEqual([plain.id]);
		expect(manager.isCurrent(h.deliveries[0])).toBe(false);
		await expect(manager.schedule({ delaySeconds: 60, prompt: "While away" })).rejects.toThrow();
		expect(await manager.cancel(watched.id)).toBe(false);
		expect(wakeupStates(journal, watched.id).map(state => state.state)).toEqual(["scheduled"]);

		h.clock.now += 3_600_000;
		await manager.activate();
		expect(h.clock.pending).toBe(1);
		h.clock.advance(0);
		await h.answer(ok("changed"));
		await waitFor(() => h.deliveries.length === 2, "restored delivery");
		expect(h.deliveries[1]).toMatchObject({ reason: "changed", record: { id: watched.id } });
	});

	it("tombstones a schedule whose durable write is interrupted by suspend", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const accepted = await manager.schedule({ delaySeconds: 60, prompt: "Accepted" });

		journal.hold();
		const interrupted = manager.schedule({ delaySeconds: 60, prompt: "Not yet accepted" });
		await waitFor(() => wakeupStates(journal).length === 2, "scheduling append");
		const interruptedId = wakeupStates(journal)[1].id;

		manager.suspend();
		expect(wakeupStates(journal, interruptedId).map(state => state.state)).toEqual(["scheduled", "cancelled"]);
		journal.release();
		await expect(interrupted).rejects.toThrow();

		await manager.activate();
		expect(h.clock.pending).toBe(1);
		h.clock.advance(120_000);
		await waitFor(() => h.deliveries.length === 1, "accepted delivery");
		await settle();
		expect(h.deliveries.map(delivery => delivery.record.id)).toEqual([accepted.id]);
	});

	it("never replays a claim interrupted by suspend (at-most-once)", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		const record = await manager.schedule({ delaySeconds: 60, prompt: "Maybe lost" });

		journal.hold();
		h.clock.advance(60_000);
		await waitFor(() => wakeupStates(journal, record.id).length === 2, "claim append");
		manager.suspend();
		journal.release();
		await settle();
		expect(h.deliveries).toHaveLength(0);

		await manager.activate();
		expect(h.clock.pending).toBe(0);
		h.clock.advance(86_400_000);
		await settle();
		expect(h.deliveries).toHaveLength(0);
		expect(wakeupStates(journal, record.id).map(state => state.state)).toEqual(["scheduled", "claimed"]);
	});

	it("fires an overdue mandatory deadline after resume without running the shell", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		await scheduleConditional(h, manager, conditional(60, 120));
		manager.suspend();

		h.clock.now += 600_000;
		const resumed = h.manager(journal);
		await resumed.activate();
		h.clock.advance(0);
		await waitFor(() => h.deliveries.length === 1, "deadline delivery");
		expect(h.deliveries[0].reason).toBe("deadline");
		expect(h.checks).toHaveLength(1);
	});

	it("arms each record once under concurrent or repeated activation", async () => {
		const h = setup();
		const { manager } = await activeManager(h);
		await manager.schedule({ delaySeconds: 60, prompt: "Once" });
		manager.suspend();

		// Only the latest activation must succeed; a superseded one may give up its lease attempt.
		const [, latest] = await Promise.allSettled([manager.activate(), manager.activate()]);
		expect(latest.status).toBe("fulfilled");
		await manager.activate();
		expect(h.clock.pending).toBe(1);
		h.clock.advance(60_000);
		await waitFor(() => h.deliveries.length === 1, "delivery");
		await settle();
		expect(h.deliveries).toHaveLength(1);
	});

	it("keeps a second in-process manager for the same owner inert until the first suspends", async () => {
		const h = setup();
		const { journal, manager: first } = await activeManager(h);
		const early = await first.schedule({ delaySeconds: 60, prompt: "Early" });
		const late = await first.schedule({ delaySeconds: 120, prompt: "Late" });

		const second = h.manager(journal);
		await second.activate();
		await expect(second.schedule({ delaySeconds: 60, prompt: "Duplicate owner" })).rejects.toThrow();
		expect(second.list()).toEqual([]);
		expect(h.clock.pending).toBe(2);
		h.clock.advance(60_000);
		await waitFor(() => h.deliveries.length === 1, "early delivery");
		await settle();
		expect(h.deliveries.map(delivery => delivery.record.id)).toEqual([early.id]);

		first.suspend();
		await second.activate();
		expect(h.clock.pending).toBe(1);
		h.clock.advance(60_000);
		await waitFor(() => h.deliveries.length === 2, "late delivery");
		expect(h.deliveries.map(delivery => delivery.record.id)).toEqual([early.id, late.id]);
	});

	it("fails closed when the writer lease moves the journal to a fresh session id", async () => {
		const h = setup();
		const { journal, manager } = await activeManager(h);
		await manager.schedule({ delaySeconds: 60, prompt: "Owned elsewhere" });
		manager.suspend();

		const competitor = h.manager(journal);
		journal.onClaim = () => {
			journal.sessionId = `moved-${Bun.randomUUIDv7()}`;
		};
		await expect(competitor.activate()).rejects.toThrow();
		expect(h.clock.pending).toBe(0);
		await expect(competitor.schedule({ delaySeconds: 60, prompt: "Moved" })).rejects.toThrow();
		h.clock.advance(120_000);
		await settle();
		expect(h.deliveries).toHaveLength(0);
	});

	it("runs no baseline shell when activation cannot acquire the writer lease", async () => {
		const h = setup();
		const journal = h.journal();
		journal.leaseError = new Error("lease acquisition failed");
		const manager = h.manager(journal);
		await expect(manager.activate()).rejects.toThrow("lease acquisition failed");
		await expect(manager.schedule(conditional(60, 600))).rejects.toThrow();
		expect(h.checks).toHaveLength(0);
		expect(h.clock.pending).toBe(0);
	});

	it("stays inactive while the host is disabled", async () => {
		const h = setup();
		h.enabled = false;
		const { journal, manager } = await activeManager(h);
		await expect(manager.schedule({ delaySeconds: 60, prompt: "Disabled" })).rejects.toThrow();
		expect(h.clock.pending).toBe(0);
		expect(journal.entries).toEqual([]);
	});

	it("restores only well-formed records owned by this exact session", async () => {
		const h = setup();
		const journal = h.journal();
		const own = fixtureRecord(journal.sessionId);
		journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, fixtureRecord("forked-from-session"));
		journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, fixtureRecord(journal.sessionId, { id: "not-a-wakeup-id" }));
		journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, fixtureRecord(journal.sessionId, { delaySeconds: Number.NaN }));
		journal.appendCustomEntry(
			WAKEUP_ENTRY_TYPE,
			fixtureRecord(journal.sessionId, { check: { command: "true", maxWaitSeconds: 60 } }),
		);
		journal.appendCustomEntry(WAKEUP_ENTRY_TYPE, own);

		const manager = h.manager(journal);
		await manager.activate();
		expect(manager.list().map(listed => listed.id)).toEqual([own.id]);
		expect(h.clock.pending).toBe(1);
		h.clock.advance(0);
		await waitFor(() => h.deliveries.length === 1, "restored delivery");
		await settle();
		expect(h.deliveries.map(delivery => delivery.record.id)).toEqual([own.id]);
	});
});

describe("persisted session journal", () => {
	const storage = new MemorySessionStorage();
	const sessionDir = path.join(os.tmpdir(), `omp-wakeup-test-${Bun.randomUUIDv7()}`);

	async function openSession(file = path.join(sessionDir, `${Bun.randomUUIDv7()}.jsonl`)): Promise<SessionManager> {
		const session = await SessionManager.open(file, sessionDir, storage, {
			initialCwd: os.tmpdir(),
			suppressBreadcrumb: true,
		});
		sessions.push(session);
		return session;
	}

	it("resumes the exact session after close, fires overdue timers once, and never replays the claim", async () => {
		const h = setup();
		const original = await openSession();
		const first = h.manager(original);
		await first.activate();
		const record = await first.schedule({ delaySeconds: 60, prompt: "After restart" });
		const file = original.getSessionFile()!;
		first.suspend();
		await original.close();

		h.clock.now += 3_600_000;
		const reopened = await openSession(file);
		expect(reopened.getSessionId()).toBe(original.getSessionId());
		const resumed = h.manager(reopened);
		await resumed.activate();
		expect(h.clock.pending).toBe(1);
		h.clock.advance(0);
		await waitFor(() => h.deliveries.length === 1, "overdue delivery");
		expect(h.deliveries[0]).toMatchObject({ reason: "delay", record: { id: record.id } });
		resumed.suspend();
		await reopened.close();

		const again = h.manager(await openSession(file));
		await again.activate();
		expect(h.clock.pending).toBe(0);
		expect(again.list().map(listed => listed.state)).toEqual(["claimed"]);
	});

	it("does not arm timers copied into a fork; /new and switching back resume the original owner", async () => {
		const h = setup();
		const session = await openSession();
		const manager = h.manager(session);
		await manager.activate();
		const originalId = session.getSessionId();
		const originalFile = session.getSessionFile()!;
		const record = await manager.schedule({ delaySeconds: 60, prompt: "Original only" });

		manager.suspend();
		await session.fork();
		expect(session.getSessionId()).not.toBe(originalId);
		expect(wakeupStates(session, record.id)).toHaveLength(1);
		await manager.activate();
		expect(manager.list()).toEqual([]);
		expect(h.clock.pending).toBe(0);
		h.clock.advance(120_000);
		await settle();
		expect(h.deliveries).toHaveLength(0);

		manager.suspend();
		await session.newSession();
		await manager.activate();
		expect(h.clock.pending).toBe(0);

		manager.suspend();
		await session.setSessionFile(originalFile);
		await manager.activate();
		expect(h.clock.pending).toBe(1);
		h.clock.advance(0);
		await waitFor(() => h.deliveries.length === 1, "original delivery");
		expect(h.deliveries[0].record).toMatchObject({ id: record.id, owner: originalId });
	});

	it("keeps cancelled and claimed wakeups dead after a branch rewind and reopen", async () => {
		const h = setup();
		const session = await openSession();
		const rewindPoint = session.appendCustomEntry("test-anchor", { before: "wakeups" });
		const manager = h.manager(session);
		await manager.activate();
		const fired = await manager.schedule({ delaySeconds: 10, prompt: "Fired" });
		const cancelled = await manager.schedule({ delaySeconds: 20, prompt: "Cancelled" });
		expect(await manager.cancel(cancelled.id)).toBe(true);
		h.clock.advance(10_000);
		await waitFor(() => h.deliveries.length === 1, "fired delivery");

		manager.suspend();
		session.branch(rewindPoint);
		await manager.activate();
		const onBranch = session
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === WAKEUP_ENTRY_TYPE);
		expect(onBranch).toEqual([]);
		expect(h.clock.pending).toBe(0);
		expect(Object.fromEntries(manager.list().map(listed => [listed.id, listed.state]))).toEqual({
			[fired.id]: "claimed",
			[cancelled.id]: "cancelled",
		});

		const file = session.getSessionFile()!;
		manager.suspend();
		await session.close();
		const reopened = h.manager(await openSession(file));
		await reopened.activate();
		expect(h.clock.pending).toBe(0);
		h.clock.advance(86_400_000);
		await settle();
		expect(h.deliveries).toHaveLength(1);
	});
});
