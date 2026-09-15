// Integration test — real timers are required because this drives the actual broker and child process.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
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

describe("daemon broker completion acknowledgement", () => {
	it("clears the pending completion after the owner acks so the name can start again", async () => {
		using tempDir = TempDir.createSync("@omp-launch-completion-ack-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "oneshot.ts");
		await Bun.write(scriptPath, `process.stdout.write("done\\n");\n`);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		const completions: DaemonCompletionNotification[] = [];
		const received = Promise.withResolvers<void>();
		const unregister = client.onCompletion("owner-1", notification => {
			completions.push(notification);
			received.resolve();
		});

		const spec: DaemonSpec = {
			name: "acked",
			application: process.execPath,
			args: [scriptPath],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: false,
			detached: false,
		};

		try {
			// The ping publishes the completion subscription before the first start.
			await client.request({ op: "ping" });
			await client.request({ op: "start", owner: "owner-1", spec: { ...spec } });
			await client.request({ op: "wait", name: "acked", for: "exit", timeoutMs: 5_000 });
			await received.promise;
			expect(completions).toHaveLength(1);
			expect(completions[0]).toMatchObject({
				event: "daemon-completed",
				owner: "owner-1",
				daemon: { name: "acked", state: "exited", exitCode: 0 },
			});

			// The sink resolved, so the client acks over the wire. Once the broker
			// processes the ack it must drop the record's pending completion;
			// otherwise restarting the settled name fails forever.
			// Real-time poll: the ack travels over a real socket and the broker
			// exposes no client-visible signal for when it lands, so fake timers
			// cannot drive this boundary (same pattern as the sibling monitor tests).
			const deadline = Date.now() + 5_000;
			let restarted = false;
			let lastError: unknown;
			while (Date.now() < deadline) {
				try {
					await client.request({ op: "start", owner: "owner-1", spec: { ...spec } });
					restarted = true;
					break;
				} catch (error) {
					lastError = error;
					if (!String(error).includes("unacknowledged completion")) throw error;
					await Bun.sleep(25);
				}
			}
			if (!restarted) throw new Error(`Completed daemon never became startable again: ${String(lastError)}`);
			await client.request({ op: "wait", name: "acked", for: "exit", timeoutMs: 5_000 });
		} finally {
			unregister();
			await client.request({ op: "stop", name: "acked", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
		}
	}, 20_000);
});
