// Integration test — real timers are required (ts-no-test-timers exception): this spawns the
// actual cross-process daemon broker driving real child processes, and the bug is a leaked real
// `setTimeout` in #settle that resurrects a stopped daemon. Fake timers cannot control the OS
// process-exit promise or the unix-socket RPC the broker relies on. The embedded broker uses a
// shorter real backoff here; proving the absence of resurrection still requires crossing it.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerStartOptions, startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
	type DaemonSnapshot,
} from "../../src/launch/protocol";

const RESTART_BACKOFF_BASE_MS = 250;
const INITIAL_RESTART_DELAY_MS = RESTART_BACKOFF_BASE_MS * 2;
const RESTART_SETTLE_MARGIN_MS = 150;

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

async function snapshotOf(client: DaemonBrokerClient, name: string): Promise<DaemonSnapshot> {
	const listed = await client.request({ op: "list" });
	if (listed.op !== "list") throw new Error(`unexpected result: ${listed.op}`);
	const daemon = listed.daemons.find(entry => entry.name === name);
	if (!daemon) throw new Error(`daemon ${name} not listed`);
	return daemon;
}

async function waitForState(
	client: DaemonBrokerClient,
	name: string,
	state: DaemonSnapshot["state"],
	deadlineMs: number,
): Promise<DaemonSnapshot> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const daemon = await snapshotOf(client, name);
		if (daemon.state === state) return daemon;
		await Bun.sleep(25);
	}
	throw new Error(`daemon ${name} never reached state ${state}`);
}

async function waitForReplacement(
	client: DaemonBrokerClient,
	name: string,
	initialStartedAt: number,
	deadlineMs: number,
): Promise<DaemonSnapshot> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const daemon = await snapshotOf(client, name);
		if (daemon.restartCount > 0 && daemon.startedAt > initialStartedAt) return daemon;
		await Bun.sleep(25);
	}
	throw new Error(`daemon ${name} never launched a replacement generation`);
}

async function waitForPendingCompletions(
	runtimeDir: string,
	name: string,
	count: number,
	deadlineMs: number,
): Promise<void> {
	const metaPath = path.join(runtimeDir, "daemons", name, "meta.json");
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const metadata = (await Bun.file(metaPath).json()) as { pendingCompletions?: unknown[] };
		if (metadata.pendingCompletions?.length === count) return;
		await Bun.sleep(25);
	}
	throw new Error(`daemon ${name} pending completion count never reached ${count}`);
}

function firstGenerationExitArgs(projectDir: string, name: string, exitCode = 0): string[] {
	const marker = path.join(projectDir, `${name}.first-generation`);
	const script = [
		'const fs = require("node:fs");',
		`const marker = ${JSON.stringify(marker)};`,
		"if (fs.existsSync(marker)) setInterval(() => {}, 1000);",
		`else { fs.writeFileSync(marker, "done"); setTimeout(() => process.exit(${JSON.stringify(exitCode)}), 100); }`,
	].join(" ");
	return ["-e", script];
}

describe.serial("daemon broker restart settling", () => {
	it("does not re-settle a restarting detached daemon on ops, keeping stop authoritative", async () => {
		using tempDir = TempDir.createSync("@omp-launch-restart-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		// Create the client (writes broker.token) before starting the broker, which reads that token.
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir, {
			restartBackoffBaseMs: RESTART_BACKOFF_BASE_MS,
		});
		const name = "crash-loop";
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name,
					// Fast-exit child: exits 0 immediately, so restart:"always" parks it in `restarting`.
					application: process.execPath,
					args: ["-e", "process.exit(0)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "always",
					persist: false,
					detached: true,
				},
			});
			expect(started.op).toBe("start");

			// Enter the restarting backoff window and record the restart count.
			const restarting = await waitForState(client, name, "restarting", 5_000);
			const baseline = restarting.restartCount;

			// Poll while restarting. Each op runs #refreshDetached; a re-entrant #settle would
			// phantom-increment restartCount and leak an armed timer (issue #6852).
			for (let i = 0; i < 3; i++) {
				const seen = await snapshotOf(client, name);
				expect(seen.state).toBe("restarting");
				expect(seen.restartCount).toBe(baseline);
			}

			// Stop must be authoritative: clears the single armed timer, no orphaned timer resurrects.
			const stopped = await client.request({ op: "stop", name, timeoutMs: 2_000 });
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			expect(stopped.daemon.state).toBe("exited");

			// Cross the configured initial backoff where a leaked timer would fire #launch.
			await Bun.sleep(INITIAL_RESTART_DELAY_MS + RESTART_SETTLE_MARGIN_MS);
			const afterStop = await snapshotOf(client, name);
			expect(afterStop.state).toBe("exited");
			expect(afterStop.pid).toBeUndefined();
			expect(afterStop.restartCount).toBe(baseline);
		} finally {
			await client.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 20_000);

	it("settles a recovered detached daemon once across concurrent refreshes", async () => {
		using tempDir = TempDir.createSync("@omp-launch-recovered-restart-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		const name = "recovered-crash";
		let pid: number | undefined;

		const firstClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const firstBroker = startBroker(projectDir, runtimeDir);
		try {
			const started = await firstClient.request({
				op: "start",
				spec: {
					name,
					application: process.execPath,
					args: ["-e", 'Bun.serve({ port: 0, fetch() { return new Response("ok"); } })'],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "always",
					persist: true,
					detached: true,
				},
			});
			if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);
			pid = started.daemon.pid;
			if (pid === undefined) throw new Error("detached daemon has no pid");
		} finally {
			await firstClient.request({ op: "shutdown" }).catch(() => undefined);
			firstClient.close();
			await firstBroker;
		}

		const secondClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const secondBroker = startBroker(projectDir, runtimeDir);
		try {
			const recovered = await snapshotOf(secondClient, name);
			expect(recovered.state).toBe("running");
			expect(recovered.pid).toBe(pid);

			const processRef = Process.fromPid(pid);
			if (!processRef) throw new Error(`recovered daemon process ${pid} is unavailable`);
			await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });

			// Both requests enter #settle before its detached-output read completes. The
			// post-read guard must let only one continuation settle this generation.
			const concurrentLists = await Promise.all([
				secondClient.request({ op: "list" }),
				secondClient.request({ op: "list" }),
			]);
			for (const listed of concurrentLists) {
				if (listed.op !== "list") throw new Error(`unexpected result: ${listed.op}`);
				const daemon = listed.daemons.find(entry => entry.name === name);
				expect(daemon?.state).toBe("restarting");
				expect(daemon?.restartCount).toBe(1);
			}
		} finally {
			await secondClient.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
			await secondClient.request({ op: "shutdown" }).catch(() => undefined);
			secondClient.close();
			await secondBroker;
			const processRef = pid === undefined ? null : Process.fromPid(pid);
			if (processRef?.status() === "running") {
				await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
			}
			process.title = previousTitle;
		}
	}, 20_000);
	it("delivers completion for the exited generation before automatic restart", async () => {
		using tempDir = TempDir.createSync("@omp-launch-completion-restart-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		const name = "completion-restart";
		const owner = "completion-owner";
		const completions: DaemonCompletionNotification[] = [];
		const firstCompletion = Promise.withResolvers<DaemonCompletionNotification>();
		let unregister: (() => void) | undefined;
		try {
			unregister = client.onCompletion(owner, notification => {
				completions.push(notification);
				if (completions.length === 1) firstCompletion.resolve(notification);
			});
			await client.request({ op: "ping" });

			const started = await client.request({
				op: "start",
				owner,
				spec: {
					name,
					application: process.execPath,
					args: firstGenerationExitArgs(projectDir, name),
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "always",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);

			const metadataBefore = (await Bun.file(path.join(runtimeDir, "daemons", name, "meta.json")).json()) as {
				completionEvents?: boolean;
				completionSubscriptionId?: string;
			};
			expect(metadataBefore.completionEvents).toBe(true);
			expect(typeof metadataBefore.completionSubscriptionId).toBe("string");

			const completion = await firstCompletion.promise;
			expect(completion).toMatchObject({
				event: "daemon-completed",
				completionId: expect.any(String),
				owner,
				daemon: {
					id: started.daemon.id,
					state: "exited",
					exitCode: 0,
					restartCount: 0,
				},
			});
			expect(completions).toHaveLength(1);

			const replacement = await waitForReplacement(client, name, completion.daemon.startedAt, 5_000);
			expect(replacement.id).toBe(completion.daemon.id);
			expect(replacement.restartCount).toBe(1);
			expect(replacement.startedAt).toBeGreaterThan(completion.daemon.startedAt);

			const metadataAfter = (await Bun.file(path.join(runtimeDir, "daemons", name, "meta.json")).json()) as {
				completionSubscriptionId?: string;
			};
			expect(metadataAfter.completionSubscriptionId).toBe(metadataBefore.completionSubscriptionId);
			const stopped = await client.request({ op: "stop", name, timeoutMs: 2_000 });
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			expect(stopped.daemon.state).toBe("exited");
			expect(completions).toHaveLength(1);
		} finally {
			await client.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
			unregister?.();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 20_000);

	it("delivers failed completion before an on-failure restart", async () => {
		using tempDir = TempDir.createSync("@omp-launch-failed-completion-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		const name = "failed-completion";
		const owner = "failed-completion-owner";
		const completion = Promise.withResolvers<DaemonCompletionNotification>();
		const completions: DaemonCompletionNotification[] = [];
		let unregister: (() => void) | undefined;
		try {
			unregister = client.onCompletion(owner, notification => {
				completions.push(notification);
				if (completions.length === 1) completion.resolve(notification);
			});
			await client.request({ op: "ping" });

			const started = await client.request({
				op: "start",
				owner,
				spec: {
					name,
					application: process.execPath,
					args: firstGenerationExitArgs(projectDir, name, 7),
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "on-failure",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);

			const notification = await completion.promise;
			expect(notification).toMatchObject({
				event: "daemon-completed",
				completionId: expect.any(String),
				owner,
				daemon: {
					id: started.daemon.id,
					state: "failed",
					exitCode: 7,
					restartCount: 0,
				},
			});
			const replacement = await waitForReplacement(client, name, notification.daemon.startedAt, 5_000);
			expect(replacement.id).toBe(notification.daemon.id);
			expect(replacement.restartCount).toBe(1);
			expect(replacement.startedAt).toBeGreaterThan(notification.daemon.startedAt);
			const stopped = await client.request({ op: "stop", name, timeoutMs: 2_000 });
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			expect(stopped.daemon.state).toBe("exited");
			expect(completions).toHaveLength(1);
		} finally {
			await client.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
			unregister?.();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 20_000);

	it("keeps a successful on-failure completion terminal", async () => {
		using tempDir = TempDir.createSync("@omp-launch-terminal-completion-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		const name = "terminal-completion";
		const owner = "terminal-completion-owner";
		const completion = Promise.withResolvers<DaemonCompletionNotification>();
		const completions: DaemonCompletionNotification[] = [];
		let unregister: (() => void) | undefined;
		try {
			unregister = client.onCompletion(owner, notification => {
				completions.push(notification);
				if (completions.length === 1) completion.resolve(notification);
			});
			await client.request({ op: "ping" });

			const started = await client.request({
				op: "start",
				owner,
				spec: {
					name,
					application: process.execPath,
					args: firstGenerationExitArgs(projectDir, name),
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "on-failure",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);

			const notification = await completion.promise;
			expect(notification).toMatchObject({
				event: "daemon-completed",
				completionId: expect.any(String),
				owner,
				daemon: {
					id: started.daemon.id,
					state: "exited",
					exitCode: 0,
					restartCount: 0,
				},
			});
			const terminal = await snapshotOf(client, name);
			expect(terminal.state).toBe("exited");
			expect(terminal.restartCount).toBe(0);
			expect(completions).toHaveLength(1);
		} finally {
			await client.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
			unregister?.();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 20_000);

	it("replays an unacknowledged restart completion to a reconnecting owner", async () => {
		using tempDir = TempDir.createSync("@omp-launch-completion-replay-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		const firstClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		const name = "completion-replay";
		const owner = "reconnecting-owner";
		const firstAck = Promise.withResolvers<void>();
		const firstDelivered = Promise.withResolvers<DaemonCompletionNotification>();
		const firstCompletions: DaemonCompletionNotification[] = [];
		const replayedCompletions: DaemonCompletionNotification[] = [];
		let unregisterFirst: (() => void) | undefined;
		let secondClient: DaemonBrokerClient | undefined;
		let unregisterSecond: (() => void) | undefined;
		try {
			unregisterFirst = firstClient.onCompletion(owner, notification => {
				firstCompletions.push(notification);
				firstDelivered.resolve(notification);
				return firstAck.promise;
			});
			await firstClient.request({ op: "ping" });

			const started = await firstClient.request({
				op: "start",
				owner,
				spec: {
					name,
					application: process.execPath,
					args: firstGenerationExitArgs(projectDir, name),
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "always",
					persist: true,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);

			const completion = await firstDelivered.promise;
			await waitForPendingCompletions(runtimeDir, name, 1, 5_000);
			const metadata = (await Bun.file(path.join(runtimeDir, "daemons", name, "meta.json")).json()) as {
				pendingCompletions?: Array<{ completionId: string }>;
			};
			expect(metadata.pendingCompletions?.map(pending => pending.completionId)).toEqual([completion.completionId]);

			firstClient.close();
			secondClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const replayed = Promise.withResolvers<DaemonCompletionNotification>();
			unregisterSecond = secondClient.onCompletion(owner, notification => {
				replayedCompletions.push(notification);
				replayed.resolve(notification);
			});
			await secondClient.request({ op: "ping" });

			const replay = await replayed.promise;
			expect(replay.completionId).toBe(completion.completionId);
			expect(replay.daemon.id).toBe(started.daemon.id);
			expect(firstCompletions).toHaveLength(1);
			expect(replayedCompletions).toHaveLength(1);

			firstAck.resolve();
			await waitForPendingCompletions(runtimeDir, name, 0, 5_000);
			await secondClient.request({ op: "ping" });
			expect(replayedCompletions).toHaveLength(1);
		} finally {
			firstAck.resolve();
			unregisterSecond?.();
			unregisterFirst?.();
			const controlClient = secondClient ?? firstClient;
			await controlClient.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
			await controlClient.request({ op: "shutdown" }).catch(() => undefined);
			secondClient?.close();
			firstClient.close();
			await broker;
			process.title = previousTitle;
		}
	}, 20_000);
});
