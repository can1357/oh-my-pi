import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
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

	it("publishes an aborted status only after the session is detached", async () => {
		const stub = makeSessionStub();
		const ref = registry.register({
			id: "Published-Aborted",
			displayName: "task",
			kind: "sub",
			session: stub.session,
			sessionFile: null,
			status: "running",
		});
		let observed: { status: string; session: AgentSession | null } | undefined;
		const unsubscribe = registry.onChange(event => {
			if (event.type === "status_changed" && event.ref.id === ref.id) {
				observed = { status: event.ref.status, session: event.ref.session };
			}
		});

		await lifecycle.release(ref.id, ref, { tombstone: true });
		unsubscribe();

		expect(observed).toEqual({ status: "aborted", session: null });
	});

	it("tombstone release survives the dispose-path unregister racing the sidecar write (#10531)", async () => {
		using tempDir = TempDir.createSync("@omp-lifecycle-tombstone-race-");
		const workerId = "Raced-Sub";
		const workerSessionFile = path.join(tempDir.path(), `${workerId}.jsonl`);
		await Bun.write(workerSessionFile, "");

		let disposeCalls = 0;
		const session = {
			dispose: async () => {
				disposeCalls++;
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

		// The dying subagent's own dispose finally-block runs unregisterUnlessParked
		// (sdk.ts) on a separate async chain. Fire it during the sidecar write await —
		// the exact window the reporter observed — mirroring its real bail-out guard:
		// spare a ref only when it is already parked, or aborted AND detached.
		const disposePathUnregister = () => {
			const cur = registry.get(workerId);
			if (!cur) return;
			if (cur.status === "parked" || (cur.status === "aborted" && !cur.session)) return;
			registry.unregister(workerId, cur);
		};
		let injected = false;
		vi.spyOn(fsp, "writeFile").mockImplementation((async (target: string) => {
			if (!injected && target.endsWith(".tombstone")) {
				injected = true;
				disposePathUnregister();
				await Bun.write(target, "");
			}
		}) as typeof fsp.writeFile);

		expect(await lifecycle.release(workerId, ref, { tombstone: true })).toBe(true);
		expect(injected).toBe(true);
		// The terminal transition ran before the await, so the racing unregister
		// saw an aborted, detached ref and bailed: the row survives as `aborted`
		// instead of vanishing from the registry.
		expect(registry.get(workerId)?.status).toBe("aborted");
		expect(registry.get(workerId)?.session).toBeNull();
		expect(disposeCalls).toBe(1);
		expect(await Bun.file(`${workerSessionFile}.tombstone`).exists()).toBe(true);
	});

	it("tombstone release disposes the detached session when sidecar persistence fails", async () => {
		const stub = makeSessionStub();
		const ref = registry.register({
			id: "Persist-Failure",
			displayName: "task",
			kind: "sub",
			session: stub.session,
			sessionFile: "/tmp/Persist-Failure.jsonl",
			status: "running",
		});
		const failure = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		vi.spyOn(fsp, "writeFile").mockRejectedValueOnce(failure);

		await expect(lifecycle.release("Persist-Failure", ref, { tombstone: true })).rejects.toBe(failure);

		// Persistence still surfaces to the caller, but the detached session cannot
		// leak its MCP, kernel, browser, or nested-job resources.
		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("Persist-Failure")).toMatchObject({ status: "aborted", session: null });
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

	// parkAll() is a BARRIER, not a batch of ordinary parks.
	// It runs while the parent session recycles, and the parent's teardown tears
	// down the shared resources (kernels, MCP, LSP) every child session borrows —
	// so parkAll() resolving must mean "no child session is live". The ordinary
	// park() it delegated to cannot promise that: park() yields once before
	// detaching precisely so a concurrent ensureLive()/hub-send can CANCEL it and
	// keep the live session. A hub `send` landing in that window made parkAll()
	// report completion with the child still attached, and the parent then
	// disposed the shared resources out from under it.
	//
	// RED (pre-fix): the cancel won, `parkAll()` resolved, and the ref was still
	// live.
	it("parkAll is exclusive with a concurrent ensureLive that would otherwise cancel the park", async () => {
		const stub = makeSessionStub();
		registerIdleSub("Barrier-Cancel", stub.session);
		let reviverRuns = 0;
		lifecycle.adopt("Barrier-Cancel", { idleTtlMs: 0, revive: async () => makeSessionStub().session });
		// The replacement parent's factory: the recycle marks the spawn-time
		// closure stale, so it is the route the released waiter actually takes.
		lifecycle.setPersistedSubagentReviverFactory(async () => {
			reviverRuns++;
			return async () => makeSessionStub().session;
		}, 0);

		// Same tick: exactly the window in which park()'s pre-detach yield lets
		// ensureLive() cancel. Under the barrier the cancel must NOT take effect.
		const parking = lifecycle.parkAll();
		const send = lifecycle.ensureLive("Barrier-Cancel");
		const release = await parking;
		release();

		// The barrier's contract: once parkAll() resolves, no session is live.
		const ref = registry.get("Barrier-Cancel");
		expect(ref?.status).toBe("parked");
		expect(ref?.session).toBeNull();
		expect(stub.disposeCalls()).toBe(1);

		// The send is not lost — it settles through the normal revive path once
		// the barrier has passed, which is what makes blocking safe rather than a
		// dropped message.
		await expect(send).resolves.toBeDefined();
		expect(reviverRuns).toBe(1);
	});

	// Second half of the same finding: a revival ALREADY in flight when parkAll()
	// starts is invisible to it. `ids` is built from #adopted + #parks, and a
	// cold-revived ref is adopted only after its reviver resolves, so the id is
	// in neither map; park() would no-op anyway because the ref has no attached
	// session yet. parkAll() therefore resolved while a child session was being
	// BUILT, and the parent tore down the shared resources under it.
	//
	// RED (pre-fix): parkAll() resolved before the reviver did, and the ref was
	// left live afterwards.
	it("parkAll settles a revival that is already in flight rather than resolving past it", async () => {
		const gate = deferred();
		const revived = makeSessionStub();
		// Restored-from-disk shape: parked with a sessionFile, never adopted, so
		// nothing about it appears in #adopted or #parks.
		registry.register({
			id: "Barrier-Reviving",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Barrier-Reviving.jsonl",
			status: "parked",
		});
		lifecycle.setPersistedSubagentReviverFactory(
			async () => async () => {
				await gate.promise;
				return revived.session;
			},
			0,
		);

		// The revival starts FIRST and parks inside its reviver.
		const revival = lifecycle.ensureLive("Barrier-Reviving");
		await flushAsync();

		const parking = lifecycle.parkAll();
		// Let the reviver finish while the barrier is waiting on it.
		gate.resolve();
		(await parking)();

		// Whichever way the revival resolved, the barrier must not leave a live
		// session behind for the parent's teardown to strand.
		expect(registry.get("Barrier-Reviving")?.session).toBeNull();
		// The session it built was disposed rather than leaked past the barrier.
		expect(revived.disposeCalls()).toBe(1);
		await revival.catch(() => {});
	});

	// The pre-pass that settles in-flight revivals has to be bounded by the SAME
	// deadline as the parking phase below it. The recycle wrapper calls
	// session.beginDispose() BEFORE awaiting parkAll(), so a revival wedged in its
	// persisted factory or its session creation is not merely a slow recycle: the
	// parent is already refusing new work, parkAll() never reaches the parking
	// phase, and onRestartRequested never runs to build the replacement. The
	// restart wedges permanently instead of degrading.
	//
	// The wedge is event-gated (a deferred nothing ever resolves), so the deadline
	// is the only thing that can complete the call — no wall-clock race.
	//
	// RED (pre-fix): the unbounded Promise.allSettled(inflight) never resolved and
	// the test hung until the runner killed it.
	it("bounds an in-flight revival that never settles by the parking deadline", async () => {
		const wedge = deferred();
		registry.register({
			id: "Barrier-Wedged",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Barrier-Wedged.jsonl",
			status: "parked",
		});
		lifecycle.setPersistedSubagentReviverFactory(
			async () => async () => {
				await wedge.promise;
				return makeSessionStub().session;
			},
			0,
		);

		// The revival starts first and parks inside its reviver, so parkAll()'s
		// pre-pass finds it in #revivals.
		const wedged = lifecycle.ensureLive("Barrier-Wedged");
		// Own its outcome up front: an abandoned revival must never surface as an
		// unhandled rejection.
		const wedgedOutcome = wedged.then(
			() => "resolved",
			() => "rejected",
		);
		await flushAsync();

		// An ordinary adopted child, so the assertions can prove the parking phase
		// was actually REACHED rather than just that parkAll() returned.
		const stub = makeSessionStub();
		registerIdleSub("Barrier-Parkable", stub.session);
		lifecycle.adopt("Barrier-Parkable", { idleTtlMs: 0 });

		(await lifecycle.parkAll(Date.now() + 50))();

		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("Barrier-Parkable")?.status).toBe("parked");
		expect(registry.get("Barrier-Parkable")?.session).toBeNull();
		// The wedged revival was abandoned, not awaited: still pending here.
		expect(await Promise.race([wedgedOutcome, Promise.resolve("pending")])).toBe("pending");

		// Still idempotent with the wedge outstanding: a second barrier (the
		// caller's finally racing an explicit call) must also stay bounded, and the
		// release must still reopen revival.
		(await lifecycle.parkAll(Date.now() + 50))();
		expect(registry.get("Barrier-Parkable")?.status).toBe("parked");

		wedge.resolve();
		expect(await wedgedOutcome).toBeString();
	});

	// Parking the children is only the first half of the recycle. The caller
	// disposes the shared kernels/MCP/LSP AFTER awaiting parkAll(), so a barrier
	// released at parkAll()'s resolution reopens revival for exactly the span in
	// which those resources go away — the waiter gets a child built on top of
	// them. The barrier therefore has to be held by the caller, across its own
	// teardown, and parkAll() hands back the release to do it with.
	//
	// RED (pre-fix): parkAll() resolved its own barrier, so the reviver ran
	// during the parent's teardown window instead of after it.
	it("keeps revival blocked until the caller releases the barrier, not when parkAll resolves", async () => {
		const stub = makeSessionStub();
		registerIdleSub("Barrier-Recycle", stub.session);
		const reviveOrder: string[] = [];
		lifecycle.adopt("Barrier-Recycle", { idleTtlMs: 0, revive: async () => makeSessionStub().session });
		// The replacement parent's factory, which the recycle's reattachment
		// installs — the only route back once the spawn-time closure is stale.
		lifecycle.setPersistedSubagentReviverFactory(
			async () => async () => {
				reviveOrder.push("revived");
				return makeSessionStub().session;
			},
			0,
		);

		const parking = lifecycle.parkAll();
		const send = lifecycle.ensureLive("Barrier-Recycle");
		const release = await parking;

		// Stand in for the parent's remaining teardown: everything between
		// parkAll() resolving and the shared resources actually being gone. The
		// waiter must still be blocked here.
		await flushAsync();
		reviveOrder.push("shared-resources-disposed");
		expect(reviveOrder).toEqual(["shared-resources-disposed"]);

		release();
		await expect(send).resolves.toBeDefined();
		// Revival happened strictly after the teardown, never interleaved with it.
		expect(reviveOrder).toEqual(["shared-resources-disposed", "revived"]);
	});

	// The release is the only thing that reopens revival, so it must be safe to
	// call more than once (the caller's `finally` may run alongside an explicit
	// call) and it must not clear a LATER parkAll()'s barrier out from under it.
	it("barrier release is idempotent and never clears a newer parkAll's barrier", async () => {
		const first = await lifecycle.parkAll();
		const second = await lifecycle.parkAll();

		// Releasing the stale handle must not open the window the second one holds.
		first();
		first();

		registry.register({
			id: "Barrier-Stale",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Barrier-Stale.jsonl",
			status: "parked",
		});
		let reviverRuns = 0;
		lifecycle.setPersistedSubagentReviverFactory(
			async () => async () => {
				reviverRuns++;
				return makeSessionStub().session;
			},
			0,
		);

		const send = lifecycle.ensureLive("Barrier-Stale");
		await flushAsync();
		expect(reviverRuns).toBe(0);

		second();
		await expect(send).resolves.toBeDefined();
		expect(reviverRuns).toBe(1);
	});

	// Two callback-enabled top-level SDK sessions can recycle at once, so two
	// `parkAll()` handoffs can be live at the same time — and they do not finish
	// in the order they started. Each one's barrier has to span its OWN parent's
	// teardown, so the protection can only lift when the LAST of them releases.
	//
	// A single barrier field cannot express that: the second call overwrites the
	// first, and the second release — arriving first — clears the field and
	// reopens revival while the first parent is still tearing down or has not
	// reattached. The first parent's release then has nothing left to hold, so
	// the protection it was promised cannot be restored.
	//
	// Event-gated: the assertions turn on the reviver having run, and every
	// release is an explicit call, so nothing here depends on elapsed time.
	//
	// RED (pre-fix): the reviver ran as soon as the second handoff released,
	// while the first was still holding.
	it("keeps revival blocked until every overlapping parkAll releases, not just the last", async () => {
		// An ordinary adopted child, so both handoffs have real parking to do
		// rather than resolving on an empty registry.
		const stub = makeSessionStub();
		registerIdleSub("Barrier-Overlap-Parkable", stub.session);
		lifecycle.adopt("Barrier-Overlap-Parkable", { idleTtlMs: 0 });

		registry.register({
			id: "Barrier-Overlap",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Barrier-Overlap.jsonl",
			status: "parked",
		});
		let reviverRuns = 0;
		lifecycle.setPersistedSubagentReviverFactory(
			async () => async () => {
				reviverRuns++;
				return makeSessionStub().session;
			},
			0,
		);

		// Both handoffs in flight at once, neither having released.
		const [first, second] = await Promise.all([lifecycle.parkAll(), lifecycle.parkAll()]);
		expect(registry.get("Barrier-Overlap-Parkable")?.status).toBe("parked");

		const send = lifecycle.ensureLive("Barrier-Overlap");
		await flushAsync();
		expect(reviverRuns).toBe(0);

		// The SECOND handoff finishes first — the ordering a single field loses.
		// The first parent is still tearing down, so revival must stay shut.
		second();
		second();
		await flushAsync();
		expect(reviverRuns).toBe(0);

		// Only the last release reopens it.
		first();
		await expect(send).resolves.toBeDefined();
		expect(reviverRuns).toBe(1);
	});

	// Two properties the barrier must hold AT ONCE, and the reason they are one
	// test: each is trivially satisfiable by breaking the other.
	//
	//  1. No permanent wedge. A revival that never settles must not hold the
	//     recycle open — the wrapper has already called session.beginDispose(),
	//     so a parkAll() that waits forever means onRestartRequested never runs
	//     and the restart wedges rather than degrading. (Blocking on the revival
	//     would satisfy #2 and break this.)
	//  2. No live child across the barrier. parkAll() resolving means "no child
	//     session is live AND none can become live", because the caller then
	//     disposes the shared kernels/MCP/LSP every child borrows. Abandoning the
	//     wait in #1 leaves that revival running past the `ids` snapshot, so if it
	//     later finishes it attaches exactly the live child the barrier promised
	//     to exclude. (Never abandoning satisfies this and breaks #1.)
	//
	// Both hold only because abandoning the WAIT also FENCES the revival: the
	// recycle completes on the deadline, and the abandoned revival then refuses
	// to attach, disposing what it built and failing its waiter — who can retry
	// against the replacement parent.
	//
	// Event-gated throughout: the revival is a deferred nothing resolves, so only
	// the deadline can complete parkAll(), and the post-barrier assertions are
	// gated on the revival's own settlement rather than on elapsed time.
	//
	// RED (pre-fix): the abandoned revival attached its session and the ref was
	// left `idle` with a live session after the barrier had been released.
	it("fences a revival that outlives the parking deadline without wedging the recycle", async () => {
		const wedge = deferred();
		const revived = makeSessionStub();
		// Restored-from-disk shape: parked with a sessionFile, no adoption, so the
		// id is in neither #adopted nor #parks and parkAll()'s `ids` snapshot
		// cannot see it.
		registry.register({
			id: "Barrier-Late",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Barrier-Late.jsonl",
			status: "parked",
		});
		lifecycle.setPersistedSubagentReviverFactory(
			async () => async () => {
				await wedge.promise;
				return revived.session;
			},
			0,
		);

		// The revival starts first and parks inside its reviver, so parkAll()'s
		// pre-pass finds it in #revivals and then has to give up on it.
		const revival = lifecycle.ensureLive("Barrier-Late");
		await flushAsync();

		// An ordinary adopted child, so the assertions can prove the parking phase
		// was REACHED rather than just that parkAll() returned.
		const stub = makeSessionStub();
		registerIdleSub("Barrier-Parkable-Late", stub.session);
		lifecycle.adopt("Barrier-Parkable-Late", { idleTtlMs: 0 });

		// INVARIANT 1: the recycle completes on the deadline despite the wedge.
		const release = await lifecycle.parkAll(Date.now() + 50);
		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("Barrier-Parkable-Late")?.status).toBe("parked");

		// The caller's own teardown, then the release — the point past which the
		// shared resources are gone.
		release();
		await flushAsync();

		// The abandoned revival now finishes, the case the deadline created.
		wedge.resolve();

		// INVARIANT 2: it refuses to attach rather than becoming the live child
		// the barrier excluded.
		await expect(revival).rejects.toThrow(/recycled/);
		expect(registry.get("Barrier-Late")?.session).toBeNull();
		expect(registry.get("Barrier-Late")?.status).toBe("parked");
		// And the session it built was disposed, not leaked onto torn-down
		// resources.
		expect(revived.disposeCalls()).toBe(1);
	});

	// The fence must be scoped to revivals parkAll() actually ABANDONED. A
	// revival that settles within the deadline is parked by the normal path and
	// must not be failed, and one started after the barrier releases must revive
	// normally — otherwise "no live child across the barrier" would be satisfied
	// by refusing every revival, which breaks revival outright.
	it("does not fence a revival that settles inside the deadline or starts after the barrier", async () => {
		const gate = deferred();
		const inTime = makeSessionStub();
		registry.register({
			id: "Barrier-InTime",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Barrier-InTime.jsonl",
			status: "parked",
		});
		lifecycle.setPersistedSubagentReviverFactory(
			async () => async () => {
				await gate.promise;
				return inTime.session;
			},
			0,
		);

		const revival = lifecycle.ensureLive("Barrier-InTime");
		await flushAsync();

		const parking = lifecycle.parkAll();
		// Settles while the pre-pass is still waiting, so it is never fenced: the
		// parking phase then disposes it like any other child.
		gate.resolve();
		(await parking)();
		expect(registry.get("Barrier-InTime")?.session).toBeNull();
		// Disposed by the ordinary park path (or the attach race), never leaked.
		expect(inTime.disposeCalls()).toBe(1);
		await revival.catch(() => {});

		// A revival started AFTER the barrier has been released is ordinary work
		// against the (notionally) replacement parent, so it must succeed.
		const afterwards = makeSessionStub();
		registry.register({
			id: "Barrier-After",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Barrier-After.jsonl",
			status: "parked",
		});
		lifecycle.setPersistedSubagentReviverFactory(async () => async () => afterwards.session, 0);
		await expect(lifecycle.ensureLive("Barrier-After")).resolves.toBe(afterwards.session);
		expect(registry.get("Barrier-After")?.session).toBe(afterwards.session);
		expect(afterwards.disposeCalls()).toBe(0);
	});

	// The barrier check at ensureLive()'s entry is not enough on its own,
	// because awaiting a per-agent park is itself a window a recycle can start
	// in. The caller arrives while an ordinary TTL park has ALREADY committed to
	// detach: no barrier is live, so the entry check passes, and it parks on that
	// park's promise. A parkAll() raising its barrier during that await is
	// invisible to every other guard — the revival is not in #revivals yet, so
	// the pre-pass cannot fence it, and the parking snapshot only joins the park
	// already in flight. Resuming straight into a revive builds a live child
	// while the parent tears down the shared kernels/MCP/LSP it borrows, which is
	// the one state the barrier exists to exclude.
	//
	// Event-gated: the park is held open by a deferred dispose, the barrier is
	// raised while that dispose is parked, and the assertion turns on whether the
	// reviver has run — never on elapsed time.
	//
	// RED (pre-fix): the reviver ran while the barrier was still held
	// (`reviverRuns` was 1 before the release).
	it("rechecks the parking barrier after waiting out a park, not only on entry", async () => {
		const disposing = deferred();
		const stub = makeSessionStub(() => disposing.promise);
		const revived = makeSessionStub();
		registerIdleSub("Barrier-AfterPark", stub.session);
		let reviverRuns = 0;
		lifecycle.adopt("Barrier-AfterPark", { idleTtlMs: 0, revive: async () => revived.session });
		// The replacement parent's factory: the recycle below marks the
		// spawn-time closure stale, so this is the route the waiter takes.
		lifecycle.setPersistedSubagentReviverFactory(
			async () => async () => {
				reviverRuns++;
				return revived.session;
			},
			0,
		);

		// An ordinary park, parked inside session.dispose() — so it is past its
		// cancel window and ensureLive() must WAIT for it rather than cancel.
		const parking = lifecycle.park("Barrier-AfterPark");
		await flushAsync();
		expect(registry.get("Barrier-AfterPark")?.status).toBe("parked");

		// The waiter enters with NO barrier live and parks on that committed park.
		const send = lifecycle.ensureLive("Barrier-AfterPark");
		await flushAsync();
		expect(reviverRuns).toBe(0);

		// The recycle starts DURING the waiter's park await — the window the
		// entry-only check cannot see. `parkAll()` registers its barrier
		// synchronously, before its first await, so it is already up when the park
		// below settles; awaiting the call itself only after that keeps the whole
		// sequence event-gated, with no deadline in it.
		const parkAllCall = lifecycle.parkAll();

		// The park now finishes, releasing the waiter into the barrier's span.
		disposing.resolve();
		await parking;
		const release = await parkAllCall;
		await flushAsync();

		// It must still be blocked: the parent's shared resources are being torn
		// down right here.
		expect(reviverRuns).toBe(0);

		release();
		await expect(send).resolves.toBe(revived.session);
		expect(reviverRuns).toBe(1);
	});

	// The same window on the CANCEL path. Here the park is still pre-detach, so
	// ensureLive() cancels it and keeps the live session — but the cancel's own
	// await is a window too, and a session handed back inside the barrier's span
	// is the same violation as one freshly revived: parkAll() has already
	// snapshotted what to park, so nothing will park this one, and the caller
	// gets a live child for the duration of the parent's teardown.
	//
	// Paired with the case above because the two are one contract with two exits;
	// a fix applied to only the reviving branch leaves this one open.
	//
	// RED (pre-fix): resolved with the kept session while the barrier was held.
	it("does not hand back a kept session when a recycle starts during the park cancel", async () => {
		const stub = makeSessionStub();
		registerIdleSub("Barrier-KeptRace", stub.session);
		let reviverRuns = 0;
		lifecycle.adopt("Barrier-KeptRace", { idleTtlMs: 0, revive: async () => makeSessionStub().session });
		// The replacement parent's factory: the recycle marks the spawn-time
		// closure stale, so it is the route the released waiter actually takes.
		lifecycle.setPersistedSubagentReviverFactory(
			async () => async () => {
				reviverRuns++;
				return makeSessionStub().session;
			},
			0,
		);

		// Same tick: park() yields once before detaching, and ensureLive() reaches
		// the cancel inside that turn — so the cancel wins and the session stays
		// attached. The recycle is raised in that same turn, after the waiter has
		// passed its entry check.
		const parking = lifecycle.park("Barrier-KeptRace");
		const send = lifecycle.ensureLive("Barrier-KeptRace");
		const parkAllCall = lifecycle.parkAll();
		await parking;
		const release = await parkAllCall;

		// Whatever the waiter ends up doing, it must not have completed while the
		// barrier was up.
		let settled = false;
		void send.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await flushAsync();
		expect(settled).toBe(false);

		release();
		await expect(send).resolves.toBeDefined();
		// The barrier's own contract still held across it: parkAll() disposed the
		// live session, so the waiter came back through the reviver rather than
		// being handed the session the barrier promised was gone.
		expect(stub.disposeCalls()).toBe(1);
		expect(reviverRuns).toBe(1);
	});

	// A recycle whose reattachment FAILED produced no replacement parent, and
	// that is not merely "the barrier releases a little early". The teardown
	// below the parking already disposed the shared dependencies every parked
	// child borrows, and with no new parent BOTH routes back to a live session
	// belong to the one that went away: the retained reviver closes over it, and
	// the factory that would have superseded that reviver is its own, because no
	// replacement installed one. So a waiter let through comes back holding a
	// disconnected MCP and dead kernels.
	//
	// The barrier must therefore lift — holding it forever strands every later
	// ensureLive() — while REFUSING the waiters it was holding. Both halves are
	// asserted, because either alone is satisfiable by breaking the other.
	//
	// Event-gated: the release is an explicit call and the assertions turn on the
	// waiter's own settlement.
	//
	// RED (pre-fix): the release took no outcome, so the waiter resolved through
	// the stale retained reviver.
	it("fails a waiting revival when the recycle's reattachment produced no replacement", async () => {
		const staleParent = makeSessionStub();
		const ref = registerIdleSub("Handoff-Failed", makeSessionStub().session);
		let staleReviverRuns = 0;
		lifecycle.adopt(
			"Handoff-Failed",
			{
				idleTtlMs: 0,
				revive: async () => {
					staleReviverRuns++;
					return staleParent.session;
				},
			},
			ref,
		);

		const release = await lifecycle.parkAll();
		const send = lifecycle.ensureLive("Handoff-Failed");
		await flushAsync();
		expect(staleReviverRuns).toBe(0);

		// The host's onRestartRequested threw: the barrier is released, but there
		// is no parent for a revived child to borrow from.
		release("failed");

		await expect(send).rejects.toThrow(/replacement failed to attach/);
		// Refused, not revived through the disposed parent's closure.
		expect(staleReviverRuns).toBe(0);
		expect(registry.get("Handoff-Failed")?.session).toBeNull();
		expect(registry.get("Handoff-Failed")?.status).toBe("parked");
	});

	// Two overlapping recycles, and the failure belongs to the one the waiter
	// never gets a reference to. A release DELETES its entry before resolving,
	// so an outcome kept on the entry is readable only by a waiter that already
	// captured that exact object — and a waiter parked on the FIRST barrier has
	// captured only that one. The second recycle then fails and vanishes: its
	// entry is gone, the first resolves cleanly, and the refusal that should
	// have stopped the revival has nothing left to read.
	//
	// The hazard is not cosmetic. The second parent's teardown disposed the
	// shared kernels/MCP/LSP its parked children borrow and produced no
	// replacement, so letting the waiter through revives a child onto dead
	// resources — exactly what the failed-handoff refusal exists to prevent.
	//
	// Ordering is forced, not hoped for: the waiter is blocked while BOTH
	// barriers are up, the failing one releases first, and only then does the
	// clean one release. So the failure is always the entry that left the set
	// before the waiter observed anything.
	//
	// RED (pre-fix): resolves through the stale reviver — the loop read
	// `failed` off the live Set, whose failing entry was already deleted.
	it("preserves a failed handoff from a barrier released while another was still awaited", async () => {
		const stale = makeSessionStub();
		const ref = registerIdleSub("Overlap-Failed", makeSessionStub().session);
		let staleReviverRuns = 0;
		lifecycle.adopt(
			"Overlap-Failed",
			{
				idleTtlMs: 0,
				revive: async () => {
					staleReviverRuns++;
					return stale.session;
				},
			},
			ref,
		);

		// Both recycles in flight before the waiter arrives, so it blocks with
		// two live barriers and holds a reference to neither outcome.
		const [failing, clean] = await Promise.all([lifecycle.parkAll(), lifecycle.parkAll()]);
		const send = lifecycle.ensureLive("Overlap-Failed");
		await flushAsync();
		expect(staleReviverRuns).toBe(0);

		// The FAILING handoff finishes first and drops its entry. Revival must
		// stay shut: the other parent is still tearing down.
		failing("failed");
		await flushAsync();
		expect(staleReviverRuns).toBe(0);

		// The surviving barrier reattached cleanly, but the recycle that did not
		// still disposed resources this child would be rebuilt on.
		clean();
		await expect(send).rejects.toThrow(/replacement failed to attach/);
		expect(staleReviverRuns).toBe(0);
		expect(registry.get("Overlap-Failed")?.status).toBe("parked");
	});

	// The same erasure one step further out, and the reason the outcome is
	// recorded on the manager rather than snapshotted per wait. Here the waiter
	// never observes the failing barrier AT ALL: it is parked on a park's own
	// dispose when the recycle is raised, fails, and clears itself, so by the
	// time the barrier check runs again the set is empty and every entry the
	// waiter could have snapshotted is gone.
	//
	// A per-wait snapshot fixes the iterator, not this: there is no iteration to
	// snapshot in the window where the whole barrier lifecycle fits inside
	// someone else's await.
	//
	// RED (pre-snapshot AND pre-counter): revives through the stale reviver.
	it("preserves a failed handoff raised and released entirely inside a park wait", async () => {
		const disposing = deferred();
		const parking = makeSessionStub(() => disposing.promise);
		const stale = makeSessionStub();
		const ref = registerIdleSub("Park-Window-Failed", parking.session);
		let staleReviverRuns = 0;
		lifecycle.adopt(
			"Park-Window-Failed",
			{
				idleTtlMs: 0,
				revive: async () => {
					staleReviverRuns++;
					return stale.session;
				},
			},
			ref,
		);

		// Park the agent and let it commit to detach, so ensureLive() takes the
		// wait-for-park branch rather than cancelling.
		const park = lifecycle.park("Park-Window-Failed");
		await Promise.resolve();
		await Promise.resolve();
		expect(registry.get("Park-Window-Failed")?.session).toBeNull();

		const send = lifecycle.ensureLive("Park-Window-Failed");
		await flushAsync();
		expect(staleReviverRuns).toBe(0);

		// A whole failed recycle, start to finish, inside that park wait. Its
		// deadline is already spent, which is the only way a recycle completes
		// while a park it snapshotted is still draining — the same
		// deadline-exceeded path a wedged dispose takes in production. Without it
		// parkAll() would itself block on the park the waiter is blocked on.
		const release = await lifecycle.parkAll(Date.now());
		release("failed");
		await flushAsync();

		// Only now does the park the waiter is blocked on finish.
		disposing.resolve();
		await park;

		await expect(send).rejects.toThrow(/replacement failed to attach/);
		expect(staleReviverRuns).toBe(0);
	});

	// The negative control for the refusal above, and the reason it keys on the
	// handoff's OUTCOME rather than on a barrier having been waited out at all.
	// A recycle that reattached cleanly must release its waiters into a normal
	// revive; refusing them too would satisfy "never revive onto a dead parent"
	// by breaking revival across every recycle.
	//
	// Also covers the caller who needs no reviver: an agent still holding a live
	// session is handed back even after a failed handoff, since it borrows
	// nothing from the parent that failed to return and refusing it would throw
	// away work the recycle never touched.
	it("still revives after a recycle that reattached, and keeps a live session across one that did not", async () => {
		const revived = makeSessionStub();
		const ref = registerIdleSub("Handoff-OK", makeSessionStub().session);
		lifecycle.adopt("Handoff-OK", { idleTtlMs: 0, revive: async () => revived.session }, ref);
		// The replacement parent's factory, which the reattachment installs — the
		// only route back once the recycle marked the spawn-time closure stale.
		lifecycle.setPersistedSubagentReviverFactory(async () => async () => revived.session, 0);

		const release = await lifecycle.parkAll();
		const send = lifecycle.ensureLive("Handoff-OK");
		// Default outcome is a successful reattachment, the ordinary recycle.
		release();
		await expect(send).resolves.toBe(revived.session);

		// A second recycle that FAILS, with an agent that is still live: it needs
		// no reviver, so the refusal must not reach it.
		const live = makeSessionStub();
		registerIdleSub("Handoff-Failed-Live", live.session);
		const failing = await lifecycle.parkAll();
		const liveSend = lifecycle.ensureLive("Handoff-Failed-Live");
		failing("failed");
		await expect(liveSend).resolves.toBe(live.session);
		expect(live.disposeCalls()).toBe(0);
	});

	// The failure is a CONDITION, not an event a caller has to be present for. A
	// recycle that produced no replacement disposed the shared MCP, kernels and
	// session every parked child would be rebuilt on, and those stay gone after
	// its barrier has lifted — so the very next hub send, arriving with nothing
	// live to wait on, is in exactly the position of the waiter that was refused.
	//
	// A refusal expressed as a delta cannot cover it: the state a call compares
	// against is sampled when the call STARTS, so one starting after the failure
	// settled already carries it in its own baseline, reads no movement, and
	// proceeds.
	//
	// The route it proceeds through is the RECYCLED parent's own factory.
	// parkAll() deliberately leaves the installed factory in place — clearing it
	// would strand a revive requested mid-recycle — so after a failed handoff the
	// factory still belongs to the parent that went away, and the stale-closure
	// refusal never fires because a factory did produce a reviver. Only the
	// retained failed state stops this.
	//
	// Event-gated: the release is an explicit call, and the send is launched only
	// after it, with no barrier and no park in flight.
	//
	// RED (pre-fix): resolves through the recycled parent's factory — the
	// entry-time sample already included the failure.
	it("refuses a revival that starts after the failed handoff has already settled", async () => {
		const stale = makeSessionStub();
		const ref = registerIdleSub("Retained-Failed", makeSessionStub().session);
		let staleReviverRuns = 0;
		let staleFactoryRuns = 0;
		lifecycle.adopt(
			"Retained-Failed",
			{
				idleTtlMs: 0,
				revive: async () => {
					staleReviverRuns++;
					return stale.session;
				},
			},
			ref,
		);
		// The RECYCLED parent's factory, installed before its own teardown — the
		// one parkAll() leaves behind.
		lifecycle.setPersistedSubagentReviverFactory(async () => {
			staleFactoryRuns++;
			return async () => stale.session;
		}, 0);

		// The whole recycle completes with nobody waiting on it.
		(await lifecycle.parkAll())("failed");
		await flushAsync();
		expect(registry.get("Retained-Failed")?.status).toBe("parked");

		// A fresh send, entering a manager with no barrier and no park live.
		await expect(lifecycle.ensureLive("Retained-Failed")).rejects.toThrow(/replacement failed to attach/);
		expect(staleReviverRuns).toBe(0);
		expect(staleFactoryRuns).toBe(0);
		expect(registry.get("Retained-Failed")?.status).toBe("parked");
	});

	// What the retained refusal must NOT accept as "the dependencies are live
	// again". A later recycle that reattached cleanly rebuilds nothing the
	// earlier failure disposed: parking children is a transition on THIS
	// manager's own records, and a clean release only says the caller of that
	// second handoff got its own parent back — not that the first failure's
	// orphaned children have one. Clearing on it would reopen revival onto
	// exactly the dead resources the refusal exists to keep children off.
	//
	// RED (pre-fix): resolves through the recycled parent's factory, for the same
	// entry-time-sample reason as above.
	it("keeps a failed handoff retained across a later recycle that released cleanly", async () => {
		const stale = makeSessionStub();
		const ref = registerIdleSub("Retained-Across-Clean", makeSessionStub().session);
		let staleFactoryRuns = 0;
		lifecycle.adopt("Retained-Across-Clean", { idleTtlMs: 0, revive: async () => stale.session }, ref);
		lifecycle.setPersistedSubagentReviverFactory(async () => {
			staleFactoryRuns++;
			return async () => stale.session;
		}, 0);

		(await lifecycle.parkAll())("failed");
		await flushAsync();

		// A second, entirely clean recycle. It installs no factory of its own, so
		// it brings no replacement for the dependencies the first one destroyed.
		(await lifecycle.parkAll())();
		await flushAsync();

		await expect(lifecycle.ensureLive("Retained-Across-Clean")).rejects.toThrow(/replacement failed to attach/);
		expect(staleFactoryRuns).toBe(0);
	});

	// The other direction, and the reason the refusal is retained rather than
	// permanent: it has to end, and it ends on the one event that proves the
	// revival dependencies are live again. Installing a persisted-subagent
	// reviver factory IS a live parent binding them to itself — the factory is
	// built from that session's auth, models, MCP and artifact managers — which
	// is exactly what a host does after answering the refusal by rebuilding a
	// parent. Nothing weaker qualifies, which is what the test above pins.
	//
	// The rebind is a re-admission, not an amnesty: the recycle marked the
	// spawn-time closure stale and clearing the refusal must not unmark it, so
	// the revival it lets through still goes via the factory.
	//
	// RED (over-broad latch): the refusal never lifts and this rejects, leaving
	// every later send stranded on a manager that has a live parent.
	it("lifts a retained failed handoff once a replacement installs its reviver factory", async () => {
		const stale = makeSessionStub();
		const replacement = makeSessionStub();
		const ref = registerIdleSub("Retained-Rebound", makeSessionStub().session);
		let staleReviverRuns = 0;
		let factoryReviverRuns = 0;
		lifecycle.adopt(
			"Retained-Rebound",
			{
				idleTtlMs: 0,
				revive: async () => {
					staleReviverRuns++;
					return stale.session;
				},
			},
			ref,
		);

		(await lifecycle.parkAll())("failed");
		await flushAsync();
		await expect(lifecycle.ensureLive("Retained-Rebound")).rejects.toThrow(/replacement failed to attach/);

		// The host rebuilds a parent and it installs its own factory.
		lifecycle.setPersistedSubagentReviverFactory(async () => {
			return async () => {
				factoryReviverRuns++;
				return replacement.session;
			};
		}, 0);

		expect(await lifecycle.ensureLive("Retained-Rebound")).toBe(replacement.session);
		expect(factoryReviverRuns).toBe(1);
		// Re-admitted through the replacement, never through the closure the
		// failed recycle invalidated.
		expect(staleReviverRuns).toBe(0);
		expect(registry.get("Retained-Rebound")?.session).toBe(replacement.session);
	});

	// An adopted subagent's reviver is built by the task executor at spawn time
	// and closes over THAT parent's spawn-time dependencies (its MCP manager,
	// artifact manager, session). parkAll() deliberately retains the adoption
	// across a parent recycle so the child stays addressable — but the parent
	// whose teardown drove the recycle then disconnects exactly those
	// dependencies. A revival that still prefers the retained closure therefore
	// rebuilds the child against the DISPOSED parent, while the replacement
	// parent's persisted-reviver factory — installed precisely to source those
	// dependencies — goes unused.
	//
	// The observable contract is which reviver produced the session: after the
	// recycle it must be the replacement's, so the child's dependencies have one
	// source of truth instead of a live parent beside a dead closure.
	//
	// RED (pre-fix): resolves to `staleParentSession` — the retained reviver won
	// and the factory was never consulted.
	it("revives through the replacement parent's factory, not the reviver captured before a recycle", async () => {
		const stale = makeSessionStub();
		const replacement = makeSessionStub();
		const ref = registerIdleSub("Recycle-Rebind", makeSessionStub().session);
		let staleReviverRuns = 0;
		let factoryReviverRuns = 0;
		lifecycle.adopt(
			"Recycle-Rebind",
			{
				idleTtlMs: 0,
				revive: async () => {
					staleReviverRuns++;
					return stale.session;
				},
			},
			ref,
		);

		// The recycle: park every child, then the replacement parent installs its
		// own factory exactly as the post-restart bootstrap does.
		(await lifecycle.parkAll())();
		lifecycle.setPersistedSubagentReviverFactory(async () => {
			return async () => {
				factoryReviverRuns++;
				return replacement.session;
			};
		}, 0);

		expect(await lifecycle.ensureLive("Recycle-Rebind")).toBe(replacement.session);
		expect(factoryReviverRuns).toBe(1);
		expect(staleReviverRuns).toBe(0);
		expect(registry.get("Recycle-Rebind")?.session).toBe(replacement.session);

		// And the rebind is durable, not a one-shot: the record now holds the
		// replacement's reviver, so a later TTL park + revive uses it too rather
		// than falling back to the closure the recycle invalidated.
		await lifecycle.park("Recycle-Rebind");
		expect(registry.get("Recycle-Rebind")?.status).toBe("parked");
		expect(await lifecycle.ensureLive("Recycle-Rebind")).toBe(replacement.session);
		expect(factoryReviverRuns).toBe(2);
		expect(staleReviverRuns).toBe(0);
	});

	// The retained reviver is not a fallback: it closes over the recycled
	// parent's MCP manager, artifact manager and session, all disposed by the
	// teardown that drove the recycle. A host following the documented
	// reconstruction with `createAgentSession` installs no factory, so this is
	// the ORDINARY state on the SDK path — and reviving through the closure
	// there hands back a session whose first tool call fails with nothing to
	// retry. Refusing keeps the transcript readable and the ref parked for a
	// later revival once a factory exists.
	//
	// RED (pre-fix): ensureLive resolved to the stale reviver's session.
	it("refuses a stale reviver across a recycle rather than reviving on disposed resources", async () => {
		const retained = makeSessionStub();
		const ref = registerIdleSub("Recycle-NoFactory", makeSessionStub().session);
		lifecycle.adopt("Recycle-NoFactory", { idleTtlMs: 0, revive: async () => retained.session }, ref);

		(await lifecycle.parkAll())();

		await expect(lifecycle.ensureLive("Recycle-NoFactory")).rejects.toThrow(/has been recycled/);
		// The ref survives the refusal: a factory installed later must still be
		// able to bring the agent back.
		expect(registry.get("Recycle-NoFactory")?.status).toBe("parked");

		// A factory that DECLINES this ref is the same situation — declining is
		// not a licence to use the closure.
		lifecycle.setPersistedSubagentReviverFactory(async () => undefined, 0);
		await expect(lifecycle.ensureLive("Recycle-NoFactory")).rejects.toThrow(/has been recycled/);

		// And the refusal is not terminal: a factory that DOES answer revives it.
		const rebuilt = makeSessionStub();
		lifecycle.setPersistedSubagentReviverFactory(async () => async () => rebuilt.session, 0);
		expect(await lifecycle.ensureLive("Recycle-NoFactory")).toBe(rebuilt.session);
	});

	// Scope check on the other side: an adoption that never crossed a recycle
	// must keep using its own reviver. The executor's live reviver is the correct
	// source while its parent is alive, and a factory installed by that same
	// parent must not displace it — preferring the factory unconditionally would
	// rebuild every TTL-parked child from its persisted JSONL instead of the
	// contract the live run captured.
	it("keeps using the adopted reviver when no recycle has happened", async () => {
		const adopted = makeSessionStub();
		const factoryBuilt = makeSessionStub();
		const ref = registerIdleSub("No-Recycle", makeSessionStub().session);
		let factoryCalls = 0;
		lifecycle.setPersistedSubagentReviverFactory(async () => {
			factoryCalls++;
			return async () => factoryBuilt.session;
		}, 0);
		lifecycle.adopt("No-Recycle", { idleTtlMs: 0, revive: async () => adopted.session }, ref);

		await lifecycle.park("No-Recycle");
		expect(await lifecycle.ensureLive("No-Recycle")).toBe(adopted.session);
		expect(factoryCalls).toBe(0);
	});

	// An adoption can hold NO reviver at all: `adopt` stores `revive: undefined`
	// for an isolated or worktree subagent, which is never resumable from its own
	// run. Such a record is not a stale-closure case, so a factory revival must
	// COLD-ADOPT it — taking the persisted-revive TTL rather than the dead run's
	// idle TTL, and arming the poisoned-reviver cleanup that drops the record when
	// a first factory revival fails. Rebinding it in place instead would keep the
	// wrong TTL and strand a failed reviver in the adoption map.
	it("cold-adopts a reviver-less adoption through the factory instead of rebinding it", async () => {
		const built = makeSessionStub();
		const ref = registerIdleSub("No-Reviver", makeSessionStub().session);
		let factoryCalls = 0;
		let failNext = true;
		lifecycle.setPersistedSubagentReviverFactory(async () => {
			factoryCalls++;
			if (failNext) {
				failNext = false;
				return async () => {
					throw new Error("cold revive failed");
				};
			}
			return async () => built.session;
		}, 0);
		lifecycle.adopt("No-Reviver", { idleTtlMs: 0, revive: undefined }, ref);
		await lifecycle.park("No-Reviver");

		// A failed cold revive must not leave the produced reviver behind on the
		// record; the next ensureLive has to consult the factory again.
		await expect(lifecycle.ensureLive("No-Reviver")).rejects.toThrow("cold revive failed");
		expect(factoryCalls).toBe(1);

		expect(await lifecycle.ensureLive("No-Reviver")).toBe(built.session);
		expect(factoryCalls).toBe(2);
	});
});
