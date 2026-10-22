import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { AsyncJobManager } from "../../src/async/job-manager";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import * as daemonClient from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import { BashTool } from "../../src/tools/bash";
import type { ToolSession } from "../../src/tools";

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previous = [
		process.env[DAEMON_PROJECT_DIR_ENV],
		process.env[DAEMON_RUNTIME_DIR_ENV],
		process.env[DAEMON_IDLE_GRACE_ENV],
	];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	for (const [index, key] of [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].entries()) {
		if (previous[index] === undefined) delete process.env[key];
		else process.env[key] = previous[index];
	}
	return broker;
}

function toolSession(cwd: string, manager?: AsyncJobManager): ToolSession {
	return {
		cwd,
		hasUI: false,
		getAgentId: () => "Main",
		getSessionId: () => "Main",
		getSessionFile: () => null,
		asyncJobManager: manager,
		settings: Settings.isolated({
			"launch.enabled": true,
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": false,
			"worktree.clone": false,
			shellPath: "/bin/sh",
		}),
	} as unknown as ToolSession;
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
	result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");

describe("bash env parameter", () => {
	it("passes env through to a service command", async () => {
		using temp = TempDir.createSync("@omp-bash-service-env-");
		const cwd = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(cwd);
		const client = await createDaemonBrokerClient(cwd, { runtimeDir, idleGraceMs: 5_000 });
		const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const oldTitle = process.title;
		const broker = startBroker(cwd, runtimeDir);
		const manager = new AsyncJobManager({});
		const bash = new BashTool(toolSession(cwd, manager));
		try {
			const started = await bash.execute("svc-env", {
				command: 'printf "%s\\n" "$OMP_SVC_ENV"; sleep 30',
				name: "env-service",
				env: { OMP_SVC_ENV: "svc-env-ok" },
				ready: { log: "svc-env-ok", timeout: 5 },
				pty: false,
			});
			expect(started.details?.service?.ready).toBeTrue();
		} finally {
			await client.request({ op: "stop", name: "env-service", timeoutMs: 1_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			await manager.dispose({ timeoutMs: 1_000 });
			client.close();
			await broker;
			setProcessName(oldTitle);
			spy.mockRestore();
		}
	}, 25_000);

	it("treats an empty env object as not set", async () => {
		const bash = new BashTool(toolSession(process.cwd()));
		const result = await bash.execute("empty-env", { command: "echo ok", env: {}, timeout: 30, pty: false });
		expect(textOf(result)).toContain("ok");
	});

	it("passes env through on a finite command", async () => {
		const bash = new BashTool(toolSession(process.cwd()));
		const result = await bash.execute("finite-env", {
			command: "echo $OMP_TEST_FOO",
			env: { OMP_TEST_FOO: "bar" },
			timeout: 30,
			pty: false,
		});
		expect(textOf(result)).toContain("bar");
	});

	it("passes env through on auto-backgrounded and async commands", async () => {
		const autoBgSession = {
			cwd: process.cwd(),
			hasUI: false,
			getAgentId: () => "Main",
			getSessionId: () => "Main",
			getSessionFile: () => null,
			asyncJobManager: new AsyncJobManager({}),
			settings: Settings.isolated({
				"launch.enabled": false,
				"async.enabled": false,
				"bash.autoBackground.enabled": true,
				"bash.autoBackground.thresholdMs": 60_000,
				"bashInterceptor.enabled": false,
				"worktree.clone": false,
				"bash.direnv": "off",
				shellPath: "/bin/sh",
			}),
		} as unknown as ToolSession;
		try {
			const autoBg = new BashTool(autoBgSession);
			const result = await autoBg.execute("autobg-env", {
				command: "echo $OMP_TEST_AUTOBG",
				env: { OMP_TEST_AUTOBG: "autobg-ok" },
				timeout: 30,
				pty: false,
			});
			expect(textOf(result)).toContain("autobg-ok");
		} finally {
			await autoBgSession.asyncJobManager?.dispose({ timeoutMs: 1_000 });
		}
		const asyncManager = new AsyncJobManager({});
		const asyncSession = {
			cwd: process.cwd(),
			hasUI: false,
			getAgentId: () => "Main",
			getSessionId: () => "Main",
			getSessionFile: () => null,
			asyncJobManager: asyncManager,
			settings: Settings.isolated({
				"launch.enabled": false,
				"async.enabled": true,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
				"worktree.clone": false,
				"bash.direnv": "off",
				shellPath: "/bin/sh",
			}),
		} as unknown as ToolSession;
		try {
			const asyncBash = new BashTool(asyncSession);
			const started = await asyncBash.execute("async-env", {
				command: "echo $OMP_TEST_ASYNC_BG",
				env: { OMP_TEST_ASYNC_BG: "async-ok" },
				async: true,
				timeout: 30,
				pty: false,
			});
			const jobId = (started.details as { async?: { jobId?: string } } | undefined)?.async?.jobId;
			expect(jobId).toBeDefined();
			await asyncManager.waitForAll();
			expect(asyncManager.getJob(jobId!)?.resultText).toContain("async-ok");
		} finally {
			await asyncManager.dispose({ timeoutMs: 1_000 });
		}
	}, 25_000);
});
