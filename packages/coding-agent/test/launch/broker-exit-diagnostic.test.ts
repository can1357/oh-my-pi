import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment, type DaemonBrokerStartOptions } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonSpec,
} from "../../src/launch/protocol";
import { displayExitReason, MAX_EXIT_REASON_LENGTH, normalizeExitReason } from "../../src/launch/exit-reason";

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

async function shutdown(client: DaemonBrokerClient, broker: Promise<void>): Promise<void> {
	await client.request({ op: "shutdown" }).catch(() => undefined);
	client.close();
	await broker;
}

function failingSpec(name: string, cwd: string): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args: ["-e", "process.exit(58)"],
		env: {},
		cwd,
		pty: false,
		restart: "no",
		persist: false,
		detached: false,
	};
}

describe("daemon broker exit diagnostics", () => {
	it("shortens a home path before applying the diagnostic bound", () => {
		const home = os.homedir();
		const prefixLength = MAX_EXIT_REASON_LENGTH - home.length + 1;
		const prefix = `${"x".repeat(prefixLength - 1)} `;
		const reason = `${prefix}${home}`;

		expect(normalizeExitReason(reason)).toBe(`${prefix}~`);
		expect(displayExitReason(reason)).toBe(`${prefix}~`);
	});

	it("records a neutral reason for a non-PTY code without a child diagnostic", async () => {
		using tempDir = TempDir.createSync("@omp-launch-exit-diagnostic-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({ op: "start", spec: failingSpec("code-58", projectDir) });
			if (started.op !== "start") throw new Error("unexpected start result");

			const waited = await client.request({ op: "wait", name: "code-58", for: "exit", timeoutMs: 5_000 });
			if (waited.op !== "wait") throw new Error("unexpected wait result");

			expect(waited.daemon).toMatchObject({
				state: "failed",
				exitCode: 58,
				exitReason: "process exited with code 58 without a reported termination reason",
			});
		} finally {
			await shutdown(client, broker);
			process.title = previousTitle;
		}
	}, 20_000);
	it("keeps a recovered terminal diagnostic when a wait races a restart", async () => {
		using tempDir = TempDir.createSync("@omp-recovered-exit-diagnostic-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		const firstClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const firstBroker = startBroker(projectDir, runtimeDir);
		try {
			const started = await firstClient.request({ op: "start", spec: failingSpec("code-58", projectDir) });
			if (started.op !== "start") throw new Error("unexpected start result");
			const waited = await firstClient.request({ op: "wait", name: "code-58", for: "exit", timeoutMs: 5_000 });
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			expect(waited.daemon.exitReason).toBe("process exited with code 58 without a reported termination reason");
		} finally {
			await shutdown(firstClient, firstBroker);
		}

		const metadata = (await Bun.file(path.join(runtimeDir, "daemons", "code-58", "meta.json")).json()) as {
			daemon: { exitReason?: string };
		};
		const rawReason = `${os.homedir()}/private\u001b[31m/recovered`;
		metadata.daemon.exitReason = rawReason;
		await Bun.write(path.join(runtimeDir, "daemons", "code-58", "meta.json"), JSON.stringify(metadata));
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const waitPending = client
				.request({ op: "wait", name: "code-58", for: "exit", pattern: "NEVER", timeoutMs: 5_000 })
				.then(
					() => undefined,
					(reason: unknown) => reason,
				);
			const restartedPending = client.request({ op: "restart", name: "code-58" });
			const [, error] = await Promise.all([restartedPending, waitPending]);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("exit code 58");
			const errorMessage = (error as Error).message;
			expect(errorMessage).toContain("reason: ~/private/recovered");
			expect(errorMessage).not.toContain(os.homedir());
			expect(errorMessage).not.toContain("\u001b");
		} finally {
			await shutdown(client, broker);
			process.title = previousTitle;
		}
	}, 30_000);
});
