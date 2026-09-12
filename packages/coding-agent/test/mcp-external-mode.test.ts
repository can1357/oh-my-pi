import { describe, expect, test } from "bun:test";
import {
	createConnectedHarnessPair,
	DefaultInProcessHarness,
	EXTERNAL_HARNESS_DISABLED_ERROR,
	ExternalHarnessController,
} from "../src/harness/external-mode";
import { DefaultLocalLLMPort } from "../src/harness/llm-port";
import { OhMyPiMcpServer } from "../src/mcp/server";

describe("mcp-external-mode", () => {
	test("Test 1: ExternalHarnessController default state (isEnabled() is false, authorizeInvocation returns allowed: false)", () => {
		const controller = new ExternalHarnessController();
		expect(controller.isEnabled()).toBe(false);
		expect(controller.enabled).toBe(false);

		const auth = controller.authorizeInvocation("read_file");
		expect(auth.allowed).toBe(false);
		expect(auth.error).toEqual(EXTERNAL_HARNESS_DISABLED_ERROR);
		expect(auth.error?.code).toBe("EXTERNAL_HARNESS_DISABLED");
	});

	test("Test 2: ExternalHarnessController enable() / disable() toggles state dynamically", () => {
		const controller = new ExternalHarnessController();
		expect(controller.isEnabled()).toBe(false);
		expect(controller.config.enabled).toBe(false);

		controller.enable();
		expect(controller.isEnabled()).toBe(true);
		expect(controller.enabled).toBe(true);
		expect(controller.config.enabled).toBe(true);

		controller.disable();
		expect(controller.isEnabled()).toBe(false);
		expect(controller.enabled).toBe(false);
		expect(controller.config.enabled).toBe(false);
	});

	test("Test 3: Tool allowlisting (allowedTools filtering, write permission check, execution permission check)", () => {
		// allowedTools filtering
		const filterController = new ExternalHarnessController({
			enabled: true,
			allowedTools: ["read_file", "custom_tool"],
		});
		expect(filterController.isToolAllowed("read_file")).toBe(true);
		expect(filterController.isToolAllowed("custom_tool")).toBe(true);
		expect(filterController.isToolAllowed("other_tool")).toBe(false);
		expect(filterController.authorizeInvocation("other_tool")).toEqual({
			allowed: false,
			error: {
				code: "PERMISSION_DENIED",
				message: 'Tool "other_tool" is not permitted by external harness policy.',
			},
		});

		// write permission check
		const writeBlockedController = new ExternalHarnessController({
			enabled: true,
			allowedTools: ["write_file", "read_file"],
			allowWrite: false,
		});
		expect(writeBlockedController.checkToolPermission("write_file")).toEqual({
			allowed: false,
			error: {
				code: "PERMISSION_DENIED",
				message: 'Write operations are not permitted by external harness policy for tool "write_file".',
			},
		});
		expect(writeBlockedController.checkToolPermission("read_file").allowed).toBe(true);

		const writeAllowedController = new ExternalHarnessController({
			enabled: true,
			allowedTools: ["write_file"],
			allowWrite: true,
		});
		expect(writeAllowedController.checkToolPermission("write_file").allowed).toBe(true);

		// execution permission check
		const execBlockedController = new ExternalHarnessController({
			enabled: true,
			allowedTools: ["bash", "read_file"],
			allowExecution: false,
		});
		expect(execBlockedController.checkToolPermission("bash")).toEqual({
			allowed: false,
			error: {
				code: "PERMISSION_DENIED",
				message: 'Execution operations are not permitted by external harness policy for tool "bash".',
			},
		});
		expect(execBlockedController.checkToolPermission("read_file").allowed).toBe(true);

		const execAllowedController = new ExternalHarnessController({
			enabled: true,
			allowedTools: ["bash"],
			allowExecution: true,
		});
		expect(execAllowedController.checkToolPermission("bash").allowed).toBe(true);
	});

	test("Test 4: OhMyPiMcpServer integration with externalController (disabled vs enabled)", async () => {
		const harness = new DefaultInProcessHarness("/home/coder/OhMyPi");
		harness.registerTool(
			{
				name: "allowed_tool",
				description: "Permitted tool",
				parameters: { type: "object", properties: {} },
			},
			async (req) => ({
				callId: req.callId,
				toolName: req.toolName,
				content: [{ type: "text", text: "allowed tool response" }],
			}),
		);
		harness.registerTool(
			{
				name: "unauthorized_tool",
				description: "Unauthorized tool",
				parameters: { type: "object", properties: {} },
			},
			async (req) => ({
				callId: req.callId,
				toolName: req.toolName,
				content: [{ type: "text", text: "unauthorized tool response" }],
			}),
		);

		const controller = new ExternalHarnessController({
			enabled: false,
			allowedTools: ["allowed_tool"],
		});
		const server = new OhMyPiMcpServer(harness, { externalController: controller });

		// When disabled: tools/list and tools/call fail with EXTERNAL_HARNESS_DISABLED error
		const disabledListRes = (await server.handleMessage({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
		})) as any;
		expect(disabledListRes.error).toBeDefined();
		expect(disabledListRes.error.code).toBe("EXTERNAL_HARNESS_DISABLED");

		const disabledCallRes = (await server.handleMessage({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "allowed_tool", arguments: {} },
		})) as any;
		expect(disabledCallRes.error).toBeDefined();
		expect(disabledCallRes.error.code).toBe("EXTERNAL_HARNESS_DISABLED");

		// When enabled: tools/list filters tools, tools/call succeeds for authorized, fails for unauthorized
		controller.enable();

		const enabledListRes = (await server.handleMessage({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/list",
		})) as any;
		expect(enabledListRes.error).toBeUndefined();
		expect(enabledListRes.result).toBeDefined();
		expect(enabledListRes.result.tools).toHaveLength(1);
		expect(enabledListRes.result.tools[0].name).toBe("allowed_tool");

		const authCallRes = (await server.handleMessage({
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "allowed_tool", arguments: {} },
		})) as any;
		expect(authCallRes.error).toBeUndefined();
		expect(authCallRes.result).toBeDefined();
		expect(authCallRes.result.content[0].text).toBe("allowed tool response");

		const unauthCallRes = (await server.handleMessage({
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: { name: "unauthorized_tool", arguments: {} },
		})) as any;
		expect(unauthCallRes.error).toBeDefined();
		expect(unauthCallRes.error.code).toBe("PERMISSION_DENIED");
	});

	test("Test 5: createConnectedHarnessPair creates functional pair with default in-process LLM connection", async () => {
		const pair = createConnectedHarnessPair({
			externalConfig: {
				enabled: true,
				allowedTools: ["calc"],
			},
		});

		expect(pair.harness).toBeDefined();
		expect(pair.mcpServer).toBeDefined();
		expect(pair.llmPort).toBeInstanceOf(DefaultLocalLLMPort);
		expect(pair.externalController).toBeInstanceOf(ExternalHarnessController);
		expect(pair.controller).toBe(pair.externalController);
		expect(pair.externalController.isEnabled()).toBe(true);

		// Verify default in-process LLM connection
		expect(pair.llmPort.isConnected()).toBe(true);
		expect(pair.llmPort.getSession()).toBe(pair.harness);

		// Functional dispatch through LLM port
		(pair.harness as DefaultInProcessHarness).registerTool(
			{
				name: "calc",
				description: "Calculator",
				parameters: { type: "object", properties: {} },
			},
			async (req) => ({
				callId: req.callId,
				toolName: req.toolName,
				content: [{ type: "text", text: "42" }],
			}),
		);

		const tools = pair.llmPort.getAvailableTools();
		expect(tools.some((t) => t.name === "calc")).toBe(true);

		const dispatchRes = await pair.llmPort.dispatchToolCall({
			callId: "call_abc",
			toolName: "calc",
			arguments: {},
		});
		expect(dispatchRes.isError).toBeFalsy();
		expect(dispatchRes.content[0].text).toBe("42");

		// Verify externalHook is functional
		expect(pair.externalHook).toBeDefined();
		if (pair.externalHook) {
			const hookRes = await pair.externalHook.invokeTool({
				callId: "call_hook",
				toolName: "calc",
				arguments: {},
			});
			expect(hookRes.isError).toBeFalsy();
			expect(hookRes.content[0].text).toBe("42");

			const hookUnauthorizedRes = await pair.externalHook.invokeTool({
				callId: "call_hook_unauth",
				toolName: "forbidden_tool",
				arguments: {},
			});
			expect(hookUnauthorizedRes.isError).toBe(true);
		}
	});
});
