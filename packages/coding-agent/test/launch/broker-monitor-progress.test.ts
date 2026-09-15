// Integration test — real timers are required because this drives the actual broker and child process.
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerStartOptions, startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import {
	createDaemonBrokerClient,
	type DaemonBrokerClient,
	type DaemonOutputUnregister,
} from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_OUTPUT_MONITOR_CAPABILITY,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonMonitorNotification,
	type DaemonSpec,
} from "../../src/launch/protocol";
import { OutputSink } from "../../src/session/streaming-output";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, options: DaemonBrokerStartOptions = {}): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment(options);
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

async function waitForOutputCount(notifications: DaemonMonitorNotification[], count: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (notifications.filter(notification => notification.event === "daemon-output").length >= count) return;
		await Bun.sleep(10);
	}
	throw new Error(`Expected ${count} output notifications`);
}

interface RawBrokerSocket {
	socket: net.Socket;
	messages: Record<string, unknown>[];
	waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

interface AdvertisedOutputSubscription {
	id: string;
	registrationId: string;
	name: string;
	owner: string;
	artifactPath: string;
	lastEpoch?: string;
	lastSeq?: number;
}

interface BrokerRequest {
	id: string;
	outputSubscriptions?: AdvertisedOutputSubscription[];
}

async function openRawBrokerSocket(endpoint: string): Promise<RawBrokerSocket> {
	const socket = net.createConnection(endpoint);
	const connected = Promise.withResolvers<void>();
	socket.once("connect", connected.resolve);
	socket.once("error", connected.reject);
	await connected.promise;
	const messages: Record<string, unknown>[] = [];
	const waiters: Array<{
		predicate: (message: Record<string, unknown>) => boolean;
		resolve: (message: Record<string, unknown>) => void;
	}> = [];
	let buffer = "";
	socket.on("data", chunk => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim()) {
				const message = JSON.parse(line) as Record<string, unknown>;
				messages.push(message);
				for (let index = waiters.length - 1; index >= 0; index--) {
					const waiter = waiters[index];
					if (!waiter?.predicate(message)) continue;
					waiters.splice(index, 1);
					waiter.resolve(message);
				}
			}
			newline = buffer.indexOf("\n");
		}
	});
	return {
		socket,
		messages,
		waitFor(predicate) {
			const existing = messages.find(predicate);
			if (existing) return Promise.resolve(existing);
			const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
			waiters.push({ predicate, resolve });
			return promise;
		},
	};
}

describe("daemon broker live output monitoring", () => {
	it("synchronously rejects output registration after the client is closed", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-closed-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
		client.close();

		expect(() =>
			client.onOutput?.(
				{
					id: "closed-monitor",
					name: "closed",
					owner: "closed-owner",
					artifactPath: path.join(tempDir.path(), "closed-progress.log"),
				},
				() => undefined,
			),
		).toThrow(/^Daemon broker client is closed$/);
	});

	it("captures immediate output, joins fragmented lines, flushes the final partial, then reports terminal state", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		const monitorArtifactPath = path.join(tempDir.path(), "watched-progress.log");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("IMMEDIATE\\n");
process.stdin.once("data", () => {
	process.stdout.write("par");
	process.stdout.write("tial\\n\\n");
	process.stdout.write("H".repeat(300) + "M".repeat(400) + "T".repeat(300) + "\\n");
	process.stdout.write("final");
	process.exit(0);
});
`,
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);

		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const entered: string[] = [];
		const unregister = client.onOutput?.(
			{ id: "monitor-1", name: "watched", owner: "owner-1", artifactPath: monitorArtifactPath },
			async notification => {
				entered.push(
					notification.event === "daemon-output"
						? `${notification.event}:${notification.seq}`
						: notification.event,
				);
				if (notification.event === "daemon-output" && notification.seq === 1) {
					firstEntered.resolve();
					await releaseFirst.promise;
				}
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");

		try {
			// Registration readiness is the broker acknowledgement that closes
			// the immediate-output race without a caller-issued preflight ping.
			await unregister.ready;
			const ping = await client.request({ op: "ping" });
			if (ping.op !== "ping") throw new Error("unexpected ping result");
			expect(ping.capabilities).toContain(DAEMON_OUTPUT_MONITOR_CAPABILITY);
			const started = await client.request({
				op: "start",
				owner: "owner-1",
				spec: {
					name: "watched",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			await firstEntered.promise;
			await client.request({ op: "send", name: "watched", data: "finish\n" });
			await client.request({ op: "wait", name: "watched", for: "exit", timeoutMs: 5_000 });
			await Bun.sleep(10);
			expect(entered).toEqual(["daemon-output:1"]);
			releaseFirst.resolve();
			await completed.promise;

			const output = notifications.filter(
				(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
					notification.event === "daemon-output",
			);
			expect(output.map(notification => notification.text)).toEqual([
				"IMMEDIATE",
				`partial\n${"H".repeat(250)}${"T".repeat(250)}\nfinal`,
			]);
			expect(await Bun.file(monitorArtifactPath).text()).toBe(
				`IMMEDIATE\npartial\n\n${"H".repeat(300)}${"M".repeat(400)}${"T".repeat(300)}\nfinal`,
			);
			expect(output.map(notification => notification.truncated)).toEqual([false, true]);
			expect(output.map(notification => notification.seq)).toEqual([1, 2]);
			expect(notifications.at(-1)).toMatchObject({
				event: "daemon-monitor-completed",
				daemon: { name: "watched", state: "exited", exitCode: 0 },
			});
			expect(entered).toEqual(["daemon-output:1", "daemon-output:2", "daemon-monitor-completed"]);
		} finally {
			releaseFirst.resolve();
			unregister();
			await client.request({ op: "stop", name: "watched", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("delivers observer output and terminal state while the owner completion sink is blocked", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-consumer-order-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const ownerEntered = Promise.withResolvers<void>();
		const releaseOwner = Promise.withResolvers<void>();
		const ownerReleased = Promise.withResolvers<void>();
		const ownerEvents: string[] = [];
		const observerEvents: string[] = [];
		const observerCompleted = Promise.withResolvers<void>();
		const unregisterOwner = client.onCompletion("daemon-owner", async () => {
			ownerEvents.push("completion-entered");
			ownerEntered.resolve();
			await releaseOwner.promise;
			ownerEvents.push("completion-released");
			ownerReleased.resolve();
		});
		const unregisterObserver = client.onOutput?.(
			{
				id: "observer-monitor",
				name: "consumer-order",
				owner: "daemon-owner",
				artifactPath: path.join(tempDir.path(), "consumer-order.log"),
			},
			notification => {
				observerEvents.push(
					notification.event === "daemon-output" ? `output:${notification.text}` : notification.event,
				);
				if (notification.event === "daemon-monitor-completed") observerCompleted.resolve();
			},
		);
		if (!unregisterObserver) throw new Error("Expected output monitoring support");

		try {
			await unregisterObserver.ready;
			await client.request({ op: "ping" });
			const started = await client.request({
				op: "start",
				owner: "daemon-owner",
				spec: {
					name: "consumer-order",
					application: process.execPath,
					args: ["-e", 'process.stdout.write("OBSERVED\\n")'],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");

			await ownerEntered.promise;
			await observerCompleted.promise;
			expect(ownerEvents).toEqual(["completion-entered"]);
			expect(observerEvents).toEqual(["output:OBSERVED", "daemon-monitor-completed"]);

			releaseOwner.resolve();
			await ownerReleased.promise;
		} finally {
			releaseOwner.resolve();
			unregisterObserver();
			unregisterOwner();
			await client.request({ op: "stop", name: "consumer-order", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("starts an attached monitor at the current output boundary", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-attach-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("BEFORE_ATTACH\\n");
process.stdin.once("data", () => {
	process.stdout.write("AFTER_ATTACH\\n");
	process.exit(0);
});
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		let unregister: DaemonOutputUnregister | undefined;
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "attach",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			await client.request({
				op: "logs",
				name: "attach",
				lines: 20,
				head: false,
				follow: true,
				cursor: 0,
				timeoutMs: 5_000,
			});
			unregister = client.onOutput?.(
				{
					id: "attach-monitor",
					name: "attach",
					owner: "owner",
					artifactPath: path.join(tempDir.path(), "attach-progress.log"),
				},
				notification => {
					notifications.push(notification);
					if (notification.event === "daemon-monitor-completed") completed.resolve();
				},
			);
			if (!unregister) throw new Error("Expected output monitoring support");
			await client.request({ op: "ping" });
			await client.request({ op: "send", name: "attach", data: "finish\n" });
			await completed.promise;

			const output = notifications.filter(notification => notification.event === "daemon-output");
			expect(output.map(notification => notification.text)).toEqual(["AFTER_ATTACH"]);
		} finally {
			unregister?.();
			await client.request({ op: "stop", name: "attach", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("scopes a shared monitor id to each broker client", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-replace-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => process.stdout.write(chunk));
`,
		);
		const firstArtifactPath = path.join(tempDir.path(), "first-progress.log");
		const secondArtifactPath = path.join(tempDir.path(), "second-progress.log");
		const firstClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const secondClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 5_000 });
		const firstNotifications: DaemonMonitorNotification[] = [];
		const secondNotifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const firstUnregister = firstClient.onOutput?.(
			{
				id: "shared-monitor",
				name: "replace",
				owner: "first-owner",
				artifactPath: firstArtifactPath,
			},
			notification => {
				firstNotifications.push(notification);
			},
		);
		if (!firstUnregister) throw new Error("Expected output monitoring support");
		let secondUnregister: (() => void) | undefined;
		try {
			await firstClient.request({ op: "ping" });
			await firstClient.request({
				op: "start",
				spec: {
					name: "replace",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			await firstClient.request({ op: "send", name: "replace", data: "OLD_SUBSCRIPTION\n" });
			await firstClient.request({
				op: "logs",
				name: "replace",
				lines: 20,
				head: false,
				follow: true,
				cursor: 0,
				timeoutMs: 5_000,
			});
			expect(firstNotifications).toEqual([]);

			secondUnregister = secondClient.onOutput?.(
				{
					id: "shared-monitor",
					name: "replace",
					owner: "second-owner",
					artifactPath: secondArtifactPath,
				},
				notification => {
					secondNotifications.push(notification);
					if (notification.event === "daemon-monitor-completed") completed.resolve();
				},
			);
			if (!secondUnregister) throw new Error("Expected output monitoring support");
			await secondClient.request({ op: "ping" });
			await secondClient.request({ op: "send", name: "replace", data: "NEW_SUBSCRIPTION\n" });
			const observed = await secondClient.request({
				op: "wait",
				name: "replace",
				for: "exit",
				pattern: "NEW_SUBSCRIPTION",
				timeoutMs: 5_000,
			});
			if (observed.op !== "wait") throw new Error("unexpected wait result");
			expect(observed.timedOut).toBeFalse();
			await secondClient.request({ op: "stop", name: "replace", timeoutMs: 2_000 });
			await completed.promise;

			const firstOutput = firstNotifications.filter(notification => notification.event === "daemon-output");
			const secondOutput = secondNotifications.filter(notification => notification.event === "daemon-output");
			expect(firstOutput.map(notification => notification.text)).toEqual(["OLD_SUBSCRIPTION\nNEW_SUBSCRIPTION"]);
			expect(secondOutput.map(notification => notification.text)).toEqual(["NEW_SUBSCRIPTION"]);
			expect(firstOutput.map(notification => notification.seq)).toEqual([1]);
			expect(secondOutput.map(notification => notification.seq)).toEqual([1]);
			expect(await Bun.file(firstArtifactPath).text()).toBe("OLD_SUBSCRIPTION\nNEW_SUBSCRIPTION\n");
			expect(await Bun.file(secondArtifactPath).text()).toBe("NEW_SUBSCRIPTION\n");
		} finally {
			firstUnregister();
			secondUnregister?.();
			await secondClient.request({ op: "stop", name: "replace", timeoutMs: 2_000 }).catch(() => undefined);
			await secondClient.request({ op: "shutdown" }).catch(() => undefined);
			firstClient.close();
			secondClient.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("treats a re-registered subscription id with new metadata as a replacement", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-rebind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => process.stdout.write(chunk));
`,
		);
		const oldArtifactPath = path.join(tempDir.path(), "old-progress.log");
		const newArtifactPath = path.join(tempDir.path(), "new-progress.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 5_000 });
		const oldNotifications: DaemonMonitorNotification[] = [];
		const newNotifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const oldUnregister = client.onOutput?.(
			{ id: "rebound-monitor", name: "old", owner: "owner-1", artifactPath: oldArtifactPath },
			notification => {
				oldNotifications.push(notification);
			},
		);
		if (!oldUnregister) throw new Error("Expected output monitoring support");
		let newUnregister: (() => void) | undefined;
		const spec = (name: string): DaemonSpec => ({
			name,
			application: process.execPath,
			args: [scriptPath],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: false,
			detached: false,
		});
		try {
			await client.request({ op: "ping" });
			await client.request({ op: "start", spec: spec("old") });
			await client.request({ op: "send", name: "old", data: "OLD_OUTPUT\n" });
			const oldObserved = await client.request({
				op: "wait",
				name: "old",
				for: "exit",
				pattern: "OLD_OUTPUT",
				timeoutMs: 5_000,
			});
			if (oldObserved.op !== "wait") throw new Error("unexpected wait result");
			expect(oldObserved.timedOut).toBeFalse();
			expect(oldNotifications).toEqual([]);

			// Re-register the same subscription id against a different daemon and
			// artifact path without unregistering first: the broker must replace the
			// registration instead of mutating it in place.
			newUnregister = client.onOutput?.(
				{ id: "rebound-monitor", name: "new", owner: "owner-1", artifactPath: newArtifactPath },
				notification => {
					newNotifications.push(notification);
					if (notification.event === "daemon-monitor-completed") completed.resolve();
				},
			);
			if (!newUnregister) throw new Error("Expected output monitoring support");
			await client.request({ op: "ping" });
			await client.request({ op: "start", spec: spec("new") });
			await client.request({ op: "send", name: "new", data: "NEW_OUTPUT\n" });
			const newObserved = await client.request({
				op: "wait",
				name: "new",
				for: "exit",
				pattern: "NEW_OUTPUT",
				timeoutMs: 5_000,
			});
			if (newObserved.op !== "wait") throw new Error("unexpected wait result");
			expect(newObserved.timedOut).toBeFalse();
			await client.request({ op: "stop", name: "new", timeoutMs: 2_000 });
			await completed.promise;

			const output = newNotifications.filter(notification => notification.event === "daemon-output");
			expect(output.map(notification => notification.text)).toEqual(["NEW_OUTPUT"]);
			expect(await Bun.file(oldArtifactPath).text()).toBe("OLD_OUTPUT\n");
			expect(await Bun.file(newArtifactPath).text()).toBe("NEW_OUTPUT\n");
		} finally {
			oldUnregister();
			newUnregister?.();
			await client.request({ op: "stop", name: "old", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "stop", name: "new", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("keeps a mid-line attach preview aligned with the monitor's own artifact", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-midline-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("abc");
process.stdin.once("data", () => {
	process.stdout.write("def\\n");
	process.exit(0);
});
`,
		);
		const artifactPath = path.join(tempDir.path(), "midline-progress.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		let unregister: (() => void) | undefined;
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "midline",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			// Ensure the unterminated "abc" prefix was consumed before the monitor attaches.
			await client.request({
				op: "logs",
				name: "midline",
				lines: 20,
				head: false,
				follow: true,
				cursor: 0,
				timeoutMs: 5_000,
			});
			unregister = client.onOutput?.(
				{ id: "midline-monitor", name: "midline", owner: "owner", artifactPath },
				notification => {
					notifications.push(notification);
					if (notification.event === "daemon-monitor-completed") completed.resolve();
				},
			);
			if (!unregister) throw new Error("Expected output monitoring support");
			await client.request({ op: "ping" });
			await client.request({ op: "send", name: "midline", data: "finish\n" });
			await completed.promise;

			const output = notifications.filter(notification => notification.event === "daemon-output");
			// The pre-attach "abc" prefix belongs to the record, not this monitor:
			// its preview and artifact must share the same attach boundary.
			expect(output.map(notification => notification.text)).toEqual(["def"]);
			expect(await Bun.file(artifactPath).text()).toBe("def\n");
		} finally {
			unregister?.();
			await client.request({ op: "stop", name: "midline", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("distinguishes terminal attachment from a subscription targeting a same-name replacement", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-reuse-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const firstScriptPath = path.join(projectDir, "first.ts");
		const secondScriptPath = path.join(projectDir, "second.ts");
		await Bun.write(firstScriptPath, `process.stdout.write("FIRST_RUN\\n");\n`);
		await Bun.write(
			secondScriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.once("data", () => {
	process.stdout.write("SECOND_RUN\\n");
	process.exit(0);
});
`,
		);
		const artifactPath = path.join(tempDir.path(), "reuse-progress.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		let raw: RawBrokerSocket | undefined;
		const spec = (application: string, args: string[]): DaemonSpec => ({
			name: "reuse",
			application,
			args,
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: false,
			detached: false,
		});
		try {
			await client.request({ op: "ping" });
			const firstStart = await client.request({
				op: "start",
				spec: spec(process.execPath, [firstScriptPath]),
			});
			if (firstStart.op !== "start") throw new Error("unexpected start result");
			const firstWait = await client.request({ op: "wait", name: "reuse", for: "exit", timeoutMs: 5_000 });
			if (firstWait.op !== "wait") throw new Error("unexpected wait result");
			expect(firstWait.timedOut).toBeFalse();

			const token = (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim();
			raw = await openRawBrokerSocket(endpoint);
			const envelope = (
				id: string,
				outputSubscriptionId: string,
				outputSubscriptions: Record<string, unknown>[],
			): string =>
				`${JSON.stringify({
					id,
					token,
					outputSubscriptionId,
					outputSubscriptions,
					operation: { op: "ping" },
				})}\n`;

			const ordinarySubscription = {
				id: "ordinary-terminal-monitor",
				registrationId: "ordinary-terminal-registration",
				name: "reuse",
				owner: "owner-1",
				artifactPath: path.join(tempDir.path(), "ordinary-terminal.log"),
			};
			raw.socket.write(envelope("attach-terminal", "ordinary-client", [ordinarySubscription]));
			// The terminal completion is written by the subscription mutation, which
			// the broker sequences independently of the ping response; wait for the
			// event rather than the response so a fast reply cannot race it.
			await raw.waitFor(
				message => message.event === "daemon-monitor-completed" && message.monitorId === ordinarySubscription.id,
			);
			const ordinaryCompletions = raw.messages.filter(
				message => message.event === "daemon-monitor-completed" && message.monitorId === ordinarySubscription.id,
			);
			expect(ordinaryCompletions).toHaveLength(1);
			expect(ordinaryCompletions[0]?.daemon).toMatchObject({ id: firstStart.daemon.id, state: "exited" });
			raw.socket.write(envelope("detach-terminal", "ordinary-client", []));
			await raw.waitFor(message => message.id === "detach-terminal");

			const futureSubscription = {
				id: "replacement-monitor",
				registrationId: "replacement-registration",
				name: "reuse",
				owner: "owner-1",
				artifactPath,
				startPending: true,
			};
			raw.socket.write(envelope("attach-next-start", "future-client", [futureSubscription]));
			await raw.waitFor(message => message.id === "attach-next-start");
			expect(raw.messages.some(message => message.monitorId === futureSubscription.id)).toBeFalse();

			const secondStart = await client.request({
				op: "start",
				spec: spec(process.execPath, [secondScriptPath]),
			});
			if (secondStart.op !== "start") throw new Error("unexpected start result");
			expect(secondStart.daemon.id).not.toBe(firstStart.daemon.id);
			await client.request({ op: "send", name: "reuse", data: "go\n" });
			await raw.waitFor(
				message => message.event === "daemon-monitor-completed" && message.monitorId === futureSubscription.id,
			);

			const replacementNotifications = raw.messages.filter(message => message.monitorId === futureSubscription.id);
			expect(replacementNotifications.map(message => message.event)).toEqual([
				"daemon-output",
				"daemon-monitor-completed",
			]);
			expect(replacementNotifications[0]?.text).toBe("SECOND_RUN");
			expect(replacementNotifications[1]?.daemon).toMatchObject({
				id: secondStart.daemon.id,
				state: "exited",
				exitCode: 0,
			});
			expect(await Bun.file(artifactPath).text()).toBe("SECOND_RUN\n");
		} finally {
			raw?.socket.destroy();
			await client.request({ op: "stop", name: "reuse", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("keeps a pending restart monitor isolated from late output by the prior daemon", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-terminal-restart-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		const oldArtifactPath = path.join(tempDir.path(), "terminal-old.log");
		const newArtifactPath = path.join(tempDir.path(), "terminal-new.log");
		await Bun.write(
			scriptPath,
			`process.stdout.write("FIRST_RUN\\n");
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.once("data", () => process.stdout.write("OLD_LATE\\n"));
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		let oldMonitor: RawBrokerSocket | undefined;
		let newMonitor: RawBrokerSocket | undefined;
		try {
			await client.request({ op: "ping" });
			const token = (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim();
			const register = (id: string, outputSubscriptionId: string, subscription: Record<string, unknown>): string =>
				`${JSON.stringify({
					id,
					token,
					outputSubscriptionId,
					outputSubscriptions: [subscription],
					operation: { op: "ping" },
				})}\n`;
			const oldSubscription = {
				id: "terminal-old-monitor",
				registrationId: "terminal-old-registration",
				name: "terminal-restart",
				owner: "terminal-owner",
				artifactPath: oldArtifactPath,
			};
			oldMonitor = await openRawBrokerSocket(endpoint);
			oldMonitor.socket.write(register("register-old", "terminal-old-client", oldSubscription));
			await oldMonitor.waitFor(message => message.id === "register-old");

			const daemonSpec: DaemonSpec = {
				name: "terminal-restart",
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			};
			const started = await client.request({ op: "start", spec: daemonSpec });
			if (started.op !== "start") throw new Error("unexpected start result");
			await oldMonitor.waitFor(
				message =>
					message.event === "daemon-output" &&
					message.monitorId === oldSubscription.id &&
					message.text === "FIRST_RUN",
			);

			await Bun.write(scriptPath, 'process.stdout.write("SECOND_RUN\\n");\n');
			const newSubscription = {
				id: "terminal-new-monitor",
				registrationId: "terminal-new-registration",
				name: "terminal-restart",
				owner: "terminal-owner",
				artifactPath: newArtifactPath,
				startPending: true,
			};
			newMonitor = await openRawBrokerSocket(endpoint);
			newMonitor.socket.write(register("register-new", "terminal-new-client", newSubscription));
			await newMonitor.waitFor(message => message.id === "register-new");
			expect(newMonitor.messages.some(message => message.monitorId === newSubscription.id)).toBeFalse();
			await client.request({ op: "send", name: "terminal-restart", data: "late\n" });
			await oldMonitor.waitFor(
				message =>
					message.event === "daemon-output" &&
					message.monitorId === oldSubscription.id &&
					message.text === "OLD_LATE",
			);
			expect(newMonitor.messages.some(message => message.monitorId === newSubscription.id)).toBeFalse();
			expect(await Bun.file(newArtifactPath).exists()).toBeFalse();

			await client.request({ op: "stop", name: "terminal-restart", timeoutMs: 2_000 });
			const restarted = await client.request({ op: "start", spec: daemonSpec });
			if (restarted.op !== "start") throw new Error("unexpected start result");
			expect(restarted.daemon.id).not.toBe(started.daemon.id);
			await newMonitor.waitFor(
				message => message.event === "daemon-monitor-completed" && message.monitorId === newSubscription.id,
			);

			const oldNotifications = oldMonitor.messages.filter(message => message.monitorId === oldSubscription.id);
			expect(oldNotifications.map(message => message.event)).toEqual([
				"daemon-output",
				"daemon-output",
				"daemon-monitor-completed",
			]);
			expect(oldNotifications.slice(0, 2).map(message => message.text)).toEqual(["FIRST_RUN", "OLD_LATE"]);
			expect(await Bun.file(oldArtifactPath).text()).toBe("FIRST_RUN\nOLD_LATE\n");

			const newNotifications = newMonitor.messages.filter(message => message.monitorId === newSubscription.id);
			expect(newNotifications.map(message => message.event)).toEqual(["daemon-output", "daemon-monitor-completed"]);
			expect(newNotifications[0]).toMatchObject({
				daemonId: restarted.daemon.id,
				text: "SECOND_RUN",
			});
			expect(newNotifications[1]?.daemon).toMatchObject({
				id: restarted.daemon.id,
				state: "exited",
				exitCode: 0,
			});
			expect(await Bun.file(newArtifactPath).text()).toBe("SECOND_RUN\n");
		} finally {
			oldMonitor?.socket.destroy();
			newMonitor?.socket.destroy();
			await client.request({ op: "stop", name: "terminal-restart", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("bounds socket previews while preserving the complete broker-written artifact", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-preview-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const artifactPath = path.join(tempDir.path(), "complete-progress.log");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`for (let index = 0; index < 20; index++) process.stdout.write(\`LINE\${String(index).padStart(2, "0")}:\${"x".repeat(400)}\\n\`);\n`,
		);
		const expected = Array.from(
			{ length: 20 },
			(_, index) => `LINE${String(index).padStart(2, "0")}:${"x".repeat(400)}\n`,
		).join("");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{ id: "bounded-monitor", name: "bounded", owner: "owner", artifactPath },
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");
		try {
			await client.request({ op: "ping" });
			await client.request({
				op: "start",
				spec: {
					name: "bounded",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			await completed.promise;

			const output = notifications.filter(
				(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
					notification.event === "daemon-output",
			);
			expect(output).toHaveLength(1);
			expect(Buffer.byteLength(output[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(3_000);
			expect(output[0]).toMatchObject({ truncated: true });
			expect(output[0]?.text).toStartWith("LINE00:");
			expect(output[0]?.text).toEndWith(`LINE19:${"x".repeat(400)}`);
			expect(await Bun.file(artifactPath).text()).toBe(expected);
		} finally {
			unregister();
			await client.request({ op: "stop", name: "bounded", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("merges retained first and last previews into a suppression summary", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-suppression-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const artifactPath = path.join(tempDir.path(), "suppressed-progress.log");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => process.stdout.write(chunk));
process.stdin.resume();
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{ id: "suppression-monitor", name: "suppression", owner: "owner", artifactPath },
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");
		try {
			await unregister.ready;
			await client.request({
				op: "start",
				spec: {
					name: "suppression",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			for (let index = 0; index < 12; index++) {
				await client.request({ op: "send", name: "suppression", data: `LINE_${index}\n` });
				await waitForOutputCount(notifications, index + 1);
			}
			await client.request({ op: "stop", name: "suppression", timeoutMs: 2_000 });
			await completed.promise;

			const summary = notifications.find(
				(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
					notification.event === "daemon-output" && notification.batchKind === "suppression-summary",
			);
			expect(summary).toMatchObject({
				text: "LINE_10\nLINE_11",
				suppressedEvents: 2,
				truncated: true,
			});
			expect(await Bun.file(artifactPath).text()).toBe(
				Array.from({ length: 12 }, (_, index) => `LINE_${index}\n`).join(""),
			);
		} finally {
			unregister();
			await client.request({ op: "stop", name: "suppression", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("keeps one monitor across an explicit process restart", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-restart-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("GENERATION_STARTED\\n");
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{
				id: "restart-monitor",
				name: "restart",
				owner: "owner",
				artifactPath: path.join(tempDir.path(), "restart-progress.log"),
			},
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");
		try {
			await client.request({ op: "ping" });
			const started = await client.request({
				op: "start",
				spec: {
					name: "restart",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			await waitForOutputCount(notifications, 1);
			await client.request({ op: "restart", name: "restart" });
			await waitForOutputCount(notifications, 2);
			expect(notifications.some(notification => notification.event === "daemon-monitor-completed")).toBe(false);

			await client.request({ op: "stop", name: "restart", timeoutMs: 2_000 });
			await completed.promise;
			const output = notifications.filter(notification => notification.event === "daemon-output");
			expect(output.map(notification => notification.text)).toEqual(["GENERATION_STARTED", "GENERATION_STARTED"]);
			expect(output.map(notification => notification.seq)).toEqual([1, 2]);
			expect(notifications.at(-1)?.event).toBe("daemon-monitor-completed");
		} finally {
			unregister();
			await client.request({ op: "stop", name: "restart", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("settles a monitor once when an explicit restart cannot relaunch", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-restart-failure-");
		const projectDir = path.join(tempDir.path(), "project");
		const serviceDir = path.join(projectDir, "service");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const scriptPath = path.join(tempDir.path(), "service.ts");
		const artifactPath = path.join(tempDir.path(), "restart-failure-progress.log");
		await fs.mkdir(serviceDir, { recursive: true });
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("GENERATION_STARTED\\n");
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{ id: "failed-restart-monitor", name: "failed-restart", owner: "owner", artifactPath },
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");
		try {
			await client.request({ op: "ping" });
			const started = await client.request({
				op: "start",
				spec: {
					name: "failed-restart",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: serviceDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			await waitForOutputCount(notifications, 1);

			await fs.rm(serviceDir, { recursive: true });
			const restarted = await client.request({ op: "restart", name: "failed-restart" });
			if (restarted.op !== "restart") throw new Error("unexpected restart result");
			expect(restarted.daemon.state).toBe("failed");
			await completed.promise;
			await client.request({ op: "ping" });

			const terminal = notifications.filter(notification => notification.event === "daemon-monitor-completed");
			expect(terminal).toHaveLength(1);
			expect(terminal[0]?.daemon.state).toBe("failed");
			expect(await Bun.file(artifactPath).text()).toBe("GENERATION_STARTED\n");
		} finally {
			unregister();
			await client.request({ op: "stop", name: "failed-restart", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("expires an artifact-failed monitor without changing a successful daemon exit", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-artifact-failure-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const artifactPath = path.join(tempDir.path(), "artifact-is-a-directory");
		await fs.mkdir(projectDir);
		await fs.mkdir(artifactPath);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(scriptPath, 'process.stdout.write("TERMINAL OUTPUT SURVIVES\\n");\n');
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const notifications: DaemonMonitorNotification[] = [];
		const expired = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{ id: "artifact-failure-monitor", name: "artifact-failure", owner: "owner", artifactPath },
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-expired") expired.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");
		try {
			await unregister.ready;
			await client.request({
				op: "start",
				spec: {
					name: "artifact-failure",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			const waited = await client.request({
				op: "wait",
				name: "artifact-failure",
				for: "exit",
				timeoutMs: 5_000,
			});
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			await expired.promise;
			// Join the client's terminal cleanup publication before inspecting the
			// lifecycle: consuming expiry must advertise an empty subscription set.
			await client.request({ op: "ping" });

			expect(waited.timedOut).toBeFalse();
			expect(waited.daemon).toMatchObject({ state: "exited", exitCode: 0 });
			expect(waited.daemon.outputBytes).toBeGreaterThan(0);
			expect(notifications).toEqual([
				{
					event: "daemon-monitor-expired",
					monitorId: "artifact-failure-monitor",
					name: "artifact-failure",
					daemonId: waited.daemon.id,
				},
			]);
		} finally {
			unregister();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("delivers daemon completion when closing its monitor artifact fails", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-artifact-close-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("READY\\n");
process.stdin.on("data", chunk => {
	if (chunk.includes("FINISH")) process.exit(0);
});
`,
		);
		const artifactPath = path.join(tempDir.path(), "artifact-close.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{ id: "artifact-close-monitor", name: "artifact-close", owner: "owner", artifactPath },
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");
		let disposeSpy: { mockRestore(): void } | undefined;
		try {
			await unregister.ready;
			await client.request({
				op: "start",
				spec: {
					name: "artifact-close",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			await waitForOutputCount(notifications, 1);
			disposeSpy = vi.spyOn(OutputSink.prototype, "dispose").mockRejectedValueOnce(new Error("close failed"));
			await client.request({ op: "send", name: "artifact-close", data: "FINISH\n" });
			const waited = await client.request({
				op: "wait",
				name: "artifact-close",
				for: "exit",
				timeoutMs: 5_000,
			});
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			await completed.promise;

			expect(waited.daemon).toMatchObject({ state: "exited", exitCode: 0 });
			expect(notifications.at(-1)?.event).toBe("daemon-monitor-completed");
		} finally {
			disposeSpy?.mockRestore();
			unregister();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("retains artifact-failure expiry across reconnect until the subscription consumes it", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-artifact-replay-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const artifactPath = path.join(tempDir.path(), "artifact-is-a-directory");
		await fs.mkdir(projectDir);
		await fs.mkdir(artifactPath);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => {
	if (chunk.includes("FINISH")) {
		process.stdout.write("AFTER_EXPIRY\\n");
		process.exit(0);
	}
	process.stdout.write("TRIGGER_EXPIRY\\n");
});
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		const subscription = {
			id: "artifact-replay-monitor",
			registrationId: "artifact-replay-registration",
			name: "artifact-replay",
			owner: "raw-owner",
			artifactPath,
		};
		const subscriptionId = "artifact-replay-client";
		let first: RawBrokerSocket | undefined;
		let second: RawBrokerSocket | undefined;
		try {
			await client.request({
				op: "start",
				spec: {
					name: "artifact-replay",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			const token = (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim();
			const envelope = (id: string, outputSubscriptions: Record<string, unknown>[]): string =>
				`${JSON.stringify({
					id,
					token,
					outputSubscriptionId: subscriptionId,
					outputSubscriptions,
					operation: { op: "ping" },
				})}\n`;

			first = await openRawBrokerSocket(endpoint);
			first.socket.write(envelope("register-artifact-replay", [subscription]));
			await first.waitFor(message => message.id === "register-artifact-replay");
			await client.request({ op: "send", name: "artifact-replay", data: "TRIGGER\n" });
			const initialExpiry = await first.waitFor(message => message.event === "daemon-monitor-expired");
			expect(initialExpiry).toMatchObject({
				monitorId: subscription.id,
				registrationId: subscription.registrationId,
				name: subscription.name,
			});
			first.socket.destroy();

			second = await openRawBrokerSocket(endpoint);
			second.socket.write(envelope("reconnect-artifact-replay", [subscription]));
			const replayedExpiry = await second.waitFor(message => message.event === "daemon-monitor-expired");
			expect(replayedExpiry).toEqual(initialExpiry);

			// An empty advertisement is the terminal acknowledgement. Once consumed,
			// later output and daemon completion must not follow the expiry.
			second.socket.write(envelope("consume-artifact-replay", []));
			await second.waitFor(message => message.id === "consume-artifact-replay");
			await client.request({ op: "send", name: "artifact-replay", data: "FINISH\n" });
			const waited = await client.request({
				op: "wait",
				name: "artifact-replay",
				for: "exit",
				timeoutMs: 5_000,
			});
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			second.socket.write(envelope("after-artifact-replay", []));
			await second.waitFor(message => message.id === "after-artifact-replay");

			expect(waited.daemon).toMatchObject({ state: "exited", exitCode: 0 });
			expect(
				second.messages.filter(message => typeof message.event === "string").map(message => message.event),
			).toEqual(["daemon-monitor-expired"]);
		} finally {
			first?.socket.destroy();
			second?.socket.destroy();
			await client.request({ op: "stop", name: "artifact-replay", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);
	it("drops a disabled offline registration after reconnect grace before it is republished", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-disabled-offline-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const artifactPath = path.join(tempDir.path(), "artifact-is-a-directory");
		await fs.mkdir(projectDir);
		await fs.mkdir(artifactPath);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => process.stdout.write(chunk));
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, {
			outputReconnectGraceMs: 100,
			progressBatchIntervalMs: 0,
		});
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		const subscription = {
			id: "disabled-offline-monitor",
			registrationId: "disabled-offline-registration",
			name: "disabled-offline",
			owner: "raw-owner",
			artifactPath,
		};
		const subscriptionId = "disabled-offline-client";
		let first: RawBrokerSocket | undefined;
		let second: RawBrokerSocket | undefined;
		try {
			await client.request({
				op: "start",
				spec: {
					name: subscription.name,
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			const token = (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim();
			const envelope = (id: string): string =>
				`${JSON.stringify({
					id,
					token,
					outputSubscriptionId: subscriptionId,
					outputSubscriptions: [subscription],
					operation: { op: "ping" },
				})}\n`;

			first = await openRawBrokerSocket(endpoint);
			first.socket.write(envelope("register-disabled-offline"));
			await first.waitFor(message => message.id === "register-disabled-offline");
			await client.request({ op: "send", name: subscription.name, data: "TRIGGER_EXPIRY\n" });
			await first.waitFor(message => message.event === "daemon-monitor-expired");
			first.socket.destroy();

			// This integration exercises the broker's real socket-close timer; fake
			// timers cannot drive the socket event loop. Once grace elapses, publishing
			// the same identity must create a new sink rather than replay its expiry.
			await Bun.sleep(400);
			await fs.rm(artifactPath, { recursive: true, force: true });
			second = await openRawBrokerSocket(endpoint);
			second.socket.write(envelope("republish-disabled-offline"));
			await second.waitFor(message => message.id === "republish-disabled-offline");
			expect(second.messages.some(message => message.event === "daemon-monitor-expired")).toBeFalse();

			await client.request({ op: "send", name: subscription.name, data: "FRESH\n" });
			const fresh = await second.waitFor(
				message => message.event === "daemon-output" && message.monitorId === subscription.id,
			);
			expect(fresh).toMatchObject({
				event: "daemon-output",
				monitorId: subscription.id,
				registrationId: subscription.registrationId,
				text: "FRESH",
			});
			expect(await Bun.file(artifactPath).text()).toBe("FRESH\n");
		} finally {
			first?.socket.destroy();
			second?.socket.destroy();
			await client.request({ op: "stop", name: subscription.name, timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	// A released registration leaves its capture on disk. A later subscription
	// on the same artifact path continues that capture only when it acknowledges
	// the size it already delivered (`artifactBytes`); otherwise the broker
	// starts a fresh capture rather than appending behind bytes nobody vouched
	// for.
	async function republishCapture(continueCapture: boolean): Promise<void> {
		using tempDir = TempDir.createSync("@omp-launch-monitor-expire-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => process.stdout.write(chunk));
`,
		);
		const artifactPath = path.join(tempDir.path(), "expire-progress.log");
		const firstClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const secondClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const firstNotifications: DaemonMonitorNotification[] = [];
		const secondNotifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const firstUnregister = firstClient.onOutput?.(
			{ id: "expire-monitor", name: "expire", owner: "first-owner", artifactPath },
			notification => {
				firstNotifications.push(notification);
			},
		);
		if (!firstUnregister) throw new Error("Expected output monitoring support");
		let secondUnregister: (() => void) | undefined;
		try {
			await firstClient.request({ op: "ping" });
			await firstClient.request({
				op: "start",
				spec: {
					name: "expire",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			await firstClient.request({ op: "send", name: "expire", data: "FIRST\n" });
			await waitForOutputCount(firstNotifications, 1);
			const first = firstNotifications.find(notification => notification.event === "daemon-output");
			if (first?.event !== "daemon-output") throw new Error("Expected a delivered output batch");
			// Every batch reports the artifact size it is backed by.
			expect(first.artifactBytes).toBe("FIRST\n".length);
			firstUnregister();
			// The ping carries the emptied subscription list; its response proves
			// the broker released the first registration before the daemon runs on.
			await firstClient.request({ op: "ping" });
			firstClient.close();

			secondUnregister = secondClient.onOutput?.(
				{
					id: "expire-monitor",
					name: "expire",
					owner: "second-owner",
					artifactPath,
					...(continueCapture ? { artifactBytes: first.artifactBytes } : {}),
				},
				notification => {
					secondNotifications.push(notification);
					if (notification.event === "daemon-monitor-completed") completed.resolve();
				},
			);
			if (!secondUnregister) throw new Error("Expected output monitoring support");
			await secondClient.request({ op: "ping" });
			await secondClient.request({ op: "send", name: "expire", data: "SECOND\n" });
			await waitForOutputCount(secondNotifications, 1);
			await secondClient.request({ op: "stop", name: "expire", timeoutMs: 2_000 });
			await completed.promise;

			const second = secondNotifications.find(notification => notification.event === "daemon-output");
			if (second?.event !== "daemon-output") throw new Error("Expected a delivered output batch");
			const expected = continueCapture ? "FIRST\nSECOND\n" : "SECOND\n";
			// Each range lands exactly once and the reported offset matches the file.
			expect(await Bun.file(artifactPath).text()).toBe(expected);
			expect(second.artifactBytes).toBe(expected.length);
		} finally {
			firstUnregister();
			secondUnregister?.();
			await secondClient.request({ op: "stop", name: "expire", timeoutMs: 2_000 }).catch(() => undefined);
			await secondClient.request({ op: "shutdown" }).catch(() => undefined);
			firstClient.close();
			secondClient.close();
			await broker;
			setProcessName(previousTitle);
		}
	}

	it("continues a dropped registration's capture only past the artifact size the subscription acknowledges", async () => {
		await republishCapture(true);
	}, 20_000);

	it("starts a fresh capture when a republished subscription acknowledges no artifact bytes", async () => {
		await republishCapture(false);
	}, 20_000);

	it("settles a replaced same-path sink before the replacement truncates the capture", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-replace-same-path-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => process.stdout.write(chunk));
`,
		);
		const artifactPath = path.join(tempDir.path(), "same-path.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		// Drives the daemon while `client`'s socket is held by its pending publication.
		const driver = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const firstNotifications: DaemonMonitorNotification[] = [];
		const secondNotifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const secondOutput = Promise.withResolvers<void>();
		const firstUnregister = client.onOutput?.(
			{ id: "same-path-monitor", name: "same-path", owner: "first-owner", artifactPath },
			notification => {
				firstNotifications.push(notification);
			},
		);
		if (!firstUnregister) throw new Error("Expected output monitoring support");
		// The replaced sink's dispose() is held open: a write that was still
		// buffered when the client re-registered lands during its in-flight end().
		const disposeStarted = Promise.withResolvers<void>();
		const releaseDispose = Promise.withResolvers<void>();
		const originalDispose = OutputSink.prototype.dispose;
		const disposeSpy = vi
			.spyOn(OutputSink.prototype, "dispose")
			.mockImplementationOnce(async function (this: OutputSink): Promise<void> {
				disposeStarted.resolve();
				await releaseDispose.promise;
				this.push("STALE\n");
				return originalDispose.call(this);
			});
		let secondUnregister: DaemonOutputUnregister | undefined;
		try {
			await firstUnregister.ready;
			await client.request({
				op: "start",
				spec: {
					name: "same-path",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			await client.request({ op: "send", name: "same-path", data: "FIRST\n" });
			await waitForOutputCount(firstNotifications, 1);
			expect(await Bun.file(artifactPath).text()).toBe("FIRST\n");

			// Same id and path, no `artifactBytes` acknowledgement: the broker must
			// start a fresh capture at `artifactPath` behind the replaced sink.
			secondUnregister = client.onOutput?.(
				{ id: "same-path-monitor", name: "same-path", owner: "second-owner", artifactPath },
				notification => {
					secondNotifications.push(notification);
					if (notification.event === "daemon-output") secondOutput.resolve();
					if (notification.event === "daemon-monitor-completed") completed.resolve();
				},
			);
			if (!secondUnregister) throw new Error("Expected output monitoring support");
			await disposeStarted.promise;
			expect(disposeSpy).toHaveBeenCalledTimes(1);
			// While the old sink is still closing, the broker has not created the
			// replacement sink: bytes the daemon emits now must not truncate the file
			// the old sink is still flushing into. `wait` returns once the broker
			// has appended the echo to the daemon log, i.e. after it fanned it out.
			await driver.request({ op: "send", name: "same-path", data: "SECOND\n" });
			const echoed = await driver.request({
				op: "wait",
				name: "same-path",
				for: "exit",
				pattern: "SECOND",
				timeoutMs: 5_000,
			});
			if (echoed.op !== "wait") throw new Error("unexpected wait result");
			expect(echoed.timedOut).toBeFalse();
			expect(secondNotifications).toHaveLength(0);
			expect(await Bun.file(artifactPath).text()).toBe("FIRST\n");

			releaseDispose.resolve();
			await secondUnregister.ready;
			// The old capture absorbed its late write before the replacement opened;
			// the replacement's capture starts at its own attach point.
			expect(await Bun.file(artifactPath).text()).toBe("FIRST\nSTALE\n");
			await client.request({ op: "send", name: "same-path", data: "THIRD\n" });
			await secondOutput.promise;
			await client.request({ op: "stop", name: "same-path", timeoutMs: 2_000 });
			await completed.promise;

			const second = secondNotifications.find(notification => notification.event === "daemon-output");
			if (second?.event !== "daemon-output") throw new Error("Expected a delivered output batch");
			expect(await Bun.file(artifactPath).text()).toBe("THIRD\n");
			expect(second.artifactBytes).toBe("THIRD\n".length);
		} finally {
			releaseDispose.resolve();
			disposeSpy.mockRestore();
			firstUnregister();
			secondUnregister?.();
			await client.request({ op: "stop", name: "same-path", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			driver.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("replays unacknowledged output batches to a reconnecting subscription and honors cumulative acks", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-replay-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => process.stdout.write(chunk));
`,
		);
		const artifactPath = path.join(tempDir.path(), "replay-progress.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);

		interface RawMonitorSocket {
			socket: net.Socket;
			messages: Record<string, unknown>[];
			waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
		}
		const openMonitorSocket = async (
			token: string,
			ack?: { lastEpoch: string; lastSeq: number },
		): Promise<RawMonitorSocket> => {
			const socket = net.createConnection(endpoint);
			const connected = Promise.withResolvers<void>();
			socket.once("connect", () => connected.resolve());
			socket.once("error", connected.reject);
			await connected.promise;
			const messages: Record<string, unknown>[] = [];
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString("utf8");
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.trim()) messages.push(JSON.parse(line) as Record<string, unknown>);
					newline = buffer.indexOf("\n");
				}
			});
			socket.write(
				`${JSON.stringify({
					id: crypto.randomUUID(),
					token,
					outputSubscriptions: [
						{
							id: "replay-monitor",
							registrationId: "replay-registration",
							name: "replay",
							owner: "raw-owner",
							artifactPath,
							...ack,
						},
					],
					outputSubscriptionId: "raw-subscription",
					operation: { op: "ping" },
				})}\n`,
			);
			return {
				socket,
				messages,
				async waitFor(predicate) {
					const deadline = Date.now() + 5_000;
					while (Date.now() < deadline) {
						const match = messages.find(predicate);
						if (match) return match;
						await Bun.sleep(10);
					}
					throw new Error(`No matching wire message among ${JSON.stringify(messages)}`);
				},
			};
		};
		const outputsOf = (raw: RawMonitorSocket): Record<string, unknown>[] =>
			raw.messages.filter(message => message.event === "daemon-output");

		let first: RawMonitorSocket | undefined;
		let second: RawMonitorSocket | undefined;
		let third: RawMonitorSocket | undefined;
		try {
			await client.request({
				op: "start",
				spec: {
					name: "replay",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			const token = (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim();

			first = await openMonitorSocket(token);
			await first.waitFor(message => message.ok === true);
			await client.request({ op: "send", name: "replay", data: "ONE\n" });
			const delivered = await first.waitFor(message => message.event === "daemon-output");
			const epoch = delivered.epoch;
			if (typeof epoch !== "string") throw new Error("Expected an epoch on the output batch");
			expect(delivered.seq).toBe(1);
			// Abrupt drop: the write succeeded locally but the client never acked.
			first.socket.destroy();

			second = await openMonitorSocket(token);
			const replayed = await second.waitFor(message => message.event === "daemon-output");
			expect(replayed.epoch).toBe(epoch);
			expect(replayed.seq).toBe(1);
			expect(replayed.text).toBe("ONE");
			await client.request({ op: "send", name: "replay", data: "TWO\n" });
			await second.waitFor(message => message.event === "daemon-output" && message.seq === 2);
			second.socket.destroy();

			// Cumulative ack through seq 2: nothing replays, live output resumes.
			third = await openMonitorSocket(token, { lastEpoch: epoch, lastSeq: 2 });
			await third.waitFor(message => message.ok === true);
			await client.request({ op: "send", name: "replay", data: "THREE\n" });
			await third.waitFor(message => message.event === "daemon-output");
			expect(outputsOf(third).map(message => message.seq)).toEqual([3]);
			expect(outputsOf(third).map(message => message.text)).toEqual(["THREE"]);
		} finally {
			first?.socket.destroy();
			second?.socket.destroy();
			third?.socket.destroy();
			await client.request({ op: "stop", name: "replay", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("streams fresh detached output without another RPC or duplicate polling", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-detached-dup-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		const flagPath = path.join(tempDir.path(), "exit-flag");
		await Bun.write(
			scriptPath,
			`import * as fs from "node:fs";
fs.writeSync(1, "PAYLOAD\\n");
const timer = setInterval(() => {
	if (fs.existsSync(${JSON.stringify(flagPath)})) {
		clearInterval(timer);
		process.exit(0);
	}
}, 25);
`,
		);
		const artifactPath = path.join(tempDir.path(), "detached-dup-progress.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{ id: "detached-dup-monitor", name: "detached-dup", owner: "owner", artifactPath },
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");
		try {
			// Publish the subscription before start so the daemon's first bytes land
			// after this registration's attach point.
			await unregister.ready;
			await client.request({
				op: "start",
				spec: {
					name: "detached-dup",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: true,
				},
			});
			// Start is the last broker operation before observing progress. The
			// detached process remains alive until the flag is written below, so
			// only the generation-owned refresh loop can advance this monitor.
			await waitForOutputCount(notifications, 1);
			const deadline = Date.now() + 5_000;
			while (
				(await Bun.file(artifactPath)
					.text()
					.catch(() => "")) !== "PAYLOAD\n"
			) {
				if (Date.now() > deadline) throw new Error("Detached monitor artifact never received its payload");
				await Bun.sleep(10);
			}
			expect(notifications.some(notification => notification.event === "daemon-monitor-completed")).toBeFalse();
			expect(await Bun.file(artifactPath).text()).toBe("PAYLOAD\n");
			const output = notifications.filter(
				(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
					notification.event === "daemon-output",
			);
			const joined = output.map(notification => notification.text).join("\n");
			expect(joined.split("PAYLOAD").length - 1).toBe(1);

			await Bun.write(flagPath, "done");
			await completed.promise;

			expect(await Bun.file(artifactPath).text()).toBe("PAYLOAD\n");
		} finally {
			unregister();
			await Bun.write(flagPath, "done").catch(() => undefined);
			await client.request({ op: "stop", name: "detached-dup", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("preserves a UTF-8 code point split across detached log polls", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-detached-utf8-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		const firstHalfWrittenPath = path.join(tempDir.path(), "first-half-written");
		const continuePath = path.join(tempDir.path(), "continue");
		await Bun.write(
			scriptPath,
			`import * as fs from "node:fs";
fs.writeSync(1, Buffer.from([0xf0, 0x9f]));
fs.writeFileSync(${JSON.stringify(firstHalfWrittenPath)}, "done");
const timer = setInterval(() => {
	if (fs.existsSync(${JSON.stringify(continuePath)})) {
		clearInterval(timer);
		fs.writeSync(1, Buffer.from([0x98, 0x80, 0x0a]));
		process.exit(0);
	}
}, 25);
`,
		);
		const artifactPath = path.join(tempDir.path(), "detached-utf8-progress.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{ id: "detached-utf8-monitor", name: "detached-utf8", owner: "owner", artifactPath },
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");
		try {
			await unregister.ready;
			await client.request({
				op: "start",
				spec: {
					name: "detached-utf8",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: true,
				},
			});

			const deadline = Date.now() + 5_000;
			while (!(await Bun.file(firstHalfWrittenPath).exists())) {
				if (Date.now() > deadline) throw new Error("Detached daemon never wrote the first UTF-8 slice");
				await Bun.sleep(10);
			}
			const sliced = await client.request({ op: "describe", name: "detached-utf8" });
			if (sliced.op !== "describe") throw new Error("unexpected describe result");
			expect(sliced.daemon.outputBytes).toBe(2);
			expect(
				await Bun.file(artifactPath)
					.text()
					.catch(() => ""),
			).toBe("");
			expect(notifications.some(notification => notification.event === "daemon-output")).toBeFalse();

			await Bun.write(continuePath, "done");
			await completed.promise;
			const output = notifications
				.filter(
					(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
						notification.event === "daemon-output",
				)
				.map(notification => notification.text)
				.join("");
			expect(output).toBe("😀");
			expect(await Bun.file(artifactPath).text()).toBe("😀\n");
		} finally {
			unregister();
			await Bun.write(continuePath, "done").catch(() => undefined);
			await client.request({ op: "stop", name: "detached-utf8", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("preserves the detached output cursor across automatic restarts", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-detached-restart-cursor-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		const statePath = path.join(tempDir.path(), "incarnation-count");
		const holdPath = path.join(tempDir.path(), "hold-third-incarnation");
		await Bun.write(
			scriptPath,
			`import * as fs from "node:fs";
let incarnation = 0;
try {
	incarnation = Number(fs.readFileSync(${JSON.stringify(statePath)}, "utf8"));
} catch {}
incarnation++;
fs.writeFileSync(${JSON.stringify(statePath)}, String(incarnation));
fs.writeSync(1, \`INCARNATION_\${incarnation}\\n\`);
if (incarnation < 3) process.exit(0);
const timer = setInterval(() => {
	if (fs.existsSync(${JSON.stringify(holdPath)})) {
		clearInterval(timer);
		process.exit(0);
	}
}, 25);
`,
		);
		const artifactPath = path.join(tempDir.path(), "detached-restart-progress.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, {
			progressBatchIntervalMs: 0,
			restartBackoffBaseMs: 10,
		});
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{ id: "detached-restart-monitor", name: "detached-restart", owner: "owner", artifactPath },
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");
		try {
			await unregister.ready;
			await client.request({
				op: "start",
				spec: {
					name: "detached-restart",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "always",
					persist: false,
					detached: true,
				},
			});

			const expected = ["INCARNATION_1", "INCARNATION_2", "INCARNATION_3"];
			const deadline = Date.now() + 5_000;
			for (;;) {
				const preview = notifications
					.filter(
						(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
							notification.event === "daemon-output",
					)
					.map(notification => notification.text)
					.join("\n");
				const artifact = await Bun.file(artifactPath)
					.text()
					.catch(() => "");
				if (expected.every(marker => preview.includes(marker) && artifact.includes(marker))) break;
				if (Date.now() > deadline) throw new Error("Detached daemon did not publish three incarnations");
				await Bun.sleep(10);
			}

			await client.request({ op: "stop", name: "detached-restart", timeoutMs: 2_000 });
			await completed.promise;
			const preview = notifications
				.filter(
					(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
						notification.event === "daemon-output",
				)
				.map(notification => notification.text)
				.join("\n");
			const artifact = await Bun.file(artifactPath).text();
			for (const marker of expected) {
				expect(preview.split(marker)).toHaveLength(2);
				expect(artifact.split(marker)).toHaveLength(2);
			}
		} finally {
			unregister();
			await Bun.write(holdPath, "done").catch(() => undefined);
			await client.request({ op: "stop", name: "detached-restart", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("starts a detached monitor at its attach point instead of replaying earlier log bytes", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-detached-attach-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		const flagPath = path.join(tempDir.path(), "finish-flag");
		await Bun.write(
			scriptPath,
			`import * as fs from "node:fs";
fs.writeSync(1, "PRE_ATTACH\\n");
const timer = setInterval(() => {
	if (fs.existsSync(${JSON.stringify(flagPath)})) {
		clearInterval(timer);
		fs.writeSync(1, "POST_ATTACH\\n");
		process.exit(0);
	}
}, 25);
`,
		);
		const artifactPath = path.join(tempDir.path(), "detached-attach-progress.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		let unregister: (() => void) | undefined;
		try {
			await client.request({
				op: "start",
				spec: {
					name: "detached-attach",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: true,
				},
			});
			// The pre-attach bytes must exist before the subscription is installed.
			// Either the periodic loop has already advanced past them or subscription
			// synchronization drains them before creating the monitor.
			const logPath = path.join(runtimeDir, "daemons", "detached-attach", "output.log");
			const deadline = Date.now() + 5_000;
			while (
				!(
					await Bun.file(logPath)
						.text()
						.catch(() => "")
				).includes("PRE_ATTACH\n")
			) {
				if (Date.now() > deadline) throw new Error("Detached daemon never wrote its pre-attach line");
				await Bun.sleep(10);
			}
			unregister = client.onOutput?.(
				{ id: "detached-attach-monitor", name: "detached-attach", owner: "owner", artifactPath },
				notification => {
					notifications.push(notification);
					if (notification.event === "daemon-monitor-completed") completed.resolve();
				},
			);
			if (!unregister) throw new Error("Expected output monitoring support");
			// Publishing the subscription drains the pre-attach log bytes so the
			// registration's capture starts here.
			await client.request({ op: "ping" });
			await Bun.write(flagPath, "done");
			await completed.promise;

			const output = notifications.filter(
				(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
					notification.event === "daemon-output",
			);
			const joined = output.map(notification => notification.text).join("\n");
			expect(joined).toContain("POST_ATTACH");
			expect(joined).not.toContain("PRE_ATTACH");
			expect(await Bun.file(artifactPath).text()).toBe("POST_ATTACH\n");
		} finally {
			unregister?.();
			await Bun.write(flagPath, "done").catch(() => undefined);
			await client.request({ op: "stop", name: "detached-attach", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("retains enough unacknowledged batches to replay a full reconnect grace window", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-replay-depth-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => process.stdout.write(chunk));
`,
		);
		const artifactPath = path.join(tempDir.path(), "replay-depth-progress.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		// A short batch window makes each send below its own batch, so the
		// disconnected registration accumulates far more notifications than the
		// old flat 32-entry retention — all still within the reconnect grace.
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 10 });
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);

		interface RawMonitorSocket {
			socket: net.Socket;
			messages: Record<string, unknown>[];
			waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
		}
		const openMonitorSocket = async (token: string): Promise<RawMonitorSocket> => {
			const socket = net.createConnection(endpoint);
			const connected = Promise.withResolvers<void>();
			socket.once("connect", () => connected.resolve());
			socket.once("error", connected.reject);
			await connected.promise;
			const messages: Record<string, unknown>[] = [];
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString("utf8");
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.trim()) messages.push(JSON.parse(line) as Record<string, unknown>);
					newline = buffer.indexOf("\n");
				}
			});
			socket.write(
				`${JSON.stringify({
					id: crypto.randomUUID(),
					token,
					outputSubscriptions: [
						{
							id: "replay-depth-monitor",
							registrationId: "replay-depth-registration",
							name: "replay-depth",
							owner: "raw-owner",
							artifactPath,
						},
					],
					outputSubscriptionId: "raw-depth-subscription",
					operation: { op: "ping" },
				})}\n`,
			);
			return {
				socket,
				messages,
				async waitFor(predicate) {
					const deadline = Date.now() + 5_000;
					while (Date.now() < deadline) {
						const match = messages.find(predicate);
						if (match) return match;
						await Bun.sleep(10);
					}
					throw new Error(`No matching wire message among ${JSON.stringify(messages)}`);
				},
			};
		};

		let first: RawMonitorSocket | undefined;
		let second: RawMonitorSocket | undefined;
		try {
			await client.request({
				op: "start",
				spec: {
					name: "replay-depth",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			const token = (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim();

			first = await openMonitorSocket(token);
			await first.waitFor(message => message.ok === true);
			// Abrupt drop before any output: every batch below goes unacknowledged.
			first.socket.destroy();

			const sends = 48;
			for (let index = 1; index <= sends; index++) {
				await client.request({ op: "send", name: "replay-depth", data: `LINE_${index}\n` });
				// Separate flush windows: each send becomes its own batch and seq.
				await Bun.sleep(40);
			}

			second = await openMonitorSocket(token);
			await second.waitFor(message => message.ok === true);
			// Replays are written before the envelope's response, so everything the
			// broker retained already precedes the ok frame in the stream.
			const seqs = second.messages
				.filter(message => message.event === "daemon-output")
				.map(message => Number(message.seq))
				.sort((left, right) => left - right);
			// Retention must cover the grace window's worst case, not a flat 32
			// entries: a shallower buffer evicts the oldest batches, so seq 1 would
			// be missing and the sequence would start past the eviction point.
			expect(seqs.length).toBeGreaterThan(32);
			expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
		} finally {
			first?.socket.destroy();
			second?.socket.destroy();
			await client.request({ op: "stop", name: "replay-depth", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 30_000);

	interface EchoDaemonHarness {
		client: DaemonBrokerClient;
		broker: Promise<void>;
		endpoint: string;
		token: string;
		artifactPath: string;
		restoreTitle: () => void;
	}

	/** Start a broker plus one stdin-echo daemon named `name`, ready for raw monitor sockets. */
	async function startEchoDaemon(
		tempDir: TempDir,
		name: string,
		options: DaemonBrokerStartOptions,
	): Promise<EchoDaemonHarness> {
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => process.stdout.write(chunk));
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, options);
		await client.request({
			op: "start",
			spec: {
				name,
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			},
		});
		return {
			client,
			broker,
			endpoint: daemonBrokerEndpoint(projectDir, runtimeDir),
			token: (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim(),
			artifactPath: path.join(tempDir.path(), `${name}.log`),
			restoreTitle: () => setProcessName(previousTitle),
		};
	}

	async function stopEchoDaemon(harness: EchoDaemonHarness, name: string): Promise<void> {
		await harness.client.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
		await harness.client.request({ op: "shutdown" }).catch(() => undefined);
		harness.client.close();
		await harness.broker;
		harness.restoreTitle();
	}

	/**
	 * The broker mirrors a chunk into the artifact as it arrives, so file
	 * growth proves the broker consumed the echo. The batch timer then has 1 ms
	 * granularity; a unix-socket round trip can finish inside it and fold the
	 * next echo into the same batch, so wait past that window too. Fake timers
	 * cannot drive the real broker socket loop here.
	 */
	async function waitForArtifactText(artifactPath: string, text: string): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			if (
				(
					await Bun.file(artifactPath)
						.text()
						.catch(() => "")
				).includes(text)
			) {
				await Bun.sleep(5);
				return;
			}
			await Bun.sleep(10);
		}
		throw new Error(`Artifact never contained ${JSON.stringify(text)}`);
	}

	function outputSeqs(raw: RawBrokerSocket): number[] {
		return raw.messages.filter(message => message.event === "daemon-output").map(message => Number(message.seq));
	}

	it("holds live output at the replay cap until acknowledgements reopen the window, then reports evictions as a gap", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-backlog-");
		const harness = await startEchoDaemon(tempDir, "backlog", {
			progressBatchIntervalMs: 0,
			maxRetainedOutputBatches: 3,
		});
		const { client, endpoint, token, artifactPath } = harness;
		const registration = {
			id: "backlog-monitor",
			registrationId: "backlog-registration",
			name: "backlog",
			owner: "raw-owner",
			artifactPath,
		};
		const envelope = (id: string, ack?: { lastEpoch: string; lastSeq: number }): string =>
			`${JSON.stringify({
				id,
				token,
				outputSubscriptionId: "backlog-subscription",
				outputSubscriptions: [{ ...registration, ...ack }],
				operation: { op: "ping" },
			})}\n`;
		let raw: RawBrokerSocket | undefined;
		try {
			raw = await openRawBrokerSocket(endpoint);
			raw.socket.write(envelope("register-backlog"));
			await raw.waitFor(message => message.id === "register-backlog" && message.ok === true);
			const send = async (index: number): Promise<void> => {
				await client.request({ op: "send", name: "backlog", data: `LINE_${index}\n` });
				await waitForArtifactText(artifactPath, `LINE_${index}\n`);
			};
			for (let index = 1; index <= 3; index++) {
				await send(index);
				await raw.waitFor(message => message.event === "daemon-output" && message.seq === index);
			}
			const first = raw.messages.find(message => message.event === "daemon-output");
			const epoch = String(first?.epoch);
			// Three unacknowledged batches are in flight: the fourth is retained but
			// not written, and the monitor is not expired for falling behind.
			await send(4);
			raw.socket.write(envelope("probe-held"));
			await raw.waitFor(message => message.id === "probe-held");
			expect(outputSeqs(raw)).toEqual([1, 2, 3]);
			expect(raw.messages.some(message => message.event === "daemon-monitor-expired")).toBeFalse();

			// Acknowledging the in-flight prefix reopens the window for the held batch.
			raw.socket.write(envelope("ack-3", { lastEpoch: epoch, lastSeq: 3 }));
			const fourth = await raw.waitFor(message => message.event === "daemon-output" && message.seq === 4);
			expect(fourth.replayGap).toBeUndefined();

			// Two more fit the window; the rest are retained. Retention is capped at
			// three, so the oldest retained batches — including one this socket
			// never received — are evicted as output keeps arriving.
			for (let index = 5; index <= 10; index++) await send(index);
			raw.socket.write(envelope("probe-window"));
			await raw.waitFor(message => message.id === "probe-window");
			expect(outputSeqs(raw)).toEqual([1, 2, 3, 4, 5, 6]);

			// The next ack surfaces the evicted, never-delivered batch (seq 7) as an
			// explicit gap before the retained tail replays.
			raw.socket.write(envelope("ack-6", { lastEpoch: epoch, lastSeq: 6 }));
			const gap = await raw.waitFor(message => message.event === "daemon-output" && message.seq === 7);
			expect(gap).toMatchObject({ text: "", replayGap: 1, suppressedEvents: 1, truncated: true });
			await raw.waitFor(message => message.event === "daemon-output" && message.seq === 9);
			raw.socket.write(envelope("ack-9", { lastEpoch: epoch, lastSeq: 9 }));
			const tenth = await raw.waitFor(message => message.event === "daemon-output" && message.seq === 10);
			expect(tenth).toMatchObject({ text: "LINE_10", artifactBytes: (await Bun.file(artifactPath).text()).length });
			expect(outputSeqs(raw)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
			expect(raw.messages.some(message => message.event === "daemon-monitor-expired")).toBeFalse();
			expect(await Bun.file(artifactPath).text()).toBe(
				Array.from({ length: 10 }, (_, index) => `LINE_${index + 1}\n`).join(""),
			);
		} finally {
			raw?.socket.destroy();
			await stopEchoDaemon(harness, "backlog");
		}
	}, 20_000);

	it("marks batches evicted by the count cap as a gap when a disconnected monitor reconnects", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-count-gap-");
		const harness = await startEchoDaemon(tempDir, "count-gap", {
			progressBatchIntervalMs: 0,
			maxRetainedOutputBatches: 4,
		});
		const { client, endpoint, token, artifactPath } = harness;
		const registration = {
			id: "count-gap-monitor",
			registrationId: "count-gap-registration",
			name: "count-gap",
			owner: "raw-owner",
			artifactPath,
		};
		const envelope = (id: string, ack?: { lastEpoch: string; lastSeq: number }): string =>
			`${JSON.stringify({
				id,
				token,
				outputSubscriptionId: "count-gap-subscription",
				outputSubscriptions: [{ ...registration, ...ack }],
				operation: { op: "ping" },
			})}\n`;
		let first: RawBrokerSocket | undefined;
		let second: RawBrokerSocket | undefined;
		try {
			first = await openRawBrokerSocket(endpoint);
			first.socket.write(envelope("register-count-gap"));
			await first.waitFor(message => message.id === "register-count-gap" && message.ok === true);
			for (let index = 1; index <= 2; index++) {
				await client.request({ op: "send", name: "count-gap", data: `LINE_${index}\n` });
				await first.waitFor(message => message.event === "daemon-output" && message.seq === index);
			}
			const epoch = String(first.messages.find(message => message.event === "daemon-output")?.epoch);
			first.socket.destroy();
			// Six more batches against a four-deep buffer: seqs 1-4 are evicted.
			for (let index = 3; index <= 8; index++) {
				await client.request({ op: "send", name: "count-gap", data: `LINE_${index}\n` });
				// Serializes echoes so each line is its own batch and seq.
				await waitForArtifactText(artifactPath, `LINE_${index}\n`);
			}
			// Settlement drains every retained batch before the terminal notice is
			// queued behind them, so the reconnect below observes a settled buffer.
			await client.request({ op: "stop", name: "count-gap", timeoutMs: 2_000 });

			// The client delivered seqs 1-2; evicted 3-4 are lost and must be
			// announced, then the retained tail replays within the window (4) and
			// the terminal notice waits behind the held batches.
			second = await openRawBrokerSocket(endpoint);
			second.socket.write(envelope("reconnect-count-gap", { lastEpoch: epoch, lastSeq: 2 }));
			await second.waitFor(message => message.id === "reconnect-count-gap" && message.ok === true);
			const gap = second.messages.find(message => message.event === "daemon-output");
			expect(gap).toMatchObject({ seq: 4, text: "", replayGap: 2, suppressedEvents: 2, truncated: true });
			expect(outputSeqs(second)).toEqual([4, 5, 6]);
			expect(second.messages.some(message => message.event === "daemon-monitor-completed")).toBeFalse();
			second.socket.write(envelope("ack-count-gap", { lastEpoch: epoch, lastSeq: 6 }));
			await second.waitFor(message => message.event === "daemon-monitor-completed");
			expect(outputSeqs(second)).toEqual([4, 5, 6, 7, 8]);
			expect(second.messages.filter(message => "event" in message).at(-1)).toMatchObject({
				event: "daemon-monitor-completed",
			});
			expect(second.messages.some(message => message.event === "daemon-monitor-expired")).toBeFalse();
		} finally {
			first?.socket.destroy();
			second?.socket.destroy();
			await stopEchoDaemon(harness, "count-gap");
		}
	}, 20_000);

	it("bounds retained replay text by bytes and reports the evicted prefix on reconnect", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-byte-gap-");
		// Each batch previews one 8-byte line; a 20-byte cap retains two.
		const harness = await startEchoDaemon(tempDir, "byte-gap", {
			progressBatchIntervalMs: 0,
			maxRetainedOutputBytes: 20,
		});
		const { client, endpoint, token, artifactPath } = harness;
		const registration = {
			id: "byte-gap-monitor",
			registrationId: "byte-gap-registration",
			name: "byte-gap",
			owner: "raw-owner",
			artifactPath,
		};
		const envelope = (id: string): string =>
			`${JSON.stringify({
				id,
				token,
				outputSubscriptionId: "byte-gap-subscription",
				outputSubscriptions: [registration],
				operation: { op: "ping" },
			})}\n`;
		let first: RawBrokerSocket | undefined;
		let second: RawBrokerSocket | undefined;
		try {
			first = await openRawBrokerSocket(endpoint);
			first.socket.write(envelope("register-byte-gap"));
			await first.waitFor(message => message.id === "register-byte-gap" && message.ok === true);
			first.socket.destroy();
			for (let index = 1; index <= 6; index++) {
				await client.request({ op: "send", name: "byte-gap", data: `LINE_00${index}\n` });
				await waitForArtifactText(artifactPath, `LINE_00${index}\n`);
			}
			await client.request({ op: "stop", name: "byte-gap", timeoutMs: 2_000 });

			second = await openRawBrokerSocket(endpoint);
			second.socket.write(envelope("reconnect-byte-gap"));
			await second.waitFor(message => message.id === "reconnect-byte-gap" && message.ok === true);
			const outputs = second.messages.filter(message => message.event === "daemon-output");
			expect(outputs[0]).toMatchObject({ seq: 4, text: "", replayGap: 4, suppressedEvents: 4, truncated: true });
			expect(outputs.slice(1)).toMatchObject([
				{ seq: 5, text: "LINE_005" },
				{ seq: 6, text: "LINE_006" },
			]);
			expect(second.messages.filter(message => "event" in message).at(-1)).toMatchObject({
				event: "daemon-monitor-completed",
			});
			expect(await Bun.file(artifactPath).text()).toBe(
				Array.from({ length: 6 }, (_, index) => `LINE_00${index + 1}\n`).join(""),
			);
		} finally {
			first?.socket.destroy();
			second?.socket.destroy();
			await stopEchoDaemon(harness, "byte-gap");
		}
	}, 20_000);

	it("lets a client without the output-monitor capability start and drive an unmonitored daemon", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-legacy-client-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => process.stdout.write(chunk));
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		let legacy: RawBrokerSocket | undefined;
		try {
			await client.request({ op: "ping" });
			const token = (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim();
			// A pre-v4 client never advertises outputSubscriptions/outputSubscriptionId.
			legacy = await openRawBrokerSocket(endpoint);
			const request = (id: string, operation: Record<string, unknown>): void => {
				legacy?.socket.write(`${JSON.stringify({ id, token, operation })}\n`);
			};
			request("legacy-start", {
				op: "start",
				spec: {
					name: "legacy",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			const started = await legacy.waitFor(message => message.id === "legacy-start");
			expect(started.ok).toBeTrue();
			request("legacy-send", { op: "send", name: "legacy", data: "UNMONITORED\n" });
			await legacy.waitFor(message => message.id === "legacy-send" && message.ok === true);
			// Output reaches the daemon log, and a describe after it proves the
			// socket stayed a plain RPC channel: no monitor frames, no error.
			const waited = await client.request({
				op: "wait",
				name: "legacy",
				for: "exit",
				pattern: "UNMONITORED",
				timeoutMs: 5_000,
			});
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			expect(waited.matched).toBe("UNMONITORED");
			request("legacy-describe", { op: "describe", name: "legacy" });
			const described = await legacy.waitFor(message => message.id === "legacy-describe");
			expect(described.ok).toBeTrue();
			expect(legacy.messages.some(message => "event" in message)).toBeFalse();
			request("legacy-stop", { op: "stop", name: "legacy", timeoutMs: 2_000 });
			const stopped = await legacy.waitFor(message => message.id === "legacy-stop");
			expect(stopped.ok).toBeTrue();
		} finally {
			legacy?.socket.destroy();
			await client.request({ op: "stop", name: "legacy", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	// The broker runs in-process here, so /proc/self/fd exposes every artifact
	// descriptor it holds. Both release paths only log on failure; this checks
	// the descriptor is really gone rather than trusting the log-and-continue.
	it.skipIf(process.platform !== "linux")(
		"releases the artifact descriptor when a monitor unregisters and when its daemon exits",
		async () => {
			using tempDir = TempDir.createSync("@omp-launch-monitor-fd-");
			const harness = await startEchoDaemon(tempDir, "fd-release", { progressBatchIntervalMs: 0 });
			const { client, artifactPath } = harness;
			const openDescriptors = async (): Promise<number> => {
				let count = 0;
				for (const entry of await fs.readdir("/proc/self/fd")) {
					const target = await fs.readlink(`/proc/self/fd/${entry}`).catch(() => "");
					if (target === artifactPath) count++;
				}
				return count;
			};
			const waitForRelease = async (): Promise<void> => {
				const deadline = Date.now() + 5_000;
				while (Date.now() < deadline) {
					if ((await openDescriptors()) === 0) return;
					await Bun.sleep(10);
				}
				throw new Error("artifact descriptor was never released");
			};
			let unregister: DaemonOutputUnregister | undefined;
			let second: DaemonOutputUnregister | undefined;
			try {
				const notifications: DaemonMonitorNotification[] = [];
				unregister = client.onOutput?.(
					{ id: "fd-monitor", name: "fd-release", owner: "owner", artifactPath },
					notification => {
						notifications.push(notification);
					},
				);
				if (!unregister) throw new Error("Expected output monitoring support");
				await unregister.ready;
				await client.request({ op: "send", name: "fd-release", data: "OPEN\n" });
				await waitForOutputCount(notifications, 1);
				expect(await openDescriptors()).toBe(1);

				unregister();
				await client.request({ op: "ping" });
				await waitForRelease();

				const completed = Promise.withResolvers<void>();
				const later: DaemonMonitorNotification[] = [];
				second = client.onOutput?.(
					{ id: "fd-monitor-2", name: "fd-release", owner: "owner", artifactPath },
					notification => {
						later.push(notification);
						if (notification.event === "daemon-monitor-completed") completed.resolve();
					},
				);
				if (!second) throw new Error("Expected output monitoring support");
				await second.ready;
				await client.request({ op: "send", name: "fd-release", data: "AGAIN\n" });
				await waitForOutputCount(later, 1);
				expect(await openDescriptors()).toBe(1);
				await client.request({ op: "stop", name: "fd-release", timeoutMs: 2_000 });
				await completed.promise;
				await waitForRelease();
			} finally {
				unregister?.();
				second?.();
				await stopEchoDaemon(harness, "fd-release");
			}
		},
		20_000,
	);

	it("releases monitor sync tokens without reviving obsolete detached envelopes", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-sync-race-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(scriptPath, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n");
		const oldArtifactPath = path.join(tempDir.path(), "old-race.log");
		const newArtifactPath = path.join(tempDir.path(), "new-race.log");
		const staleArtifactPath = path.join(tempDir.path(), "stale-race.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		const spec: DaemonSpec = {
			name: "sync-race",
			application: process.execPath,
			args: [scriptPath],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: false,
			detached: true,
		};
		let raw: RawBrokerSocket | undefined;
		try {
			await client.request({ op: "start", owner: "race-owner", spec });
			const token = (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim();
			raw = await openRawBrokerSocket(endpoint);
			const request = (
				id: string,
				outputSubscriptions: Record<string, unknown>[],
				outputSubscriptionId = "sync-race-client",
				completionOwners?: string[],
			): string =>
				JSON.stringify({
					id,
					token,
					outputSubscriptionId,
					outputSubscriptions,
					...(completionOwners === undefined
						? {}
						: {
								completionEvents: true,
								completionSubscriptionId: "sync-race-completions",
								owners: completionOwners,
							}),
					operation: { op: "ping" },
				});
			const oldSubscription = {
				id: "race-monitor",
				registrationId: "old-race-registration",
				name: "sync-race",
				owner: "race-owner",
				artifactPath: oldArtifactPath,
			};
			const newSubscription = {
				...oldSubscription,
				registrationId: "new-race-registration",
				artifactPath: newArtifactPath,
			};
			// Both lines are parsed in one data callback. The first registration
			// yields in the detached pre-attach drain; the replacement must wait.
			raw.socket.write(`${request("old", [oldSubscription])}\n${request("new", [newSubscription])}\n`);
			await Promise.all([
				raw.waitFor(message => message.id === "old"),
				raw.waitFor(message => message.id === "new"),
			]);

			const logPath = path.join(runtimeDir, "daemons", "sync-race", "output.log");
			await Bun.write(logPath, "REPLACEMENT\n");
			await client.request({ op: "describe", name: "sync-race" });
			await raw.waitFor(message => message.event === "daemon-output" && message.monitorId === "race-monitor");
			expect(await Bun.file(newArtifactPath).text()).toBe("REPLACEMENT\n");
			expect(await Bun.file(oldArtifactPath).exists()).toBeFalse();

			const staleSubscription = {
				id: "stale-monitor",
				registrationId: "stale-registration",
				name: "sync-race",
				owner: "race-owner",
				artifactPath: staleArtifactPath,
			};
			// The first line begins attaching stale-monitor and yields in its drain
			// before publishing race-owner. The newer envelope removes both the
			// monitor and owner in arrival order; neither obsolete mutation may
			// resume after the newer envelope settles.
			raw.socket.write(
				`${request("register-stale", [staleSubscription], "obsolete-token-client", [
					"race-owner",
				])}\n${request("unregister-stale", [], "obsolete-token-client", [])}\n`,
			);
			await Promise.all([
				raw.waitFor(message => message.id === "register-stale"),
				raw.waitFor(message => message.id === "unregister-stale"),
			]);
			await Bun.write(logPath, "REPLACEMENT\nUNREGISTERED\n");
			await client.request({ op: "describe", name: "sync-race" });
			await client.request({ op: "stop", name: "sync-race", timeoutMs: 2_000 });
			await raw.waitFor(
				message => message.event === "daemon-monitor-completed" && message.monitorId === "race-monitor",
			);
			raw.socket.write(`${JSON.stringify({ id: "completion-fence", token, operation: { op: "ping" } })}\n`);
			await raw.waitFor(message => message.id === "completion-fence" && message.ok === true);

			expect(await Bun.file(newArtifactPath).text()).toBe("REPLACEMENT\nUNREGISTERED\n");
			expect(await Bun.file(staleArtifactPath).exists()).toBeFalse();
			expect(raw.messages.some(message => message.monitorId === "stale-monitor")).toBeFalse();
			expect(
				raw.messages.some(message => message.event === "daemon-completed" && message.owner === "race-owner"),
			).toBeFalse();
			await client.request({ op: "start", owner: "race-owner", spec });
		} finally {
			raw?.socket.destroy();
			await client.request({ op: "stop", name: "sync-race", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("keeps a retained terminal monitor bound to its original daemon incarnation", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-incarnation-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		const artifactPath = path.join(tempDir.path(), "incarnation.log");
		await Bun.write(scriptPath, 'process.stdout.write("OLD\\n");\n');
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		let first: RawBrokerSocket | undefined;
		let reconnect: RawBrokerSocket | undefined;
		try {
			await client.request({ op: "ping" });
			const token = (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim();
			const subscription = {
				id: "incarnation-monitor",
				registrationId: "incarnation-registration",
				name: "incarnation",
				owner: "incarnation-owner",
				artifactPath,
			};
			const envelope = (id: string): string =>
				`${JSON.stringify({
					id,
					token,
					outputSubscriptionId: "incarnation-client",
					outputSubscriptions: [subscription],
					operation: { op: "ping" },
				})}\n`;
			first = await openRawBrokerSocket(endpoint);
			first.socket.write(envelope("register-old"));
			await first.waitFor(message => message.id === "register-old");
			const oldStart = await client.request({
				op: "start",
				spec: {
					name: "incarnation",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (oldStart.op !== "start") throw new Error("unexpected start result");
			const oldId = oldStart.daemon.id;
			await first.waitFor(
				message => message.event === "daemon-monitor-completed" && message.monitorId === "incarnation-monitor",
			);
			const closed = Promise.withResolvers<void>();
			first.socket.once("close", closed.resolve);
			first.socket.destroy();
			await closed.promise;

			await Bun.write(scriptPath, 'process.stdout.write("NEW\\n");\n');
			const newStart = await client.request({
				op: "start",
				spec: {
					name: "incarnation",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (newStart.op !== "start") throw new Error("unexpected start result");
			const newId = newStart.daemon.id;
			await client.request({ op: "wait", name: "incarnation", for: "exit", timeoutMs: 5_000 });

			reconnect = await openRawBrokerSocket(endpoint);
			reconnect.socket.write(envelope("reconnect-old"));
			await reconnect.waitFor(message => message.id === "reconnect-old");
			const terminal = reconnect.messages.filter(
				message => message.event === "daemon-monitor-completed" && message.monitorId === "incarnation-monitor",
			);
			expect(terminal).toHaveLength(1);
			const replayedDaemon = terminal[0]?.daemon;
			expect(
				replayedDaemon && typeof replayedDaemon === "object" && "id" in replayedDaemon
					? replayedDaemon.id
					: undefined,
			).toBe(oldId);
			expect(
				reconnect.messages.some(
					message =>
						message.event === "daemon-output" &&
						(message.daemonId === newId || String(message.text).includes("NEW")),
				),
			).toBeFalse();
			expect(await Bun.file(artifactPath).text()).toBe("OLD\n");
		} finally {
			first?.socket.destroy();
			reconnect?.socket.destroy();
			await client.request({ op: "stop", name: "incarnation", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("replays rejected output without delivering queued completion to the failed sink", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-sink-reject-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(scriptPath, 'process.stdout.write("REPLAY_ME\\n");\n');
		const artifactPath = path.join(tempDir.path(), "sink-reject.log");
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const observer = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 0 });
		const firstRejected = Promise.withResolvers<void>();
		const replayed = Promise.withResolvers<void>();
		const events: string[] = [];
		let rejectOutput = true;
		const unregister = client.onOutput?.(
			{ id: "reject-monitor", name: "sink-reject", owner: "reject-owner", artifactPath },
			notification => {
				events.push(notification.event);
				if (notification.event === "daemon-output" && rejectOutput) {
					rejectOutput = false;
					firstRejected.resolve();
					throw new Error("intentional sink rejection");
				}
				if (notification.event === "daemon-output") replayed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");
		try {
			await client.request({ op: "ping" });
			await observer.request({
				op: "start",
				spec: {
					name: "sink-reject",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			await firstRejected.promise;
			await observer.request({ op: "wait", name: "sink-reject", for: "exit", timeoutMs: 5_000 });
			await replayed.promise;
			await Promise.resolve();
			await Promise.resolve();
			await client.request({ op: "ping" });

			expect(events).toEqual(["daemon-output", "daemon-output"]);
			expect(await Bun.file(artifactPath).text()).toBe("REPLAY_ME\n");
		} finally {
			unregister();
			await observer.request({ op: "stop", name: "sink-reject", timeoutMs: 2_000 }).catch(() => undefined);
			await observer.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			observer.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("acknowledges monitor output as soon as its sink finishes delivery", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-output-ack-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		const requests: BrokerRequest[] = [];
		const firstPublication = Promise.withResolvers<BrokerRequest>();
		const outputAck = Promise.withResolvers<BrokerRequest>();
		let brokerSocket: net.Socket | undefined;
		const server = net.createServer(socket => {
			brokerSocket = socket;
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString("utf8");
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.trim()) {
						const request = JSON.parse(line) as BrokerRequest;
						requests.push(request);
						if (requests.length === 1) firstPublication.resolve(request);
						if (request.outputSubscriptions?.[0]?.lastSeq === 1) outputAck.resolve(request);
						socket.write(
							`${JSON.stringify({
								id: request.id,
								ok: true,
								result: {
									op: "ping",
									projectDir,
									capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY],
								},
							})}\n`,
						);
					}
					newline = buffer.indexOf("\n");
				}
			});
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(endpoint, listening.resolve);
		await listening.promise;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const sinkStarted = Promise.withResolvers<void>();
		const releaseSink = Promise.withResolvers<void>();
		let unregister: DaemonOutputUnregister | undefined;
		try {
			unregister = client.onOutput?.(
				{
					id: "output-ack",
					name: "acknowledged",
					owner: "owner",
					artifactPath: path.join(tempDir.path(), "acknowledged.log"),
				},
				async notification => {
					if (notification.event !== "daemon-output") return;
					sinkStarted.resolve();
					await releaseSink.promise;
				},
			);
			if (!unregister) throw new Error("Expected output monitoring registration");
			const publication = await firstPublication.promise;
			await unregister.ready;
			await client.request({ op: "ping" });
			expect(requests.at(-1)?.outputSubscriptions).toBeUndefined();
			const registrationId = publication.outputSubscriptions?.[0]?.registrationId;
			if (typeof registrationId !== "string") throw new Error("Expected advertised registration id");
			if (!brokerSocket) throw new Error("Expected connected broker socket");
			brokerSocket.write(
				`${JSON.stringify({
					event: "daemon-output",
					monitorId: "output-ack",
					registrationId,
					name: "acknowledged",
					daemonId: "acknowledged-daemon",
					epoch: "acknowledged-epoch",
					seq: 1,
					text: "READY",
					batchKind: "progress",
					suppressedEvents: 0,
				})}\n`,
			);

			await sinkStarted.promise;
			await Promise.resolve();
			expect(requests.some(request => request.outputSubscriptions?.[0]?.lastSeq === 1)).toBeFalse();

			releaseSink.resolve();
			const acknowledgement = await outputAck.promise;
			expect(acknowledgement.outputSubscriptions).toEqual([
				expect.objectContaining({
					id: "output-ack",
					registrationId,
					name: "acknowledged",
					owner: "owner",
					artifactPath: path.join(tempDir.path(), "acknowledged.log"),
					lastEpoch: "acknowledged-epoch",
					lastSeq: 1,
				}),
			]);
		} finally {
			releaseSink.resolve();
			unregister?.();
			client.close();
			const serverClosed = Promise.withResolvers<void>();
			server.close(() => serverClosed.resolve());
			await serverClosed.promise;
		}
	}, 20_000);

	it("isolates a failed monitor publication from later daemon requests", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-publication-failure-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		const requests: BrokerRequest[] = [];
		const server = net.createServer(socket => {
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString("utf8");
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.trim()) {
						const request = JSON.parse(line) as BrokerRequest;
						requests.push(request);
						const publication = request.outputSubscriptions !== undefined;
						socket.write(
							`${JSON.stringify(
								publication
									? { id: request.id, ok: false, error: "subscription sync failed" }
									: {
											id: request.id,
											ok: true,
											result: {
												op: "ping",
												projectDir,
												capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY],
											},
										},
							)}\n`,
						);
					}
					newline = buffer.indexOf("\n");
				}
			});
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(endpoint, listening.resolve);
		await listening.promise;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const unregister = client.onOutput?.(
			{
				id: "failed-publication",
				name: "anything",
				owner: "owner",
				artifactPath: path.join(tempDir.path(), "failed-publication.log"),
			},
			() => undefined,
		);
		if (!unregister) throw new Error("Expected output monitoring registration");
		try {
			await expect(unregister.ready).rejects.toThrow("subscription sync failed");
			await expect(client.request({ op: "ping" })).resolves.toMatchObject({ op: "ping" });
			expect(requests).toHaveLength(2);
			expect(requests[0]?.outputSubscriptions).toHaveLength(1);
			expect(requests[1]?.outputSubscriptions).toBeUndefined();
		} finally {
			unregister();
			client.close();
			const serverClosed = Promise.withResolvers<void>();
			server.close(() => serverClosed.resolve());
			await serverClosed.promise;
		}
	}, 20_000);

	it("settles monitor readiness when completion wins publication acknowledgement", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-completion-publication-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		type PublicationRequest = BrokerRequest;
		const requests: PublicationRequest[] = [];
		const firstPublication = Promise.withResolvers<PublicationRequest>();
		const removalPublication = Promise.withResolvers<PublicationRequest>();
		const acknowledgePublications = Promise.withResolvers<void>();
		const server = net.createServer(socket => {
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString("utf8");
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.trim()) {
						const request = JSON.parse(line) as PublicationRequest;
						requests.push(request);
						if (requests.length === 1) {
							firstPublication.resolve(request);
							socket.write(
								`${JSON.stringify({
									event: "daemon-monitor-completed",
									monitorId: "completion-before-ping",
									registrationId: request.outputSubscriptions?.[0]?.registrationId,
									daemon: {
										name: "completed",
										id: "completed-daemon",
										state: "exited",
										createdAt: 1,
										startedAt: 1,
										exitedAt: 2,
										exitCode: 0,
										restartCount: 0,
										outputBytes: 0,
										persist: false,
										detached: false,
									},
								})}\n`,
							);
						} else if (requests.length === 2) {
							removalPublication.resolve(request);
						}
						void acknowledgePublications.promise.then(() => {
							socket.write(
								`${JSON.stringify({
									id: request.id,
									ok: true,
									result: {
										op: "ping",
										projectDir,
										capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY],
									},
								})}\n`,
							);
						});
					}
					newline = buffer.indexOf("\n");
				}
			});
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(endpoint, () => listening.resolve());
		await listening.promise;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const artifactPath = path.join(tempDir.path(), "completion-publication.log");
		const completionDelivered = Promise.withResolvers<void>();
		try {
			const unregister = client.onOutput?.(
				{
					id: "completion-before-ping",
					name: "completed",
					owner: "owner",
					artifactPath,
				},
				notification => {
					if (notification.event === "daemon-monitor-completed") completionDelivered.resolve();
				},
			);
			if (!unregister) throw new Error("Expected output monitoring registration");
			const published = await firstPublication.promise;
			const registrationId = published.outputSubscriptions?.[0]?.registrationId;
			if (typeof registrationId !== "string") throw new Error("Expected advertised registration id");
			expect(published.outputSubscriptions).toEqual([
				{
					id: "completion-before-ping",
					registrationId,
					name: "completed",
					owner: "owner",
					artifactPath,
				},
			]);
			await completionDelivered.promise;
			const removed = await removalPublication.promise;
			expect(removed.outputSubscriptions).toEqual([]);
			await expect(unregister.ready).resolves.toBeUndefined();

			acknowledgePublications.resolve();
			const ping = await client.request({ op: "ping" });
			expect(ping.op).toBe("ping");
			unregister();
		} finally {
			acknowledgePublications.resolve();
			client.close();
			const serverClosed = Promise.withResolvers<void>();
			server.close(() => serverClosed.resolve());
			await serverClosed.promise;
		}
	}, 20_000);

	it("ignores stale same-daemon notifications after replacing a monitor registration", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-client-replacement-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		type PublicationRequest = BrokerRequest;
		const firstPublication = Promise.withResolvers<PublicationRequest>();
		const replacementPublication = Promise.withResolvers<PublicationRequest>();
		const removalPublication = Promise.withResolvers<PublicationRequest>();
		const acknowledgePublications = Promise.withResolvers<void>();
		let requestCount = 0;
		let brokerSocket: net.Socket | undefined;
		const server = net.createServer(socket => {
			brokerSocket = socket;
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString("utf8");
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.trim()) {
						const request = JSON.parse(line) as PublicationRequest;
						requestCount++;
						if (requestCount === 1) firstPublication.resolve(request);
						else if (requestCount === 2) replacementPublication.resolve(request);
						else if (request.outputSubscriptions?.length === 0) removalPublication.resolve(request);
						void acknowledgePublications.promise.then(() => {
							socket.write(
								`${JSON.stringify({
									id: request.id,
									ok: true,
									result: {
										op: "ping",
										projectDir,
										capabilities: [DAEMON_OUTPUT_MONITOR_CAPABILITY],
									},
								})}\n`,
							);
						});
					}
					newline = buffer.indexOf("\n");
				}
			});
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(endpoint, () => listening.resolve());
		await listening.promise;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const oldNotifications: DaemonMonitorNotification[] = [];
		const newNotifications: DaemonMonitorNotification[] = [];
		const newCompletionDelivered = Promise.withResolvers<void>();
		let oldUnregister: DaemonOutputUnregister | undefined;
		let newUnregister: DaemonOutputUnregister | undefined;
		try {
			oldUnregister = client.onOutput?.(
				{
					id: "replacement-race",
					name: "same-daemon",
					owner: "owner",
					artifactPath: path.join(tempDir.path(), "old.log"),
				},
				notification => {
					oldNotifications.push(notification);
				},
			);
			if (!oldUnregister) throw new Error("Expected output monitoring registration");
			const first = await firstPublication.promise;
			const oldRegistrationId = first.outputSubscriptions?.[0]?.registrationId;
			if (typeof oldRegistrationId !== "string") throw new Error("Expected first advertised registration id");

			newUnregister = client.onOutput?.(
				{
					id: "replacement-race",
					name: "same-daemon",
					owner: "owner",
					artifactPath: path.join(tempDir.path(), "new.log"),
				},
				notification => {
					newNotifications.push(notification);
					if (notification.event === "daemon-monitor-completed") newCompletionDelivered.resolve();
				},
			);
			if (!newUnregister) throw new Error("Expected replacement output monitoring registration");
			const replacement = await replacementPublication.promise;
			const newRegistrationId = replacement.outputSubscriptions?.[0]?.registrationId;
			if (typeof newRegistrationId !== "string") throw new Error("Expected replacement advertised registration id");
			expect(newRegistrationId).not.toBe(oldRegistrationId);
			expect(replacement.outputSubscriptions).toEqual([
				{
					id: "replacement-race",
					registrationId: newRegistrationId,
					name: "same-daemon",
					owner: "owner",
					artifactPath: path.join(tempDir.path(), "new.log"),
				},
			]);
			await expect(oldUnregister.ready).rejects.toThrow(/replaced before it was acknowledged/);
			if (!brokerSocket) throw new Error("Expected connected broker socket");

			brokerSocket.write(
				`${[
					{
						event: "daemon-output",
						monitorId: "replacement-race",
						registrationId: oldRegistrationId,
						name: "same-daemon",
						daemonId: "same-incarnation",
						epoch: "old-epoch",
						seq: 1,
						text: "OLD_OUTPUT",
						batchKind: "progress",
						suppressedEvents: 0,
					},
					{
						event: "daemon-monitor-completed",
						monitorId: "replacement-race",
						registrationId: oldRegistrationId,
						daemon: {
							name: "same-daemon",
							id: "same-incarnation",
							state: "exited",
							createdAt: 1,
							startedAt: 1,
							exitedAt: 2,
							exitCode: 0,
							restartCount: 0,
							outputBytes: 10,
							persist: false,
							detached: false,
						},
					},
					{
						event: "daemon-output",
						monitorId: "replacement-race",
						registrationId: newRegistrationId,
						name: "same-daemon",
						daemonId: "same-incarnation",
						epoch: "new-epoch",
						seq: 1,
						text: "NEW_OUTPUT",
						batchKind: "progress",
						suppressedEvents: 0,
					},
					{
						event: "daemon-monitor-completed",
						monitorId: "replacement-race",
						registrationId: newRegistrationId,
						daemon: {
							name: "same-daemon",
							id: "same-incarnation",
							state: "exited",
							createdAt: 3,
							startedAt: 3,
							exitedAt: 4,
							exitCode: 0,
							restartCount: 0,
							outputBytes: 10,
							persist: false,
							detached: false,
						},
					},
				]
					.map(notification => JSON.stringify(notification))
					.join("\n")}\n`,
			);

			await newCompletionDelivered.promise;
			const removal = await removalPublication.promise;
			expect(removal.outputSubscriptions).toEqual([]);
			expect(oldNotifications).toEqual([]);
			expect(newNotifications.map(notification => notification.event)).toEqual([
				"daemon-output",
				"daemon-monitor-completed",
			]);
			expect(newNotifications[0]).toMatchObject({
				name: "same-daemon",
				daemonId: "same-incarnation",
				text: "NEW_OUTPUT",
			});
			expect(newNotifications[0]).not.toHaveProperty("registrationId");
			expect(newNotifications[1]).toMatchObject({
				daemon: { name: "same-daemon", id: "same-incarnation" },
			});
			expect(newNotifications[1]).not.toHaveProperty("registrationId");
			await expect(newUnregister.ready).resolves.toBeUndefined();

			acknowledgePublications.resolve();
			const ping = await client.request({ op: "ping" });
			expect(ping.op).toBe("ping");
		} finally {
			acknowledgePublications.resolve();
			oldUnregister?.();
			newUnregister?.();
			client.close();
			const serverClosed = Promise.withResolvers<void>();
			server.close(() => serverClosed.resolve());
			await serverClosed.promise;
		}
	}, 20_000);

	it("rejects the first onOutput operation after a legacy broker acknowledges its capabilities", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-capability-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
		const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		const requests: BrokerRequest[] = [];
		const firstRequest = Promise.withResolvers<BrokerRequest>();
		const acknowledgeCapabilities = Promise.withResolvers<void>();
		// Pre-v4 broker: authenticates and answers pings but advertises no
		// output-monitor capability.
		const server = net.createServer(socket => {
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString("utf8");
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.trim()) {
						const request = JSON.parse(line) as BrokerRequest;
						requests.push(request);
						if (requests.length === 1) firstRequest.resolve(request);
						void acknowledgeCapabilities.promise.then(() => {
							socket.write(
								`${JSON.stringify({
									id: request.id,
									ok: true,
									result: { op: "ping", projectDir, capabilities: [] },
								})}\n`,
							);
						});
					}
					newline = buffer.indexOf("\n");
				}
			});
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(endpoint, () => listening.resolve());
		await listening.promise;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const artifactPath = path.join(tempDir.path(), "capability-progress.log");
		try {
			const unregister = client.onOutput?.(
				{ id: "capability-monitor", name: "anything", owner: "owner", artifactPath },
				() => undefined,
			);
			if (!unregister) throw new Error("Expected output monitoring registration");
			let readySettled = false;
			void unregister.ready.then(
				() => {
					readySettled = true;
				},
				() => {
					readySettled = true;
				},
			);
			const published = await firstRequest.promise;
			const registrationId = published.outputSubscriptions?.[0]?.registrationId;
			if (typeof registrationId !== "string") throw new Error("Expected advertised registration id");
			expect(published.outputSubscriptions).toEqual([
				{ id: "capability-monitor", registrationId, name: "anything", owner: "owner", artifactPath },
			]);
			await Promise.resolve();
			expect(readySettled).toBeFalse();

			const earlyUnregister = client.onOutput?.(
				{ id: "early-monitor", name: "early", owner: "owner", artifactPath },
				() => undefined,
			);
			if (!earlyUnregister) throw new Error("Expected output monitoring registration");
			earlyUnregister();
			earlyUnregister();
			await expect(earlyUnregister.ready).rejects.toThrow(/removed before it was acknowledged/);
			expect(readySettled).toBeFalse();

			acknowledgeCapabilities.resolve();
			await expect(unregister.ready).rejects.toThrow(/does not support output monitoring/);
			expect(readySettled).toBeTrue();
			unregister();
			unregister();

			await client.request({ op: "ping" });
			expect(requests.at(-1)?.outputSubscriptions).toBeUndefined();
		} finally {
			acknowledgeCapabilities.resolve();
			client.close();
			const serverClosed = Promise.withResolvers<void>();
			server.close(() => serverClosed.resolve());
			await serverClosed.promise;
		}
	}, 20_000);

	it("turns carriage-return progress rewrites into line-bounded previews", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-cr-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		const monitorArtifactPath = path.join(tempDir.path(), "cr-progress.log");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("progress 1\\rprogress 2\\rprogress 3\\n");
process.stdin.once("data", () => process.exit(0));
`,
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 25 });

		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{ id: "monitor-cr", name: "cr-watched", owner: "owner-cr", artifactPath: monitorArtifactPath },
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");

		try {
			// Publish the subscription before start, closing the immediate-output race.
			await client.request({ op: "ping" });
			const started = await client.request({
				op: "start",
				owner: "owner-cr",
				spec: {
					name: "cr-watched",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			await waitForOutputCount(notifications, 1);
			await client.request({ op: "send", name: "cr-watched", data: "finish\n" });
			await client.request({ op: "wait", name: "cr-watched", for: "exit", timeoutMs: 5_000 });
			await completed.promise;

			const output = notifications.filter(
				(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
					notification.event === "daemon-output",
			);
			// Each \r-overwritten state is its own preview line, not one concatenated blob.
			expect(output.map(notification => notification.text).join("\n")).toBe("progress 1\nprogress 2\nprogress 3");
			expect(await Bun.file(monitorArtifactPath).text()).toBe("progress 1\nprogress 2\nprogress 3\n");
		} finally {
			unregister();
			await client.request({ op: "stop", name: "cr-watched", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("emits live batches for a carriage-return-only stream with no trailing newline", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-cr-only-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		const monitorArtifactPath = path.join(tempDir.path(), "cr-only-progress.log");
		// Spinner-style process: only \r-terminated rewrites, never a newline.
		// The child's real setTimeout forces two separate pipe chunks; fake
		// timers cannot drive a subprocess clock.
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("step 1\\r");
setTimeout(() => {
	process.stdout.write("step 2\\r");
}, 50);
process.stdin.once("data", () => process.exit(0));
`,
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir, { progressBatchIntervalMs: 25 });

		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.(
			{ id: "monitor-cr-only", name: "cr-only", owner: "owner-cr-only", artifactPath: monitorArtifactPath },
			notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");

		try {
			await client.request({ op: "ping" });
			const started = await client.request({
				op: "start",
				owner: "owner-cr-only",
				spec: {
					name: "cr-only",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			// The second \r completes the first state into a line; a live batch
			// must arrive while the process is still running (pre-fix this hung
			// until exit because sanitizeText stripped every \r first).
			await waitForOutputCount(notifications, 1);
			const liveTexts = notifications
				.filter(
					(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
						notification.event === "daemon-output",
				)
				.map(notification => notification.text);
			expect(liveTexts[0]).toBe("step 1");

			await client.request({ op: "send", name: "cr-only", data: "finish\n" });
			await client.request({ op: "wait", name: "cr-only", for: "exit", timeoutMs: 5_000 });
			await completed.promise;

			const output = notifications.filter(
				(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
					notification.event === "daemon-output",
			);
			// The trailing partial (after the final \r) flushes at settlement.
			expect(output.map(notification => notification.text).join("\n")).toBe("step 1\nstep 2");
		} finally {
			unregister();
			await client.request({ op: "stop", name: "cr-only", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);
});
