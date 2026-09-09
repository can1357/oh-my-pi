import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonSnapshot,
	type DaemonSpec,
} from "../../src/launch/protocol";

const TERMINAL_HISTORY_LIMIT = 10;

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

function terminalSnapshot(index: number): DaemonSnapshot {
	const name = `exited-${index}`;
	return {
		name,
		id: name,
		state: index % 2 === 0 ? "exited" : "failed",
		createdAt: index * 10,
		startedAt: index * 10,
		exitedAt: index * 10 + 1,
		exitReason: `historical exit ${index}`,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
	};
}

async function seedTerminalRecord(runtimeDir: string, cwd: string, snapshot: DaemonSnapshot): Promise<void> {
	const metaPath = path.join(runtimeDir, "daemons", snapshot.name, "meta.json");
	await Bun.write(metaPath, JSON.stringify({ daemon: snapshot, spec: spec(snapshot.name, cwd) }));
}

async function shutdown(client: DaemonBrokerClient, broker: Promise<void>, activeName: string): Promise<void> {
	await client.request({ op: "stop", name: activeName, timeoutMs: 2_000 }).catch(() => undefined);
	await client.request({ op: "shutdown" }).catch(() => undefined);
	client.close();
	await broker;
}

describe("broker list", () => {
	it("returns active daemons first and caps recovered terminal history by real exit time", async () => {
		using tempDir = TempDir.createSync("@omp-launch-list-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		await Promise.all(
			Array.from({ length: TERMINAL_HISTORY_LIMIT + 5 }, (_, index) =>
				seedTerminalRecord(runtimeDir, projectDir, terminalSnapshot(index)),
			),
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const activeName = "active-server";
		try {
			const started = await client.request({
				op: "start",
				spec: {
					...spec(activeName, projectDir),
					args: ["-e", "process.stdin.resume()"],
				},
			});
			expect(started.op).toBe("start");

			const listed = await client.request({ op: "list" });
			expect(listed.op).toBe("list");
			if (listed.op !== "list") throw new Error(`Unexpected broker result: ${listed.op}`);

			expect(listed.daemons.map(daemon => daemon.name)).toEqual([
				activeName,
				...Array.from({ length: TERMINAL_HISTORY_LIMIT }, (_, offset) => `exited-${14 - offset}`),
			]);
			expect(listed.daemons[0]?.state).toBe("running");
			expect(listed.daemons.at(-1)?.exitedAt).toBe(51);
		} finally {
			await shutdown(client, broker, activeName);
			process.title = previousTitle;
		}
	}, 20_000);
});
