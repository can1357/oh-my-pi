/**
 * Tests for the ACP permission gate in AgentSession.
 *
 * Verifies that tools with a real ACP approval policy (bash/delete/move) are gated behind
 * `ClientBridge.requestPermission`, while regular file-editing tools keep the same no-approval
 * behavior they have in the TUI.
 */
import { afterAll, afterEach, beforeAll, expect, it, spyOn } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { Extension, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type {
	ClientBridge,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { dispatchXdevTool, resolveMountedXdevExecutable, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let tempDir: TempDir;
let session: AgentSession | undefined;

const boundaryCases: Array<[decision: "allow_always" | "reject_always", transition: "new" | "switch"]> = [
	["allow_always", "new"],
	["allow_always", "switch"],
	["reject_always", "new"],
	["reject_always", "switch"],
];
/** Fake tool that records execute calls. */
function makeFakeTool(name: string): AgentTool & { executeCalls: number } {
	const tool = {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({ "command?": "string" }),
		executeCalls: 0,
		async execute() {
			tool.executeCalls++;
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	return tool;
}

function makeToolSession(bridge: ClientBridge): ToolSession {
	return {
		cwd: tempDir.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "apply_patch" }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
		getClientBridge: () => bridge,
	} as unknown as ToolSession;
}

/** Build a minimal ClientBridge whose requestPermission resolves to the given outcome. */
function makeBridge(outcome: ClientBridgePermissionOutcome): ClientBridge {
	return {
		capabilities: { requestPermission: true },
		async requestPermission(_toolCall, _options, _signal) {
			return outcome;
		},
	};
}

async function createSession(
	tools: AgentTool[],
	bridge?: ClientBridge,
	settingsOverrides: Partial<Record<SettingPath, unknown>> = {},
	options?: {
		xdev?: XdevState;
		builtInToolNames?: string[];
		persist?: boolean;
		extension?: { runtime: ExtensionRuntime; value: Extension };
	},
): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	const settings = Settings.isolated({ "compaction.enabled": false, ...settingsOverrides });
	const sessionManager = options?.persist
		? SessionManager.create(tempDir.path(), `${tempDir.path()}/sessions`)
		: SessionManager.inMemory(tempDir.path());
	const modelRegistry = {} as never;
	const extensionRunner = options?.extension
		? new ExtensionRunner(
				[options.extension.value],
				options.extension.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
				undefined,
				settings,
			)
		: undefined;
	const runtimeTools = extensionRunner ? tools.map(tool => new ExtensionToolWrapper(tool, extensionRunner)) : tools;

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: runtimeTools,
			messages: [],
		},
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});

	const toolRegistry = options?.xdev?.tools ?? new Map<string, AgentTool>();
	for (const tool of runtimeTools) toolRegistry.set(tool.name, tool);
	const sess = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry,
		xdev: options?.xdev,
		builtInToolNames: options?.builtInToolNames,
		extensionRunner,
	});

	if (bridge) sess.setClientBridge(bridge);
	return sess;
}

function initializeExtensionApprovalUI(runner: ExtensionRunner, select: ExtensionUIContext["select"]): void {
	runner.initialize(
		{
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			getSessionName: () => undefined,
			setSessionName: async () => {},
		} as never,
		{
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => [],
		} as never,
		undefined,
		{ select, notify: () => {} } as never,
	);
}

async function createSessionWithMockModel(
	tools: AgentTool[],
	bridge: ClientBridge,
	responses: NonNullable<MockModelOptions["responses"]>,
): Promise<AgentSession> {
	const mock = createMockModel({ responses });
	const settings = Settings.isolated({ "compaction.enabled": false });
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock.model,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});

	const sess = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: { getApiKey: () => "test-key" } as never,
		toolRegistry: new Map(tools.map(t => [t.name, t])),
	});
	sess.setClientBridge(bridge);
	return sess;
}

beforeAll(() => {
	tempDir = TempDir.createSync("@pi-acp-permission-test-");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
});

afterAll(async () => {
	await tempDir.remove();
});

// ---------------------------------------------------------------------------
// 1. Allow once: bridge called once, underlying execute called once
// ---------------------------------------------------------------------------

it("allow_once: calls bridge once and executes the underlying tool", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	// Get the wrapped tool from the agent's active set.
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");

	await wrappedBash!.execute("call-1", { command: "echo hi" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(1);
});

it("extension denial runs before an ACP permission request", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("tool_authorization", () => ({ decision: "deny", reason: "Blocked before ACP permission" }));
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"acp-final-authorization-order",
	);
	session = await createSession([bashTool], bridge, {}, { extension: { runtime, value: extension } });

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(tool => tool.name === "bash");

	await expect(
		wrappedBash!.execute(
			"call-extension-deny",
			{ command: "echo hi" },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow("Blocked before ACP permission");
	expect(permissionSpy).not.toHaveBeenCalled();
	expect(bashTool.executeCalls).toBe(0);
});

it("extension ask uses one ACP permission request without form elicitation", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("tool_authorization", () => ({ decision: "ask", reason: "Confirm protected command" }));
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"acp-final-authorization-approval",
	);
	session = await createSession([bashTool], bridge, {}, { extension: { runtime, value: extension } });

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(tool => tool.name === "bash");
	await wrappedBash!.execute(
		"call-extension-approve",
		{ command: "echo hi" },
		undefined,
		undefined as never,
		{ hasUI: false } as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(1);
});

it("combined native and extension asks use one ACP permission request", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("tool_authorization", () => ({ decision: "ask", reason: "Confirm protected command" }));
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"acp-final-authorization-combined-approval",
	);
	session = await createSession(
		[bashTool],
		bridge,
		{ "tools.approvalMode": "write" },
		{ extension: { runtime, value: extension } },
	);

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(tool => tool.name === "bash");
	await wrappedBash!.execute(
		"call-combined-approval",
		{ command: "echo hi" },
		undefined,
		undefined as never,
		{ hasUI: false } as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(1);
});

it("extension ask emits approval lifecycle events around deferred ACP permission", async () => {
	const order: string[] = [];
	const approvalEvents: Array<Record<string, unknown>> = [];
	const bashTool = makeFakeTool("bash");
	bashTool.execute = async () => {
		order.push("execute");
		bashTool.executeCalls++;
		return { content: [{ type: "text" as const, text: "ok" }] };
	};
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission() {
			order.push("requestPermission");
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("tool_authorization", () => ({ decision: "ask", reason: "Confirm protected command" }));
			pi.on("tool_approval_requested", event => {
				order.push("requested");
				approvalEvents.push({
					type: event.type,
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					reason: event.reason,
					approvalMode: event.approvalMode,
				});
			});
			pi.on("tool_approval_resolved", event => {
				order.push("resolved");
				approvalEvents.push({
					type: event.type,
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					approved: event.approved,
					reason: event.reason,
				});
			});
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"acp-final-authorization-lifecycle",
	);
	session = await createSession([bashTool], bridge, {}, { extension: { runtime, value: extension } });

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(tool => tool.name === "bash");
	await wrappedBash!.execute(
		"call-extension-lifecycle",
		{ command: "echo hi" },
		undefined,
		undefined as never,
		{ hasUI: false } as never,
	);

	expect(order).toEqual(["requested", "requestPermission", "resolved", "execute"]);
	expect(approvalEvents).toEqual([
		{
			type: "tool_approval_requested",
			toolName: "bash",
			toolCallId: "call-extension-lifecycle",
			reason: "Confirm protected command",
			approvalMode: "yolo",
		},
		{
			type: "tool_approval_resolved",
			toolName: "bash",
			toolCallId: "call-extension-lifecycle",
			approved: true,
			reason: undefined,
		},
	]);
});

it("extension ask includes its bounded reason in the ACP permission request", async () => {
	const bashTool = makeFakeTool("bash");
	const permissionRequests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			permissionRequests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("tool_authorization", () => ({
				decision: "ask",
				reason: `Protected\tcommand\n${"界".repeat(200)}`,
			}));
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"acp-final-authorization-reason",
	);
	session = await createSession([bashTool], bridge, {}, { extension: { runtime, value: extension } });

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(tool => tool.name === "bash");
	await wrappedBash!.execute(
		"call-extension-reason",
		{ command: "echo hi" },
		undefined,
		undefined as never,
		{ hasUI: false } as never,
	);

	const content = permissionRequests[0]?.content as
		| Array<{ type: string; content?: { type: string; text?: string } }>
		| undefined;
	const reason = content?.find(item => item.content?.text?.startsWith("Protected"))?.content?.text;
	expect(reason).toContain("Protected command");
	expect(reason).not.toContain("\t");
	expect(reason).not.toContain("\n");
	expect(reason).toContain("…");
	expect(Bun.stringWidth(reason ?? "")).toBeLessThanOrEqual(TRUNCATE_LENGTHS.CONTENT);
});

it("explicit yolo skips routine ACP prompts but preserves extension asks", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	const runtime = new ExtensionRuntime();
	let authorizationCalls = 0;
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("tool_authorization", () => {
				authorizationCalls++;
				return authorizationCalls === 1
					? { decision: "allow" }
					: { decision: "ask", reason: "Confirm protected command" };
			});
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"acp-final-authorization-yolo-fallback",
	);
	session = await createSession(
		[bashTool],
		bridge,
		{ "tools.approvalMode": "yolo" },
		{ extension: { runtime, value: extension } },
	);

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(tool => tool.name === "bash");
	await wrappedBash!.execute(
		"call-yolo-allow",
		{ command: "echo first" },
		undefined,
		undefined as never,
		{ hasUI: false } as never,
	);
	await wrappedBash!.execute(
		"call-yolo-extension-ask",
		{ command: "echo second" },
		undefined,
		undefined as never,
		{ hasUI: false } as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(2);
});

it("extension ask requires fresh ACP permission after a persisted allow", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_always", kind: "allow_always" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	const runtime = new ExtensionRuntime();
	let authorizationCalls = 0;
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("tool_authorization", () => {
				authorizationCalls++;
				return authorizationCalls === 1
					? { decision: "allow" }
					: { decision: "ask", reason: "Confirm protected command again" };
			});
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"acp-final-authorization-fresh-approval",
	);
	session = await createSession([bashTool], bridge, {}, { extension: { runtime, value: extension } });

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(tool => tool.name === "bash");
	await wrappedBash!.execute(
		"call-persist-allow",
		{ command: "echo first" },
		undefined,
		undefined as never,
		{ hasUI: false } as never,
	);
	await wrappedBash!.execute(
		"call-extension-ask-after-allow",
		{ command: "echo second" },
		undefined,
		undefined as never,
		{ hasUI: false } as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(2);
	expect(bashTool.executeCalls).toBe(2);
});

it("extension approval with form elicitation avoids a second ACP permission request", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("tool_authorization", () => ({ decision: "ask", reason: "Confirm protected command" }));
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"acp-final-authorization-form-approval",
	);
	session = await createSession([bashTool], bridge, {}, { extension: { runtime, value: extension } });
	let selectCalls = 0;
	const select: ExtensionUIContext["select"] = async () => {
		selectCalls++;
		return "Approve";
	};
	if (!session.extensionRunner) throw new Error("expected extension runner");
	initializeExtensionApprovalUI(session.extensionRunner, select);

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(tool => tool.name === "bash");
	await wrappedBash!.execute(
		"call-extension-form-approve",
		{ command: "echo hi" },
		undefined,
		undefined as never,
		{ hasUI: true } as never,
	);

	expect(selectCalls).toBe(1);
	expect(permissionSpy).not.toHaveBeenCalled();
	expect(bashTool.executeCalls).toBe(1);
});

it("extension approval does not approve a nested tool that reuses the call ID", async () => {
	const deleteTool = makeFakeTool("delete");
	deleteTool.loadMode = "discoverable";
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("tool_authorization", event =>
				event.toolName === "write" ? { decision: "ask", reason: "Confirm outer write" } : { decision: "allow" },
			);
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"acp-final-authorization-tool-scope",
	);
	let writeExecuteCalls = 0;
	const writeTool: AgentTool = {
		name: "write",
		label: "write",
		description: "Fake write",
		parameters: type({}),
		async execute(toolCallId) {
			writeExecuteCalls++;
			const dispatched = await dispatchXdevTool(
				xdev,
				"delete",
				JSON.stringify({ path: "/tmp/gone.ts" }),
				toolCallId,
			);
			return dispatched.result;
		},
	};
	const tools = new Map([writeTool, deleteTool].map(tool => [tool.name, tool]));
	const xdev: XdevState = {
		tools,
		mountedNames: new Set(["delete"]),
		builtInNames: new Set(["write"]),
		isActive: name => name === "write",
	};
	session = await createSession(
		[writeTool, deleteTool],
		bridge,
		{},
		{ xdev, builtInToolNames: ["write"], extension: { runtime, value: extension } },
	);
	let selectCalls = 0;
	if (!session.extensionRunner) throw new Error("expected extension runner");
	initializeExtensionApprovalUI(session.extensionRunner, async () => {
		selectCalls++;
		return "Approve";
	});

	const wrappedWrite = session.agent.state.tools.find(tool => tool.name === "write");
	await wrappedWrite!.execute(
		"call-reused-acp-id",
		{ path: "/tmp/outer.ts" },
		undefined,
		undefined as never,
		{ hasUI: true } as never,
	);

	expect({
		selectCalls,
		permissionCalls: permissionSpy.mock.calls.length,
		writeExecuteCalls,
		deleteExecuteCalls: deleteTool.executeCalls,
	}).toEqual({ selectCalls: 1, permissionCalls: 1, writeExecuteCalls: 1, deleteExecuteCalls: 1 });
});

it("extension ask without form elicitation does not bypass ordinary edit calls", async () => {
	const editTool = makeFakeTool("edit");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("tool_authorization", () => ({ decision: "ask", reason: "Confirm ordinary edit" }));
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"acp-final-authorization-edit-no-form",
	);
	session = await createSession([editTool], bridge, {}, { extension: { runtime, value: extension } });

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(tool => tool.name === "edit");
	await expect(
		wrappedEdit!.execute(
			"call-extension-edit-no-form",
			{ command: "" },
			undefined,
			undefined as never,
			{ hasUI: false } as never,
		),
	).rejects.toThrow("requires approval from an extension but no interactive UI is available");

	expect(permissionSpy).not.toHaveBeenCalled();
	expect(editTool.executeCalls).toBe(0);
});

it("persisted ACP rejection overrides later extension approval", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_always", kind: "reject_always" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	const runtime = new ExtensionRuntime();
	let authorizationCalls = 0;
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("tool_authorization", () => {
				authorizationCalls++;
				return authorizationCalls === 1
					? { decision: "allow" }
					: { decision: "ask", reason: "Confirm protected command" };
			});
		},
		tempDir.path(),
		new EventBus(),
		runtime,
		"acp-final-authorization-persisted-rejection",
	);
	session = await createSession([bashTool], bridge, {}, { extension: { runtime, value: extension } });

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(tool => tool.name === "bash");
	await expect(
		wrappedBash!.execute(
			"call-persist-reject",
			{ command: "echo hi" },
			undefined,
			undefined as never,
			{ hasUI: false } as never,
		),
	).rejects.toThrow("Tool call rejected by user (bash)");
	await expect(
		wrappedBash!.execute(
			"call-still-rejected",
			{ command: "echo hi" },
			undefined,
			undefined as never,
			{ hasUI: false } as never,
		),
	).rejects.toThrow("Tool call rejected by user (preference)");

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(0);
});

it("eval bridge dispatch uses the same ACP gate as a direct tool call", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	const bridgedBash = session.getToolForEvalBridge("bash");
	await bridgedBash!.execute("call-bridge", { command: "echo hi" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(1);
});

it("explicit yolo approval mode skips the ACP permission gate", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([bashTool], bridge, { "tools.approvalMode": "yolo" });

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");

	await wrappedBash!.execute("call-1", { command: "echo hi" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).not.toHaveBeenCalled();
	expect(bashTool.executeCalls).toBe(1);
});

it("explicit yolo still gates tools whose per-tool policy requires a prompt", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([bashTool], bridge, {
		"tools.approvalMode": "yolo",
		"tools.approval": { bash: "prompt" },
	});

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");

	await wrappedBash!.execute("call-1", { command: "echo hi" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(1);
});

it("delete and move tools request ACP permission before executing", async () => {
	const deleteTool = makeFakeTool("delete");
	const moveTool = makeFakeTool("move");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([deleteTool, moveTool], bridge);

	await session.setActiveToolsByName(["delete", "move"]);
	const wrappedDelete = session.agent.state.tools.find(t => t.name === "delete");
	const wrappedMove = session.agent.state.tools.find(t => t.name === "move");

	await wrappedDelete!.execute(
		"call-delete",
		{ path: "/tmp/gone.ts" },
		undefined,
		undefined as never,
		undefined as never,
	);
	await wrappedMove!.execute(
		"call-move",
		{ oldPath: "/tmp/old.ts", newPath: "/tmp/new.ts" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests.map(({ toolName, title, locations }) => ({ toolName, title, locations }))).toEqual([
		{ toolName: "delete", title: "Delete /tmp/gone.ts", locations: [{ path: "/tmp/gone.ts" }] },
		{
			toolName: "move",
			title: "Move /tmp/old.ts to /tmp/new.ts",
			locations: [{ path: "/tmp/old.ts" }, { path: "/tmp/new.ts" }],
		},
	]);
	expect(deleteTool.executeCalls).toBe(1);
	expect(moveTool.executeCalls).toBe(1);
});

it("top-level fallback preserves ACP permission for mounted destructive tools", async () => {
	const readTool = makeFakeTool("read");
	const writeTool = makeFakeTool("write");
	const deleteTool = makeFakeTool("delete");
	deleteTool.loadMode = "discoverable";
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	const tools = new Map([readTool, writeTool].map(tool => [tool.name, tool]));
	const xdev: XdevState = {
		tools,
		mountedNames: new Set(),
		builtInNames: new Set(["read", "write"]),
		isActive: name => name === "read" || name === "write",
	};
	session = await createSession([readTool, writeTool], bridge, {}, { xdev, builtInToolNames: ["read", "write"] });

	await session.refreshRpcHostTools([deleteTool]);
	expect(xdev.mountedNames.has("delete")).toBe(true);
	expect(session.getActiveToolNames()).not.toContain("delete");
	const fallbackTool = resolveMountedXdevExecutable(xdev, "delete");
	await fallbackTool!.execute(
		"call-mounted-delete",
		{ path: "/tmp/gone.ts" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(deleteTool.executeCalls).toBe(1);
});

it("startup-mounted destructive tools gain the ACP permission gate when the bridge attaches", async () => {
	const readTool = makeFakeTool("read");
	const writeTool = makeFakeTool("write");
	const deleteTool = makeFakeTool("delete");
	deleteTool.loadMode = "discoverable";
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	const tools = new Map([readTool, writeTool, deleteTool].map(tool => [tool.name, tool]));
	const xdev: XdevState = {
		tools,
		mountedNames: new Set(["delete"]),
		builtInNames: new Set(["read", "write"]),
		isActive: name => name === "read" || name === "write",
	};
	session = await createSession(
		[readTool, writeTool, deleteTool],
		bridge,
		{},
		{ xdev, builtInToolNames: ["read", "write"] },
	);

	await dispatchXdevTool(xdev, "delete", JSON.stringify({ path: "/tmp/gone.ts" }), "call-startup-delete");

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(deleteTool.executeCalls).toBe(1);
});
it("edit, write, and ast_edit do not request ACP permission", async () => {
	const editTool = makeFakeTool("edit");
	const writeTool = makeFakeTool("write");
	const astEditTool = makeFakeTool("ast_edit");
	const bridge = makeBridge({ outcome: "cancelled" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([editTool, writeTool, astEditTool], bridge);

	await session.setActiveToolsByName(["edit", "write", "ast_edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");
	const wrappedWrite = session.agent.state.tools.find(t => t.name === "write");
	const wrappedAstEdit = session.agent.state.tools.find(t => t.name === "ast_edit");

	await wrappedEdit!.execute("call-edit", { path: "/tmp/foo.ts" }, undefined, undefined as never, undefined as never);
	await wrappedWrite!.execute(
		"call-write",
		{ path: "/tmp/foo.ts" },
		undefined,
		undefined as never,
		undefined as never,
	);
	await wrappedAstEdit!.execute(
		"call-ast",
		{ paths: ["/tmp/foo.ts"] },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(0);
	expect(editTool.executeCalls).toBe(1);
	expect(writeTool.executeCalls).toBe(1);
	expect(astEditTool.executeCalls).toBe(1);
});

it("edit delete and move operations request ACP permission before executing", async () => {
	const editTool = makeFakeTool("edit");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");

	await wrappedEdit!.execute(
		"call-edit-delete",
		{ path: "/tmp/gone.ts", edits: [{ op: "delete" }] },
		undefined,
		undefined as never,
		undefined as never,
	);
	await wrappedEdit!.execute(
		"call-edit-move",
		{ path: "/tmp/old.ts", edits: [{ op: "update", rename: "/tmp/new.ts" }] },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests.map(({ title, locations }) => ({ title, locations }))).toEqual([
		{ title: "Delete /tmp/gone.ts", locations: [{ path: "/tmp/gone.ts" }] },
		{ title: "Move /tmp/old.ts to /tmp/new.ts", locations: [{ path: "/tmp/old.ts" }, { path: "/tmp/new.ts" }] },
	]);
	expect(editTool.executeCalls).toBe(2);
});

it("edit delete operations take precedence over stale rename metadata", async () => {
	const editTool = makeFakeTool("edit");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");

	await wrappedEdit!.execute(
		"call-edit-delete-with-rename",
		{ path: "/tmp/gone.ts", edits: [{ op: "delete", rename: "/tmp/stale.ts" }] },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests.map(({ title, locations }) => ({ title, locations }))).toEqual([
		{ title: "Delete /tmp/gone.ts", locations: [{ path: "/tmp/gone.ts" }] },
	]);
	expect(editTool.executeCalls).toBe(1);
});

it("apply_patch delete operations take precedence over earlier moves", async () => {
	const editTool = makeFakeTool("edit");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");

	await wrappedEdit!.execute(
		"call-apply-patch-delete-after-move",
		{
			input: [
				"*** Begin Patch",
				"*** Update File: /tmp/old.ts",
				"*** Move to: /tmp/new.ts",
				"@@",
				"-old",
				"+new",
				"*** Delete File: /tmp/gone.ts",
				"*** End Patch",
			].join("\n"),
		},
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests.map(({ title, locations }) => ({ title, locations }))).toEqual([
		{ title: "Delete /tmp/gone.ts", locations: [{ path: "/tmp/gone.ts" }] },
	]);
	expect(editTool.executeCalls).toBe(1);
});

it("apply_patch custom-wire delete requests ACP permission through agent dispatch", async () => {
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	const editTool = new EditTool(makeToolSession(bridge));
	session = await createSessionWithMockModel([editTool as AgentTool], bridge, [
		{
			content: [
				{
					type: "toolCall",
					id: "call-custom-apply-patch",
					name: "apply_patch",
					arguments: {
						input: ["*** Begin Patch", "*** Delete File: /tmp/gone.ts", "*** End Patch"].join("\n"),
					},
				},
			],
		},
		{ content: ["done"] },
	]);

	await session.prompt("delete with custom apply_patch");

	expect(requests.map(({ toolCallId, title, locations }) => ({ toolCallId, title, locations }))).toEqual([
		{
			toolCallId: "call-custom-apply-patch",
			title: "Delete /tmp/gone.ts",
			locations: [{ path: "/tmp/gone.ts" }],
		},
	]);
});

it("patch-mode delete operations take precedence over earlier moves", async () => {
	const editTool = makeFakeTool("edit");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");

	await wrappedEdit!.execute(
		"call-patch-delete-after-move",
		{
			path: "/tmp/old.ts",
			edits: [{ op: "update", rename: "/tmp/new.ts" }, { op: "delete" }],
		},
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests.map(({ title, locations }) => ({ title, locations }))).toEqual([
		{ title: "Delete /tmp/old.ts", locations: [{ path: "/tmp/old.ts" }] },
	]);
	expect(editTool.executeCalls).toBe(1);
});

it("always-allowing edit moves does not bypass patch-mode calls that also delete", async () => {
	const editTool = makeFakeTool("edit");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_always", kind: "allow_always" };
		},
	};
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");

	await wrappedEdit!.execute(
		"call-edit-move",
		{ path: "/tmp/old.ts", edits: [{ op: "update", rename: "/tmp/new.ts" }] },
		undefined,
		undefined as never,
		undefined as never,
	);
	await wrappedEdit!.execute(
		"call-patch-delete-after-move",
		{
			path: "/tmp/another-old.ts",
			edits: [{ op: "update", rename: "/tmp/another-new.ts" }, { op: "delete" }],
		},
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests.map(({ title }) => title)).toEqual([
		"Move /tmp/old.ts to /tmp/new.ts",
		"Delete /tmp/another-old.ts",
	]);
	expect(editTool.executeCalls).toBe(2);
});

it("permission requests report the gated tool call as pending", async () => {
	const bashTool = makeFakeTool("bash");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");

	await wrappedBash!.execute("call-bash", { command: "echo hi" }, undefined, undefined as never, undefined as never);

	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		toolCallId: "call-bash",
		toolName: "bash",
		status: "pending",
	});
	expect(bashTool.executeCalls).toBe(1);
});

it("bash permission requests include execute metadata and command content", async () => {
	const bashTool = makeFakeTool("bash");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");

	await wrappedBash!.execute(
		"call-bash-rich",
		{ command: "git status --short" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		toolCallId: "call-bash-rich",
		toolName: "bash",
		title: "git status --short",
		kind: "execute",
		status: "pending",
		rawInput: { command: "git status --short" },
		content: [{ type: "content", content: { type: "text", text: "$ git status --short" } }],
	});
	expect(bashTool.executeCalls).toBe(1);
});

it("ordinary edit calls still bypass ACP permission after rejecting edit moves forever", async () => {
	const editTool = makeFakeTool("edit");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_always", kind: "reject_always" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");

	await expect(
		wrappedEdit!.execute(
			"call-edit-move",
			{ path: "/tmp/old.ts", edits: [{ op: "update", rename: "/tmp/new.ts" }] },
			undefined,
			undefined as never,
			undefined as never,
		),
	).rejects.toThrow(/rejected by user/);
	await wrappedEdit!.execute(
		"call-edit-update",
		{ path: "/tmp/foo.ts" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(editTool.executeCalls).toBe(1);
});

it("edit create operations with rename metadata do not request ACP move permission", async () => {
	const editTool = makeFakeTool("edit");
	const bridge = makeBridge({ outcome: "cancelled" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");

	await wrappedEdit!.execute(
		"call-edit-create",
		{ path: "/tmp/new.ts", edits: [{ op: "create", rename: "/tmp/ignored.ts", diff: "export {};" }] },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(0);
	expect(editTool.executeCalls).toBe(1);
});

it("always-allowing edit moves does not bypass later edit delete permission", async () => {
	const editTool = makeFakeTool("edit");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_always", kind: "allow_always" };
		},
	};
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");

	await wrappedEdit!.execute(
		"call-edit-move",
		{ path: "/tmp/old.ts", edits: [{ op: "update", rename: "/tmp/new.ts" }] },
		undefined,
		undefined as never,
		undefined as never,
	);
	await wrappedEdit!.execute(
		"call-edit-delete",
		{ path: "/tmp/gone.ts", edits: [{ op: "delete" }] },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(requests.map(({ title }) => title)).toEqual(["Move /tmp/old.ts to /tmp/new.ts", "Delete /tmp/gone.ts"]);
	expect(editTool.executeCalls).toBe(2);
});

it("setClientBridge wraps tools that were already active", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([bashTool]);

	session.setClientBridge(bridge);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");

	await wrappedBash!.execute("call-1", { command: "echo hi" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(1);
});

it("aborting an open permission request rejects without executing the tool", async () => {
	const bashTool = makeFakeTool("bash");
	const pending = Promise.withResolvers<ClientBridgePermissionOutcome>();
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		requestPermission: async () => pending.promise,
	};
	session = await createSession([bashTool], bridge);
	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");

	const abortController = new AbortController();
	const execution = wrappedBash!.execute(
		"call-1",
		{ command: "echo hi" },
		abortController.signal,
		undefined as never,
		undefined as never,
	);
	abortController.abort();

	await expect(execution).rejects.toThrow(/Permission request cancelled/);
	expect(bashTool.executeCalls).toBe(0);
	pending.resolve({ outcome: "cancelled" });
});

// ---------------------------------------------------------------------------
// 2. Reject once: throws, underlying execute never called
// ---------------------------------------------------------------------------

it("reject_once: throws ToolError and never calls underlying execute", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");

	await expect(
		wrappedBash!.execute("call-1", { command: "echo hi" }, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/rejected by user/);

	expect(bashTool.executeCalls).toBe(0);
});

it("unknown selected permission option ID fails closed without executing", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_typo" });
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");

	await expect(
		wrappedBash!.execute("call-unknown", { command: "echo hi" }, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/unknown option ID/);
	expect(bashTool.executeCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// 3. Always allow caches: bridge called exactly once across two executions
// ---------------------------------------------------------------------------

it("allow_always: caches decision and calls bridge only once for subsequent executes", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_always", kind: "allow_always" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");

	// First call — bridge is consulted, decision cached.
	await wrappedBash!.execute("call-1", { command: "echo a" }, undefined, undefined as never, undefined as never);
	// Second call — must skip the bridge entirely.
	await wrappedBash!.execute("call-2", { command: "echo b" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(2);
});

it.each(boundaryCases)(
	"%s permission decisions prompt again after a successful %s session boundary",
	async (decision, transition) => {
		const bashTool = makeFakeTool("bash");
		const bridge = makeBridge({ outcome: "selected", optionId: decision, kind: decision });
		const permissionSpy = spyOn(bridge, "requestPermission");
		session = await createSession([bashTool], bridge, {}, { persist: true });

		await session.setActiveToolsByName(["bash"]);
		const wrappedBash = session.agent.state.tools.find(tool => tool.name === "bash");
		if (!wrappedBash) throw new Error("Expected wrapped bash tool");

		for (let callIndex = 0; callIndex < 2; callIndex++) {
			if (callIndex === 1) {
				if (transition === "new") {
					expect(await session.newSession()).toBe(true);
				} else {
					const targetId = `permission-target-${Bun.nanoseconds()}`;
					const targetPath = `${tempDir.path()}/${targetId}.jsonl`;
					await Bun.write(
						targetPath,
						`${JSON.stringify({
							type: "session",
							version: 3,
							id: targetId,
							timestamp: new Date().toISOString(),
							cwd: tempDir.path(),
						})}\n`,
					);
					expect(await session.switchSession(targetPath)).toBe(true);
				}
			}

			const execution = wrappedBash.execute(
				`call-${callIndex}`,
				{ command: "echo boundary" },
				undefined,
				undefined as never,
				undefined as never,
			);
			if (decision === "reject_always") {
				await expect(execution).rejects.toThrow(/rejected by user/);
			} else {
				await execution;
			}
		}

		expect(permissionSpy).toHaveBeenCalledTimes(2);
		expect(bashTool.executeCalls).toBe(decision === "allow_always" ? 2 : 0);
	},
);

// ---------------------------------------------------------------------------
// 4. Read tool not gated: bridge never called even when bridge is set
// ---------------------------------------------------------------------------

it("read tool: requestPermission is never called for non-gated tools", async () => {
	const readTool = makeFakeTool("read");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([readTool], bridge);

	await session.setActiveToolsByName(["read"]);
	const wrappedRead = session.agent.state.tools.find(t => t.name === "read");

	await wrappedRead!.execute("call-1", {}, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(0);
	expect(readTool.executeCalls).toBe(1);
});

it("setActiveToolsByName normalizes legacy tool names", async () => {
	const grepTool = makeFakeTool("grep");
	const globTool = makeFakeTool("glob");
	session = await createSession([grepTool, globTool]);

	await session.setActiveToolsByName(["Search", "find", "grep"]);

	expect(session.getActiveToolNames()).toEqual(["grep", "glob"]);
});
