/**
 * A broker serves every omp process in its scope (project or machine-global),
 * but its own environment is that of whichever session started it. A daemon it
 * starts must carry the requesting session's MCP choice (`--no-mcp`,
 * `PI_NO_MCP=1`), or an omp that daemon runs starts the user's MCP servers
 * (PR #17795 review, rounds 3 and 4).
 *
 * The broker runs in this process, so its environment is this process's; the
 * requesting session's choice is set through the policy module alone.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { startDaemonBrokerFromEnvironment } from "@oh-my-pi/pi-coding-agent/launch/broker";
import { createDaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";
import * as mcpPolicy from "@oh-my-pi/pi-coding-agent/mcp/policy";
import { TempDir } from "@oh-my-pi/pi-utils";
import { setNoMcpEnvForTest } from "../helpers/no-mcp-env";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const saved = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
		name => [name, process.env[name]] as const,
	);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	for (const [name, value] of saved) restoreEnv(name, value);
	return broker;
}

describe("broker daemons and the requester's MCP choice", () => {
	for (const { requester, broker: brokerEnv, expected } of [
		{ requester: "off", broker: "", expected: "1" },
		{ requester: "on", broker: "1", expected: "" },
	]) {
		it(`gives a daemon PI_NO_MCP=${JSON.stringify(expected)} when the requester has MCP ${requester} and the broker's environment says otherwise`, async () => {
			using tempDir = TempDir.createSync("@omp-broker-mcp-policy-");
			const projectDir = path.join(tempDir.path(), "project");
			const runtimeDir = path.join(tempDir.path(), "runtime");
			await fs.mkdir(projectDir);
			setNoMcpEnvForTest(brokerEnv);
			const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const previousTitle = process.title;
			const broker = startBroker(projectDir, runtimeDir);
			const spy = vi.spyOn(mcpPolicy, "isMCPDisabled").mockReturnValue(requester === "off");
			try {
				const started = await client.request({
					op: "start",
					spec: {
						name: "env-probe",
						application: process.execPath,
						args: ["-e", "console.log(`PI_NO_MCP=<${process.env.PI_NO_MCP ?? 'unset'}>`)"],
						env: {},
						cwd: projectDir,
						pty: false,
						restart: "no",
						persist: false,
						detached: false,
					},
				});
				expect(started.op).toBe("start");
				const exited = await client.request({ op: "wait", name: "env-probe", for: "exit", timeoutMs: 10_000 });
				if (exited.op !== "wait") throw new Error(`Unexpected broker result: ${exited.op}`);
				expect(exited.timedOut).toBe(false);
				const logs = await client.request({
					op: "logs",
					name: "env-probe",
					lines: 20,
					head: false,
					follow: false,
					timeoutMs: 1_000,
				});
				if (logs.op !== "logs") throw new Error(`Unexpected broker result: ${logs.op}`);
				expect(logs.text).toContain(`PI_NO_MCP=<${expected}>`);
			} finally {
				spy.mockRestore();
				await client.request({ op: "shutdown" }).catch(() => undefined);
				client.close();
				await broker;
				process.title = previousTitle;
			}
		}, 30_000);
	}
});
