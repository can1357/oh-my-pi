import { describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { AsyncJobManager } from "../../src/async/job-manager";
import * as daemonClient from "../../src/daemon/client";
import type { DaemonClient, DaemonOp } from "../../src/daemon/protocol";
import type { UnitSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { BashTool } from "../../src/tools/bash";
import type { ToolSession } from "../../src/tools";

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
		const opened: DaemonOp[] = [];
		const now = Date.now();
		const unit = {
			id: "env-service-id",
			kind: "proc",
			scope: { kind: "project", dir: process.cwd() },
			key: "env-service",
			label: "env-service",
			generation: "env-service-gen-1",
			state: "running",
			pids: [],
			createdAt: now,
			startedAt: now,
			readyAt: now,
			restartCount: 0,
			outputBytes: 0,
			leases: 1,
			policy: { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "exec" },
			supervised: true,
		} as UnitSnapshot;
		const client = {
			onCompletion: () => () => {},
			onNotify: () => () => {},
			onReconnect: () => () => {},
			close() {},
			request: async (operation: DaemonOp) => {
				if (operation.op === "list") return { units: [] };
				if (operation.op === "logs") return { unit, text: "svc-env-ok\n" };
				if (operation.op !== "open") throw new Error(`Unexpected daemon op ${operation.op}`);
				opened.push(operation);
				return { unit };
			},
		} as unknown as DaemonClient;
		const spy = vi.spyOn(daemonClient, "daemonClient").mockResolvedValue(client);
		const manager = new AsyncJobManager({});
		const bash = new BashTool(toolSession(process.cwd(), manager));
		try {
			await bash.execute("svc-env", {
				command: "sleep 30",
				name: "env-service",
				env: { OMP_SVC_ENV: "svc-env-ok" },
				ready: { log: "svc-env-ok", timeout: 5 },
				pty: false,
			});
			expect(opened).toHaveLength(1);
			const open = opened[0] as DaemonOp & { proc?: { env?: Record<string, string> } };
			expect(open.proc?.env?.OMP_SVC_ENV).toBe("svc-env-ok");
		} finally {
			await manager.dispose({ timeoutMs: 1_000 });
			spy.mockRestore();
		}
	});

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
		const autoBgManager = new AsyncJobManager({});
		const autoBgSession = {
			cwd: process.cwd(),
			hasUI: false,
			getAgentId: () => "Main",
			getSessionId: () => "Main",
			getSessionFile: () => null,
			asyncJobManager: autoBgManager,
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
			await autoBgManager.dispose({ timeoutMs: 1_000 });
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
