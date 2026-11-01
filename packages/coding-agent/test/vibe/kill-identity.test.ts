/**
 * Contract: killing a Vibe worker stops it without changing who it is. Its
 * transcript stays, a reopen revives the same worker, and a due-by notice
 * addressed to the worker before the kill still reaches it after the reopen.
 * A kill that gave the worker a new identity would leave every clock that
 * recorded the old one with no recipient.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { dispatchChain, type SubagentOverdueEntry } from "@oh-my-pi/pi-coding-agent/task/due-by";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";

let temp: TempDir;
let manager: AsyncJobManager;
let parentManager: SessionManager;
const run = Promise.withResolvers<void>();

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	VibeSessionRegistry.resetGlobalForTests();
	temp = TempDir.createSync("@pi-vibe-kill-identity-");
	manager = new AsyncJobManager({});
});

afterEach(async () => {
	run.resolve();
	vi.restoreAllMocks();
	await manager.dispose({ timeoutMs: 1_000 });
	await parentManager?.close();
	temp.removeSync();
	VibeSessionRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

it("keeps a killed worker's identity, so a due-by recorded before the kill reaches it after a reopen", async () => {
	parentManager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
	parentManager.appendMessage({ role: "user", content: "vibe", timestamp: Date.now() });
	await parentManager.flush();
	const registry = AgentRegistry.global();
	const told = Promise.withResolvers<string>();
	// Only the worker's run is replaced; spawn, kill, release, the tombstone and the reopen are real.
	const worker = {
		isStreaming: false,
		dispose: async () => {},
		notifySubagentOverdue: (entry: SubagentOverdueEntry) => told.resolve(`worker: ${entry.stage}`),
		emitNotice: () => told.resolve("the person"),
	} as unknown as AgentSession;
	const parent = {
		cwd: temp.path(),
		hasUI: false,
		settings: Settings.isolated(),
		sessionManager: parentManager,
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionId: () => parentManager.getSessionId(),
		getSessionFile: () => parentManager.getSessionFile(),
		getArtifactsDir: () => parentManager.getSessionFile()!.slice(0, -6),
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		const childFile = path.join(options.artifactsDir!, `${options.id}.jsonl`);
		const child = await SessionManager.open(childFile, undefined, undefined, {
			initialCwd: temp.path(),
			parentSession: parentManager.getSessionFile()!,
			suppressBreadcrumb: true,
		});
		child.appendSessionInit({
			systemPrompt: ["test"],
			task: "work",
			tools: ["read"],
			agent: "sonic",
			resolvedModel: "mock/mock-model",
		});
		await child.close();
		registry.register({
			id: options.id!,
			displayName: options.id!,
			kind: "sub",
			parentId: "Main",
			status: "idle",
			session: worker,
			sessionFile: childFile,
		});
		return {
			index: 0,
			id: options.id!,
			agent: options.agent.name,
			agentSource: options.agent.source,
			task: "work",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		};
	});

	const spawned = await VibeSessionRegistry.global().spawn(parent, { cli: "fast", name: "Worker", prompt: "work" });
	await manager.getJob(spawned.jobId)!.promise;
	const original = registry.get(spawned.id)!;
	// The worker dispatched something before it was killed: its clock records the worker as owner.
	const chain = dispatchChain(registry, spawned.id);

	await VibeSessionRegistry.global().kill(parent, spawned.id);
	const tombstone = registry.get(spawned.id)!;
	expect(tombstone.status).toBe("aborted");
	const reopened = registry.reopen(spawned.id, tombstone)!;
	expect(registry.attachSession(spawned.id, worker, reopened.sessionFile, reopened)).toBe(true);
	expect(reopened.identityToken).toBe(original.identityToken);

	registry.dueBy.arm(
		{ childId: "Grandchild", ...chain, agent: "task", dispatchedAt: Date.now(), dueMs: 30, stated: true },
		{ settled: run.promise, signal: new AbortController().signal },
	);
	// Telling nobody has no event to wait for: bound the wait at a hundred due-bys,
	// so that failure is an assertion, not a timeout.
	const recipient = await Promise.race([told.promise, Bun.sleep(3_000).then(() => "nobody")]);
	expect(recipient).toBe("worker: owner");
}, 30_000);
