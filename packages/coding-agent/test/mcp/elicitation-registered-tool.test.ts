import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { RegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { wrapRegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { customToolToDefinition } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createMockConnection, createMockTransport } from "../mcp-test-utils";

describe("MCP elicitation through a startup-registered tool", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-mcp-elicit-registered-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("asks through the tool call's own form surface after the custom-tool → definition bridge", async () => {
		const calls: Record<string, unknown>[] = [];
		const transport = createMockTransport(
			new Map([
				[
					"tools/call",
					[
						{
							resultType: "input_required",
							inputRequests: {
								q: {
									method: "elicitation/create",
									params: {
										message: "Proceed?",
										requestedSchema: {
											type: "object",
											properties: { ok: { type: "boolean" } },
											required: ["ok"],
										},
									},
								},
							},
						},
						{ content: [{ type: "text", text: "done" }] },
					],
				],
			]),
			(_method, params) => calls.push(params ?? {}),
		);
		const tool = new MCPTool(createMockConnection({ tools: {} }, transport), {
			name: "proceed",
			inputSchema: { type: "object", properties: {} },
		});
		const definition = customToolToDefinition(tool);
		const loaded = await loadExtensions([], tempDir.path());
		// The extension runner itself has no UI: only the tool call can reach the user.
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			tempDir.path(),
			SessionManager.inMemory(tempDir.path()),
			new ModelRegistry(authStorage),
		);
		const adapter = wrapRegisteredTool({ definition, extensionPath: "<sdk>" } as RegisteredTool, runner);
		const forms: string[] = [];
		const ui = {
			formDialog: async (html: string) => {
				forms.push(html);
				return { data: { ok: "true" } };
			},
		} as Partial<ExtensionUIContext> as ExtensionUIContext;

		const result = await adapter.execute("call-1", {}, undefined, undefined, {
			ui,
			hasUI: true,
		} as AgentToolContext);

		expect(forms).toHaveLength(1);
		expect(calls[1]?.inputResponses).toEqual({ q: { action: "accept", content: { ok: true } } });
		expect(result.content).toEqual([{ type: "text", text: "done" }]);
	});
});
