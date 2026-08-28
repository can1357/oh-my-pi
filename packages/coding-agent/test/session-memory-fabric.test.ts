import { describe, expect, it } from "bun:test";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MemoryBackendStartOptions } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { SessionMemory, type SessionMemoryHost } from "@oh-my-pi/pi-coding-agent/session/session-memory";

/**
 * A structural host. `SessionMemoryHost` is a plain interface, and with no
 * `memoryAgentDir` supplied the backend-start path is skipped entirely, so
 * none of the heavy members are exercised — only `agent.sessionId` is read.
 */
function createHost(overrides: Partial<SessionMemoryHost> = {}): SessionMemoryHost {
	return {
		agent: { sessionId: "session-1" } as unknown as Agent,
		settings: Settings.isolated({ "memory.backend": "off" }),
		modelRegistry: {} as unknown as ModelRegistry,
		isDisposed: () => false,
		memoryBackendSession: () => ({}) as MemoryBackendStartOptions["session"],
		getHindsightSessionState: () => undefined,
		setHindsightSessionState: () => {},
		getMnemopiSessionState: () => undefined,
		takeMnemopiSessionState: () => undefined,
		setBaseSystemPrompt: () => {},
		refreshBaseSystemPrompt: async () => {},
		replaceMemoryTools: async () => {},
		...overrides,
	};
}

describe("SessionMemory — Memory Fabric wiring", () => {
	it("constructs nothing when the stage is off", async () => {
		const memory = new SessionMemory(createHost(), { memoryFabricStage: "off" });
		await memory.applyMemoryBackend();
		expect(memory.memoryFabric).toBeNull();
	});

	it("is off when the injected environment has no flag", async () => {
		const memory = new SessionMemory(createHost(), { memoryFabricEnv: {} });
		await memory.applyMemoryBackend();
		expect(memory.memoryFabric).toBeNull();
	});

	it("is off for an unrecognised flag value", async () => {
		const memory = new SessionMemory(createHost(), {
			memoryFabricEnv: { OMP_MEMORY_FABRIC: "aggressive" },
		});
		await memory.applyMemoryBackend();
		expect(memory.memoryFabric).toBeNull();
	});

	it("activates an observe-stage runtime through the environment path", async () => {
		const memory = new SessionMemory(createHost(), {
			memoryFabricEnv: { OMP_MEMORY_FABRIC: "observe" },
		});
		await memory.applyMemoryBackend();
		expect(memory.memoryFabric).not.toBeNull();
		expect(memory.memoryFabric?.stage).toBe("observe");
		expect(memory.memoryFabric?.requestedStage).toBe("observe");
		expect(memory.memoryFabric?.downgradeReason).toBeUndefined();
	});

	it("activates through the explicit stage override", async () => {
		const memory = new SessionMemory(createHost(), { memoryFabricStage: "observe" });
		await memory.applyMemoryBackend();
		expect(memory.memoryFabric?.stage).toBe("observe");
	});

	it("downgrades active to observe when no retrieval port exists", async () => {
		const memory = new SessionMemory(createHost(), { memoryFabricStage: "active" });
		await memory.applyMemoryBackend();
		expect(memory.memoryFabric?.stage).toBe("observe");
		expect(memory.memoryFabric?.requestedStage).toBe("active");
		expect(memory.memoryFabric?.downgradeReason).toBeDefined();
	});

	it("replaces the runtime on a backend re-apply", async () => {
		const memory = new SessionMemory(createHost(), { memoryFabricStage: "observe" });
		await memory.applyMemoryBackend();
		const first = memory.memoryFabric;
		expect(first).not.toBeNull();
		await memory.applyMemoryBackend();
		expect(memory.memoryFabric).not.toBeNull();
		expect(memory.memoryFabric).not.toBe(first);
	});

	it("does not activate for a subagent task depth", async () => {
		const memory = new SessionMemory(createHost(), {
			memoryTaskDepth: 1,
			memoryFabricStage: "observe",
		});
		await memory.applyMemoryBackend();
		expect(memory.memoryFabric).toBeNull();
	});

	it("does not activate on a disposed host", async () => {
		const memory = new SessionMemory(createHost({ isDisposed: () => true }), {
			memoryFabricStage: "observe",
		});
		await memory.applyMemoryBackend();
		expect(memory.memoryFabric).toBeNull();
	});

	it("falls back to a generated session id when the agent has none", async () => {
		const memory = new SessionMemory(createHost({ agent: {} as unknown as Agent }), {
			memoryFabricStage: "observe",
		});
		await memory.applyMemoryBackend();
		expect(memory.memoryFabric).not.toBeNull();
	});
});
