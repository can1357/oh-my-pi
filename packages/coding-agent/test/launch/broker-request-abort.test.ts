import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import * as daemonClient from "../../src/launch/client";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { ToolSession } from "../../src/tools";
import { WaitTool } from "../../src/tools/wait";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

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
	// The three variables go back however the start ends: a synchronous failure
	// would otherwise point every later launch test in this process at this
	// project dir.
	try {
		return startDaemonBrokerFromEnvironment();
	} finally {
		restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
		restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
		restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	}
}

describe("broker client request abort", () => {
	it("rejects a request whose signal aborted while the client was still connecting", async () => {
		using tempDir = TempDir.createSync("@omp-launch-request-abort-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		// `startBroker` is inside the region that closes the client and restores
		// the title: it rewrites the title itself and can fail.
		let broker: Promise<void> | undefined;
		try {
			broker = startBroker(projectDir, runtimeDir);
			// A caller that gave up during connection setup (a `wait` past its
			// deadline) must not get a result whose session state it then applies.
			const controller = new AbortController();
			const pending = client.request({ op: "list" }, controller.signal);
			controller.abort();
			const outcome = await pending.then(
				result => result.op,
				(rejection: unknown) => (rejection as Error).message,
			);
			expect(outcome).toBe("Daemon broker request aborted");

			// The abort is scoped to that request; the connection keeps serving.
			expect((await client.request({ op: "ping" })).op).toBe("ping");
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 10_000);
});

describe("wait refresh lifetime", () => {
	beforeEach(() => AgentRegistry.resetGlobalForTests());
	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
	});

	it("subscribes no session a failed refresh setup left behind", async () => {
		// Client creation does not observe the refresh signal, so a refresh the
		// wait abandoned can still reach `subscribe()` later. When the wait ends
		// by a setup failure rather than its deadline, the caller is free to
		// dispose the session at once: the refresh must have been cancelled on
		// that exit too, or the shared broker client becomes a completion sink
		// for a dead session and registers a dispose callback after disposal ran.
		using tempDir = TempDir.createSync("@omp-launch-refresh-lifetime-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const manager = new AsyncJobManager({});
		const disposers = new Set<() => void>();
		let disposed = false;
		let lateDisposeCallbacks = 0;
		// `startBroker` rewrites the process title and can fail, so it runs inside
		// the region that closes the client, disposes the manager and puts the
		// title back.
		let broker: Promise<void> | undefined;
		try {
			broker = startBroker(projectDir, runtimeDir);
			expect((await client.request({ op: "ping" })).op).toBe("ping");
			// Only the acquisition is held back; every request and subscription
			// below is the real client's.
			const acquired = Promise.withResolvers<DaemonBrokerClient>();
			vi.spyOn(daemonClient, "daemonClientForProject").mockImplementation(() => acquired.promise);
			const onCompletion = vi.spyOn(client, "onCompletion");
			const registry = AgentRegistry.global();
			vi.spyOn(registry.awaits, "onChange").mockImplementation(() => {
				throw new Error("injected awaits subscription rejection");
			});
			const session = {
				cwd: projectDir,
				hasUI: false,
				settings: Settings.isolated({ "launch.enabled": true }),
				agentRegistry: registry,
				asyncJobManager: manager,
				getAgentId: () => "Main",
				getSessionId: () => "refresh-lifetime",
				queueLaunchCompletion: async () => {},
				registerDisposeCallback: (callback: () => void) => {
					if (disposed) lateDisposeCallbacks++;
					disposers.add(callback);
					return () => disposers.delete(callback);
				},
			} as unknown as ToolSession;

			await expect(new WaitTool(session).execute("failed-refresh", { timeout: 30 })).rejects.toThrow(
				"injected awaits subscription rejection",
			);
			for (const dispose of disposers) dispose();
			disposers.clear();
			disposed = true;
			acquired.resolve(client);
			// The abandoned acquisition resolves on the broker's own schedule,
			// which no clock of this process drives; a subscription it makes
			// would appear within a few of its turns.
			for (let turn = 0; turn < 50 && lateDisposeCallbacks === 0; turn++) await Bun.sleep(10);

			expect(lateDisposeCallbacks).toBe(0);
			expect(disposers.size).toBe(0);
			expect(onCompletion).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			for (const dispose of disposers) dispose();
			await manager.dispose({ timeoutMs: 1_000 });
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 30_000);
});
