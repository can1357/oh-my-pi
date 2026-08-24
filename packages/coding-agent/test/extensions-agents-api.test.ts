import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAgentsApi } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

async function loadAgentsApi(cwd: string): Promise<ExtensionAgentsApi> {
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

	await initializeExtensions({ extensionRunner: runner, discoverStartupSkillPaths: async () => {} } as AgentSession, {
		reportSendError: (_action, error) => {
			throw error;
		},
		reportRuntimeError: error => {
			throw error.error;
		},
	});
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

function persistedWorkerTranscript(): string {
	return [
		JSON.stringify({ type: "session", id: "session", parentId: null, timestamp: "2026-08-24T00:00:00.000Z" }),
		JSON.stringify({
			type: "session_init",
			id: "init",
			parentId: "session",
			timestamp: "2026-08-24T00:00:01.000Z",
			agent: "task",
			task: "persisted task",
		}),
	].join("\n");
}

describe("ExtensionAPI agents", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
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

	it("ensureLive rescans a parent transcript when its registry ref is absent", async () => {
		using tempDir = TempDir.createSync("@omp-extension-agents-");
		const agents = await loadAgentsApi(tempDir.path());
		const parentSessionFile = path.join(tempDir.path(), "main.jsonl");
		const sessionFile = path.join(tempDir.path(), "main", "Rescanned.jsonl");
		await Bun.write(parentSessionFile, "");
		await Bun.write(sessionFile, `${persistedWorkerTranscript()}\n`);
		const revived = sessionStub();
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(async ref => {
			return ref.id === "Rescanned" ? async () => revived : undefined;
		}, 0);

		expect(await agents.ensureLive("Rescanned", { parentSessionFile })).toEqual({
			id: "Rescanned",
			status: "idle",
			kind: "sub",
			sessionFile,
		});
		expect(AgentRegistry.global().get("Rescanned")?.status).toBe("idle");
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
			session: null,
			sessionFile,
			status: "parked",
		});
		AgentLifecycleManager.global().adopt("Worker2", { idleTtlMs: 0, revive: async () => revived });

		await agents.prompt("Worker2", "continue from the saved transcript", { deliverAs: "followUp" });

		expect(delivered).toEqual({ text: "continue from the saved transcript", deliverAs: "followUp" });
		expect(registry.get("Worker2")?.status).toBe("idle");
	});
});
