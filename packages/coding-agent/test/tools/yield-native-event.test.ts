import { describe, expect, it, vi } from "bun:test";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { runSubprocess } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { YieldTool } from "../../src/tools/yield";
import { EventBus } from "../../src/utils/event-bus";

// The current executor consumes live AgentSession events, not a JSONL stdout reader.
// Only SDK construction is replaced; the agent loop, tools, monitor and finalizer are real.
describe("yield through native AgentSession events", () => {
	it("consumes item, batch, multi-label and terminal tool events through runSubprocess", async () => {
		using temp = TempDir.createSync("@omp-yield-native-");
		const cwd = temp.path();
		const auth = await AuthStorage.create(path.join(cwd, "auth.db"));
		try {
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"advisor.enabled": false,
				"todo.enabled": false,
				"task.softRequestBudget": 0,
			});
			const outputSchema = {
				type: "object",
				properties: {
					findings: {
						type: "array",
						items: {
							type: "object",
							properties: { title: { type: "string" }, detail: { type: "string" } },
							required: ["title"],
							additionalProperties: false,
						},
					},
					note: { type: "string" },
					count: { type: "integer" },
				},
				required: ["findings", "note", "count"],
				additionalProperties: false,
			};
			const toolSession: ToolSession = {
				cwd,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "",
				settings,
				outputSchema,
			};
			const yieldTool = new YieldTool(toolSession);
			const mock = createMockModel({
				provider: "openai",
				id: "synthetic-yield-event-model",
				responses: [
					{
						content: [
							{
								type: "toolCall",
								id: "native-item",
								name: "yield",
								arguments: { type: ["findings"], data: { title: "one", detail: null } },
							},
						],
					},
					{
						content: [
							{
								type: "toolCall",
								id: "native-batch",
								name: "yield",
								arguments: { type: ["findings"], data: [{ title: "two" }, { title: "three", detail: null }] },
							},
						],
					},
					{
						content: [
							{
								type: "toolCall",
								id: "native-map",
								name: "yield",
								arguments: { type: ["note", "count"], data: { note: "done", count: 3 } },
							},
						],
					},
					{
						content: [
							{
								type: "toolCall",
								id: "native-terminal",
								name: "yield",
								arguments: { type: "result" },
							},
						],
					},
				],
				handler: () => {
					throw new Error("Synthetic stream continued after terminal yield");
				},
			});
			// Satisfy the real AgentSession auth guard with an in-memory override only.
			auth.keys.setRuntime(mock.model.provider, "synthetic-fixture-key-not-a-real-credential");
			let discoveryRequests = 0;
			const modelRegistry = new ModelRegistry(auth, path.join(cwd, "models.yml"), {
				settings,
				cacheDbPath: path.join(cwd, "models.db"),
				fetch: async () => {
					discoveryRequests++;
					throw new Error("Network disabled in synthetic yield fixture");
				},
			});
			const agent = new Agent({
				getApiKey: () => "synthetic-fixture-key-not-a-real-credential",
				initialState: { model: mock.model, tools: [yieldTool], messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			});
			const id = `YieldShapeLive-${randomUUID()}`;
			const live = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(cwd),
				settings,
				modelRegistry,
				agentId: id,
				memoryEnabled: false,
				disableExtensionDiscovery: true,
				autoApprove: true,
				toolRegistry: new Map([["yield", yieldTool]]),
				builtInToolNames: ["yield"],
			});
			const registry = AgentRegistry.global();
			const ref = registry.register({
				id,
				displayName: id,
				kind: "sub",
				session: live,
				sessionFile: null,
				status: "running",
			});
			const factory = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
				session: live,
				extensionsResult: {} as unknown as LoadExtensionsResult,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} satisfies CreateAgentSessionResult);
			const executed: Array<{ id: string; failed: boolean }> = [];
			const unsubscribe = live.subscribe(event => {
				if (event.type === "tool_execution_end" && event.toolName === "yield") {
					executed.push({ id: event.toolCallId, failed: event.isError });
				}
			});
			try {
				const definition: AgentDefinition = {
					name: "synthetic-yield-event",
					description: "Synthetic yield event fixture",
					systemPrompt: "Synthetic fixture",
					source: "bundled",
					tools: ["yield"],
				};
				const result = await runSubprocess({
					cwd,
					agent: definition,
					task: "synthetic fixture input",
					index: 0,
					id,
					settings,
					modelRegistry,
					outputSchema,
					outputSchemaMode: "strict",
					outputSchemaSource: "caller",
					enableLsp: false,
					enableMCP: false,
					enableIrc: false,
					restrictToolNames: true,
					keepAlive: false,
					maxRuntimeMs: 10_000,
				});
				expect(factory).toHaveBeenCalledTimes(1);
				expect(executed).toEqual([
					{ id: "native-item", failed: false },
					{ id: "native-batch", failed: false },
					{ id: "native-map", failed: false },
					{ id: "native-terminal", failed: false },
				]);
				expect(mock.calls).toHaveLength(4);
				expect(result.extractedToolData?.yield).toHaveLength(4);
				expect(result.exitCode).toBe(0);
				expect(result.structuredOutput?.status).toBe("valid");
				expect(JSON.parse(result.output)).toEqual({
					findings: [{ title: "one" }, { title: "two" }, { title: "three" }],
					note: "done",
					count: 3,
				});
				expect(discoveryRequests).toBe(0);
			} finally {
				unsubscribe();
				factory.mockRestore();
				registry.unregister(id, ref);
				await live.abort();
				await live.dispose();
			}
		} finally {
			auth.close();
		}
	}, 20_000);
});
