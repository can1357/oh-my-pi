import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LoadExtensionsResult } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions/types";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import type { ClientBridge } from "@pk-nerdsaver-ai/pi-coding-agent/session/client-bridge";
import { createPersistedSubagentReviverFactory } from "@pk-nerdsaver-ai/pi-coding-agent/task/persisted-revive";
import { EventBus } from "@pk-nerdsaver-ai/pi-coding-agent/utils/event-bus";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";

function mockSession(): AgentSession {
	return {
		sessionManager: { getArtifactManager: () => undefined },
		setActiveToolsByName: async () => {},
		setCollaborationPolicy: () => {},
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

describe("persisted Fusion sidekick revive", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
	});

	it("restores the persisted sidekick request budget on cold revive", async () => {
		const dir = await fs.mkdtemp(path.join(process.cwd(), "tmp-persisted-revive-"));
		try {
			const sessionFile = path.join(dir, "Sidekick.jsonl");
			await Bun.write(
				sessionFile,
				[
					JSON.stringify({ type: "session", id: "parent", timestamp: new Date().toISOString(), cwd: dir }),
					JSON.stringify({
						type: "session_init",
						id: "init",
						parentId: null,
						timestamp: new Date().toISOString(),
						systemPrompt: "system",
						task: "task",
						tools: ["yield"],
						fusionSidekick: true,
						maxModelRequestsPerRun: 4,
					}),
				].join("\n"),
			);
			const session = mockSession();
			const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
				session,
				extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			});
			const clientBridge: ClientBridge = {
				capabilities: { requestPermission: true, toolApprovalMode: "always-ask" },
				requestPermission: async () => ({ outcome: "cancelled" }),
			};
			const topSession = {
				sessionManager: {
					getCwd: () => dir,
					getArtifactManager: () => undefined,
				},
				clientBridge,
			} as unknown as AgentSession;
			const reviveFactory = createPersistedSubagentReviverFactory({
				session: topSession,
				authStorage: {} as unknown as AuthStorage,
				modelRegistry: {} as unknown as ModelRegistry,
				settings: Settings.isolated(),
				enableLsp: false,
			});
			const reviver = await reviveFactory({
				id: "Sidekick",
				kind: "agent",
				status: "parked",
				displayName: "Sidekick",
				sessionFile,
				parentId: "Main",
			} as never);

			expect(reviver).toBeDefined();
			await reviver?.();
			const options = spy.mock.calls[0]?.[0];
			expect(options).toBeDefined();
			expect(options?.maxModelRequestsPerRun).toBe(4);
			expect(options?.clientBridge).toBe(clientBridge);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
