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
			const aborted = new AbortController();
			aborted.abort();
			const abortedDispatches: string[] = [];
			await expect(
				client.request({ op: "ping" }, aborted.signal, state => abortedDispatches.push(state)),
			).rejects.toThrow("aborted");
			expect(abortedDispatches).toEqual([]);

			// The callback is the local certainty boundary: once socket.write
			// accepts the frame, a missing response can no longer prove rejection.
			const dispatches: string[] = [];
			await client.request({ op: "ping" }, undefined, state => dispatches.push(state));
			expect(dispatches).toEqual(["written"]);
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

	it.each([
		{ preservePending: true, replayed: true },
		{ preservePending: false, replayed: false },
	])(
		"detaching an owner with preservePending=$preservePending before exit replays its completion: $replayed",
		async ({ preservePending, replayed }) => {
			using tempDir = TempDir.createSync("@omp-launch-completion-detach-");
			const projectDir = path.join(tempDir.path(), "project");
			const runtimeDir = path.join(tempDir.path(), "runtime");
			await fs.mkdir(projectDir);
			const scriptPath = path.join(projectDir, "gated.ts");
			// Exits once its release file appears, so the owner can detach while
			// the process is still alive and the completion is produced afterwards.
			const releasePath = path.join(projectDir, "release");
			await Bun.write(
				scriptPath,
				`const { existsSync } = require("node:fs");
const release = ${JSON.stringify(releasePath)};
const tick = () => (existsSync(release) ? process.exit(0) : setTimeout(tick, 20));
tick();
`,
			);

			const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const broker = startBroker(projectDir, runtimeDir);
			const spec: DaemonSpec = {
				name: "gated",
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			};
			const replays: DaemonCompletionNotification[] = [];
			let unregisterReplay: (() => void) | undefined;
			try {
				const unregister = client.onCompletion("owner-1", () => {
					throw new Error("The detached owner must not receive completions");
				});
				await client.request({ op: "ping" });
				await client.request({ op: "start", owner: "owner-1", spec: { ...spec } });

				// Detach the owner while the process is still running, the way a
				// context boundary does, then let the process exit.
				unregister({ preservePending });
				await Bun.write(releasePath, "go");
				await client.request({ op: "wait", name: "gated", for: "exit", timeoutMs: 5_000 });

				// Re-register the same owner, the way the next Hub call from that
				// session does, and observe whether the broker replays the exit.
				const replayed1 = Promise.withResolvers<void>();
				unregisterReplay = client.onCompletion("owner-1", notification => {
					replays.push(notification);
					replayed1.resolve();
				});
				// Real-time poll, as above: the retained replay's acknowledgement
				// travels over a real socket with no client-visible landing signal.
				const deadline = Date.now() + 5_000;
				let restarted = false;
				let lastError: unknown;
				while (Date.now() < deadline) {
					try {
						// A retained completion blocks the same-name start until the
						// replay is acknowledged; a discarded one never blocks it.
						await client.request({ op: "start", owner: "owner-2", spec: { ...spec } });
						restarted = true;
						break;
					} catch (error) {
						lastError = error;
						if (!String(error).includes("unacknowledged completion")) throw error;
						if (!replayed) throw new Error(`Discarded completion still blocks restart: ${String(error)}`);
						await Bun.sleep(25);
					}
				}
				if (!restarted) throw new Error(`Name never became startable again: ${String(lastError)}`);
				if (replayed) {
					await replayed1.promise;
					expect(replays).toHaveLength(1);
					expect(replays[0]).toMatchObject({ owner: "owner-1", daemon: { name: "gated", state: "exited" } });
				} else {
					// The broker writes a replay to the socket while applying the
					// owner re-registration, ahead of any later request's response
					// on that same socket: after two ordered round trips a replay
					// that was going to arrive has arrived.
					await client.request({ op: "describe", name: "gated" });
					expect(replays).toEqual([]);
				}
				await Bun.write(releasePath, "go");
				await client.request({ op: "wait", name: "gated", for: "exit", timeoutMs: 5_000 });
			} finally {
				unregisterReplay?.();
				await client.request({ op: "stop", name: "gated", timeoutMs: 2_000 }).catch(() => undefined);
				await client.request({ op: "shutdown" }).catch(() => undefined);
				client.close();
				await broker;
			}
		},
		20_000,
	);
});
