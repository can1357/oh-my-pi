import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TempDir } from "@oh-my-pi/pi-utils";

interface SessionStub {
	session: AgentSession;
	disposeCalls: () => number;
}

/** Minimal session: the lifecycle manager only ever calls dispose() on it. */
function makeSessionStub(dispose?: () => Promise<void>): SessionStub {
	let calls = 0;
	const stub = {
		dispose: async () => {
			calls++;
			await dispose?.();
		},
	};
	return { session: stub as unknown as AgentSession, disposeCalls: () => calls };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(r => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Settle the async park chain (timer callback → park() → dispose → setStatus). */
async function flushAsync(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

const TTL = 20;

describe("AgentLifecycleManager", () => {
	let registry: AgentRegistry;
	let lifecycle: AgentLifecycleManager;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registry = AgentRegistry.global();
		lifecycle = AgentLifecycleManager.global();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function registerIdleSub(id: string, session: AgentSession | null, sessionFile: string | null = `/tmp/${id}.jsonl`) {
		return registry.register({ id, displayName: "task", kind: "sub", session, sessionFile, status: "idle" });
	}

	it("registerIfAvailable never replaces a collision and reuses only the exact expected ref", () => {
		const parked = registerIdleSub("generation-Sub", null);
		registry.setStatus("generation-Sub", "parked", parked);
		const next = {
			id: "generation-Sub",
			displayName: "replacement",
			kind: "sub" as const,
			session: null,
			status: "running" as const,
		};

		expect(registry.registerIfAvailable(next, null)).toBeUndefined();
		expect(registry.get("generation-Sub")).toBe(parked);
		expect(registry.registerIfAvailable(next, parked)).toBe(parked);
		expect(registry.get("generation-Sub")).toBe(parked);

		registry.setStatus("generation-Sub", "aborted", parked);
		expect(registry.registerIfAvailable(next, parked)).toBeUndefined();
		const staleSession = makeSessionStub().session;
		expect(registry.attachSession("generation-Sub", staleSession, undefined, parked)).toBe(false);
		expect(registry.setStatus("generation-Sub", "idle", parked)).toBe(false);
		expect(registry.get("generation-Sub")).toMatchObject({ status: "aborted", session: null });

		registry.unregister("generation-Sub", parked);
		expect(registry.registerIfAvailable(next, parked)).toBeUndefined();
		expect(registry.get("generation-Sub")).toBeUndefined();
	});

	it("adopt arms the TTL: an idle agent is parked — session disposed, ref + sessionFile retained", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("1-Sub", stub.session, "/tmp/1-Sub.jsonl");
		lifecycle.adopt("1-Sub", { idleTtlMs: TTL });

		vi.advanceTimersByTime(TTL);
		await flushAsync();

		const ref = registry.get("1-Sub");
		expect(stub.disposeCalls()).toBe(1);
		expect(ref?.status).toBe("parked");
		expect(ref?.session).toBeNull();
		expect(ref?.sessionFile).toBe("/tmp/1-Sub.jsonl");
		expect(lifecycle.has("1-Sub")).toBe(true);
	});

	it("running disarms the timer; returning to idle re-arms a fresh TTL", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("2-Sub", stub.session);
		lifecycle.adopt("2-Sub", { idleTtlMs: TTL });
		registry.setStatus("2-Sub", "running");

		vi.advanceTimersByTime(TTL * 10);
		await flushAsync();
		expect(registry.get("2-Sub")?.status).toBe("running");
		expect(registry.get("2-Sub")?.session).toBe(stub.session);
		expect(stub.disposeCalls()).toBe(0);

		registry.setStatus("2-Sub", "idle");
		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("2-Sub")?.status).toBe("parked");
		expect(stub.disposeCalls()).toBe(1);
	});

	it("ensureLive revives a parked agent through its reviver and flips it back to idle", async () => {
		const revived = makeSessionStub();
		registry.register({
			id: "3-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/3-Sub.jsonl",
			status: "parked",
		});
		lifecycle.adopt("3-Sub", { idleTtlMs: 0, revive: async () => revived.session });

		const session = await lifecycle.ensureLive("3-Sub");

		expect(session).toBe(revived.session);
		const ref = registry.get("3-Sub");
		expect(ref?.status).toBe("idle");
		expect(ref?.session).toBe(revived.session);
		expect(ref?.sessionFile).toBe("/tmp/3-Sub.jsonl");
	});

	it("reclaimDeadCorpse frees a parked, session-less, unadopted id and refuses live/adopted refs (#8490)", async () => {
		// A corpse: registered running, then parked with no session and no adoption
		// (the isolated-run finalize / interrupted-construction outcome). It cannot
		// be revived and would otherwise poison its id for the process lifetime.
		const corpse = registry.register({
			id: "Corpse-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Corpse-Sub.jsonl",
			status: "running",
		});
		registry.setStatus("Corpse-Sub", "parked", corpse);
		await expect(lifecycle.ensureLive("Corpse-Sub")).rejects.toThrow(/parked and cannot be revived/);

		// A live ref is never reclaimed.
		const live = makeSessionStub();
		registry.register({
			id: "Live-Sub",
			displayName: "task",
			kind: "sub",
			session: live.session,
			status: "running",
		});
		expect(await lifecycle.reclaimDeadCorpse("Live-Sub", registry.get("Live-Sub")!)).toBe(false);
		expect(registry.get("Live-Sub")?.session).toBe(live.session);

		// An adopted (revivable) parked agent is never reclaimed.
		const adopted = registry.register({
			id: "Adopted-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Adopted-Sub.jsonl",
			status: "parked",
		});
		lifecycle.adopt("Adopted-Sub", { idleTtlMs: 0, revive: async () => makeSessionStub().session }, adopted);
		expect(await lifecycle.reclaimDeadCorpse("Adopted-Sub", adopted)).toBe(false);
		expect(registry.get("Adopted-Sub")).toBe(adopted);

		// A stale expected ref (points at a different agent) is never reclaimed.
		expect(await lifecycle.reclaimDeadCorpse("Corpse-Sub", adopted)).toBe(false);

		// The corpse is reclaimed, and its id becomes registerable again.
		expect(await lifecycle.reclaimDeadCorpse("Corpse-Sub", corpse)).toBe(true);
		expect(registry.get("Corpse-Sub")).toBeUndefined();
		const respawn = registry.registerIfAvailable(
			{ id: "Corpse-Sub", displayName: "task", kind: "sub", session: null, status: "running" },
			null,
		);
		expect(respawn?.status).toBe("running");
		expect(registry.get("Corpse-Sub")).toBe(respawn);
	});

	it("reclaimDeadCorpse preserves an unadopted parked ref when its persisted session can cold-revive", async () => {
		const revived = makeSessionStub();
		const cold = registry.register({
			id: "Cold-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Cold-Sub.jsonl",
			status: "parked",
		});
		let factoryCalls = 0;
		lifecycle.setPersistedSubagentReviverFactory(async ref => {
			factoryCalls++;
			expect(ref).toBe(cold);
			return async () => revived.session;
		}, 0);

		expect(await lifecycle.reclaimDeadCorpse("Cold-Sub", cold)).toBe(false);
		expect(registry.get("Cold-Sub")).toBe(cold);
		expect(factoryCalls).toBe(1);

		// The preserved ref remains messageable through the normal cold-revive path.
		expect(await lifecycle.ensureLive("Cold-Sub")).toBe(revived.session);
		expect(registry.get("Cold-Sub")?.session).toBe(revived.session);
	});

	it("concurrent ensureLive calls during a slow revive coalesce into one reviver run", async () => {
		const gate = deferred();
		const revived = makeSessionStub();
		let reviverRuns = 0;
		registry.register({
			id: "4-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/4-Sub.jsonl",
			status: "parked",
		});
		lifecycle.adopt("4-Sub", {
			idleTtlMs: 0,
			revive: async () => {
				reviverRuns++;
				await gate.promise;
				return revived.session;
			},
		});

		const first = lifecycle.ensureLive("4-Sub");
		const second = lifecycle.ensureLive("4-Sub");
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);

		expect(reviverRuns).toBe(1);
		expect(a).toBe(revived.session);
		expect(b).toBe(revived.session);
	});

	it("tombstoning a parked agent during revive prevents the stale session from attaching", async () => {
		const gate = deferred();
		const revived = makeSessionStub();
		const ref = registry.register({
			id: "Revive-Killed",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Revive-Killed.jsonl",
			status: "parked",
		});
		lifecycle.adopt(
			"Revive-Killed",
			{
				idleTtlMs: 0,
				revive: async () => {
					await gate.promise;
					return revived.session;
				},
			},
			ref,
		);

		const revival = lifecycle.ensureLive("Revive-Killed");
		expect(await lifecycle.release("Revive-Killed", ref, { tombstone: true })).toBe(true);
		expect(registry.get("Revive-Killed")).toMatchObject({ status: "aborted", session: null });

		gate.resolve();
		await expect(revival).rejects.toThrow(/became terminal/);
		expect(revived.disposeCalls()).toBe(1);
		expect(registry.get("Revive-Killed")).toMatchObject({ status: "aborted", session: null });
	});

	it("ensureLive on an unknown id throws and points at history://", async () => {
		await expect(lifecycle.ensureLive("9-Ghost")).rejects.toThrow(/history:\/\/9-Ghost/);
	});

	it("ensureLive on a parked agent without a reviver throws as not revivable", async () => {
		registry.register({ id: "5-Sub", displayName: "task", kind: "sub", session: null, status: "parked" });
		lifecycle.adopt("5-Sub", { idleTtlMs: 0 });

		await expect(lifecycle.ensureLive("5-Sub")).rejects.toThrow(/cannot be revived.*no reviver registered/);
	});

	it("ensureLive cold-revives a parked ref via the persisted factory and rejoins the lifecycle", async () => {
		vi.useFakeTimers();
		const revived = makeSessionStub();
		// Restored from disk (hub scan / resume): parked with a sessionFile but NEVER adopted.
		registry.register({
			id: "6-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/6-Sub.jsonl",
			status: "parked",
		});
		let factoryCalls = 0;
		lifecycle.setPersistedSubagentReviverFactory(async () => {
			factoryCalls++;
			return async () => revived.session;
		}, TTL);

		const session = await lifecycle.ensureLive("6-Sub");

		expect(factoryCalls).toBe(1);
		expect(session).toBe(revived.session);
		expect(registry.get("6-Sub")?.status).toBe("idle");
		expect(registry.get("6-Sub")?.session).toBe(revived.session);

		// Adopted on demand with the configured TTL: it re-parks like any idle subagent.
		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("6-Sub")?.status).toBe("parked");
		expect(revived.disposeCalls()).toBe(1);
	});

	it("a persisted factory that declines leaves the parked ref transcript-only", async () => {
		registry.register({
			id: "7-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/7-Sub.jsonl",
			status: "parked",
		});
		lifecycle.setPersistedSubagentReviverFactory(async () => undefined, TTL);

		await expect(lifecycle.ensureLive("7-Sub")).rejects.toThrow(/cannot be revived.*no reviver registered/);
	});

	it("a failed cold revive is not sticky: the next ensureLive re-runs the factory", async () => {
		const revived = makeSessionStub();
		registry.register({
			id: "8-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/8-Sub.jsonl",
			status: "parked",
		});
		let factoryCalls = 0;
		lifecycle.setPersistedSubagentReviverFactory(async () => {
			factoryCalls++;
			const failFirst = factoryCalls === 1;
			return async () => {
				if (failFirst) throw new Error("stale context");
				return revived.session;
			};
		}, TTL);

		await expect(lifecycle.ensureLive("8-Sub")).rejects.toThrow(/stale context/);
		expect(registry.get("8-Sub")?.status).toBe("parked");

		const session = await lifecycle.ensureLive("8-Sub");
		expect(factoryCalls).toBe(2);
		expect(session).toBe(revived.session);
		expect(registry.get("8-Sub")?.status).toBe("idle");
	});

	it("release disposes a live adopted agent, unregisters it, and leaves no pending park", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("6-Sub", stub.session);
		lifecycle.adopt("6-Sub", { idleTtlMs: TTL });

		await lifecycle.release("6-Sub");

		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("6-Sub")).toBeUndefined();
		expect(lifecycle.has("6-Sub")).toBe(false);

		// The disarmed timer must not fire a late park (which would double-dispose).
		vi.advanceTimersByTime(TTL * 10);
		await flushAsync();
		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("6-Sub")).toBeUndefined();
	});

	it("does not let one stuck adopted agent block sibling disposal", async () => {
		const gate = deferred();
		const stuck = makeSessionStub(() => gate.promise);
		const sibling = makeSessionStub();
		registerIdleSub("stuck-Sub", stuck.session);
		registerIdleSub("sibling-Sub", sibling.session);
		lifecycle.adopt("stuck-Sub", { idleTtlMs: TTL });
		lifecycle.adopt("sibling-Sub", { idleTtlMs: TTL });

		await lifecycle.dispose(Date.now());

		expect(stuck.disposeCalls()).toBe(1);
		expect(sibling.disposeCalls()).toBe(1);
		gate.resolve();
		await flushAsync();
	});

	it("a delayed release cannot remove or mutate a replacement ref with the same id", async () => {
		const gate = deferred();
		const oldSession = makeSessionStub(() => gate.promise);
		const oldRef = registerIdleSub("cas-Sub", oldSession.session);
		lifecycle.adopt("cas-Sub", { idleTtlMs: 0 }, oldRef);
		const releasing = lifecycle.release("cas-Sub", oldRef);
		await flushAsync();
		expect(oldSession.disposeCalls()).toBe(1);

		const replacementSession = makeSessionStub();
		const replacement = registerIdleSub("cas-Sub", replacementSession.session, "/tmp/replacement.jsonl");
		lifecycle.adopt("cas-Sub", { idleTtlMs: 0 }, replacement);
		expect(registry.setStatus("cas-Sub", "aborted", oldRef)).toBe(false);
		expect(registry.detachSession("cas-Sub", oldRef)).toBe(false);
		expect(registry.unregister("cas-Sub", oldRef)).toBe(false);

		gate.resolve();
		await releasing;

		expect(registry.get("cas-Sub")).toBe(replacement);
		expect(replacement.status).toBe("idle");
		expect(replacement.session).toBe(replacementSession.session);
		expect(replacementSession.disposeCalls()).toBe(0);
		expect(lifecycle.has("cas-Sub", replacement)).toBe(true);
	});

	it("adopt(Main) is a no-op: Main is never adopted or parked", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: stub.session,
			status: "idle",
		});
		lifecycle.adopt(MAIN_AGENT_ID, { idleTtlMs: TTL });

		expect(lifecycle.has(MAIN_AGENT_ID)).toBe(false);
		vi.advanceTimersByTime(TTL * 10);
		await flushAsync();
		expect(registry.get(MAIN_AGENT_ID)?.status).toBe("idle");
		expect(registry.get(MAIN_AGENT_ID)?.session).toBe(stub.session);
		expect(stub.disposeCalls()).toBe(0);
	});

	it("isParking is true while park is in flight; session is detached before dispose", async () => {
		const gate = deferred();
		const stub = makeSessionStub(() => gate.promise);
		registerIdleSub("7-Sub", stub.session);
		lifecycle.adopt("7-Sub", { idleTtlMs: 0 });

		// park() registers the in-flight entry synchronously, then yields a
		// cancel window before detach. During dispose we hold the gate open.
		const parking = lifecycle.park("7-Sub");

		expect(lifecycle.isParking("7-Sub")).toBe(true);
		expect(registry.get("7-Sub")?.status).toBe("idle"); // cancel window not yet elapsed
		expect(registry.get("7-Sub")?.session).toBe(stub.session);

		// Cancel window + detach + start dispose.
		await Promise.resolve();
		await Promise.resolve();

		expect(stub.disposeCalls()).toBe(1);
		expect(lifecycle.isParking("7-Sub")).toBe(true);
		// Detach + parked happen BEFORE dispose resolves — callers never see a
		// dying session attached to an idle ref.
		expect(registry.get("7-Sub")?.status).toBe("parked");
		expect(registry.get("7-Sub")?.session).toBeNull();

		gate.resolve();
		await parking;

		expect(lifecycle.isParking("7-Sub")).toBe(false);
		expect(registry.get("7-Sub")?.status).toBe("parked");
		expect(registry.get("7-Sub")?.session).toBeNull();
	});

	it("ensureLive during pre-detach park cancels park and keeps the live session", async () => {
		const gate = deferred();
		const stub = makeSessionStub(() => gate.promise);
		registerIdleSub("Race-Keep", stub.session, "/tmp/Race-Keep.jsonl");
		lifecycle.adopt("Race-Keep", { idleTtlMs: 0 });

		const parking = lifecycle.park("Race-Keep");
		// Same tick as park start: cancel window is still open.
		const live = lifecycle.ensureLive("Race-Keep");

		const session = await live;
		await parking;

		expect(session).toBe(stub.session);
		expect(stub.disposeCalls()).toBe(0);
		expect(lifecycle.isParking("Race-Keep")).toBe(false);
		expect(registry.get("Race-Keep")?.status).toBe("idle");
		expect(registry.get("Race-Keep")?.session).toBe(stub.session);
	});

	it("ensureLive after park detaches waits for dispose then revives once", async () => {
		const gate = deferred();
		const stub = makeSessionStub(() => gate.promise);
		const revived = makeSessionStub();
		let reviverRuns = 0;
		registerIdleSub("Race-Revive", stub.session, "/tmp/Race-Revive.jsonl");
		lifecycle.adopt("Race-Revive", {
			idleTtlMs: 0,
			revive: async () => {
				reviverRuns++;
				return revived.session;
			},
		});

		const parking = lifecycle.park("Race-Revive");
		// Let park pass the cancel window and detach before ensureLive.
		await Promise.resolve();
		await Promise.resolve();
		expect(registry.get("Race-Revive")?.status).toBe("parked");
		expect(registry.get("Race-Revive")?.session).toBeNull();
		expect(stub.disposeCalls()).toBe(1);

		const first = lifecycle.ensureLive("Race-Revive");
		const second = lifecycle.ensureLive("Race-Revive");

		// ensureLive is blocked on park until dispose finishes — never hands out
		// the dying session.
		let firstSettled = false;
		void first.then(() => {
			firstSettled = true;
		});
		await flushAsync();
		expect(firstSettled).toBe(false);
		expect(reviverRuns).toBe(0);

		gate.resolve();
		const [a, b] = await Promise.all([first, second, parking]);

		expect(reviverRuns).toBe(1);
		expect(a).toBe(revived.session);
		expect(b).toBe(revived.session);
		expect(registry.get("Race-Revive")?.status).toBe("idle");
		expect(registry.get("Race-Revive")?.session).toBe(revived.session);
		expect(stub.disposeCalls()).toBe(1);
	});

	it("concurrent park calls coalesce into one dispose", async () => {
		const stub = makeSessionStub();
		registerIdleSub("Race-ParkOnce", stub.session);
		lifecycle.adopt("Race-ParkOnce", { idleTtlMs: 0 });

		const a = lifecycle.park("Race-ParkOnce");
		const b = lifecycle.park("Race-ParkOnce");
		await Promise.all([a, b]);

		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("Race-ParkOnce")?.status).toBe("parked");
		expect(registry.get("Race-ParkOnce")?.session).toBeNull();
	});

	it("dispose failure still leaves the agent parked and detached", async () => {
		const stub = makeSessionStub(async () => {
			throw new Error("dispose blew up");
		});
		registerIdleSub("Park-FailDispose", stub.session, "/tmp/Park-FailDispose.jsonl");
		lifecycle.adopt("Park-FailDispose", {
			idleTtlMs: 0,
			revive: async () => makeSessionStub().session,
		});

		await lifecycle.park("Park-FailDispose");

		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("Park-FailDispose")?.status).toBe("parked");
		expect(registry.get("Park-FailDispose")?.session).toBeNull();
		expect(lifecycle.isParking("Park-FailDispose")).toBe(false);

		// Still revivable after a failed dispose.
		const session = await lifecycle.ensureLive("Park-FailDispose");
		expect(session).toBeTruthy();
		expect(registry.get("Park-FailDispose")?.status).toBe("idle");
	});

	it("revive failure leaves the agent parked without a live session", async () => {
		const gate = deferred();
		const stub = makeSessionStub(() => gate.promise);
		registerIdleSub("Park-FailRevive", stub.session, "/tmp/Park-FailRevive.jsonl");
		lifecycle.adopt("Park-FailRevive", {
			idleTtlMs: 0,
			revive: async () => {
				throw new Error("revive blew up");
			},
		});

		const parking = lifecycle.park("Park-FailRevive");
		await Promise.resolve();
		await Promise.resolve();
		const ensure = lifecycle.ensureLive("Park-FailRevive");
		gate.resolve();
		await parking;

		await expect(ensure).rejects.toThrow(/revive blew up/);
		expect(registry.get("Park-FailRevive")?.status).toBe("parked");
		expect(registry.get("Park-FailRevive")?.session).toBeNull();
		expect(lifecycle.has("Park-FailRevive")).toBe(true);
	});

	it("cancelled park re-arms the idle TTL so a later park still fires", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("Park-Rearm", stub.session, "/tmp/Park-Rearm.jsonl");
		lifecycle.adopt("Park-Rearm", { idleTtlMs: TTL });

		// Force an early park, then cancel it via ensureLive.
		const parking = lifecycle.park("Park-Rearm");
		const kept = await lifecycle.ensureLive("Park-Rearm");
		await parking;
		expect(kept).toBe(stub.session);
		expect(stub.disposeCalls()).toBe(0);
		expect(registry.get("Park-Rearm")?.status).toBe("idle");

		// Fresh TTL from the cancel path.
		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("Park-Rearm")?.status).toBe("parked");
		expect(stub.disposeCalls()).toBe(1);
	});

	it("idleTtlMs <= 0 adopts without a timer: the agent never parks", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("8-Sub", stub.session);
		lifecycle.adopt("8-Sub", { idleTtlMs: 0 });

		vi.advanceTimersByTime(60_000);
		await flushAsync();
		const ref = registry.get("8-Sub");
		expect(ref?.status).toBe("idle");
		expect(ref?.session).toBe(stub.session);
		expect(stub.disposeCalls()).toBe(0);
		expect(lifecycle.has("8-Sub")).toBe(true);
	});

	it("tombstone release keeps a killed ref as terminal `aborted` so a persisted-subagent rescan cannot resurrect it as parked", async () => {
		using tempDir = TempDir.createSync("@omp-lifecycle-tombstone-");
		const rootSessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerId = "Killed-Sub";
		const workerSessionFile = path.join(tempDir.path(), "main", `${workerId}.jsonl`);
		await Bun.write(rootSessionFile, "");
		await Bun.write(workerSessionFile, "");

		// Mirror the real wrapped session dispose (createAgentSession's
		// `unregisterUnlessParked`): disposing a live session unregisters the ref
		// unless it is already terminal (parked/aborted). This is what defeated the
		// naive fix — the ref must be marked `aborted` *before* dispose runs.
		let disposeCalls = 0;
		const session = {
			dispose: async () => {
				disposeCalls++;
				const live = registry.get(workerId);
				if (live && live.status !== "parked" && live.status !== "aborted") {
					registry.unregister(workerId, live);
				}
			},
		} as unknown as AgentSession;
		const ref = registry.register({
			id: workerId,
			displayName: "task",
			kind: "sub",
			session,
			sessionFile: workerSessionFile,
			status: "running",
		});

		expect(await lifecycle.release(workerId, ref, { tombstone: true })).toBe(true);
		// The kill disposes the live session but keeps the ref registered as a
		// terminal, hard-killed row (session detached) instead of removing it.
		expect(disposeCalls).toBe(1);
		expect(registry.get(workerId)?.status).toBe("aborted");
		expect(registry.get(workerId)?.session).toBeNull();
		// The tombstone is terminal: ensureLive must not hand back the disposed
		// session (the ref carries session === null), it treats it as unrevivable.
		await expect(lifecycle.ensureLive(workerId)).rejects.toThrow(/aborted/);

		// Reopening after the original registry is gone must preserve the terminal
		// decision from the sidecar, not infer a fresh parked agent from the JSONL.
		expect(await Bun.file(`${workerSessionFile}.tombstone`).exists()).toBe(true);
		const restoredRegistry = new AgentRegistry();
		await registerPersistedSubagents(restoredRegistry, rootSessionFile);
		expect(restoredRegistry.get(workerId)?.status).toBe("aborted");
	});

	it("a cold revive whose factory resolves after dispose rejects without adopting or arming a TTL", async () => {
		vi.useFakeTimers();
		const gate = deferred();
		const revived = makeSessionStub();
		let reviverRuns = 0;
		// Restored-from-disk parked ref: never adopted, so dispose() does not track it.
		registry.register({
			id: "Cold-DisposeRace",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Cold-DisposeRace.jsonl",
			status: "parked",
		});
		lifecycle.setPersistedSubagentReviverFactory(async () => {
			await gate.promise;
			return async () => {
				reviverRuns++;
				return revived.session;
			};
		}, TTL);

		const revival = lifecycle.ensureLive("Cold-DisposeRace");
		await flushAsync(); // reach the factory await
		await lifecycle.dispose(Date.now()); // teardown while the factory is in flight
		gate.resolve(); // factory completes for a superseded owner

		await expect(revival).rejects.toThrow(/disposed/);
		// Rejected before the reviver ran: no session was ever created.
		expect(reviverRuns).toBe(0);
		expect(revived.disposeCalls()).toBe(0);
		// No adoption, no live session, no armed TTL that could fire a late park.
		expect(lifecycle.has("Cold-DisposeRace")).toBe(false);
		expect(registry.get("Cold-DisposeRace")?.session ?? null).toBeNull();
		expect(registry.get("Cold-DisposeRace")?.status).not.toBe("idle");
		vi.advanceTimersByTime(TTL * 10);
		await flushAsync();
		expect(revived.disposeCalls()).toBe(0);
	});

	it("a cold revive whose session resolves after dispose disposes that session and rejects", async () => {
		const gate = deferred();
		const revived = makeSessionStub();
		registry.register({
			id: "Cold-SessionRace",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Cold-SessionRace.jsonl",
			status: "parked",
		});
		// Factory resolves immediately (cold-adopts), but the reviver — which builds
		// the live session — is held open across dispose().
		lifecycle.setPersistedSubagentReviverFactory(
			async () => async () => {
				await gate.promise;
				return revived.session;
			},
			TTL,
		);

		const revival = lifecycle.ensureLive("Cold-SessionRace");
		await flushAsync(); // reach the reviver await
		await lifecycle.dispose(Date.now()); // teardown while the reviver is in flight
		gate.resolve(); // reviver hands back a live session for a disposed owner

		await expect(revival).rejects.toThrow(/disposed/);
		expect(revived.disposeCalls()).toBe(1);
		expect(lifecycle.has("Cold-SessionRace")).toBe(false);
		expect(registry.get("Cold-SessionRace")?.session ?? null).toBeNull();
	});

	it("a new top-level owner can cold-revive after the previous global lifecycle was disposed", async () => {
		await lifecycle.dispose(Date.now());
		const revived = makeSessionStub();
		registry.register({
			id: "Next-Owner",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Next-Owner.jsonl",
			status: "parked",
		});

		const nextLifecycle = AgentLifecycleManager.global();
		nextLifecycle.setPersistedSubagentReviverFactory(async () => async () => revived.session, 0);

		await expect(nextLifecycle.ensureLive("Next-Owner")).resolves.toBe(revived.session);
		expect(registry.get("Next-Owner")).toMatchObject({ status: "idle", session: revived.session });
		expect(revived.disposeCalls()).toBe(0);
	});
});
