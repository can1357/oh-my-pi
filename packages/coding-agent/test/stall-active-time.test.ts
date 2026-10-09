import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AgentRegistry, MAIN_AGENT_ID, type AgentKind } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ACTIVE_TIME_CUSTOM_TYPE, readActiveTime } from "@oh-my-pi/pi-coding-agent/session/active-time";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function assistantMessage(text = "completed turn") {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/** Exercise the AgentSession observer contract with real transcript persistence. */
function observableSession(initialManager = SessionManager.inMemory(), initiallyStreaming = false) {
	let manager = initialManager;
	let streaming = initiallyStreaming;
	let disposed = false;
	const runStateListeners = new Set<(state: "running" | "idle") => void>();
	const sessionChangeListeners = new Set<() => void>();
	const disposers: Array<() => void> = [];
	const session = {
		get sessionManager() {
			return manager;
		},
		get isStreaming() {
			return streaming;
		},
		get isDisposed() {
			return disposed;
		},
		subscribeRunState(listener: (state: "running" | "idle") => void) {
			runStateListeners.add(listener);
			return () => runStateListeners.delete(listener);
		},
		registerSessionChangeCallback(listener: () => void) {
			sessionChangeListeners.add(listener);
			return () => sessionChangeListeners.delete(listener);
		},
		addDisposer(dispose: () => void) {
			disposers.push(dispose);
		},
		async dispose() {
			disposed = true;
			for (const dispose of disposers.splice(0)) dispose();
			streaming = false;
		},
	} as unknown as AgentSession;
	return {
		session,
		runStateListeners,
		sessionChangeListeners,
		disposers,
		emitRunState(state: "running" | "idle", isStreaming = state === "running") {
			streaming = isStreaming;
			for (const listener of runStateListeners) listener(state);
		},
		changeSession(next: SessionManager) {
			manager = next;
			for (const listener of sessionChangeListeners) listener();
		},
	};
}

function activeSnapshots(manager: SessionManager) {
	return manager
		.getBranch()
		.filter(entry => entry.type === "custom" && entry.customType === ACTIVE_TIME_CUSTOM_TYPE)
		.map(entry => (entry.type === "custom" ? entry.data : undefined));
}

describe("durable true running-window telemetry", () => {
	let registry: AgentRegistry;
	let now: number;
	const tempDirs: TempDir[] = [];
	const persistedManagers: SessionManager[] = [];

	beforeEach(() => {
		registry = new AgentRegistry();
		now = 1_000;
		spyOn(Date, "now").mockImplementation(() => now);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(persistedManagers.splice(0).map(manager => manager.close()));
		await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
	});

	function register(id: string, session: AgentSession, kind: AgentKind = "sub") {
		return registry.register({ id, displayName: id, kind, session, status: "running" });
	}

	it("distinguishes fresh/user-only history from older assistant history without telemetry", () => {
		const manager = SessionManager.inMemory();
		expect(readActiveTime(manager.getBranch())).toEqual({ durationMs: 0, historicalUnavailable: false });
		manager.appendMessage({ role: "user", content: "queued", timestamp: now });
		expect(readActiveTime(manager.getBranch())).toEqual({ durationMs: 0, historicalUnavailable: false });
		manager.appendMessage(assistantMessage());
		expect(readActiveTime(manager.getBranch())).toEqual({ durationMs: 0, historicalUnavailable: true });
	});

	it("restores the latest cumulative snapshot without summing snapshots or using entry wall timestamps", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(ACTIVE_TIME_CUSTOM_TYPE, {
			durationMs: 0,
			historicalUnavailable: false,
			runningSince: now,
		});
		manager.appendMessage(assistantMessage());
		manager.appendCustomEntry(ACTIVE_TIME_CUSTOM_TYPE, { durationMs: 35, historicalUnavailable: false });
		manager.appendCustomEntry(ACTIVE_TIME_CUSTOM_TYPE, { durationMs: 80, historicalUnavailable: false });
		now += 1_000_000;
		expect(readActiveTime(manager.getBranch())).toEqual({ durationMs: 80, historicalUnavailable: false });
	});

	it("marks an unclosed historical window unavailable instead of extrapolating crash/idle time", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(ACTIVE_TIME_CUSTOM_TYPE, {
			durationMs: 80,
			historicalUnavailable: false,
			runningSince: now,
		});
		now += 1_000_000;
		expect(readActiveTime(manager.getBranch())).toEqual({ durationMs: 80, historicalUnavailable: true });
		const observed = observableSession(manager);
		const ref = register("Resumed", observed.session);
		registry.syncSessionStatus(ref.id, observed.session);
		expect(ref.activeTime).toEqual({ durationMs: 80, historicalUnavailable: true });
		observed.emitRunState("running");
		expect(ref.activeTime?.runningSince).toBe(now);
		now += 20;
		observed.emitRunState("idle");
		expect(ref.activeTime).toEqual({ durationMs: 100, historicalUnavailable: true });
	});

	it("ignores malformed telemetry without allowing invalid numbers into restored totals", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(assistantMessage());
		for (const data of [
			undefined,
			{ durationMs: -1, historicalUnavailable: false },
			{ durationMs: Infinity, historicalUnavailable: false },
			{ durationMs: 1, historicalUnavailable: "false" },
			{ durationMs: 1, historicalUnavailable: false, runningSince: NaN },
		]) {
			manager.appendCustomEntry(ACTIVE_TIME_CUSTOM_TYPE, data);
		}
		expect(readActiveTime(manager.getBranch())).toEqual({ durationMs: 0, historicalUnavailable: true });
	});

	it("records Main and child run windows independently and excludes long idle gaps", () => {
		const main = observableSession();
		const child = observableSession();
		const mainRef = register(MAIN_AGENT_ID, main.session, "main");
		const childRef = registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: mainRef.id,
			rootSessionId: main.session.sessionManager.getSessionId(),
			session: child.session,
		});
		registry.syncSessionStatus(mainRef.id, main.session);
		registry.syncSessionStatus(childRef.id, child.session);
		main.emitRunState("running");
		now += 10;
		child.emitRunState("running");
		now += 20;
		main.emitRunState("idle");
		now += 15;
		child.emitRunState("idle");
		now += 100_000;
		main.emitRunState("running");
		now += 5;
		main.emitRunState("idle");
		const expected = { durationMs: 35, historicalUnavailable: false };
		expect(mainRef.activeTime).toEqual(expected);
		expect(childRef.activeTime).toEqual(expected);
		expect(mainRef.rootSessionId).toBe(main.session.sessionManager.getSessionId());
		expect(childRef.rootSessionId).toBe(mainRef.rootSessionId);
		expect(readActiveTime(main.session.sessionManager.getBranch())).toEqual(expected);
	});

	it("uses actual streaming state at attachment and does not start windows from stale registry status", () => {
		const idle = observableSession();
		const idleRef = register("IdleDespiteStatus", idle.session);
		registry.syncSessionStatus(idleRef.id, idle.session);
		now += 100_000;
		registry.setStatus(idleRef.id, "idle", idleRef);
		registry.setStatus(idleRef.id, "running", idleRef);
		expect(idleRef.activeTime).toEqual({ durationMs: 0, historicalUnavailable: false });
		expect(activeSnapshots(idle.session.sessionManager)).toHaveLength(0);

		const running = observableSession(SessionManager.inMemory(), true);
		const runningRef = register("AlreadyStreaming", running.session);
		registry.syncSessionStatus(runningRef.id, running.session);
		expect(runningRef.activeTime?.runningSince).toBe(now);
		now += 25;
		registry.setStatus(runningRef.id, "idle", runningRef);
		expect(runningRef.activeTime?.runningSince).toBe(now - 25);
		running.emitRunState("idle", true); // Prompt wrapper has not unwound yet.
		expect(runningRef.activeTime).toEqual({ durationMs: 25, historicalUnavailable: false });
	});

	it("keeps repeated SDK/executor sync and duplicate notifications idempotent", () => {
		const observed = observableSession();
		const ref = register("Worker", observed.session);
		const dispose = registry.syncSessionStatus(ref.id, observed.session);
		expect(registry.syncSessionStatus(ref.id, observed.session)).toBe(dispose);
		expect(observed.runStateListeners.size).toBe(1);
		expect(observed.sessionChangeListeners.size).toBe(1);
		expect(observed.disposers).toHaveLength(1);
		observed.emitRunState("running");
		now += 10;
		observed.emitRunState("running");
		now += 20;
		observed.emitRunState("idle");
		observed.emitRunState("idle");
		expect(ref.activeTime).toEqual({ durationMs: 30, historicalUnavailable: false });
		expect(activeSnapshots(observed.session.sessionManager)).toEqual([
			{ durationMs: 0, historicalUnavailable: false, runningSince: 1_000 },
			{ durationMs: 30, historicalUnavailable: false },
		]);
		dispose();
		dispose();
		expect(observed.runStateListeners.size).toBe(0);
		expect(observed.sessionChangeListeners.size).toBe(0);
		expect(activeSnapshots(observed.session.sessionManager)).toHaveLength(2);
	});

	it("finalizes before detaching/parking and retains cumulative time across durable revival", async () => {
		const temp = TempDir.createSync("@pi-stall-active-time-");
		tempDirs.push(temp);
		const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
		persistedManagers.push(manager);
		const observed = observableSession(manager);
		const ref = register("ParkedWorker", observed.session);
		registry.syncSessionStatus(ref.id, observed.session);
		observed.emitRunState("running");
		manager.appendMessage(assistantMessage());
		now += 40;
		expect(registry.detachSession(ref.id, observed.session)).toBe(true);
		registry.setStatus(ref.id, "parked", ref);
		expect(ref.activeTime).toEqual({ durationMs: 40, historicalUnavailable: false });
		expect(ref.session).toBeNull();
		await observed.session.dispose();
		expect(activeSnapshots(manager)).toHaveLength(2);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await manager.close();

		now += 1_000_000;
		const reopened = await SessionManager.open(sessionFile);
		persistedManagers.push(reopened);
		const revived = observableSession(reopened);
		expect(registry.attachSession(ref.id, revived.session, sessionFile, ref)).toBe(true);
		registry.syncSessionStatus(ref.id, revived.session);
		expect(ref.activeTime).toEqual({ durationMs: 40, historicalUnavailable: false });
		revived.emitRunState("running");
		now += 15;
		revived.emitRunState("idle");
		const expected = { durationMs: 55, historicalUnavailable: false };
		expect(ref.activeTime).toEqual(expected);
		expect(readActiveTime(reopened.getBranch())).toEqual(expected);
	});

	it("preserves only completed windows in a disk snapshot interrupted mid-run", async () => {
		const temp = TempDir.createSync("@pi-stall-active-crash-");
		tempDirs.push(temp);
		const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
		persistedManagers.push(manager);
		const observed = observableSession(manager);
		const ref = register("CrashedWorker", observed.session);
		registry.syncSessionStatus(ref.id, observed.session);
		observed.emitRunState("running");
		manager.appendMessage(assistantMessage());
		now += 30;
		observed.emitRunState("idle");
		now += 500;
		observed.emitRunState("running");
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const crashedFile = path.join(temp.path(), "crashed.jsonl");
		fs.writeFileSync(crashedFile, fs.readFileSync(sessionFile));
		now += 1_000_000;
		const reopened = await SessionManager.open(crashedFile);
		persistedManagers.push(reopened);
		expect(readActiveTime(reopened.getBranch())).toEqual({ durationMs: 30, historicalUnavailable: true });
		expect(ref.activeTime).toEqual({ durationMs: 30, historicalUnavailable: false, runningSince: 1_530 });
	});

	it("finalizes an observed live window once on disposal, before later detach", async () => {
		const observed = observableSession();
		const ref = register("DisposedWorker", observed.session);
		registry.syncSessionStatus(ref.id, observed.session);
		observed.emitRunState("running");
		now += 12;
		await observed.session.dispose();
		expect(ref.activeTime).toEqual({ durationMs: 12, historicalUnavailable: false });
		registry.syncSessionStatus(ref.id, observed.session);
		expect(observed.runStateListeners.size).toBe(0);
		expect(observed.disposers).toHaveLength(0);
		now += 5_000;
		registry.detachSession(ref.id, observed.session);
		await observed.session.dispose();
		expect(ref.activeTime).toEqual({ durationMs: 12, historicalUnavailable: false });
		expect(activeSnapshots(observed.session.sessionManager)).toHaveLength(2);
	});

	it("keeps older resumed history explicitly partial after recording new complete windows", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(assistantMessage("old unobserved turn"));
		const observed = observableSession(manager);
		const ref = register(MAIN_AGENT_ID, observed.session, "main");
		registry.syncSessionStatus(ref.id, observed.session);
		expect(ref.activeTime).toEqual({ durationMs: 0, historicalUnavailable: true });
		observed.emitRunState("running");
		now += 17;
		observed.emitRunState("idle");
		const expected = { durationMs: 17, historicalUnavailable: true };
		expect(ref.activeTime).toEqual(expected);
		expect(readActiveTime(manager.getBranch())).toEqual(expected);
	});

	it("isolates a session change to the new branch and updates Main tree identity", () => {
		const first = SessionManager.inMemory();
		const observed = observableSession(first);
		const ref = register(MAIN_AGENT_ID, observed.session, "main");
		registry.syncSessionStatus(ref.id, observed.session);
		observed.emitRunState("running");
		now += 20;
		observed.emitRunState("idle");
		const second = SessionManager.inMemory();
		second.appendMessage(assistantMessage("older second session"));
		observed.changeSession(second);
		expect(ref.activeTime).toEqual({ durationMs: 0, historicalUnavailable: true });
		expect(ref.rootSessionId).toBe(second.getSessionId());
		observed.emitRunState("running");
		now += 7;
		observed.emitRunState("idle");
		const expected = { durationMs: 7, historicalUnavailable: true };
		expect(ref.activeTime).toEqual(expected);
		expect(readActiveTime(first.getBranch())).toEqual({ durationMs: 20, historicalUnavailable: false });
		expect(readActiveTime(second.getBranch())).toEqual(expected);
		const fresh = SessionManager.inMemory();
		observed.changeSession(fresh);
		expect(ref.activeTime).toEqual({ durationMs: 0, historicalUnavailable: false });
		expect(ref.rootSessionId).toBe(fresh.getSessionId());
	});

	it("does not carry an open window across a session change", () => {
		const first = SessionManager.inMemory();
		const observed = observableSession(first);
		const ref = register(MAIN_AGENT_ID, observed.session, "main");
		registry.syncSessionStatus(ref.id, observed.session);
		observed.emitRunState("running");
		now += 50;
		const second = SessionManager.inMemory();
		observed.changeSession(second);
		expect(ref.activeTime).toEqual({ durationMs: 0, historicalUnavailable: false, runningSince: now });
		now += 9;
		observed.emitRunState("idle");
		const expected = { durationMs: 9, historicalUnavailable: false };
		expect(ref.activeTime).toEqual(expected);
		expect(readActiveTime(first.getBranch())).toEqual({ durationMs: 0, historicalUnavailable: true });
		expect(readActiveTime(second.getBranch())).toEqual(expected);
	});

	it("stops an old generation before replacement and ignores its later notifications", () => {
		const old = observableSession();
		const previous = register("Worker", old.session);
		registry.syncSessionStatus(previous.id, old.session);
		old.emitRunState("running");
		now += 10;
		const next = observableSession();
		const current = register("Worker", next.session);
		registry.syncSessionStatus(current.id, next.session);
		expect(previous.activeTime).toEqual({ durationMs: 10, historicalUnavailable: false });
		expect(old.runStateListeners.size).toBe(0);
		now += 10;
		old.emitRunState("idle");
		old.emitRunState("running");
		expect(current.activeTime).toEqual({ durationMs: 0, historicalUnavailable: false });
		next.emitRunState("running");
		now += 3;
		expect(registry.unregister(current.id, current)).toBe(true);
		expect(current.activeTime).toEqual({ durationMs: 3, historicalUnavailable: false });
		expect(next.runStateListeners.size).toBe(0);
	});

	it("emits attachment metadata after exposing the live session to scope observers", () => {
		const observed = observableSession();
		const ref = registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			rootSessionId: "owning-main-session",
			session: null,
		});
		const attached: AgentSession[] = [];
		registry.onChange(event => {
			if (event.type === "metadata_changed" && event.ref === ref && ref.session) attached.push(ref.session);
		});
		expect(registry.attachSession(ref.id, observed.session, null, ref)).toBe(true);
		expect(attached).toEqual([observed.session]);
		expect(ref.rootSessionId).toBe("owning-main-session");
	});
});
