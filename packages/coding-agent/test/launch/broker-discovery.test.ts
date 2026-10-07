// Real private broker, socket requests, child exits, and production wait consumers.
// Only project resolution and response delivery gates are substituted.
import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as clients from "../../src/launch/client";
import type { DaemonBrokerClient } from "../../src/launch/client";
import type { ToolSession } from "../../src/tools";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import * as services from "../../src/launch/services";
import { WaitTool } from "../../src/tools/wait";
import { IrcBus } from "../../src/irc/bus";
import { AgentRegistry } from "../../src/registry/agent-registry";

interface Fixture {
	client: DaemonBrokerClient;
	session: ToolSession;
	projectDir: string;
	runtimeDir: string;
	owner: string;
	change: Array<() => void>;
}
async function withBroker(run: (fixture: Fixture) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-broker-regression-"));
	const projectDir = path.join(root, "project");
	const runtimeDir = path.join(root, "runtime");
	await fs.mkdir(projectDir);
	const client = await clients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5000 });
	const previousTitle = process.title;
	const env = { OMP_DAEMON_PROJECT_DIR: projectDir, OMP_DAEMON_RUNTIME_DIR: runtimeDir, OMP_DAEMON_IDLE_GRACE_MS: "5000" };
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) { previous.set(key, process.env[key]); process.env[key] = value; }
	const listening = Promise.withResolvers<void>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve() });
	for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	const dispose: Array<() => void> = [];
	const change: Array<() => void> = [];
	const owner = crypto.randomUUID();
	const session: ToolSession = {
		cwd: projectDir, hasUI: false, settings: Settings.isolated({ "launch.enabled": true }),
		getSessionFile: () => null, getSessionSpawns: () => "*", getAgentId: () => owner, getSessionId: () => owner,
		registerDisposeCallback: callback => { dispose.push(callback); },
		registerSessionChangeCallback: callback => { change.push(callback); },
	};
	try {
		await Promise.race([listening.promise, finished.then(() => { throw new Error("Private broker exited before listening"); })]);
		vi.spyOn(clients, "daemonClientForProject").mockResolvedValue(client);
		await run({ client, session, projectDir, runtimeDir, owner, change });
	} finally {
		vi.restoreAllMocks();
		for (const callback of dispose) callback();
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
		await finished;
		process.title = previousTitle;
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function startOwned(f: Fixture, name: string): Promise<void> {
	await f.client.request({ op: "start", owner: f.owner, spec: {
		name, application: process.execPath, args: ["-e", "console.log('service-ready'); process.stdin.once('data', () => process.exit(0));"],
		env: {}, cwd: f.projectDir, pty: false, ready: { log: "service-ready", timeoutMs: 5000 }, restart: "no", persist: false, detached: false,
	} });
}

function holdResponse(client: DaemonBrokerClient, op: "list" | "start") {
	const received = Promise.withResolvers<void>();
	void received.promise.catch(() => undefined);
	const release = Promise.withResolvers<void>();
	const request = client.request.bind(client);
	let held = false;
	let signal: AbortSignal | undefined;
	const spy = vi.spyOn(client, "request").mockImplementation(async (operation, requestSignal) => {
		if (operation.op !== op || held) return request(operation, requestSignal);
		held = true;
		signal = requestSignal;
		try {
			const result = await request(operation, requestSignal);
			received.resolve();
			await release.promise;
			return result;
		} catch (error) {
			received.reject(error);
			throw error;
		}
	});
	return { received: received.promise, release: release.resolve, restore: () => spy.mockRestore(), get signal() { return signal; } };
}

// Event-driven success; a bounded watchdog releases gates even on pristine failure.
async function beforeRelease<T>(release: () => void, result: Promise<T>): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		deadline.reject(new Error("Result did not precede discovery gate release"));
		release();
	}, 2000);
	try { return await Promise.race([result, deadline.promise]); }
	finally { clearTimeout(timer); release(); }
}

async function terminalListBeforeCompletion(f: Fixture, keepOtherService: boolean): Promise<void> {
	const completionReceived = Promise.withResolvers<void>();
	const completionRelease = Promise.withResolvers<void>();
	const onCompletion = f.client.onCompletion.bind(f.client);
	vi.spyOn(f.client, "onCompletion").mockImplementation((owner, sink) =>
		onCompletion(owner, async notification => {
			completionReceived.resolve();
			await completionRelease.promise;
			await sink(notification);
		}),
	);
	await startOwned(f, "exiting");
	if (keepOtherService) await startOwned(f, "still-live");
	await services.listServices(f.session);
	const listEntered = Promise.withResolvers<void>();
	const listRelease = Promise.withResolvers<void>();
	const request = f.client.request.bind(f.client);
	let held = false;
	vi.spyOn(f.client, "request").mockImplementation(async (operation, signal) => {
		if (operation.op === "list" && !held) {
			held = true;
			listEntered.resolve();
			await listRelease.promise;
		}
		return request(operation, signal);
	});
	const controller = new AbortController();
	const waiting = new WaitTool(f.session).execute("terminal-list", {}, controller.signal);
	try {
		await listEntered.promise;
		await f.client.request({ op: "send", name: "exiting", data: "finish\n" });
		// The broker has truly settled and sent completion; only its consumer
		// delivery is held, so discovery now reads a real terminal snapshot.
		await completionReceived.promise;
		listRelease.resolve();
		const result = await beforeRelease(completionRelease.resolve, waiting);
		expect(result.content.some(block => block.type === "text" && /service finished/i.test(block.text))).toBe(true);
		expect(services.hasLiveOwnedService(f.session)).toBe(keepOtherService);
	} finally {
		controller.abort();
		listRelease.resolve();
		completionRelease.resolve();
		await waiting.catch(() => undefined);
	}
}

describe("broker discovery and session generations", () => {
	test("same-scope session invalidation does not suppress the next real discovery", () => withBroker(async f => {
		await startOwned(f, "resumable");
		const gate = holdResponse(f.client, "list");
		const tool = new WaitTool(f.session);
		const stale = tool.execute("invalidated-discovery", {});
		const outcome = stale.then(() => undefined, (error: unknown) => error);
		await gate.received;
		for (const callback of f.change) callback();
		gate.release();
		expect(await outcome).toBeInstanceOf(Error);
		gate.restore();

		const freshGate = holdResponse(f.client, "list");
		const installed = Promise.withResolvers<void>();
		const waitForCompletion = services.waitForOwnedServiceCompletion;
		vi.spyOn(services, "waitForOwnedServiceCompletion").mockImplementation((...args) => {
			const result = waitForCompletion(...args);
			installed.resolve();
			return result;
		});
		const controller = new AbortController();
		const fresh = tool.execute("same-scope-rediscovery", {}, controller.signal);
		void fresh.catch(() => undefined);
		try {
			await beforeRelease(freshGate.release, freshGate.received);
			await beforeRelease(freshGate.release, installed.promise);
			await f.client.request({ op: "send", name: "resumable", data: "finish\n" });
			const result = await fresh;
			expect(result.content.some(block => block.type === "text" && /service finished/i.test(block.text))).toBe(true);
			expect(services.hasLiveOwnedService(f.session)).toBe(false);
		} finally {
			controller.abort();
			freshGate.release();
			await fresh.catch(() => undefined);
		}
	}));
	test("terminal discovery wakes the service waiter before its delayed completion", () =>
		withBroker(f => terminalListBeforeCompletion(f, false)),
	);
	test("terminal discovery reports an exit even when another owned service stays live", () =>
		withBroker(f => terminalListBeforeCompletion(f, true)),
	);
	test("connection-cancel-sends-nothing-and-shared-connect-survives", () => withBroker(async f => {
		const controller = new AbortController();
		const added = vi.spyOn(controller.signal, "addEventListener");
		const removed = vi.spyOn(controller.signal, "removeEventListener");
		const cancelled = f.client.request({ op: "start", spec: {
			name: "must-not-start", application: process.execPath, args: ["-e", "process.stdin.resume()"], env: {}, cwd: f.projectDir,
			pty: false, restart: "no", persist: false, detached: false,
		} }, controller.signal);
		const sibling = f.client.request({ op: "list" });
		controller.abort();
		await expect(cancelled).rejects.toThrow("request aborted");
		const listed = await sibling;
		if (listed.op !== "list") throw new Error("Expected real list");
		expect(listed.daemons.some(d => d.name === "must-not-start")).toBe(false);
		for (const [event, listener] of added.mock.calls)
			expect(removed.mock.calls.some(([name, callback]) => name === event && callback === listener)).toBe(true);
		expect((await f.client.request({ op: "ping" })).op).toBe("ping");
	}));
	test("hung-discovery-does-not-block-local-job", () => withBroker(async f => {
		const gate = holdResponse(f.client, "list");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = Promise.withResolvers<string>();
		f.session.asyncJobManager = manager;
		const id = manager.register("bash", "owned-build", () => job.promise, { ownerId: f.owner });
		const waiting = new WaitTool(f.session).execute("job", {});
		try {
			await gate.received;
			job.resolve("owned build completed");
			const result = await beforeRelease(gate.release, waiting);
			expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "owned build completed" });
			expect(gate.signal?.aborted).toBe(true);
			expect(manager.isJobResultConsumed(id)).toBe(true);
		} finally { gate.release(); job.resolve("cleanup"); await waiting.catch(() => undefined); await manager.dispose(); }
	}));
	test("hung-discovery-does-not-block-accepted-completion", () => withBroker(async f => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		f.session.asyncJobManager = manager;
		const id = manager.register("bash", "settled", async () => "accepted completion", { ownerId: f.owner });
		await manager.waitForAll();
		const gate = holdResponse(f.client, "list");
		try {
			const result = await beforeRelease(gate.release, new WaitTool(f.session).execute("accepted", {}));
			expect(result.details?.jobs?.[0]?.id).toBe(id);
		} finally { gate.release(); await manager.dispose(); }
	}));
	test("hung-discovery-does-not-block-real-message", () => withBroker(async f => {
		const registry = AgentRegistry.global();
		registry.register({ id: f.owner, displayName: "isolated waiter", kind: "sub", session: null });
		f.session.agentRegistry = registry;
		const gate = holdResponse(f.client, "list");
		const controller = new AbortController();
		const installed = Promise.withResolvers<void>();
		const bus = IrcBus.global();
		const original = bus.wait.bind(bus);
		vi.spyOn(bus, "wait").mockImplementation((...args) => { const result = original(...args); installed.resolve(); return result; });
		const waiting = new WaitTool(f.session).execute("message", {}, controller.signal);
		try {
			await gate.received;
			const driven = (async () => {
				await installed.promise;
				await bus.send({ from: "isolated-peer", to: f.owner, body: "directly consumed" }, { suppressRelay: true });
				return waiting;
			})();
			const result = await beforeRelease(gate.release, driven);
			expect(result.details?.waited?.body).toBe("directly consumed");
		} finally { controller.abort(); gate.release(); await waiting.catch(() => undefined); registry.unregister(f.owner); }
	}));
	test("hung-discovery-does-not-block-real-service-exit", () => withBroker(async f => {
		await startOwned(f, "service");
		await services.listServices(f.session);
		const gate = holdResponse(f.client, "list");
		const controller = new AbortController();
		const waiting = new WaitTool(f.session).execute("exit", {}, controller.signal);
		try {
			await gate.received;
			await f.client.request({ op: "send", name: "service", data: "finish\n" });
			const result = await beforeRelease(gate.release, waiting);
			expect(result.content.some(b => b.type === "text" && /service finished/i.test(b.text))).toBe(true);
			expect(services.hasLiveOwnedService(f.session)).toBe(false);
		} finally { controller.abort(); gate.release(); await waiting.catch(() => undefined); }
	}));
	test("wait-caller-abort-races-discovery-without-stopping-service", () => withBroker(async f => {
		await startOwned(f, "survivor");
		await services.listServices(f.session);
		const gate = holdResponse(f.client, "list");
		const controller = new AbortController();
		const waiting = new WaitTool(f.session).execute("cancel", {}, controller.signal);
		const outcome = waiting.then(
			() => { throw new Error("Cancelled wait unexpectedly returned a result"); },
			(error: unknown) => error,
		);
		try {
			await gate.received;
			controller.abort();
			const error = await beforeRelease(gate.release, outcome);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).name).toBe("ToolAbortError");
			expect(gate.signal?.aborted).toBe(true);
			gate.restore();
			const current = await f.client.request({ op: "list" });
			if (current.op !== "list") throw new Error("Expected real list");
			expect(current.daemons.find(d => d.name === "survivor")?.state).toBe("ready");
		} finally { controller.abort(); gate.release(); await waiting.catch(() => undefined); }
	}));
	test("failed discovery does not claim last-known services are current", () => withBroker(async f => {
		await startOwned(f, "last-known");
		await services.listServices(f.session);
		const closed = await clients.createDaemonBrokerClient(f.projectDir, { runtimeDir: f.runtimeDir });
		closed.close();
		vi.spyOn(clients, "daemonClientForProject").mockResolvedValue(closed);
		await expect(new WaitTool(f.session).execute("failure", {}, AbortSignal.timeout(2000))).rejects.toThrow("Last-known service state is not current");
	}));
	test("late-list-cannot-resurrect-completed-generation", () => withBroker(async f => {
		await startOwned(f, "first"); await startOwned(f, "second"); await services.listServices(f.session);
		const gate = holdResponse(f.client, "list");
		const listed = services.listServices(f.session);
		try {
			await gate.received;
			const exited = services.waitForOwnedServiceCompletion(f.session);
			await f.client.request({ op: "send", name: "first", data: "finish\n" }); await exited;
			gate.release(); await listed;
			expect(services.hasLiveOwnedService(f.session)).toBe(true);
			const other = services.waitForOwnedServiceCompletion(f.session);
			await f.client.request({ op: "send", name: "second", data: "finish\n" }); await other;
			expect(services.hasLiveOwnedService(f.session)).toBe(false);
		} finally { gate.release(); await listed.catch(() => undefined); }
	}));
	test("late-list-rejected-after-session-generation-change", () => withBroker(async f => {
		await startOwned(f, "previous"); await services.listServices(f.session);
		const gate = holdResponse(f.client, "list");
		const listed = services.listServices(f.session);
		const outcome = listed.then(() => undefined, (error: unknown) => error);
		await gate.received;
		// Same owner id but a different session revision must still reject stale state.
		for (const callback of f.change) callback();
		gate.release();
		expect(await outcome).toBeInstanceOf(Error);
		expect(services.hasLiveOwnedService(f.session)).toBe(false);
	}));
	test("late-start-cannot-overwrite-newer-replacement", () => withBroker(async f => {
		vi.spyOn(f.session.settings, "getShellConfig").mockReturnValue({ shell: process.execPath, args: ["-e"], env: {}, prefix: undefined });
		const start = { name: "replace", command: "console.log('ready'); process.stdin.once('data', () => process.exit(0));", pty: false, ready: { log: "ready", timeout: 5 } };
		const gate = holdResponse(f.client, "start");
		const older = services.startService(f.session, start);
		try {
			await gate.received;
			const newer = await services.startService(f.session, start);
			gate.release();
			const late = await older;
			expect(late.daemon.id).not.toBe(newer.daemon.id);
			gate.restore();
			const controller = new AbortController();
			const exited = services.waitForOwnedServiceCompletion(f.session, controller.signal);
			await f.client.request({ op: "send", name: "replace", data: "finish\n" });
			await beforeRelease(() => controller.abort(), exited);
			expect(services.hasLiveOwnedService(f.session)).toBe(false);
		} finally { gate.release(); await older.catch(() => undefined); }
	}));
	test("late-start-rejected-after-session-generation-change", () => withBroker(async f => {
		vi.spyOn(f.session.settings, "getShellConfig").mockReturnValue({ shell: process.execPath, args: ["-e"], env: {}, prefix: undefined });
		const gate = holdResponse(f.client, "start");
		const older = services.startService(f.session, { name: "old-start", command: "console.log('ready'); process.stdin.resume();", pty: false, ready: { log: "ready", timeout: 5 } });
		const outcome = older.then(() => undefined, (error: unknown) => error);
		await gate.received;
		f.session.getSessionId = () => "new-owner";
		for (const callback of f.change) callback();
		gate.release();
		expect(await outcome).toBeInstanceOf(Error);
		expect(services.hasLiveOwnedService(f.session)).toBe(false);
	}));
});
