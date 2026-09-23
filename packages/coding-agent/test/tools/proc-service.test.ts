import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ProcProtocolHandler } from "../../src/internal-urls/proc-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
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

function toolSession(cwd: string, manager?: AsyncJobManager, launchEnabled = true): ToolSession {
	return {
		cwd,
		hasUI: false,
		getAgentId: () => "Main",
		getSessionId: () => "Main",
		getSessionFile: () => null,
		asyncJobManager: manager,
		settings: {
			get(key: string) {
				if (key === "launch.enabled") return launchEnabled;
				if (
					key === "async.enabled" ||
					key === "bash.autoBackground.enabled" ||
					key === "bashInterceptor.enabled" ||
					key === "worktree.clone"
				)
					return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				return undefined;
			},
			getShellConfig: () => ({ shell: "/bin/sh", args: ["-c"] }),
		},
	} as unknown as ToolSession;
}

describe("proc:// background jobs", () => {
	it("lists a running owned job, does not consume its result on read, and cancels with an empty write", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		const id = manager.register(
			"bash",
			"compiling assets",
			async ({ signal, reportProgress }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				await reportProgress("building 50%", { output: "building 50%" });
				return pending.promise;
			},
			{ id: "build-job", ownerId: "Main" },
		);
		const otherPending = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"other owner's work",
			async ({ signal }) => {
				signal.addEventListener("abort", () => otherPending.resolve("cancelled"), { once: true });
				return otherPending.promise;
			},
			{ id: "other-job", ownerId: "Other" },
		);
		const session = toolSession(process.cwd(), manager, false);
		const protocol = new ProcProtocolHandler();
		try {
			await expect(protocol.resolve(parseInternalUrl("proc://"))).rejects.toThrow("requires a tool session");
			await expect(protocol.write(parseInternalUrl(`proc://${id}`), "")).rejects.toThrow("requires a tool session");
			const list = await protocol.resolve(parseInternalUrl("proc://"), { session });
			expect(list.content).toContain(`${id} [bash] running`);
			expect(list.content).not.toContain("other-job");
			expect(list.details?.proc.jobs).toMatchObject([{ id, status: "running" }]);
			await expect(protocol.resolve(parseInternalUrl("proc://other-job"), { session })).rejects.toThrow("not found");
			await expect(protocol.write(parseInternalUrl("proc://other-job"), "", { session })).rejects.toThrow(
				"not found",
			);
			const running = await protocol.resolve(parseInternalUrl(`proc://${id}`), { session });
			expect(running.content).toContain("compiling assets");
			expect(running.content).toContain("building 50%");
			expect(running.details?.proc.job).toMatchObject({ id, status: "running" });
			await expect(protocol.write(parseInternalUrl(`proc://${id}`), "input", { session })).rejects.toThrow(
				"stdin is only available for services",
			);
			const cancelled = await protocol.write(parseInternalUrl(`proc://${id}`), "", { session });
			expect(cancelled.text).toContain(`Cancelled background job ${id}`);
			expect(cancelled.details?.proc).toMatchObject({ op: "cancel", cancelled: [{ id, status: "cancelled" }] });
			expect(manager.getJob(id)?.status).toBe("cancelled");
			const settledId = manager.register("bash", "completed command", async () => "DONE", {
				id: "settled-job",
				ownerId: "Main",
			});
			await manager.getJob(settledId)?.promise;
			const settled = await protocol.resolve(parseInternalUrl(`proc://${settledId}`), { session });
			expect(settled.content).toContain("DONE");
			expect(manager.isJobResultConsumed(settledId)).toBeFalse();
		} finally {
			await manager.dispose();
		}
	});
});

describe("bash services via proc://", () => {
	it("starts at log readiness, delivers stdin, switches persistence, and restarts a live name", async () => {
		using temp = TempDir.createSync("@omp-proc-service-");
		const cwd = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(cwd);
		const client = await createDaemonBrokerClient(cwd, { runtimeDir, idleGraceMs: 5_000 });
		const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const oldTitle = process.title;
		const broker = startBroker(cwd, runtimeDir);
		const manager = new AsyncJobManager({});
		const session = toolSession(cwd, manager);
		const bash = new BashTool(session);
		const proc = new ProcProtocolHandler();
		try {
			const started = await bash.execute("service", {
				command: "printf 'READY\\n'; read line; printf 'ACK:%s\\n' \"$line\"; read line",
				name: "echo-service",
				ready: { log: "READY", timeout: 5 },
				pty: false,
			});
			expect(started.details?.service?.ready).toBeTrue();
			expect(started.content[0]?.type === "text" ? started.content[0].text : "").toContain("READY");
			const list = await proc.resolve(parseInternalUrl("proc://"), { session });
			expect(list.content).toContain("echo-service [service]");
			expect(list.details?.proc.daemons).toMatchObject([{ name: "echo-service", state: "ready" }]);
			const pending = Promise.withResolvers<string>();
			const collisionId = manager.register(
				"bash",
				"colliding job",
				async ({ signal }) => {
					signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
					return pending.promise;
				},
				{ id: "echo-service", ownerId: "Main" },
			);
			expect(collisionId).toBe("echo-service");
			await expect(proc.resolve(parseInternalUrl("proc://echo-service"), { session })).rejects.toThrow(
				"both job echo-service and service echo-service",
			);
			await expect(proc.write(parseInternalUrl("proc://echo-service"), "", { session })).rejects.toThrow(
				"both job echo-service and service echo-service",
			);
			manager.cancel(collisionId, { ownerId: "Main" });
			await manager.getJob(collisionId)?.promise;
			await manager.dispose({ timeoutMs: 1_000 });
			session.asyncJobManager = undefined;
			const sent = await proc.write(parseInternalUrl("proc://echo-service"), "hello", { session });
			expect(sent.text).toContain("Sent input");
			expect(sent.details?.proc).toMatchObject({
				action: "stdin",
				daemon: { name: "echo-service" },
				input: "hello",
			});
			const observed = await client.request({
				op: "wait",
				name: "echo-service",
				for: "exit",
				pattern: "ACK:hello",
				timeoutMs: 2_000,
			});
			expect(observed.op === "wait" && observed.matched).toBe("ACK:hello");
			const read = await proc.resolve(parseInternalUrl("proc://echo-service"), { session });
			expect(read.content).toContain("ACK:hello");
			expect(read.details?.proc).toMatchObject({
				daemon: { name: "echo-service" },
				log: expect.stringContaining("ACK:hello"),
			});
			const persisted = await proc.write(parseInternalUrl("proc://echo-service/mode"), "persist", { session });
			expect(persisted.text).toContain("persistent");
			expect(persisted.details?.proc).toMatchObject({ action: "mode", mode: "persist", daemon: { persist: true } });
			const metadata: { spec: { persist: boolean } } = await Bun.file(
				path.join(runtimeDir, "daemons", "echo-service", "meta.json"),
			).json();
			expect(metadata.spec.persist).toBeTrue();
			const sessionMode = await proc.write(parseInternalUrl("proc://echo-service/mode"), "session", { session });
			expect(sessionMode.text).toContain("mode=session");
			const sessionMetadata: { spec: { persist: boolean } } = await Bun.file(
				path.join(runtimeDir, "daemons", "echo-service", "meta.json"),
			).json();
			expect(sessionMetadata.spec.persist).toBeFalse();
			const restarted = await bash.execute("restart", {
				command: "printf 'REPLACED\\n'; read line",
				name: "echo-service",
				ready: { log: "REPLACED", timeout: 5 },
				pty: false,
			});
			expect(restarted.content[0]?.type === "text" ? restarted.content[0].text : "").toContain("REPLACED");
			const stopped = await proc.write(parseInternalUrl("proc://echo-service"), "", { session });
			expect(stopped.text).toContain("Stopped");
			expect(stopped.details?.proc).toMatchObject({ action: "stop", daemon: { name: "echo-service" } });
			const background = await bash.execute("detach-candidate", {
				command: "printf 'RUNNING\\n'; sleep 30",
				name: "detach-candidate",
				ready: { log: "RUNNING", timeout: 5 },
				pty: false,
			});
			expect(background.details?.service?.ready).toBeTrue();
			const detached = await proc.write(parseInternalUrl("proc://detach-candidate/mode"), "detached", { session });
			expect(detached.text).toContain("detached");
			const detachedRead = await proc.resolve(parseInternalUrl("proc://detach-candidate"), { session });
			expect(detachedRead.content).toContain("detached=true");
			const detachedMetadata: { spec: { persist: boolean; detached: boolean; pty: boolean } } = await Bun.file(
				path.join(runtimeDir, "daemons", "detach-candidate", "meta.json"),
			).json();
			expect(detachedMetadata.spec).toMatchObject({ detached: true, persist: true, pty: false });
			await expect(
				proc.write(parseInternalUrl("proc://detach-candidate/mode"), "session", { session }),
			).rejects.toThrow("must remain persistent");
			await proc.write(parseInternalUrl("proc://detach-candidate"), "", { session });
			await expect(bash.execute("invalid", { command: "true", name: "bad", async: true })).rejects.toThrow(
				"does not accept async or timeout",
			);
			await expect(bash.execute("invalid", { command: "true", name: "bad", async: false })).rejects.toThrow(
				"does not accept async or timeout",
			);
			await expect(bash.execute("invalid", { command: "true", name: "bad", timeout: 1 })).rejects.toThrow(
				"does not accept async or timeout",
			);
		} finally {
			await client.request({ op: "stop", name: "echo-service", timeoutMs: 1_000 }).catch(() => undefined);
			await client.request({ op: "stop", name: "detach-candidate", timeoutMs: 1_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			await manager.dispose({ timeoutMs: 1_000 });
			client.close();
			await broker;
			setProcessName(oldTitle);
			spy.mockRestore();
		}
	}, 25_000);
});
