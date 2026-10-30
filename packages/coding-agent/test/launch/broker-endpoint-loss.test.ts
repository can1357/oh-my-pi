// Integration test — real timers are required (ts-no-test-timers exception): the bug is a broker that
// keeps its native scope lease after its runtime dir is deleted, so no replacement broker can bind the
// socket. Fake timers cannot drive the unix-socket RPC or the replacement broker process. Shutdown is
// observed by awaiting the broker's own run() promise; a regression leaves it pending, so the test's
// own timeout surfaces the failure.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, onListening: () => void): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "60000";
	const broker = startDaemonBrokerFromEnvironment({ endpointCheckMs: 50, onListening });
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

describe.skipIf(process.platform === "win32")("daemon broker runtime dir loss", () => {
	it("hands the scope to a new broker after its runtime dir is deleted under it", async () => {
		using tempDir = TempDir.createSync("@omp-launch-endpoint-loss-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		// Create the client (writes broker.token) before starting the broker, which reads that token.
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
		const listening = Promise.withResolvers<void>();
		const broker = startBroker(projectDir, runtimeDir, listening.resolve);
		try {
			await listening.promise;
			expect((await client.request({ op: "ping" })).op).toBe("ping");

			// A sweep or cleaner removes the scope, socket and token included, while the broker still
			// runs with a connected client. The broker must give the scope up rather than keep its lease.
			await fs.rm(runtimeDir, { recursive: true, force: true });
			await broker;

			// The same client reconnects: it recreates the token, spawns a fresh broker, and is served.
			const ping = await client.request({ op: "ping" });
			if (ping.op !== "ping") throw new Error(`unexpected daemon result ${ping.op}`);
			expect(ping.projectDir).toBe(client.projectDir);
		} finally {
			process.title = previousTitle;
			try {
				await client.request({ op: "shutdown" });
			} catch {
				// The replacement broker may already be gone.
			}
			client.close();
		}
	}, 30_000);
});
