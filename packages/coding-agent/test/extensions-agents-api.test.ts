import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAgentsApi } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

async function loadAgentsApi(cwd: string, agentId: string = MAIN_AGENT_ID): Promise<ExtensionAgentsApi> {
	let agents: ExtensionAgentsApi | undefined;
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		api => {
			agents = api.agents;
		},
		cwd,
		new EventBus(),
		runtime,
	);
	const authStorage = await AuthStorage.create(":memory:");
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		cwd,
		SessionManager.inMemory(cwd),
		new ModelRegistry(authStorage),
	);

	await initializeExtensions(
		{
			extensionRunner: runner,
			discoverStartupSkillPaths: async () => {},
			getAgentId: () => agentId,
			sessionManager: { getSessionFile: () => undefined },
		} as unknown as AgentSession,
		{
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
		},
	);
	if (!agents) throw new Error("Extension factory did not receive api.agents");
	return agents;
}

function sessionStub(
	options: { onPrompt?: (text: string, deliverAs: "steer" | "followUp") => void } = {},
): AgentSession {
	return {
		dispose: async () => {},
		prompt: async (text: string, promptOptions: { streamingBehavior: "steer" | "followUp" }) => {
			options.onPrompt?.(text, promptOptions.streamingBehavior);
		},
	} as unknown as AgentSession;
}

describe("ExtensionAPI agents", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("agents.list exposes registry refs and ensureLive revives a parked agent", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-");
		const agents = await loadAgentsApi(tempDir.path());
		const registry = AgentRegistry.global();
		const sessionFile = path.join(tempDir.path(), "Worker1.jsonl");
		await Bun.write(sessionFile, "");
		const revived = sessionStub();
		registry.register({
			id: "Worker1",
			displayName: "Worker 1",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile,
			status: "parked",
		});
		AgentLifecycleManager.global().adopt("Worker1", { idleTtlMs: 0, revive: async () => revived });

		expect(agents.list()).toEqual([{ id: "Worker1", status: "parked", kind: "sub", sessionFile }]);
		expect(agents.get("Worker1")).toEqual({ id: "Worker1", status: "parked", kind: "sub", sessionFile });

		expect(await agents.ensureLive("Worker1")).toEqual({ id: "Worker1", status: "idle", kind: "sub", sessionFile });
		expect(registry.get("Worker1")?.status).toBe("idle");
	});

	it("prompt delivers a follow-up turn to a revived agent", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-");
		const agents = await loadAgentsApi(tempDir.path());
		const registry = AgentRegistry.global();
		const sessionFile = path.join(tempDir.path(), "Worker2.jsonl");
		await Bun.write(sessionFile, "");
		let delivered: { text: string; deliverAs: "steer" | "followUp" } | undefined;
		const revived = sessionStub({
			onPrompt: (text, deliverAs) => {
				delivered = { text, deliverAs };
			},
		});
		registry.register({
			id: "Worker2",
			displayName: "Worker 2",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile,
			status: "parked",
		});
		AgentLifecycleManager.global().adopt("Worker2", { idleTtlMs: 0, revive: async () => revived });

		await agents.prompt("Worker2", "continue from the saved transcript", { deliverAs: "followUp" });

		expect(delivered).toEqual({ text: "continue from the saved transcript", deliverAs: "followUp" });
		expect(registry.get("Worker2")?.status).toBe("idle");
	});

	it("scopes agents.list/get/ensureLive/prompt to the calling session's own family", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-scope-");
		const cwd = tempDir.path();
		const agentsA = await loadAgentsApi(cwd, "SessionA");
		const agentsB = await loadAgentsApi(cwd, "SessionB");
		const registry = AgentRegistry.global();

		const fileA = path.join(cwd, "ChildA.jsonl");
		const fileB = path.join(cwd, "ChildB.jsonl");
		await Bun.write(fileA, "");
		await Bun.write(fileB, "");
		registry.register({
			id: "ChildA",
			displayName: "Child A",
			kind: "sub",
			parentId: "SessionA",
			session: null,
			sessionFile: fileA,
			status: "parked",
		});
		registry.register({
			id: "ChildB",
			displayName: "Child B",
			kind: "sub",
			parentId: "SessionB",
			session: null,
			sessionFile: fileB,
			status: "parked",
		});
		AgentLifecycleManager.global().adopt("ChildA", { idleTtlMs: 0, revive: async () => sessionStub() });
		AgentLifecycleManager.global().adopt("ChildB", { idleTtlMs: 0, revive: async () => sessionStub() });

		expect(agentsA.list().map(ref => ref.id)).toEqual(["ChildA"]);
		expect(agentsB.list().map(ref => ref.id)).toEqual(["ChildB"]);
		expect(agentsA.get("ChildA")).toBeDefined();
		expect(agentsA.get("ChildB")).toBeUndefined();
		expect(agentsB.get("ChildA")).toBeUndefined();

		await expect(agentsA.ensureLive("ChildB")).rejects.toThrow(/not visible to this session/);
		await expect(agentsA.prompt("ChildB", "hi")).rejects.toThrow(/not visible to this session/);
		await expect(agentsB.ensureLive("ChildA")).rejects.toThrow(/not visible to this session/);

		expect(await agentsA.ensureLive("ChildA")).toMatchObject({ id: "ChildA", status: "idle" });
		expect(registry.get("ChildB")?.status).toBe("parked");
	});

	it("a grandchild of the scoped agent is visible, an unrelated session's descendant is not", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-family-");
		const cwd = tempDir.path();
		const agents = await loadAgentsApi(cwd, "SessionA");
		const registry = AgentRegistry.global();
		for (const [id, parentId] of [
			["Child", "SessionA"],
			["Grandchild", "Child"],
			["Foreign", "SessionB"],
		] as const) {
			const sessionFile = path.join(cwd, `${id}.jsonl`);
			await Bun.write(sessionFile, "");
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId,
				session: null,
				sessionFile,
				status: "parked",
			});
		}

		expect(
			agents
				.list()
				.map(ref => ref.id)
				.sort(),
		).toEqual(["Child", "Grandchild"]);
		expect(agents.get("Grandchild")).toBeDefined();
		expect(agents.get("Foreign")).toBeUndefined();
	});
});
