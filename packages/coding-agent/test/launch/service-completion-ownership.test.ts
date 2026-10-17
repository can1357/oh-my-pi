import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { convertToLlm } from "../../src/session/messages";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { Settings } from "../../src/config/settings";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import * as brokerClients from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
} from "../../src/launch/protocol";
import { listServices, sendService, startService, waitForOwnedServiceCompletion } from "../../src/launch/services";
import type { ToolSession } from "../../src/tools";

interface EmbeddedBroker {
	/** Settles once this in-process broker has shut down and flushed its metadata. */
	finished: Promise<void>;
}

/**
 * Start the in-process broker and wait until it accepts connections. A client
 * that connects earlier spawns a broker process, which can claim the scope in a
 * broker-restart handoff; `finished` would then not track the broker that
 * flushes the metadata these tests read.
 */
async function startBroker(projectDir: string, runtimeDir: string): Promise<EmbeddedBroker> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve(true) });
	if (previousProjectDir === undefined) delete process.env[DAEMON_PROJECT_DIR_ENV];
	else process.env[DAEMON_PROJECT_DIR_ENV] = previousProjectDir;
	if (previousRuntimeDir === undefined) delete process.env[DAEMON_RUNTIME_DIR_ENV];
	else process.env[DAEMON_RUNTIME_DIR_ENV] = previousRuntimeDir;
	if (previousGrace === undefined) delete process.env[DAEMON_IDLE_GRACE_ENV];
	else process.env[DAEMON_IDLE_GRACE_ENV] = previousGrace;
	const claimed = await Promise.race([listening.promise, finished.then(() => false)]);
	if (!claimed) throw new Error("In-process daemon broker did not claim its scope");
	return { finished };
}

describe("session-owned supervised services", () => {
	it("delivers a failed service only to its session when another session shares the broker", async () => {
		using tempDir = TempDir.createSync("@omp-service-completion-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = await startBroker(projectDir, runtimeDir);
		const settings = Settings.isolated();
		const firstCompletions: DaemonCompletionNotification[] = [];
		const secondCompletions: DaemonCompletionNotification[] = [];
		const delivered = Promise.withResolvers<string>();
		const makeSession = (sessionId: string, completions: DaemonCompletionNotification[]): ToolSession => ({
			cwd: projectDir,
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getSessionId: () => sessionId,
			queueLaunchCompletion: notification => {
				delivered.resolve(sessionId);
				completions.push(notification);
				return Promise.resolve();
			},
		});
		const first = makeSession("first-session", firstCompletions);
		const second = makeSession("second-session", secondCompletions);
		try {
			vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
			const started = await startService(first, {
				name: "failing-service",
				command: "echo service-ready; read answer; exit 3",
				ready: { log: "service-ready", timeout: 5 },
			});
			expect(started.daemon.state).toBe("ready");
			await listServices(second);
			const firstFinished = waitForOwnedServiceCompletion(first);
			await sendService(first, "failing-service", "go\n");
			expect(await delivered.promise).toBe("first-session");
			await firstFinished;
			expect(firstCompletions.map(({ daemon }) => [daemon.name, daemon.state, daemon.exitCode])).toEqual([
				["failing-service", "failed", 3],
			]);
			expect(secondCompletions).toEqual([]);
			expect(started.daemon.owner).toBe("first-session");
		} finally {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			process.title = previousTitle;
		}
	}, 15_000);

	it("replays a completion to its session when that session is resumed after a switch", async () => {
		using tempDir = TempDir.createSync("@omp-service-transition-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = await startBroker(projectDir, runtimeDir);
		let sessionId = "old-session";
		const callbacks: Array<() => void> = [];
		const deliveries: Array<[string, DaemonCompletionNotification]> = [];
		const session: ToolSession = {
			cwd: projectDir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getSessionId: () => sessionId,
			registerSessionChangeCallback: callback => {
				callbacks.push(callback);
			},
			queueLaunchCompletion: notification => {
				deliveries.push([sessionId, notification]);
				return Promise.resolve();
			},
		};
		const switchTo = (nextSessionId: string): void => {
			sessionId = nextSessionId;
			for (const callback of callbacks) callback();
		};
		try {
			vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
			await startService(session, {
				name: "old-service",
				command: "echo service-ready; read answer; exit 3",
				ready: { log: "service-ready", timeout: 5 },
			});
			switchTo("new-session");
			await listServices(session);
			await sendService(session, "old-service", "go\n");
			const exited = await client.request({ op: "wait", name: "old-service", for: "exit", timeoutMs: 5_000 });
			if (exited.op !== "wait") throw new Error("Expected daemon exit wait");
			expect(exited.daemon.state).toBe("failed");
			expect(deliveries).toEqual([]);

			switchTo("old-session");
			// The broker writes the replay before the list response, so the sink has already run.
			await listServices(session);
			expect(
				deliveries.map(([receiver, { owner, daemon }]) => [receiver, owner, daemon.name, daemon.state]),
			).toEqual([["old-session", "old-session", "old-service", "failed"]]);
			await client.request({ op: "shutdown" });
			await broker.finished;
			const metadata = (await Bun.file(path.join(runtimeDir, "daemons", "old-service", "meta.json")).json()) as {
				pendingCompletions: DaemonCompletionNotification[];
			};
			expect(metadata.pendingCompletions).toEqual([]);
		} finally {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			process.title = previousTitle;
		}
	}, 15_000);

	it("replays a detached service exit only when its original session resumes after broker restart", async () => {
		using tempDir = TempDir.createSync("@omp-service-detached-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		let client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		let broker = await startBroker(projectDir, runtimeDir);
		let daemonPid: number | undefined;
		const laterCompletions: DaemonCompletionNotification[] = [];
		const resumedCompletions: DaemonCompletionNotification[] = [];
		const resumedDelivery = Promise.withResolvers<DaemonCompletionNotification>();
		const disposeOriginal: Array<() => void> = [];
		const makeSession = (
			sessionId: string,
			completions: DaemonCompletionNotification[],
			onDispose?: (callback: () => void) => void,
		): ToolSession => ({
			cwd: projectDir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getSessionId: () => sessionId,
			registerDisposeCallback: onDispose,
			queueLaunchCompletion: notification => {
				completions.push(notification);
				if (completions === resumedCompletions) resumedDelivery.resolve(notification);
				return Promise.resolve();
			},
		});
		try {
			vi.spyOn(brokerClients, "daemonClientForProject").mockImplementation(async () => client);
			await listServices(makeSession("original-session", [], callback => disposeOriginal.push(callback)));
			const started = await client.request({
				op: "start",
				owner: "original-session",
				spec: {
					name: "detached-service",
					application: process.execPath,
					args: ["-e", "Bun.serve({port: 0, fetch() { return new Response('ok'); } })"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: true,
					detached: true,
				},
			});
			if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("Expected detached daemon");
			daemonPid = started.daemon.pid;
			for (const dispose of disposeOriginal) dispose();
			await client.request({ op: "ping" });
			await client.request({ op: "shutdown" });
			client.close();
			await broker.finished;

			client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			broker = await startBroker(projectDir, runtimeDir);
			const running = await listServices(makeSession("later-session", laterCompletions));
			expect(running.find(daemon => daemon.name === "detached-service")?.pid).toBe(daemonPid);
			const processRef = Process.fromPid(daemonPid);
			if (!processRef) throw new Error("Recovered detached daemon disappeared");
			await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
			const exited = await client.request({ op: "wait", name: "detached-service", for: "exit", timeoutMs: 5_000 });
			if (exited.op !== "wait") throw new Error("Expected daemon exit wait");
			expect(exited.timedOut).toBe(false);
			expect(laterCompletions).toEqual([]);

			await listServices(makeSession("original-session", resumedCompletions));
			const completion = await resumedDelivery.promise;
			expect(completion.owner).toBe("original-session");
			expect(completion.daemon.name).toBe("detached-service");
			await client.request({ op: "shutdown" });
			// Closed before the broker drops its socket, so no completion reconnect spawns a
			// broker process that recovers and rewrites the metadata read below.
			client.close();
			await broker.finished;
			const metadata = (await Bun.file(
				path.join(runtimeDir, "daemons", "detached-service", "meta.json"),
			).json()) as {
				pendingCompletions: DaemonCompletionNotification[];
			};
			expect(metadata.pendingCompletions).toEqual([]);
		} finally {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			if (daemonPid !== undefined) {
				const processRef = Process.fromPid(daemonPid);
				if (processRef?.status() === "running") {
					await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
				}
			}
			process.title = previousTitle;
		}
	}, 20_000);

	for (const commit of [true, false]) {
		it(`preserves an exit during the real cwd adoption await (${commit ? "commit and resume" : "rollback"})`, async () => {
			using tempDir = TempDir.createSync("@omp-service-switch-await-");
			const projectDir = path.join(tempDir.path(), "source");
			const targetDir = path.join(tempDir.path(), "target");
			const runtimeDir = path.join(tempDir.path(), "runtime");
			await fs.mkdir(projectDir);
			await fs.mkdir(targetDir);
			const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const observer = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const previousTitle = process.title;
			const broker = await startBroker(projectDir, runtimeDir);
			const authStorage = await AuthStorage.create(":memory:");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			authStorage.keys.setRuntime("anthropic", "test-key");
			const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				convertToLlm,
				streamFn: mock.stream,
			});
			const sessionManager = SessionManager.create(projectDir, path.join(tempDir.path(), "sessions"));
			sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
			await sessionManager.ensureOnDisk();
			await sessionManager.flush();
			const oldFile = sessionManager.getSessionFile()!;
			const oldOwner = sessionManager.getSessionId();
			const target = SessionManager.create(targetDir, path.join(tempDir.path(), "target-sessions"));
			target.appendMessage({ role: "user", content: "target", timestamp: 2 });
			await target.ensureOnDisk();
			await target.flush();
			const targetFile = target.getSessionFile()!;
			const newOwner = target.getSessionId();
			await target.close();
			const session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false, "advisor.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage),
			});
			const disposals: Array<() => void> = [];
			const toolSession: ToolSession = {
				get cwd() {
					return sessionManager.getCwd();
				},
				hasUI: false,
				settings: session.settings,
				getSessionFile: () => sessionManager.getSessionFile() ?? null,
				getSessionSpawns: () => "*",
				getAgentId: () => "Main",
				getSessionId: () => sessionManager.getSessionId(),
				registerSessionChangeCallback: callback => {
					session.registerSessionChangeCallback(callback);
				},
				registerDisposeCallback: callback => {
					disposals.push(callback);
				},
				queueLaunchCompletion: notification => session.queueLaunchCompletion(notification),
			};
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<boolean>();
			const observed = Promise.withResolvers<void>();
			const originalOnCompletion = client.onCompletion.bind(client);
			vi.spyOn(client, "onCompletion").mockImplementation((owner, sink) =>
				originalOnCompletion(owner, async notification => {
					try {
						await sink(notification);
					} finally {
						observed.resolve();
					}
				}),
			);
			let switching: Promise<boolean> | undefined;
			try {
				vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
				await listServices(toolSession);
				const started = await client.request({
					op: "start",
					owner: oldOwner,
					spec: {
						name: "switch-window-service",
						application: process.execPath,
						args: ["-e", "console.log('ready');for await(const x of Bun.stdin.stream()){process.exit(3)}"],
						env: {},
						cwd: projectDir,
						pty: false,
						restart: "no",
						persist: false,
						detached: false,
						ready: { log: "ready", timeoutMs: 5_000 },
					},
				});
				expect(started.op).toBe("start");
				switching = session.switchSession(targetFile, {
					onCwdChange: async () => {
						entered.resolve();
						return release.promise;
					},
				});
				void switching.then(
					result => entered.reject(new Error(`Switch returned ${result} without entering cwd callback`)),
					error => entered.reject(error),
				);
				await entered.promise;
				expect(sessionManager.getSessionId()).toBe(newOwner);
				expect(toolSession.cwd).toBe(targetDir);
				await observer.request({ op: "send", name: "switch-window-service", data: "go\n" });
				const exited = await observer.request({
					op: "wait",
					name: "switch-window-service",
					for: "exit",
					timeoutMs: 5_000,
				});
				expect(exited.op === "wait" && exited.daemon.exitCode).toBe(3);
				await observed.promise;
				release.resolve(commit);
				expect(await switching).toBe(commit);
				// A request barrier settles any ACK/unsubscribe emitted by the observed sink.
				await client.request({ op: "ping" });
				const metadata = await Bun.file(
					path.join(runtimeDir, "daemons", "switch-window-service", "meta.json"),
				).json();
				const pendingBeforeResume = metadata.pendingCompletions.length;
				const targetTranscript = JSON.stringify(sessionManager.buildSessionContext().messages);
				if (commit) expect(await session.switchSession(oldFile, { onCwdChange: async () => true })).toBe(true);
				await listServices(toolSession);
				await session.waitForIdle();
				await sessionManager.flush();
				const sourceTranscript = JSON.stringify(sessionManager.buildSessionContext().messages);
				console.log(
					JSON.stringify({
						case: commit ? "commit" : "rollback",
						pendingBeforeResume,
						targetHasCompletion: targetTranscript.includes("switch-window-service"),
						sourceHasCompletion: sourceTranscript.includes("switch-window-service"),
					}),
				);
				if (commit) {
					expect(pendingBeforeResume).toBe(1);
					expect(targetTranscript.includes("switch-window-service")).toBe(false);
				}
				expect(sourceTranscript).toContain("switch-window-service");
				await client.request({ op: "ping" });
				await client.request({ op: "shutdown" });
				await broker.finished;
				const finalMetadata = await Bun.file(
					path.join(runtimeDir, "daemons", "switch-window-service", "meta.json"),
				).json();
				expect(finalMetadata.pendingCompletions).toEqual([]);
			} finally {
				release.resolve(false);
				await switching?.catch(() => undefined);
				for (const dispose of disposals) dispose();
				await session.dispose();
				await sessionManager.close();
				authStorage.close();
				vi.restoreAllMocks();
				await observer.request({ op: "shutdown" }).catch(() => undefined);
				client.close();
				observer.close();
				await broker.finished;
				process.title = previousTitle;
			}
		}, 20_000);
	}
});
