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
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type {
	ClientBridge,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { dispatchXdevTool, resolveMountedXdevExecutable, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
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
	},
): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	const settings = Settings.isolated({ "compaction.enabled": false, ...settingsOverrides });
	const sessionManager = options?.persist
		? SessionManager.create(tempDir.path(), `${tempDir.path()}/sessions`)
		: SessionManager.inMemory(tempDir.path());

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});

	const toolRegistry = options?.xdev?.tools ?? new Map<string, AgentTool>();
	for (const tool of tools) toolRegistry.set(tool.name, tool);
	const sess = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: {} as never,
		toolRegistry,
		xdev: options?.xdev,
		builtInToolNames: options?.builtInToolNames,
	});

	if (bridge) sess.setClientBridge(bridge);
	return sess;
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
