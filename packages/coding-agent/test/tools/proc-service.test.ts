import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ProcProtocolHandler } from "../../src/internal-urls/proc-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import * as daemonClient from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import * as bashExecutor from "../../src/exec/bash-executor";
import { BashTool } from "../../src/tools/bash";
import { WriteTool } from "../../src/tools/write";
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

function toolSession(cwd: string, manager?: AsyncJobManager, options: { launch?: boolean } = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getAgentId: () => "Main",
		getSessionId: () => "Main",
		getSessionFile: () => null,
		asyncJobManager: manager,
		settings: Settings.isolated({
			"launch.enabled": options.launch ?? true,
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": false,
			"worktree.clone": false,
			shellPath: "/bin/sh",
		}),
	} as unknown as ToolSession;
}

describe("proc:// background jobs", () => {
	it("lists owned jobs, preserves delivery on read, and scopes kill to the owner", async () => {
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
		const session = toolSession(process.cwd(), manager, { launch: false });
		const protocol = new ProcProtocolHandler();
		try {
			await expect(protocol.resolve(parseInternalUrl("proc://"))).rejects.toThrow("requires a tool session");
			await expect(protocol.write(parseInternalUrl(`proc://${id}/kill`), "")).rejects.toThrow(
				"requires a tool session",
			);
			const list = await protocol.resolve(parseInternalUrl("proc://"), { session });
			expect(list.content).toContain(`${id} [bash] running`);
			expect(list.content).not.toContain("other-job");
			expect(list.details?.proc?.jobs).toMatchObject([{ id, status: "running" }]);
			await expect(protocol.resolve(parseInternalUrl("proc://other-job"), { session })).rejects.toThrow("not found");
			await expect(protocol.write(parseInternalUrl("proc://other-job/kill"), "", { session })).rejects.toThrow(
				"not found",
			);
			const running = await protocol.resolve(parseInternalUrl(`proc://${id}`), { session });
			expect(running.content).toContain("compiling assets");
			expect(running.content).toContain("building 50%");
			expect(running.details?.proc?.job).toMatchObject({ id, status: "running" });
			await expect(protocol.write(parseInternalUrl(`proc://${id}`), "input", { session })).rejects.toThrow(
				"stdin is only available for services",
			);
			await expect(protocol.resolve(parseInternalUrl(`proc://${id}/kill`), { session })).rejects.toThrow(
				"writable only",
			);
			expect(manager.getJob(id)?.status).toBe("running");
			const cancelled = await protocol.write(parseInternalUrl(`proc://${id}/kill`), "ignored payload", { session });
			expect(cancelled.content[0]?.type === "text" ? cancelled.content[0].text : "").toContain(
				`Cancelled background job ${id}`,
			);
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

	it("kills without content and never interprets bare job writes as cancellation", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		const id = manager.register(
			"bash",
			"running command",
			async ({ signal }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				return pending.promise;
			},
			{ ownerId: "Main" },
		);
		const write = new WriteTool(toolSession(process.cwd(), manager, { launch: false }));
		try {
			await expect(
				write.execute("invalid-cancel", {
					path: `proc://${id}`,
					content: '</antml>\n<parameter name="i">Cancelling background test run',
				}),
			).rejects.toThrow("stdin is only available for services");
			await expect(write.execute("empty-stdin", { path: `proc://${id}`, content: "" })).rejects.toThrow(
				"stdin is only available for services",
			);
			await expect(
				write.execute("missing-stdin", write.parameters.assert({ path: `proc://${id}` })),
			).rejects.toThrow("content is required");
			expect(manager.getJob(id)?.status).toBe("running");
			const result = await write.execute("kill", write.parameters.assert({ path: `proc://${id}/kill` }));
			await manager.getJob(id)?.promise;
			expect(result.details?.proc).toMatchObject({ op: "cancel", cancelled: [{ id, status: "cancelled" }] });
			expect(manager.getJob(id)?.status).toBe("cancelled");
		} finally {
			await manager.dispose();
		}
	});

	it("scopes a caller without an agent id to unowned jobs and parentless agents", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"main's work",
			async ({ signal }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				return pending.promise;
			},
			{ id: "owned-job", ownerId: "Main" },
		);
		manager.register("bash", "unowned work", async () => "done", { id: "unowned-job" });
		const registry = new AgentRegistry();
		registry.register({ id: "Foreign", displayName: "Foreign", kind: "sub", parentId: "Main", session: null });
		const session = toolSession(process.cwd(), manager, { launch: false });
		session.getAgentId = () => null;
		session.agentRegistry = registry;
		const protocol = new ProcProtocolHandler();
		try {
			const list = await protocol.resolve(parseInternalUrl("proc://"), { session });
			expect(list.details?.proc?.jobs).toMatchObject([{ id: "unowned-job" }]);
			await expect(protocol.resolve(parseInternalUrl("proc://owned-job"), { session })).rejects.toThrow("not found");
			await expect(protocol.write(parseInternalUrl("proc://owned-job/kill"), "", { session })).rejects.toThrow(
				"not found",
			);
			expect(manager.getJob("owned-job")?.status).toBe("running");
			const denied = await protocol.write(parseInternalUrl("proc://Foreign/kill"), "", { session });
			expect(denied.details?.proc).toMatchObject({ cancelled: [{ id: "Foreign", status: "not_found" }] });
			expect(registry.get("Foreign")?.status).toBe("running");
		} finally {
			await manager.dispose();
		}
	});

	it.each([false, true])("kills only owned jobless agents (job manager: %s)", async withManager => {
		const manager = withManager ? new AsyncJobManager({}) : undefined;
		const registry = new AgentRegistry();
		registry.register({ id: "Worker", displayName: "Worker", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "Foreign", displayName: "Foreign", kind: "sub", parentId: "Other", session: null });
		const session = toolSession(process.cwd(), manager, { launch: false });
		session.agentRegistry = registry;
		const write = new WriteTool(session);
		try {
			const denied = await write.execute("foreign", { path: "proc://Foreign/kill" });
			expect(denied.details?.proc).toMatchObject({ cancelled: [{ id: "Foreign", status: "not_found" }] });
			expect(registry.get("Foreign")?.status).toBe("running");
			const killed = await write.execute("worker", { path: "proc://Worker/kill" });
			expect(killed.details?.proc).toMatchObject({ cancelled: [{ id: "Worker", status: "cancelled" }] });
			expect(registry.get("Worker")).toBeUndefined();
		} finally {
			await manager?.dispose();
		}
	});

	it("requires file content instead of silently truncating a file", async () => {
		using temp = TempDir.createSync("@omp-proc-write-");
		const file = path.join(temp.path(), "keep.txt");
		await Bun.write(file, "keep this");
		const write = new WriteTool(toolSession(temp.path(), undefined, { launch: false }));
		await expect(write.execute("missing-content", write.parameters.assert({ path: file }))).rejects.toThrow(
			"content is required",
		);
		expect(await Bun.file(file).text()).toBe("keep this");
		await write.execute("empty-file", { path: file, content: "" });
		expect(await Bun.file(file).text()).toBe("");
	});

	it("lists settled jobs with their frozen run duration instead of their age", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const manager = new AsyncJobManager({});
		const release = Promise.withResolvers<string>();
		const doneId = manager.register("bash", "sleep 2; echo fast-done", () => release.promise, { ownerId: "Main" });
		const blocked = Promise.withResolvers<string>();
		const runningId = manager.register(
			"bash",
			"sleep 60",
			async ({ signal }) => {
				signal.addEventListener("abort", () => blocked.resolve("cancelled"), { once: true });
				return blocked.promise;
			},
			{ ownerId: "Main" },
		);
		const session = toolSession(process.cwd(), manager, { launch: false });
		try {
			clock.mockReturnValue(3_000);
			release.resolve("fast-done");
			await manager.getJob(doneId)?.promise;
			clock.mockReturnValue(40_000);
			const list = await new ProcProtocolHandler().resolve(parseInternalUrl("proc://"), { session });
			expect(list.content).toContain(`${doneId} [bash] completed in 2.0s — sleep 2; echo fast-done`);
			expect(list.content).toContain(`${runningId} [bash] running up 39.0s — sleep 60`);
			expect(list.details?.proc?.jobs).toMatchObject([
				{ id: doneId, durationMs: 2_000 },
				{ id: runningId, durationMs: 39_000 },
			]);
		} finally {
			clock.mockRestore();
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
				command: "printf 'READY\\n'; while IFS= read -r line; do printf 'ACK:[%s]\\n' \"$line\"; done",
				name: "echo-service",
				ready: { log: "READY", timeout: 5 },
				pty: false,
			});
			expect(started.details?.service?.ready).toBeTrue();
			expect(started.content[0]?.type === "text" ? started.content[0].text : "").toContain("READY");
			const list = await proc.resolve(parseInternalUrl("proc://"), { session });
			expect(list.content).toContain("echo-service [service]");
			expect(list.details?.proc?.daemons).toMatchObject([{ name: "echo-service", state: "ready" }]);
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
			await expect(proc.write(parseInternalUrl("proc://echo-service/kill"), "", { session })).rejects.toThrow(
				"both job echo-service and service echo-service",
			);
			manager.cancel(collisionId, { ownerId: "Main" });
			await manager.getJob(collisionId)?.promise;
			await manager.dispose({ timeoutMs: 1_000 });
			session.asyncJobManager = undefined;
			const sent = await proc.write(parseInternalUrl("proc://echo-service"), "hello", { session });
			expect(sent.content[0]?.type === "text" ? sent.content[0].text : "").toContain("Sent input");
			expect(sent.details?.proc).toMatchObject({
				action: "stdin",
				daemon: { name: "echo-service" },
				input: "hello",
			});
			const observed = await client.request({
				op: "wait",
				name: "echo-service",
				for: "exit",
				pattern: "ACK:\\[hello\\]",
				timeoutMs: 2_000,
			});
			expect(observed.op === "wait" && observed.matched).toBe("ACK:[hello]");
			const read = await proc.resolve(parseInternalUrl("proc://echo-service"), { session });
			expect(read.content).toContain("ACK:[hello]");
			expect(read.details?.proc).toMatchObject({
				daemon: { name: "echo-service" },
				log: expect.stringContaining("ACK:[hello]"),
			});
			await proc.write(parseInternalUrl("proc://echo-service"), "", { session });
			const blank = await client.request({
				op: "wait",
				name: "echo-service",
				for: "exit",
				pattern: "ACK:\\[\\]",
				timeoutMs: 2_000,
			});
			expect(blank.op === "wait" && blank.matched).toBe("ACK:[]");
			const persisted = await proc.write(parseInternalUrl("proc://echo-service/mode"), "persist", { session });
			expect(persisted.content[0]?.type === "text" ? persisted.content[0].text : "").toContain("persistent");
			expect(persisted.details?.proc).toMatchObject({ action: "mode", mode: "persist", daemon: { persist: true } });
			const metadata: { spec: { persist: boolean } } = await Bun.file(
				path.join(runtimeDir, "daemons", "echo-service", "meta.json"),
			).json();
			expect(metadata.spec.persist).toBeTrue();
			const sessionMode = await proc.write(parseInternalUrl("proc://echo-service/mode"), "session", { session });
			expect(sessionMode.content[0]?.type === "text" ? sessionMode.content[0].text : "").toContain("mode=session");
			const sessionMetadata: { spec: { persist: boolean } } = await Bun.file(
				path.join(runtimeDir, "daemons", "echo-service", "meta.json"),
			).json();
			expect(sessionMetadata.spec.persist).toBeFalse();
			const restarted = await bash.execute("restart", {
				command: "printf 'REPLACED\\n'; read line",
				name: "echo-service",
				ready: { log: "REPLACED", host: "", timeout: 5 },
				pty: false,
				async: false,
				env: {},
			});
			expect(restarted.content[0]?.type === "text" ? restarted.content[0].text : "").toContain("REPLACED");
			const write = new WriteTool(session);
			const stopped = await write.execute("kill", write.parameters.assert({ path: "proc://echo-service/kill" }));
			expect(stopped.details?.proc).toMatchObject({ action: "stop", daemon: { name: "echo-service" } });
			const background = await bash.execute("detach-candidate", {
				command: "printf 'RUNNING\\n'; sleep 30",
				name: "detach-candidate",
				ready: { log: "RUNNING", timeout: 5 },
				pty: false,
			});
			expect(background.details?.service?.ready).toBeTrue();
			const detached = await proc.write(parseInternalUrl("proc://detach-candidate/mode"), "detached", { session });
			expect(detached.content[0]?.type === "text" ? detached.content[0].text : "").toContain("detached");
			const detachedRead = await proc.resolve(parseInternalUrl("proc://detach-candidate"), { session });
			expect(detachedRead.content).toContain("detached=true");
			const detachedMetadata: { spec: { persist: boolean; detached: boolean; pty: boolean } } = await Bun.file(
				path.join(runtimeDir, "daemons", "detach-candidate", "meta.json"),
			).json();
			expect(detachedMetadata.spec).toMatchObject({ detached: true, persist: true, pty: false });
			await expect(
				proc.write(parseInternalUrl("proc://detach-candidate/mode"), "session", { session }),
			).rejects.toThrow("must remain persistent");
			await proc.write(parseInternalUrl("proc://detach-candidate/kill"), "", { session });
			await expect(bash.execute("invalid", { command: "true", name: "bad", async: true })).rejects.toThrow(
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

	it("keeps empty or default optional fields out of service-mode selection", async () => {
		const bash = new BashTool(toolSession(process.cwd()));
		const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
			result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
		const commands: string[] = [];
		const spy = vi.spyOn(bashExecutor, "executeBash").mockImplementation(async command => {
			commands.push(command);
			return {
				output: "PLAIN",
				exitCode: 0,
				cancelled: false,
				timedOut: false,
				truncated: false,
				totalBytes: 5,
				totalLines: 1,
				outputBytes: 5,
				outputLines: 1,
			};
		});
		try {
			// Argument shape produced by tool-call layers that materialize every
			// optional field: a plain command, not a service start.
			const materialized = await bash.execute("materialized", {
				command: "printf 'PLAIN\\n'",
				timeout: 120,
				cwd: process.cwd(),
				pty: false,
				async: false,
				name: "",
				ready: { log: "", port: 1, host: "", timeout: 1 },
				env: {},
			});
			expect(materialized.details?.service).toBeUndefined();
			expect(textOf(materialized)).toContain("PLAIN");
			expect(textOf(materialized)).toContain("Ignored ready");

			const blank = await bash.execute("blank", {
				command: "printf 'BLANK\\n'",
				name: "   ",
				ready: { log: "", host: "" },
				env: {},
			});
			expect(blank.details?.service).toBeUndefined();
			expect(textOf(blank)).not.toContain("Ignored");

			const orphanEnv = await bash.execute("orphan-env", {
				command: "printf 'ENV\\n'",
				env: { SERVICE_ONLY: "1" },
			});
			expect(orphanEnv.details?.service).toBeUndefined();
			expect(textOf(orphanEnv)).toContain("Ignored env");

			expect(commands).toEqual(["printf 'PLAIN\\n'", "printf 'BLANK\\n'", "printf 'ENV\\n'"]);
		} finally {
			spy.mockRestore();
		}
	});
});
