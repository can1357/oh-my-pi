import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
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
});
