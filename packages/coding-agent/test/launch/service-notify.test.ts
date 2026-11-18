/**
 * `notify` on a supervised service: the launch broker matches the service's
 * output and reports it to the session that owns the service. Real broker
 * socket and child processes drive these, so fake timers cannot.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import type { DaemonSnapshot, DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import * as brokerClients from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonNotifyNotification,
} from "../../src/launch/protocol";
import { listServices, sendService, serviceLogs, startService, stopService } from "../../src/launch/services";
import type { AsyncNotifyEntry } from "../../src/session/async-notify";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";

/**
 * Start the in-process broker and wait until it accepts connections. `finished` settles once it
 * has shut down; it is wrapped because an async function returning it bare would await it.
 */
async function startBroker(projectDir: string, runtimeDir: string): Promise<{ finished: Promise<void> }> {
	const previous = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
		name => [name, process.env[name]] as const,
	);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve(true) });
	for (const [name, value] of previous) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	if (!(await Promise.race([listening.promise, finished.then(() => false)]))) {
		throw new Error("In-process daemon broker did not claim its scope");
	}
	return { finished };
}

/** A session that records the service matches queued on it. */
function serviceSession(
	projectDir: string,
	sessionId: string,
	queued: AsyncNotifyEntry[],
	arrived?: () => void,
): ToolSession {
	return {
		cwd: projectDir,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		getSessionId: () => sessionId,
		queueLaunchCompletion: () => Promise.resolve(),
		queueServiceNotify: entry => {
			queued.push(entry);
			arrived?.();
		},
	};
}

describe("service notify", () => {
	it("reports a service's matching output to the session that owns it, and to no other", async () => {
		using tempDir = TempDir.createSync("@omp-service-notify-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = await startBroker(projectDir, runtimeDir);
		const ownerQueue: AsyncNotifyEntry[] = [];
		const otherQueue: AsyncNotifyEntry[] = [];
		const matched = Promise.withResolvers<void>();
		const owner = serviceSession(projectDir, "owner-session", ownerQueue, matched.resolve);
		const other = serviceSession(projectDir, "other-session", otherQueue);
		try {
			vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
			const started = await startService(owner, {
				name: "web",
				command: 'echo service-ready; read answer; echo "quiet line"; echo "ERROR $answer"; read again',
				pty: false,
				ready: { log: "service-ready", timeout: 5 },
				notify: "ERROR",
			});
			expect(started.notifyArmed).toBe(true);
			// The other session shares the broker connection and has subscribed too.
			await listServices(other);

			await sendService(owner, "web", "boom\n");
			await matched.promise;

			expect(otherQueue).toEqual([]);
			expect(ownerQueue).toHaveLength(1);
			const [entry] = ownerQueue;
			expect(entry).toMatchObject({
				id: "web",
				type: "service",
				pattern: "ERROR",
				owner: "owner-session",
				lines: ["ERROR boom"],
				omitted: 0,
				stopped: false,
			});
			expect(entry.running()).toBe(true);

			await stopService(owner, "web");
			expect(entry.running()).toBe(false);
		} finally {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			process.title = previousTitle;
		}
	}, 20_000);

	it("stops reporting to a session that switched away, and reports again once it returns", async () => {
		using tempDir = TempDir.createSync("@omp-service-notify-switch-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = await startBroker(projectDir, runtimeDir);
		let sessionId = "old-session";
		const callbacks: Array<() => void> = [];
		const queued: AsyncNotifyEntry[] = [];
		let arrived = Promise.withResolvers<void>();
		const session: ToolSession = {
			...serviceSession(projectDir, sessionId, queued, () => arrived.resolve()),
			getSessionId: () => sessionId,
			registerSessionChangeCallback: callback => {
				callbacks.push(callback);
			},
		};
		const switchTo = (next: string): void => {
			sessionId = next;
			for (const callback of callbacks) callback();
		};
		try {
			vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
			await startService(session, {
				name: "echo",
				command: 'echo service-ready; while read line; do echo "ERROR $line"; done',
				pty: false,
				ready: { log: "service-ready", timeout: 5 },
				notify: "ERROR",
			});
			await sendService(session, "echo", "one\n");
			await arrived.promise;

			// Printed while another session holds the transcript: seen by the broker, reported to nobody.
			switchTo("new-session");
			await sendService(session, "echo", "two\n");
			while (!(await serviceLogs(session, "echo")).includes("ERROR two"));

			switchTo("old-session");
			await listServices(session);
			arrived = Promise.withResolvers<void>();
			await sendService(session, "echo", "three\n");
			await arrived.promise;

			expect(queued.map(entry => [entry.owner, entry.lines])).toEqual([
				["old-session", ["ERROR one"]],
				["old-session", ["ERROR three"]],
			]);
		} finally {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			process.title = previousTitle;
		}
	}, 20_000);

	it.each([false, true])(
		"reports a match printed right before the service exits, ahead of its exit notice (pty: %p)",
		async pty => {
			using tempDir = TempDir.createSync("@omp-service-notify-exit-");
			const projectDir = path.join(tempDir.path(), "project");
			const runtimeDir = path.join(tempDir.path(), "runtime");
			await fs.mkdir(projectDir);
			const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const previousTitle = process.title;
			const broker = await startBroker(projectDir, runtimeDir);
			const events: string[] = [];
			const completed = Promise.withResolvers<void>();
			client.onCompletion("owner", completion => {
				events.push(`exited ${completion.daemon.exitCode}`);
				completed.resolve();
			});
			client.onNotify("owner", notification => events.push(`matched ${notification.lines.join("|")}`));
			try {
				// The crash line and the exit land well inside one batching window; the last line has no newline.
				const spec: DaemonSpec = {
					name: "crashing",
					application: process.execPath,
					args: ["-e", "process.stdout.write('ERROR fatal: boom\\nERROR no newline'); process.exit(1)"],
					env: {},
					cwd: projectDir,
					pty,
					notify: "ERROR",
					restart: "no",
					persist: false,
					detached: false,
				};
				await client.request({ op: "start", spec, owner: "owner" });
				await completed.promise;
				expect(events).toEqual(["matched ERROR fatal: boom|ERROR no newline", "exited 1"]);
			} finally {
				await client.request({ op: "shutdown" }).catch(() => undefined);
				client.close();
				await broker.finished;
				process.title = previousTitle;
			}
		},
		20_000,
	);

	it("does not report a recovered detached service's earlier output again, only what it prints next", async () => {
		using tempDir = TempDir.createSync("@omp-service-notify-recover-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const previousTitle = process.title;
		const spec: DaemonSpec = {
			name: "detached",
			application: process.execPath,
			// Prints once at start and once more after the test creates `go`. It outlives a broker by
			// design, so it exits on its own should the test fail before stopping it.
			args: [
				"-e",
				"console.log('ERROR one'); setTimeout(() => process.exit(0), 30_000); const t = setInterval(() => { if (require('fs').existsSync('go')) { console.log('ERROR two'); clearInterval(t); } }, 20)",
			],
			env: {},
			cwd: projectDir,
			pty: false,
			notify: "ERROR",
			restart: "no",
			persist: true,
			detached: true,
		};
		const firstClient = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const firstBroker = await startBroker(projectDir, runtimeDir);
		const reported = Promise.withResolvers<void>();
		firstClient.onCompletion("owner", () => undefined);
		firstClient.onNotify("owner", () => reported.resolve());
		await firstClient.request({ op: "start", spec, owner: "owner" });
		await reported.promise;
		// The detached service outlives the broker; the next one recovers it.
		await firstClient.request({ op: "shutdown" }).catch(() => undefined);
		firstClient.close();
		await firstBroker.finished;

		const secondBroker = await startBroker(projectDir, runtimeDir);
		const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const lines: string[] = [];
		const next = Promise.withResolvers<void>();
		client.onCompletion("owner", () => undefined);
		client.onNotify("owner", notification => {
			lines.push(...notification.lines);
			next.resolve();
		});
		try {
			await client.request({ op: "list" });
			await Bun.write(path.join(projectDir, "go"), "");
			await next.promise;
			expect(lines).toEqual(["ERROR two"]);
		} finally {
			await client.request({ op: "stop", name: "detached", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await secondBroker.finished;
			process.title = previousTitle;
		}
	}, 30_000);

	it("never sends a match to a client that did not say it reads them", async () => {
		using tempDir = TempDir.createSync("@omp-service-notify-legacy-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = await startBroker(projectDir, runtimeDir);
		const chatty = (name: string): DaemonSpec => ({
			name,
			application: process.execPath,
			args: ["-e", "setInterval(() => console.log('ERROR tick'), 20)"],
			env: {},
			cwd: projectDir,
			pty: false,
			notify: "ERROR",
			restart: "no",
			persist: false,
			detached: false,
		});
		// A client from before notify events: it would fail every pending request on a message it cannot read.
		const legacy = await IpcConnection.connect(daemonBrokerEndpoint(runtimeDir), {
			framing: "lines",
			timeoutMs: 2_000,
		});
		const legacyLines: string[] = [];
		const legacyStarted = Promise.withResolvers<void>();
		legacy.start(
			line => {
				legacyLines.push(line);
				if (line.includes('"id":"legacy-start"')) legacyStarted.resolve();
			},
			() => {},
		);
		try {
			const token = (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim();
			legacy.send(
				JSON.stringify({
					id: "legacy-start",
					token,
					owners: ["legacy-session"],
					completionEvents: true,
					completionSubscriptionId: "legacy-subscription",
					operation: { op: "start", spec: chatty("legacy-service"), owner: "legacy-session" },
				}),
			);
			await legacyStarted.promise;

			// Started after the legacy service and printing the same lines: once this one has reported
			// twice, the legacy one has had longer to.
			const reports: DaemonNotifyNotification[] = [];
			const reportedTwice = Promise.withResolvers<void>();
			client.onCompletion("current-session", () => undefined);
			client.onNotify("current-session", notification => {
				reports.push(notification);
				if (reports.length === 2) reportedTwice.resolve();
			});
			await client.request({ op: "start", spec: chatty("current-service"), owner: "current-session" });
			await reportedTwice.promise;

			expect(reports[0]).toMatchObject({ owner: "current-session", daemon: { name: "current-service" } });
			expect(legacyLines.filter(line => line.includes("daemon-notify"))).toEqual([]);
		} finally {
			legacy.destroy();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			process.title = previousTitle;
		}
	}, 20_000);

	it.each([
		{ broker: "a broker that armed the regex", notifyArmed: true, told: /Output lines matching \/ERROR\/ arrive/ },
		{
			broker: "a broker from an older omp",
			notifyArmed: undefined,
			told: /Ignored notify: .* web's output is not reported; read proc:\/\/web for it\./,
		},
	])("tells the model what became of the regex on $broker", async ({ notifyArmed, told }) => {
		using tempDir = TempDir.createSync("@omp-service-notify-bash-");
		const daemon: DaemonSnapshot = {
			name: "web",
			id: "web-1",
			state: "running",
			createdAt: 1,
			startedAt: 1,
			restartCount: 0,
			outputBytes: 0,
			owner: "owner-session",
			persist: false,
			detached: false,
		};
		const client: brokerClients.DaemonBrokerClient = {
			projectDir: tempDir.path(),
			onCompletion: () => () => {},
			onNotify: () => () => {},
			close() {},
			async request(operation) {
				if (operation.op === "start") return { op: "start", daemon, readyTimedOut: false, notifyArmed };
				if (operation.op === "logs") {
					return { op: "logs", name: "web", text: "", cursor: 0, timedOut: false, state: "running" };
				}
				throw new Error(`Unexpected broker op ${operation.op}`);
			},
		};
		vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
		try {
			const result = await new BashTool(serviceSession(tempDir.path(), "owner-session", [])).execute("start-web", {
				command: "bun dev",
				name: "web",
				notify: "ERROR",
			});
			const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			expect(text).toMatch(told);
		} finally {
			vi.restoreAllMocks();
		}
	});
});
