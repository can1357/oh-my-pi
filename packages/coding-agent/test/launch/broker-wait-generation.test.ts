/**
 * Integration test: the real broker socket and child-process exit drive the
 * generation transition, so fake timers cannot control the observed events.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient, DaemonBrokerRejectedError } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import { type DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

function exitingSpec(name: string, cwd: string, restart: DaemonSpec["restart"]): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args: ["-e", "process.stdout.write('booting\\n'); process.exitCode = 1"],
		env: {},
		cwd,
		pty: false,
		restart,
		persist: false,
		detached: false,
	};
}

async function shutdown(client: DaemonBrokerClient, broker: Promise<void>, name: string): Promise<void> {
	await client.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
	await client.request({ op: "shutdown" }).catch(() => undefined);
	client.close();
	await broker;
}

describe("daemon wait generation binding", () => {
	it("rejects a pattern wait when the observed generation automatically restarts", async () => {
		using tempDir = TempDir.createSync("@omp-wait-generation-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({
				op: "start",
				spec: exitingSpec("restarting", projectDir, "always"),
			});
			if (started.op !== "start") throw new Error("unexpected start result");

			const waitStartedAt = Date.now();
			const waitPending = client
				.request({ op: "wait", name: "restarting", for: "exit", pattern: "NEVER", timeoutMs: 15_000 })
				.then(
					() => undefined,
					(reason: unknown) => reason,
				);

			let restartObserved = false;
			const restartDeadline = Date.now() + 5_000;
			while (Date.now() < restartDeadline) {
				const listed = await client.request({ op: "list" });
				if (
					listed.op === "list" &&
					listed.daemons.some(daemon => daemon.name === "restarting" && daemon.restartCount > 0)
				) {
					restartObserved = true;
					break;
				}
				await Bun.sleep(25);
			}
			const error = await waitPending;
			const elapsed = Date.now() - waitStartedAt;

			expect(restartObserved).toBe(true);
			expect(error).toBeInstanceOf(DaemonBrokerRejectedError);
			expect((error as Error).message).toContain("generation");
			expect(elapsed).toBeLessThan(1_000);
		} finally {
			await shutdown(client, broker, "restarting");
			process.title = previousTitle;
		}
	}, 25_000);

	it("wakes a pattern wait when the process exits without printing the pattern", async () => {
		using tempDir = TempDir.createSync("@omp-wait-exit-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({ op: "start", spec: exitingSpec("crashing", projectDir, "no") });
			if (started.op !== "start") throw new Error("unexpected start result");

			const waitStartedAt = Date.now();
			const result = await client.request({
				op: "wait",
				name: "crashing",
				for: "exit",
				pattern: "NEVER",
				timeoutMs: 15_000,
			});
			const elapsed = Date.now() - waitStartedAt;

			if (result.op !== "wait") throw new Error("unexpected wait result");
			expect(result.daemon.state).toBe("failed");
			expect(result.daemon.exitCode).toBe(1);
			expect(result.matched).toBeUndefined();
			expect(result.timedOut).toBe(false);
			expect(elapsed).toBeLessThan(5_000);
		} finally {
			await shutdown(client, broker, "crashing");
			process.title = previousTitle;
		}
	}, 25_000);

	it("stops polling a wait its client cancelled or aborted", async () => {
		using tempDir = TempDir.createSync("@omp-wait-cancel-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const ids: string[] = [];
		const randomUUID = crypto.randomUUID.bind(crypto);
		const uuidSpy = spyOn(crypto, "randomUUID").mockImplementation(() => {
			const id = randomUUID();
			ids.push(id);
			return id;
		});
		try {
			const spec: DaemonSpec = {
				...exitingSpec("idle", projectDir, "no"),
				args: ["-e", "setInterval(() => {}, 1000)"],
			};
			const started = await client.request({ op: "start", spec });
			if (started.op !== "start") throw new Error("unexpected start result");
			const waitOperation = { op: "wait", name: "idle", for: "exit", pattern: "NEVER", timeoutMs: 60_000 } as const;

			// Requests on one socket reach the broker in order, and it registers a
			// wait before its first await, so a completed `list` sent afterwards proves
			// the wait is live. The client mints a request's id after its connect
			// await, so the id is read only once that barrier returns.
			ids.length = 0;
			const waitStartedAt = Date.now();
			const waitPending = client.request(waitOperation).then(
				() => undefined,
				(reason: unknown) => reason,
			);
			await client.request({ op: "list" });
			const waitId = ids[0]!;
			const cancelled = await client.request({ op: "cancel", requestId: waitId });
			expect(cancelled).toEqual({ op: "cancel", cancelled: true });
			const error = await waitPending;
			expect(error).toBeInstanceOf(DaemonBrokerRejectedError);
			expect((error as Error).message).toContain("cancelled");
			expect(Date.now() - waitStartedAt).toBeLessThan(5_000);

			// Aborting the client request cancels the broker's poll as well, so
			// nothing is left for a later cancel to stop.
			ids.length = 0;
			const controller = new AbortController();
			const aborted = client.request(waitOperation, controller.signal).catch(() => undefined);
			await client.request({ op: "list" });
			const abortedId = ids[0]!;
			controller.abort();
			await aborted;
			const late = await client.request({ op: "cancel", requestId: abortedId });
			expect(late).toEqual({ op: "cancel", cancelled: false });
		} finally {
			uuidSpy.mockRestore();
			await shutdown(client, broker, "idle");
			process.title = previousTitle;
		}
	}, 25_000);
});
