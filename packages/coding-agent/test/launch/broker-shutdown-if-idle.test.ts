import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, createLiveSessionHost, type DaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	LIVE_SESSION_PROTOCOL_VERSION,
	type DaemonSpec,
	type LiveSessionRegistration,
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

function spec(name: string, cwd: string): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args: [],
		env: {},
		cwd,
		pty: false,
		restart: "no",
		persist: false,
		detached: false,
	};
}

async function shutdown(client: DaemonBrokerClient, broker: Promise<void>): Promise<void> {
	await client.request({ op: "shutdown" }).catch(() => undefined);
	client.close();
	await broker;
}

describe("broker shutdownIfIdle", () => {
	it("refuses while a live daemon runs and shuts down once it stops", async () => {
		using tempDir = TempDir.createSync("@omp-shutdown-if-idle-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir, { recursive: true });

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({
				op: "start",
				spec: { ...spec("active-server", projectDir), args: ["-e", "process.stdin.resume()"] },
			});
			if (started.op !== "start") throw new Error(`Unexpected broker result: ${started.op}`);

			// A concurrent start in flight must not be terminated: the broker
			// refuses instead of racing a separate list + shutdown.
			const refused = await client.request({ op: "shutdownIfIdle" });
			if (refused.op !== "shutdownIfIdle") throw new Error(`Unexpected broker result: ${refused.op}`);
			expect(refused.shutDown).toBe(false);
			expect(refused.active).toEqual(["active-server"]);

			const listed = await client.request({ op: "list" });
			if (listed.op !== "list") throw new Error(`Unexpected broker result: ${listed.op}`);
			expect(listed.daemons.map(daemon => daemon.name)).toContain("active-server");

			await client.request({ op: "stop", name: "active-server", timeoutMs: 2_000 });
			const armed = await client.request({ op: "shutdownIfIdle" });
			if (armed.op !== "shutdownIfIdle") throw new Error(`Unexpected broker result: ${armed.op}`);
			expect(armed.shutDown).toBe(true);
			expect(armed.active).toEqual([]);

			client.close();
			await broker;
		} finally {
			await client.request({ op: "stop", name: "active-server", timeoutMs: 2_000 }).catch(() => undefined);
			await shutdown(client, broker);
		}
	}, 20_000);

	it("reports the live session's actual working directory, not the broker scope", async () => {
		using tempDir = TempDir.createSync("@omp-session-cwd-");
		const projectDir = path.join(tempDir.path(), "project");
		const subDir = path.join(projectDir, "packages", "app");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(subDir, { recursive: true });

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		const registration: LiveSessionRegistration = {
			version: LIVE_SESSION_PROTOCOL_VERSION,
			endpointId: crypto.randomUUID(),
			sessionId: "session-in-subdir",
			startedAt: new Date().toISOString(),
			cwd: subDir,
		};
		const host = await createLiveSessionHost(projectDir, registration, () => {}, { runtimeDir });
		try {
			const listed = await client.request({ op: "session-list" });
			if (listed.op !== "session-list") throw new Error(`Unexpected broker result: ${listed.op}`);
			expect(listed.sessions).toHaveLength(1);
			expect(listed.sessions[0]?.endpointId).toBe(registration.endpointId);
			expect(listed.sessions[0]?.cwd).toBe(subDir);
		} finally {
			await host.close();
			await shutdown(client, broker);
		}
	}, 20_000);
});
