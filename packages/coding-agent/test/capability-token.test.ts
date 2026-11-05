import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import * as natives from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../src/async/job-manager";
import { Settings } from "../src/config/settings";
import { parseInternalUrl } from "../src/internal-urls/parse";
import { ProcProtocolHandler } from "../src/internal-urls/proc-protocol";
import { AgentLifecycleManager, type AgentReleaseOptions, unsavedAgentWork } from "../src/registry/agent-lifecycle";
import { AgentRegistry } from "../src/registry/agent-registry";
import {
	CAPABILITY_TOKEN_TTL_MS,
	CapabilityAction,
	CapabilityRequiredError,
	capabilityTokens,
	issueCapabilityToken,
	requireCapabilityToken,
	resetCapabilityTokensForTests,
	setCapabilityTokenClockForTests,
} from "../src/safety/capability-tokens";
import * as executorModule from "../src/task/executor";
import { discardIsolationWorkspace, runIsolatedSubprocess } from "../src/task/isolation-runner";
import type { IsolationHandle } from "../src/task/worktree";
import * as worktreeModule from "../src/task/worktree";
import type { AgentSessionHandle } from "../src/session/agent-session-handle";
import type { ToolSession } from "../src/tools";

const tempDirs: TempDir[] = [];

function tempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	vi.restoreAllMocks();
	resetCapabilityTokensForTests();
	for (const dir of tempDirs.splice(0)) dir[Symbol.dispose]?.();
});

beforeEach(() => {
	resetCapabilityTokensForTests();
});

/** The message of the refusal `promise` rejects with; the test fails when it resolves. */
async function refusalMessage(promise: Promise<unknown>): Promise<{ error: CapabilityRequiredError; message: string }> {
	try {
		await promise;
	} catch (error) {
		if (!(error instanceof CapabilityRequiredError)) throw error;
		return { error, message: error.message };
	}
	throw new Error("Expected a capability refusal");
}

function fakeSession(overrides: Record<string, unknown> = {}): AgentSessionHandle {
	return {
		ircWakesPending: false,
		dispose: async () => {},
		abort: async () => {},
		...overrides,
	} as unknown as AgentSessionHandle;
}

/** A git worktree with one committed file, materialised the way an isolation handle points at it. */
async function isolationFixture(): Promise<{ handle: IsolationHandle; merged: string }> {
	const base = tempDir("omp-capability-iso");
	const merged = path.join(base, "iso", "m");
	await fs.mkdir(merged, { recursive: true });
	const git = (...args: string[]) =>
		$`git -C ${merged} -c user.email=test@example.com -c user.name=Test ${args}`.quiet();
	await git("init", "-q");
	await Bun.write(path.join(merged, "tracked.txt"), "one\n");
	await git("add", ".");
	await git("commit", "-qm", "base");
	return {
		handle: { mergedDir: merged, backend: natives.IsoBackendKind.Rcopy, fellBack: false, fallbackReason: null },
		merged,
	};
}

describe("capability tokens", () => {
	it("issues an unguessable <8hex>@<id> token and burns it on the first use", () => {
		const token = issueCapabilityToken("proc-kill", "bg_1");
		expect(token).toMatch(/^[0-9a-f]{8}@[0-9a-z]+$/);

		expect(capabilityTokens.consume(token, "proc-kill", "bg_1")).toBeTrue();
		expect(capabilityTokens.consume(token, "proc-kill", "bg_1")).toBeFalse();
		expect(capabilityTokens.size).toBe(0);
		expect(issueCapabilityToken("proc-kill", "bg_1")).not.toBe(token);
	});

	it("binds a token to its action and target", () => {
		const token = issueCapabilityToken("proc-kill", "bg_1");
		expect(capabilityTokens.check(token, "isolation-discard", "bg_1")).toBeFalse();
		expect(capabilityTokens.check(token, "proc-kill", "bg_2")).toBeFalse();
		expect(capabilityTokens.check(token, "proc-kill", "bg_1")).toBeTrue();
		// A rejected cross-operation check never burns the grant.
		expect(capabilityTokens.consume(token, "proc-kill", "bg_1")).toBeTrue();
	});

	it("expires a token after the TTL and drops the grant", () => {
		const started = Date.now();
		setCapabilityTokenClockForTests(() => started);
		const token = issueCapabilityToken("isolation-discard", "/tmp/iso");

		setCapabilityTokenClockForTests(() => started + CAPABILITY_TOKEN_TTL_MS - 1);
		expect(capabilityTokens.check(token, "isolation-discard", "/tmp/iso")).toBeTrue();

		setCapabilityTokenClockForTests(() => started + CAPABILITY_TOKEN_TTL_MS + 1);
		expect(capabilityTokens.check(token, "isolation-discard", "/tmp/iso")).toBeFalse();
		expect(capabilityTokens.size).toBe(0);
	});

	it("refuses with the fresh token and the parameter that carries it", () => {
		const base = tempDir("omp-capability-refusal");
		let thrown: CapabilityRequiredError | undefined;
		try {
			requireCapabilityToken({
				action: "isolation-discard",
				target: base,
				force: undefined,
				consequence: `discarding ${base} destroys uncommitted changes`,
				retry: token => `force: ${JSON.stringify(token)}`,
			});
		} catch (error) {
			thrown = error as CapabilityRequiredError;
		}
		expect(thrown).toBeInstanceOf(CapabilityRequiredError);
		expect(thrown?.message).toContain(thrown?.token ?? "<missing token>");
		expect(thrown?.message).toContain("force:");
		expect(thrown?.message).toContain("10 minutes");
		expect(capabilityTokens.size).toBe(1);
	});

	it("reports a rejected token without issuing a second grant per retry", () => {
		const base = tempDir("omp-capability-rejected");
		let thrown: CapabilityRequiredError | undefined;
		try {
			requireCapabilityToken({
				action: "isolation-discard",
				target: base,
				force: "deadbeef@0",
				consequence: `discarding ${base} destroys uncommitted changes`,
				retry: token => `force: ${JSON.stringify(token)}`,
			});
		} catch (error) {
			thrown = error as CapabilityRequiredError;
		}
		expect(thrown?.message).toContain("deadbeef@0");
		expect(thrown?.token).toMatch(/^[0-9a-f]{8}@[0-9a-z]+$/);
		expect(thrown?.token).not.toBe("deadbeef@0");
	});
});

describe("isolation worktree discard", () => {
	it("refuses to delete a worktree with uncommitted changes and names a token", async () => {
		const { handle, merged } = await isolationFixture();
		await Bun.write(path.join(merged, "untracked.txt"), "draft\n");

		const refusal = await refusalMessage(discardIsolationWorkspace(handle));
		expect(refusal.message).toContain(refusal.error.token);
		expect(refusal.message).toContain("force:");
		expect(await fs.exists(path.join(merged, "untracked.txt"))).toBeTrue();
	});

	it("deletes the worktree when the refusal's token comes back as force", async () => {
		const { handle, merged } = await isolationFixture();
		await Bun.write(path.join(merged, "tracked.txt"), "rewritten\n");

		const refusal = await refusalMessage(discardIsolationWorkspace(handle));
		await discardIsolationWorkspace(handle, { force: refusal.error.token });
		expect(await fs.exists(merged)).toBeFalse();
	});

	it("refuses a spent token and an expired token", async () => {
		const { handle, merged } = await isolationFixture();
		const started = Date.now();
		setCapabilityTokenClockForTests(() => started);
		await Bun.write(path.join(merged, "untracked.txt"), "draft\n");

		const spent = issueCapabilityToken(CapabilityAction.isolationDiscard, merged);
		expect(capabilityTokens.consume(spent, CapabilityAction.isolationDiscard, merged)).toBeTrue();
		const refusal = await refusalMessage(discardIsolationWorkspace(handle, { force: spent }));
		expect(refusal.message).toContain(spent);
		expect(refusal.message).toContain("force:");
		await discardIsolationWorkspace(handle, { force: refusal.error.token });
		expect(await fs.exists(merged)).toBeFalse();

		const second = await isolationFixture();
		await Bun.write(path.join(second.merged, "untracked.txt"), "draft\n");
		const expired = issueCapabilityToken(CapabilityAction.isolationDiscard, second.merged);
		setCapabilityTokenClockForTests(() => started + CAPABILITY_TOKEN_TTL_MS + 1);
		const expiredRefusal = await refusalMessage(discardIsolationWorkspace(second.handle, { force: expired }));
		expect(expiredRefusal.error.token).not.toBe(expired);
		expect(await fs.exists(second.merged)).toBeTrue();
	});

	it("deletes a clean worktree without a token", async () => {
		const { handle, merged } = await isolationFixture();
		await discardIsolationWorkspace(handle);
		expect(await fs.exists(merged)).toBeFalse();
	});
});

describe("failed isolated run", () => {
	it("retains a worktree whose changes were never captured instead of deleting it", async () => {
		const { merged } = await isolationFixture();
		const scratch = tempDir("omp-capability-run");
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: merged,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue({
			root: { repoRoot: scratch, headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
			nested: [],
		});
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "diff --git a/task.txt b/task.txt\n+work\n",
			nestedPatches: [],
		});
		// The run left an edit behind; nothing captured it.
		await Bun.write(path.join(merged, "task.txt"), "work\n");
		const cleanup = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue({
			index: 0,
			id: "failed-run",
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Do work",
			exitCode: 1,
			output: "half done",
			stderr: "boom",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		});

		const result = await runIsolatedSubprocess({
			baseOptions: {
				cwd: scratch,
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do work",
				index: 0,
				id: "failed-run",
			},
			context: { repoRoot: scratch },
			preferredBackend: undefined,
			agentId: "failed-run",
			mergeMode: "patch",
			artifactsDir: scratch,
			buildFailureResult: error => {
				throw error;
			},
		});

		expect(result.exitCode).toBe(1);
		expect(cleanup).not.toHaveBeenCalled();
		// Retained: the deterministic slot is renamed to a unique `.retained-*` sibling.
		expect(await fs.exists(merged)).toBeFalse();
		const siblings = await fs.readdir(path.dirname(path.dirname(merged)));
		expect(siblings.some(name => name.includes(".retained-"))).toBeTrue();
	});
});

describe("agent release", () => {
	it("refuses to release a parked agent whose transcript exists only in memory", async () => {
		const registry = new AgentRegistry();
		const ref = registry.register({
			id: "parked-memory",
			displayName: "Parked Memory",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
		});
		expect(unsavedAgentWork(ref)).toBeDefined();
		const lifecycle = new AgentLifecycleManager(registry);

		const refusal = await refusalMessage(lifecycle.release("parked-memory"));
		expect(refusal.message).toContain(refusal.error.token);
		expect(refusal.message).toContain("force:");
		expect(registry.get("parked-memory")).toBe(ref);

		expect(await lifecycle.release("parked-memory", undefined, { force: refusal.error.token })).toBeTrue();
		expect(registry.get("parked-memory")).toBeUndefined();
	});

	it("refuses a replayed release token", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "parked-memory",
			displayName: "Parked Memory",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
		});
		const lifecycle = new AgentLifecycleManager(registry);
		const refusal = await refusalMessage(lifecycle.release("parked-memory"));
		await lifecycle.release("parked-memory", undefined, { force: refusal.error.token });

		const registry2 = new AgentRegistry();
		registry2.register({
			id: "parked-memory",
			displayName: "Parked Memory",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
		});
		const lifecycle2 = new AgentLifecycleManager(registry2);
		const replay = await refusalMessage(
			lifecycle2.release("parked-memory", undefined, { force: refusal.error.token }),
		);
		expect(replay.error.token).not.toBe(refusal.error.token);
		expect(registry2.get("parked-memory")).toBeDefined();
	});

	it("releases a session-backed agent without a token", async () => {
		const registry = new AgentRegistry();
		const ref = registry.register({
			id: "clean-agent",
			displayName: "Clean Agent",
			kind: "sub",
			parentId: "Main",
			status: "idle",
			session: fakeSession(),
			sessionFile: "/tmp/clean-agent.jsonl",
		});
		expect(unsavedAgentWork(ref)).toBeUndefined();
		const lifecycle = new AgentLifecycleManager(registry);
		const options: AgentReleaseOptions = {};
		expect(await lifecycle.release("clean-agent", undefined, options)).toBeTrue();
		expect(registry.get("clean-agent")).toBeUndefined();
	});
});

describe("proc:// kill capability gate", () => {
	function toolSession(
		registry: AgentRegistry,
		lifecycle: AgentLifecycleManager,
		manager: AsyncJobManager,
	): ToolSession {
		return {
			cwd: process.cwd(),
			hasUI: false,
			getAgentId: () => "Main",
			getSessionId: () => "Main",
			getSessionFile: () => null,
			asyncJobManager: manager,
			agentRegistry: registry,
			agentLifecycle: () => lifecycle,
			settings: Settings.isolated({ "launch.enabled": false, "async.enabled": false }),
		} as unknown as ToolSession;
	}

	it("refuses a jobless agent that still owes queued messages, then honours the token", async () => {
		const registry = new AgentRegistry();
		const session = fakeSession({ ircWakesPending: true });
		const ref = registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			status: "running",
			session,
			sessionFile: "/tmp/worker.jsonl",
		});
		expect(unsavedAgentWork(ref)).toBeDefined();
		const lifecycle = new AgentLifecycleManager(registry);
		const manager = new AsyncJobManager({});
		const tool = toolSession(registry, lifecycle, manager);
		const protocol = new ProcProtocolHandler();
		try {
			const refusal = await refusalMessage(
				protocol.write(parseInternalUrl("proc://Worker/kill"), "", { session: tool }),
			);
			expect(refusal.message).toContain(refusal.error.token);
			expect(refusal.message).toContain(
				JSON.stringify({ path: "proc://Worker/kill", content: refusal.error.token }),
			);
			expect(registry.get("Worker")).toBe(ref);

			const killed = await protocol.write(parseInternalUrl("proc://Worker/kill"), refusal.error.token, {
				session: tool,
			});
			expect(killed.content[0]?.type === "text" ? killed.content[0].text : "").toContain("Cancelled agent Worker");
			expect(registry.get("Worker")).toBeUndefined();

			// The token was one-shot: the grant is spent, so it cannot authorize another kill.
			expect(capabilityTokens.check(refusal.error.token, CapabilityAction.agentRelease, "Worker")).toBeFalse();
		} finally {
			await manager.dispose();
			await lifecycle.dispose();
		}
	});

	it("refuses a running task job whose agent owes queued messages, then honours the token once", async () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			status: "running",
			session: fakeSession({ ircWakesPending: true }),
			sessionFile: "/tmp/worker.jsonl",
		});
		const lifecycle = new AgentLifecycleManager(registry);
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		manager.register(
			"task",
			"worker",
			async ({ signal }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				return pending.promise;
			},
			{ id: "worker", agentId: "worker", ownerId: "Main" },
		);
		const tool = toolSession(registry, lifecycle, manager);
		const protocol = new ProcProtocolHandler();
		try {
			const refusal = await refusalMessage(
				protocol.write(parseInternalUrl("proc://worker/kill"), "", { session: tool }),
			);
			expect(refusal.message).toContain(refusal.error.token);
			expect(manager.getJob("worker")?.status).toBe("running");

			await protocol.write(parseInternalUrl("proc://worker/kill"), refusal.error.token, { session: tool });
			expect(manager.getJob("worker")?.status).toBe("cancelled");

			const replay = await refusalMessage(
				protocol.write(parseInternalUrl("proc://worker/kill"), refusal.error.token, { session: tool }),
			);
			expect(replay.error.token).not.toBe(refusal.error.token);
		} finally {
			await manager.dispose();
			await lifecycle.dispose();
		}
	});

	it("keeps a plain background job kill tokenless", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"compiling",
			async ({ signal }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				return pending.promise;
			},
			{ id: "build-job", ownerId: "Main" },
		);
		const tool = toolSession(registry, lifecycle, manager);
		const protocol = new ProcProtocolHandler();
		try {
			const killed = await protocol.write(parseInternalUrl("proc://build-job/kill"), "", { session: tool });
			expect(killed.content[0]?.type === "text" ? killed.content[0].text : "").toContain(
				"Cancelled background job build-job",
			);
			expect(capabilityTokens.size).toBe(0);
		} finally {
			await manager.dispose();
			await lifecycle.dispose();
		}
	});
});
