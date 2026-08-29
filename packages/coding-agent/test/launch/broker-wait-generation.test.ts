/**
 * Integration test: the real broker socket and child-process exit drive the
 * generation transition, so fake timers cannot control the observed events.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient, DaemonBrokerRejectedError } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonSpec,
} from "../../src/launch/protocol";

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

function restartingSpec(name: string, cwd: string): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args: ["-e", "process.stdout.write('booting\\n'); process.exitCode = 1"],
		env: {},
		cwd,
		pty: false,
		restart: "always",
		persist: false,
		detached: false,
	};
}

async function shutdown(client: DaemonBrokerClient, broker: Promise<void>): Promise<void> {
	await client.request({ op: "stop", name: "restarting", timeoutMs: 2_000 }).catch(() => undefined);
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
			const started = await client.request({ op: "start", spec: restartingSpec("restarting", projectDir) });
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
			await shutdown(client, broker);
			process.title = previousTitle;
		}
	}, 25_000);
});
