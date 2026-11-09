import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

export interface TerminalBrokerFixture {
	readonly client: DaemonBrokerClient;
	readonly projectDir: string;
	readonly runtimeDir: string;
	connect(): Promise<DaemonBrokerClient>;
}

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

export async function withTerminalBroker(body: (fixture: TerminalBrokerFixture) => Promise<void>): Promise<void> {
	using tempDir = TempDir.createSync("@omp-launch-terminal-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const clients: DaemonBrokerClient[] = [];
	const connect = async (): Promise<DaemonBrokerClient> => {
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		clients.push(client);
		return client;
	};
	const client = await connect();
	const broker = startBroker(projectDir, runtimeDir);
	try {
		await body({ client, projectDir, runtimeDir, connect });
	} finally {
		for (const candidate of clients) {
			try {
				await candidate.request({ op: "shutdown" });
				break;
			} catch {}
		}
		for (const candidate of clients) candidate.close();
		await broker;
	}
}

export function terminalSpec(projectDir: string, script: string, overrides: Partial<DaemonSpec> = {}): DaemonSpec {
	return {
		name: `mind-${Snowflake.next()}`,
		application: process.execPath,
		args: ["-e", script],
		env: {},
		cwd: projectDir,
		pty: true,
		persist: true,
		detached: false,
		restart: "no",
		...overrides,
	};
}
