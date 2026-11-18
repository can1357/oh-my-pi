import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, DaemonBrokerRejectedError } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previous = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
		name => [name, process.env[name]] as const,
	);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	for (const [name, value] of previous) restoreEnv(name, value);
	return broker;
}

async function listen(host: string, port = 0): Promise<net.Server> {
	const server = net.createServer(socket => socket.destroy());
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(port, host, () => resolve());
	await promise;
	return server;
}

function portOf(server: net.Server): number {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("server has no TCP address");
	return address.port;
}

describe("broker port readiness", () => {
	it("refuses a port another process already listens on, and finds a server bound only to ::1", async () => {
		using tempDir = TempDir.createSync("@omp-launch-ready-port-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const foreign = await listen("127.0.0.1");
		const port = portOf(foreign);
		const spec = (name: string, script: string, readyPort: number): DaemonSpec => ({
			name,
			application: process.execPath,
			args: ["-e", script],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: false,
			detached: false,
			ready: { port: readyPort, timeoutMs: 5_000 },
		});
		try {
			const error = await client
				.request({ op: "start", spec: spec("occupied", "process.stdin.resume()", port) })
				.then(
					() => undefined,
					(rejection: unknown) => rejection,
				);
			expect(error).toBeInstanceOf(DaemonBrokerRejectedError);
			expect((error as Error).message).toContain(`Port ${port} already accepts connections`);

			// A free port the daemon binds on ::1 only, as `localhost` dev servers do.
			const probe = await listen("::1").catch(() => undefined);
			if (probe === undefined) return; // No IPv6 loopback on this host.
			const freePort = portOf(probe);
			const closed = Promise.withResolvers<void>();
			probe.close(() => closed.resolve());
			await closed.promise;
			const started = await client.request({
				op: "start",
				spec: spec(
					"loopback6",
					`require("node:net").createServer(s => s.destroy()).listen(${freePort}, "::1")`,
					freePort,
				),
			});
			if (started.op !== "start") throw new Error(`Unexpected broker result: ${started.op}`);
			expect(started.readyTimedOut).toBe(false);
			expect(started.daemon.readyAt).toBeDefined();
		} finally {
			foreign.close();
			await client.request({ op: "stop", name: "loopback6", timeoutMs: 1_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 15_000);
});
