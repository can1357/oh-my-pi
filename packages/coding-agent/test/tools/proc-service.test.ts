import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { procmgr, setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ProcProtocolHandler } from "../../src/internal-urls/proc-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { SessionManager } from "../../src/session/session-manager";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import * as daemonClient from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonOperation,
	type DaemonRpcResult,
} from "../../src/launch/protocol";
import { BashTool } from "../../src/tools/bash";
import { WriteTool } from "../../src/tools/write";
import { sharedBrowserDaemonName } from "../../src/tools/browser/shared-daemon";
import type { ToolSession } from "../../src/tools";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";

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

// Services really spawn the configured shell with POSIX command lines. Windows
// has no `/bin/sh`, so use the product's own Git Bash discovery there.
const SERVICE_SHELL = process.platform === "win32" ? procmgr.resolveWindowsShell() : "/bin/sh";

/**
 * Settles a broker-backed call with a plain `await`. On Windows, Bun's
 * `expect(promise).rejects` waits on the promise without servicing the
 * in-process broker's named-pipe I/O, so the request stalls until its timeout.
 */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("Expected the promise to reject");
}

function toolSession(
	cwd: string,
	manager?: AsyncJobManager,
	options: { launch?: boolean; async?: boolean } = {},
): ToolSession {
	return {
		cwd,
		hasUI: false,
		getAgentId: () => "Main",
		getSessionId: () => "Main",
		getSessionFile: () => null,
		asyncJobManager: manager,
		settings: Settings.isolated({
			"launch.enabled": options.launch ?? true,
			"async.enabled": options.async ?? false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": false,
			"worktree.clone": false,
			shellPath: SERVICE_SHELL,
		}),
	} as unknown as ToolSession;
}

function steeringContext(steeringSignal: AbortSignal): AgentToolContext {
	return {
		sessionManager: SessionManager.inMemory(),
		modelRegistry: undefined,
		model: undefined,
		isIdle: () => false,
		hasQueuedMessages: () => true,
		abort: () => {},
		toolNames: [],
		toolCall: {
			batchId: "batch-1",
			index: 0,
			total: 1,
			toolCalls: [{ id: "service", name: "bash" }],
			steeringSignal,
		},
	} as unknown as AgentToolContext;
}

describe("proc:// background jobs", () => {
	it("reads what a pipeline stage wrote while a later stage still holds it back", async () => {
		const manager = new AsyncJobManager({});
		const session = toolSession(process.cwd(), manager, { launch: false, async: true });
		const proc = new ProcProtocolHandler();
		try {
			await new BashTool(session).execute("piped", {
				command: "{ printf 'one\\r\\ntwo\\rthree\\n'; sleep 30; } | tail -n 1",
				async: true,
				pty: false,
			});
			const [job] = manager.getAllJobs({ ownerId: "Main" });
			if (!job) throw new Error("no bash job started");
			const read = (url: string) => proc.resolve(parseInternalUrl(url), { session });

			// Real-time poll: the stream fills from a real child's pipe write, and
			// nothing in-process signals when the relay thread has copied it.
			let stream = "";
			for (let waited = 0; stream !== "one\ntwo\nthree\n" && waited < 10_000; waited += 20) {
				await Bun.sleep(20);
				const opened = (await read(`proc://${job.id}/streams`)).content.startsWith(`proc://${job.id}/streams/1 `);
				if (opened) stream = (await read(`proc://${job.id}/streams/1`)).content;
			}
			// CRLF and bare-CR progress both read as lines.
			expect(stream).toBe("one\ntwo\nthree\n");
			// The job's own output is still empty: `tail` prints only at EOF.
			expect((await read(`proc://${job.id}`)).details).toMatchObject({ proc: { log: "" } });
			const listing = await read(`proc://${job.id}/streams`);
			expect(listing.isDirectory).toBeTrue();
			expect(listing.content).toMatch(new RegExp(`^proc://${job.id}/streams/1 open 15B — .*printf.* → tail -n 1$`));
			expect(await rejectionMessage(read(`proc://${job.id}/streams/2`))).toContain(
				`List them with proc://${job.id}/streams`,
			);
		} finally {
			await manager.dispose({ timeoutMs: 2_000 });
		}
	}, 20_000);

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

	it.each([
		{ label: "plan mode", deviceOnlyWrite: false },
		{ label: "plan mode with device-only write", deviceOnlyWrite: true },
	])("kills owned jobs under $label while stdin stays guarded (issue #13803)", async ({ deviceOnlyWrite }) => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		const id = manager.register(
			"task",
			"exploring the wrong track",
			async ({ signal }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				return pending.promise;
			},
			{ ownerId: "Main" },
		);
		const session = toolSession(process.cwd(), manager, { launch: false });
		session.getPlanModeState = () => ({
			enabled: true,
			planFilePath: "local://PLAN.md",
			workflow: "parallel",
			reentry: false,
		});
		session.deviceOnlyWrite = deviceOnlyWrite || undefined;
		const write = new WriteTool(session);
		try {
			await expect(write.execute("stdin", { path: `proc://${id}`, content: "go" })).rejects.toThrow(
				deviceOnlyWrite ? "limited to the xd:// device transport" : "Plan mode",
			);
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

	it("keeps listing jobs and agents when the daemon broker hangs, flagging agents with no live turn", async () => {
		const broker = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue({
			request: async () => {
				throw new Error("Daemon list request timed out");
			},
			onCompletion: () => () => {},
		} as unknown as daemonClient.DaemonBrokerClient);
		const manager = new AsyncJobManager({});
		const blocked = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"long build",
			async ({ signal }) => {
				signal.addEventListener("abort", () => blocked.resolve("cancelled"), { once: true });
				return blocked.promise;
			},
			{ id: "build-job", ownerId: "Main" },
		);
		const registry = new AgentRegistry();
		// Claims `running` but no session is streaming: the run is over.
		registry.register({ id: "Visuals", displayName: "Visuals", kind: "sub", parentId: "Main", session: null });
		const session = toolSession(process.cwd(), manager, { launch: true });
		session.agentRegistry = registry;
		const proc = new ProcProtocolHandler();
		try {
			const list = await proc.resolve(parseInternalUrl("proc://"), { session });
			expect(list.content).toContain("build-job [bash] running");
			expect(list.content).toContain("Visuals [task] running up");
			expect(list.content).toContain("no turn in flight");
			expect(list.content).toContain("Services unavailable (daemon broker): Daemon list request timed out");
			const single = await proc.resolve(parseInternalUrl("proc://Visuals"), { session });
			expect(single.content).toContain("no turn in flight");
			await expect(proc.resolve(parseInternalUrl("proc://web"), { session })).rejects.toThrow(
				"services unavailable: Daemon list request timed out",
			);
			// The suggested kill works without the broker; service-only actions still surface its error.
			const killed = await proc.write(parseInternalUrl("proc://Visuals/kill"), "", { session });
			expect(killed.details?.proc).toMatchObject({ cancelled: [{ id: "Visuals", status: "cancelled" }] });
			expect(registry.get("Visuals")).toBeUndefined();
			const killedJob = await proc.write(parseInternalUrl("proc://build-job/kill"), "", { session });
			expect(killedJob.details?.proc).toMatchObject({ cancelled: [{ id: "build-job", status: "cancelled" }] });
			await expect(proc.write(parseInternalUrl("proc://web"), "go\n", { session })).rejects.toThrow(
				"Daemon list request timed out",
			);
		} finally {
			broker.mockRestore();
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
			expect(await rejectionMessage(proc.resolve(parseInternalUrl("proc://echo-service"), { session }))).toContain(
				"both job echo-service and service echo-service",
			);
			expect(
				await rejectionMessage(proc.write(parseInternalUrl("proc://echo-service/kill"), "", { session })),
			).toContain("both job echo-service and service echo-service");
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
			const spec: { persist: boolean } = await Bun.file(
				path.join(runtimeDir, "daemons", "echo-service", "spec.json"),
			).json();
			expect(spec.persist).toBeTrue();
			const sessionMode = await proc.write(parseInternalUrl("proc://echo-service/mode"), "session", { session });
			expect(sessionMode.content[0]?.type === "text" ? sessionMode.content[0].text : "").toContain("mode=session");
			const sessionSpec: { persist: boolean } = await Bun.file(
				path.join(runtimeDir, "daemons", "echo-service", "spec.json"),
			).json();
			expect(sessionSpec.persist).toBeFalse();
			const restarted = await bash.execute("restart", {
				command: "printf 'REPLACED\\n'; read line",
				name: "echo-service",
				ready: { log: "REPLACED", host: "", timeout: 5 },
				pty: false,
				async: false,
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
			const detachedSpec: { persist: boolean; detached: boolean; pty: boolean } = await Bun.file(
				path.join(runtimeDir, "daemons", "detach-candidate", "spec.json"),
			).json();
			expect(detachedSpec).toMatchObject({ detached: true, persist: true, pty: false });
			expect(
				await rejectionMessage(
					proc.write(parseInternalUrl("proc://detach-candidate/mode"), "session", { session }),
				),
			).toContain("must remain persistent");
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

	it("ends the readiness wait on a queued steer only after the broker launched the service", async () => {
		using temp = TempDir.createSync("@omp-proc-service-steer-");
		const cwd = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(cwd);
		const client = await createDaemonBrokerClient(cwd, { runtimeDir, idleGraceMs: 5_000 });
		const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const oldTitle = process.title;
		const broker = startBroker(cwd, runtimeDir);
		// Already queued when the call starts, i.e. before the broker connection.
		const steering = new AbortController();
		steering.abort();
		try {
			// Readiness would wait 300s, past the test timeout; only the steer ends the call early.
			const result = await new BashTool(toolSession(cwd)).execute(
				"service",
				{
					command: "sleep 30",
					name: "slow-service",
					ready: { log: "never-printed", timeout: 300 },
					pty: false,
				},
				undefined,
				undefined,
				steeringContext(steering.signal),
			);
			expect(result.details?.service).toMatchObject({ name: "slow-service", state: "starting", ready: false });
			expect(result.details?.service?.pid).toBeNumber();
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("proc://slow-service");
			const read = await new ProcProtocolHandler().resolve(parseInternalUrl("proc://slow-service"), {
				session: toolSession(cwd),
			});
			expect(read.details?.proc).toMatchObject({ daemon: { name: "slow-service", state: "starting" } });
		} finally {
			await client.request({ op: "stop", name: "slow-service", timeoutMs: 1_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(oldTitle);
			spy.mockRestore();
		}
	}, 20_000);

	it("still rejects validation and launch failures when a steer is queued", async () => {
		const steering = new AbortController();
		const client = {
			projectDir: process.cwd(),
			onCompletion: () => () => {},
			close() {},
			async request(operation: DaemonOperation): Promise<DaemonRpcResult> {
				if (operation.op === "start") {
					// The steer lands while the launch request is in flight.
					steering.abort();
					throw new Error("Daemon cwd is not a directory");
				}
				throw new Error(`Unexpected broker op ${operation.op}`);
			},
		} as unknown as DaemonBrokerClient;
		const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const bash = new BashTool(toolSession(process.cwd()));
		try {
			expect(
				await rejectionMessage(
					bash.execute(
						"launch-failure",
						{ command: "sleep 600", name: "launch-failure", ready: { log: "never-printed", timeout: 300 } },
						undefined,
						undefined,
						steeringContext(steering.signal),
					),
				),
			).toContain("Daemon cwd is not a directory");
			expect(
				await rejectionMessage(
					bash.execute(
						"bad-regex",
						{ command: "true", name: "bad-regex", ready: { log: "(", timeout: 300 } },
						undefined,
						undefined,
						steeringContext(steering.signal),
					),
				),
			).toContain("Invalid readiness regex");
		} finally {
			spy.mockRestore();
		}
	});

	it("keeps the settled service result when a steer arrives during log retrieval", async () => {
		const now = Date.now();
		const daemon: DaemonSnapshot = {
			name: "ready-service",
			id: "ready-service-id",
			state: "starting",
			pid: 12345,
			owner: "Main",
			createdAt: now,
			startedAt: now,
			restartCount: 0,
			outputBytes: 0,
			persist: false,
			detached: false,
		};
		const logsRequested = Promise.withResolvers<void>();
		const logs = Promise.withResolvers<DaemonRpcResult>();
		const client = {
			projectDir: process.cwd(),
			onCompletion: () => () => {},
			close() {},
			async request(operation: DaemonOperation): Promise<DaemonRpcResult> {
				if (operation.op === "start") return { op: "start", daemon, readyTimedOut: false };
				if (operation.op === "wait")
					return { op: "wait", daemon: { ...daemon, state: "ready", readyAt: now }, timedOut: false };
				if (operation.op === "logs") {
					logsRequested.resolve();
					return logs.promise;
				}
				throw new Error(`Unexpected broker op ${operation.op}`);
			},
		} as unknown as DaemonBrokerClient;
		const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		const steering = new AbortController();
		try {
			const pending = new BashTool(toolSession(process.cwd())).execute(
				"ready-service",
				{ command: "printf 'READY\n'", name: "ready-service", ready: { log: "READY", timeout: 300 } },
				undefined,
				undefined,
				steeringContext(steering.signal),
			);
			await logsRequested.promise;
			steering.abort();
			logs.resolve({
				op: "logs",
				name: "ready-service",
				text: "READY\n",
				cursor: 6,
				timedOut: false,
				state: "ready",
			});
			const result = await pending;
			expect(result.details?.service).toMatchObject({
				name: "ready-service",
				state: "ready",
				ready: true,
				pid: 12345,
			});
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("READY");
		} finally {
			spy.mockRestore();
		}
	});

	it.each([
		{
			label: "materialized placeholders",
			name: "",
			ready: { log: "", port: 0, host: "", timeout: 30 },
			ignored: false,
		},
		{ label: "blank fields", name: "   ", ready: { log: "", host: "" }, ignored: false },
		{ label: "timeout only", ready: { timeout: 30 }, ignored: false },
		{ label: "host only", ready: { host: "127.0.0.1" }, ignored: false },
		{ label: "log condition", ready: { log: "READY", port: 0, timeout: 30 }, ignored: true },
		{ label: "port condition", name: "", ready: { log: "", port: 1, host: "", timeout: 1 }, ignored: true },
	])("runs plain commands with $label and only warns for readiness conditions", async ({ name, ready, ignored }) => {
		const bash = new BashTool(toolSession(process.cwd()));
		const result = await bash.execute("plain", {
			command: "printf 'PLAIN\\n'",
			timeout: 10,
			cwd: process.cwd(),
			pty: false,
			async: false,
			name,
			ready,
		});
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(result.details?.service).toBeUndefined();
		expect(text).toContain("PLAIN\n");
		expect(text.includes("Ignored ready:")).toBe(ignored);
	});

	it("refuses to detach the project-shared browser, which the broker would relaunch on an unprepared profile", async () => {
		const name = sharedBrowserDaemonName(true);
		const now = Date.now();
		const daemon: DaemonSnapshot = {
			name,
			id: "shared",
			state: "ready",
			createdAt: now,
			startedAt: now,
			readyAt: now,
			restartCount: 0,
			outputBytes: 0,
			persist: false,
			detached: false,
		};
		const operations: DaemonOperation["op"][] = [];
		const client = {
			projectDir: process.cwd(),
			onCompletion: () => () => {},
			close() {},
			async request(operation: DaemonOperation): Promise<DaemonRpcResult> {
				operations.push(operation.op);
				if (operation.op === "list") return { op: "list", daemons: [daemon] };
				// The real broker answers by relaunching the browser as a detached process.
				if (operation.op === "mode") return { op: "mode", daemon: { ...daemon, detached: true } };
				throw new Error(`Unexpected broker op ${operation.op}`);
			},
		} as unknown as DaemonBrokerClient;
		const spy = vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);
		try {
			await rejectionMessage(
				new ProcProtocolHandler().write(parseInternalUrl(`proc://${name}/mode`), "detached", {
					session: toolSession(process.cwd()),
				}),
			);
			expect(operations).not.toContain("mode");
		} finally {
			spy.mockRestore();
		}
	});
});
