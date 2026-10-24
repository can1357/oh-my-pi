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
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
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
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { computerTurnInFlight, registerComputerController } from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { dispatchXdevTool, resolveMountedXdevExecutable, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

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
	settingsOverrides: Record<string, unknown> = {},
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

/**
 * Minimal runner for wrapping a tool exactly as an ACP session does: no
 * interactive UI (so the inner tier gate fails closed) and no event handlers.
 */
function noUiRunner(): ExtensionRunner {
	return {
		hasHandlers: () => false,
		consumeToolCallEmitted: () => false,
		hasUI: () => false,
		hasSessionApproval: () => false,
		sessionId: "acp-permission-test",
		runScoped<T>(fn: () => T): T {
			return fn();
		},
	} as unknown as ExtensionRunner;
}

it("always-ask: an ACP grant satisfies the inner wrapper's explicit prompt policy", async () => {
	// In a real ACP session every registry tool is wrapped by ExtensionToolWrapper,
	// then again by the ACP permission gate. The client has answered the explicit
	// prompt, so the inner wrapper must not request the unavailable interactive UI.
	const bashTool = makeFakeTool("bash");
	const wrapped = new ExtensionToolWrapper(bashTool, noUiRunner()) as unknown as AgentTool;
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	const approvalSettings: Record<string, unknown> = {
		"tools.approvalMode": "always-ask",
		"tools.approval": { bash: "prompt" },
	};
	session = await createSession([wrapped], bridge, approvalSettings);

	await session.setActiveToolsByName(["bash"]);
	const gatedBash = session.agent.state.tools.find(t => t.name === "bash");
	const ctx = { settings: Settings.isolated(approvalSettings) } as never;

	await gatedBash!.execute("call-1", { command: "echo hi" }, undefined, undefined as never, ctx);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(1);
});

it("ACP bash uses pattern decisions and scopes persistent grants to noncritical commands", async () => {
	const settingsOverrides = {
		"tools.approvalMode": "always-ask",
		"tools.approval": { bash: "prompt" },
		"bash.patterns": [
			{ match: "echo safe*", approval: "allow" },
			{ match: "echo denied*", approval: "deny" },
		],
	};
	const settings = Settings.isolated(settingsOverrides);
	const requests: string[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall) {
			const input = toolCall.rawInput;
			if (!input || typeof input !== "object" || !("command" in input) || typeof input.command !== "string") {
				throw new Error("Missing bash command");
			}
			const command = input.command;
			requests.push(command);
			return { outcome: "selected", optionId: "allow_always", kind: "allow_always" };
		},
	};
	const bashTool = makeFakeTool("bash");
	bashTool.approval = new BashTool({ ...makeToolSession(bridge), settings }).approval;
	const wrapped = new ExtensionToolWrapper(bashTool, noUiRunner()) as unknown as AgentTool;
	session = await createSession([wrapped], bridge, settingsOverrides);
	await session.setActiveToolsByName(["bash"]);
	const gatedBash = session.agent.state.tools.find(tool => tool.name === "bash");
	if (!gatedBash) throw new Error("Missing bash tool");
	const ctx = { settings } as never;
	const run = (command: string) =>
		gatedBash.execute(`call-${command}`, { command }, undefined, undefined as never, ctx);

	await run("echo safe-read");
	expect(requests).toEqual([]);
	await expect(run("echo denied-write")).rejects.toThrow(/blocked by tool policy/);
	expect(requests).toEqual([]);
	await run("echo probe-1");
	await run("echo probe-2");
	// "Always allow" covers later ordinary commands, as before.
	expect(requests).toEqual(["echo probe-1"]);
	await run("rm -rf /");
	await run("rm -rf /");
	// Critical commands ask on every call, whatever was granted.
	expect(requests).toEqual(["echo probe-1", "rm -rf /", "rm -rf /"]);
	expect(bashTool.executeCalls).toBe(5);
});

it("always-ask: an ordinary edit without an ACP grant still faces the inner approval gate", async () => {
	const editTool = makeFakeTool("edit");
	editTool.approval = "write";
	const wrapped = new ExtensionToolWrapper(editTool, noUiRunner()) as unknown as AgentTool;
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([wrapped], bridge, { "tools.approvalMode": "always-ask" });

	await session.setActiveToolsByName(["edit"]);
	const gatedEdit = session.agent.state.tools.find(t => t.name === "edit");
	const ctx = { settings: Settings.isolated({ "tools.approvalMode": "always-ask" }) } as never;

	await expect(
		gatedEdit!.execute("call-edit", { path: "/tmp/foo.ts" }, undefined, undefined as never, ctx),
	).rejects.toThrow(/requires approval but no interactive UI/);

	expect(permissionSpy).not.toHaveBeenCalled();
	expect(editTool.executeCalls).toBe(0);
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

it("lets the computer display sleep while the ACP client asks the user for permission", async () => {
	const bashTool = makeFakeTool("bash");
	const releases: number[] = [];
	let owner = "";
	let asked: { turn: number | undefined; releases: number[] } | undefined;
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission() {
			asked = { turn: computerTurnInFlight(owner), releases: [...releases] };
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	session = await createSessionWithMockModel([bashTool], bridge, [
		{ content: [{ type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "echo hi" } }] },
		{ content: ["done"] },
	]);
	owner = session.getEvalKernelOwnerId();
	const unregister = registerComputerController(owner, {
		async run() {
			throw new Error("not used");
		},
		async capabilities() {
			return undefined;
		},
		releaseDisplay(turn) {
			releases.push(turn);
		},
		async close() {},
	});
	try {
		await session.prompt("run it");
	} finally {
		unregister();
	}

	expect(asked).toEqual({ turn: undefined, releases: [1] });
	expect(bashTool.executeCalls).toBe(1);
	expect(releases).toEqual([1, 2]);
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

	await session.setActiveToolsByName(["Search", "glob", "grep"]);

	expect(session.getActiveToolNames()).toEqual(["grep", "glob"]);
});

// ---------------------------------------------------------------------------
// 5. Steering supersedes an open permission dialog (ACP `_session/steering`)
// ---------------------------------------------------------------------------

it("a steer sent while a permission dialog is open supersedes it instead of waiting behind it", async () => {
	const deleteTool = makeFakeTool("delete");
	const permissionPending = Promise.withResolvers<ClientBridgePermissionOutcome>();
	const permissionOpened = Promise.withResolvers<void>();
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(_toolCall, _options, _signal) {
			permissionOpened.resolve();
			return await permissionPending.promise;
		},
	};
	session = await createSessionWithMockModel([deleteTool as AgentTool], bridge, [
		{
			content: [{ type: "toolCall", id: "call-delete-1", name: "delete", arguments: { path: "/tmp/gone.ts" } }],
		},
		{ content: ["done after steer"] },
	]);

	// Drive the turn; the delete tool's permission elicit pends inside it.
	let promptSettled = false;
	const promptDone = session.prompt("delete something").then(() => {
		promptSettled = true;
	});
	// Await the observable signal that the elicit is open — not a guessed delay.
	await permissionOpened.promise;

	// The turn is live, so the steer joins it — and must supersede the open
	// dialog: the elicit is abandoned, its tool call surfaces as a cancelled
	// permission (a normal tool error), and the queued message is injected at
	// the next batch boundary (the model call that produced the final
	// response), not behind the dialog until the user answers.
	const admitted = await session.joinActiveTurn("wait — use the other parser instead");
	expect(admitted).toBe(true);

	await promptDone;
	expect(promptSettled).toBe(true);
	// The superseded call never executed.
	expect(deleteTool.executeCalls).toBe(0);
	// The steer reached the model inside the same turn.
	const messages = session.agent.state.messages;
	expect(
		messages.some(
			message => message.role === "user" && JSON.stringify(message.content).includes("use the other parser"),
		),
	).toBe(true);

	// Resolve the abandoned elicit so nothing dangles into the next test.
	permissionPending.resolve({ outcome: "cancelled" });
});

it("keeps the dialog open when an agent-authored steer queues mid-dialog", async () => {
	const deleteTool = makeFakeTool("delete");
	const permissionPending = Promise.withResolvers<ClientBridgePermissionOutcome>();
	const permissionOpened = Promise.withResolvers<void>();
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(_toolCall, _options, _signal) {
			permissionOpened.resolve();
			return await permissionPending.promise;
		},
	};
	// A controllable loop steering signal: tool calls run under a ctx
	// (`ctx.toolCall.steeringSignal`), so the gate takes the production
	// loop-signal path and the test aborts it on command, exactly the way
	// the loop's any-source steering poll does.
	const loopSteering = new AbortController();
	session = await createSessionWithMockModel(
		[deleteTool as AgentTool],
		bridge,
		[
			{
				content: [{ type: "toolCall", id: "call-delete-9", name: "delete", arguments: { path: "/tmp/gone2.ts" } }],
			},
			{ content: ["done after steer"] },
		],
		{ loopSteeringSignal: loopSteering.signal },
	);

	let promptSettled = false;
	const promptDone = session.prompt("delete something else").then(() => {
		promptSettled = true;
	});
	await permissionOpened.promise;

	// An agent-authored steer queues while the dialog is open: the loop's
	// steering signal aborts for it (any queued source), but no user
	// steering arrival fired, so the dialog must stay open — the tool call
	// keeps waiting on the user instead of being classified as superseded.
	await session.agent.steer({
		role: "user",
		content: [{ type: "text", text: "agent-authored aside while the dialog is open" }],
		timestamp: Date.now(),
	});
	loopSteering.abort();
	await Bun.sleep(50);
	expect(promptSettled).toBe(false);
	expect(deleteTool.executeCalls).toBe(0);

	// A user steer through the arrival channel still supersedes the dialog.
	const admitted = await session.joinActiveTurn("wait — the user changed their mind");
	expect(admitted).toBe(true);
	await promptDone;
	expect(promptSettled).toBe(true);
	expect(deleteTool.executeCalls).toBe(0);
	const messages = session.agent.state.messages;
	expect(
		messages.some(
			message => message.role === "user" && JSON.stringify(message.content).includes("the user changed their mind"),
		),
	).toBe(true);

	// Resolve the abandoned elicit so nothing dangles into the next test.
	permissionPending.resolve({ outcome: "cancelled" });
});

it("delivers the steer that supersedes a permission dialog ahead of older queued steers", async () => {
	const deleteTool = makeFakeTool("delete");
	const permissionPending = Promise.withResolvers<ClientBridgePermissionOutcome>();
	const permissionOpened = Promise.withResolvers<void>();
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(_toolCall, _options, _signal) {
			permissionOpened.resolve();
			return await permissionPending.promise;
		},
	};
	// Hold the first response open so an older steer can queue before the
	// delete call dispatches; the later steer supersedes the elicit and must
	// deliver first (agent.prioritizeSteering — same semantics as the TUI
	// approval dialog's denying steer).
	const turnStreamStarted = Promise.withResolvers<void>();
	const releaseTurnStream = Promise.withResolvers<void>();
	session = await createSessionWithMockModel([deleteTool as AgentTool], bridge, [
		async () => {
			turnStreamStarted.resolve();
			await releaseTurnStream.promise;
			return {
				content: [{ type: "toolCall", id: "call-delete-1", name: "delete", arguments: { path: "/tmp/gone.ts" } }],
			};
		},
		{ content: ["answered superseding steer"] },
		{ content: ["answered older steer"] },
	]);

	const promptDone = session.prompt("delete something");
	await withTimeout(turnStreamStarted.promise, 5_000, "Held turn stream never started");
	// An older steer queues while the turn streams, before any dialog exists.
	expect(await session.joinActiveTurn("older question about the batch")).toBe(true);
	releaseTurnStream.resolve();
	await permissionOpened.promise;

	// This steer supersedes the open dialog.
	expect(await session.joinActiveTurn("why this deletion?")).toBe(true);

	await promptDone;
	await session.waitForIdle();
	expect(deleteTool.executeCalls).toBe(0);

	// Order proof: the superseding steer was delivered to the model before
	// the older queued one.
	const messages = session.agent.state.messages;
	const contentIndexOf = (needle: string) =>
		messages.findIndex(message => message.role === "user" && JSON.stringify(message.content).includes(needle));
	const supersedeIndex = contentIndexOf("why this deletion?");
	const olderIndex = contentIndexOf("older question about the batch");
	expect(supersedeIndex).toBeGreaterThanOrEqual(0);
	expect(olderIndex).toBeGreaterThan(supersedeIndex);

	permissionPending.resolve({ outcome: "cancelled" });
});

it("delivers the user steer that supersedes a dialog ahead of an agent-authored steer", async () => {
	// Regression: the permission gate promoted *any* queued message older
	// than the dialog-open baseline — including steers the agent enqueued
	// itself without ever firing the steering-arrival signal. The user's
	// superseding steer must deliver first; the agent-authored one waits
	// for the next boundary.
	const deleteTool = makeFakeTool("delete");
	const permissionPending = Promise.withResolvers<ClientBridgePermissionOutcome>();
	const permissionOpened = Promise.withResolvers<void>();
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(_toolCall, _options, _signal) {
			permissionOpened.resolve();
			return await permissionPending.promise;
		},
	};
	const turnStreamStarted = Promise.withResolvers<void>();
	const releaseTurnStream = Promise.withResolvers<void>();
	session = await createSessionWithMockModel([deleteTool as AgentTool], bridge, [
		async () => {
			turnStreamStarted.resolve();
			await releaseTurnStream.promise;
			return {
				content: [{ type: "toolCall", id: "call-delete-1", name: "delete", arguments: { path: "/tmp/gone.ts" } }],
			};
		},
		{ content: ["answered user steer"] },
		{ content: ["answered agent steer"] },
	]);

	const promptDone = session.prompt("delete something");
	await withTimeout(turnStreamStarted.promise, 5_000, "Held turn stream never started");
	releaseTurnStream.resolve();
	await permissionOpened.promise;

	// The agent enqueues a steer while the dialog is open. This path never
	// fires the steering-arrival signal, so it must not be promoted.
	session.agent.steer({
		role: "user",
		content: [{ type: "text", text: "agent-authored steer" }],
		timestamp: Date.now(),
	});

	// The user steer supersedes the open dialog and delivers first.
	expect(await session.joinActiveTurn("user steer superseding the dialog")).toBe(true);

	await promptDone;
	await session.waitForIdle();
	expect(deleteTool.executeCalls).toBe(0);

	const messages = session.agent.state.messages;
	const contentIndexOf = (needle: string) =>
		messages.findIndex(message => message.role === "user" && JSON.stringify(message.content).includes(needle));
	const userSteerIndex = contentIndexOf("user steer superseding the dialog");
	const agentSteerIndex = contentIndexOf("agent-authored steer");
	expect(userSteerIndex).toBeGreaterThanOrEqual(0);
	expect(agentSteerIndex).toBeGreaterThan(userSteerIndex);

	permissionPending.resolve({ outcome: "cancelled" });
});

it("parks a steer that lands mid-dispatch until the owning prompt goes live, then injects it", async () => {
	// Park-until-live: a steer arriving while the owning prompt is reserved
	// but still dispatching (`#promptInFlightCount` raised, the agent not yet
	// streaming) must neither be refused back to the host (agent-shell would
	// interrupt the very turn it targeted) nor injected mid-dispatch — it
	// parks, then admits when the run goes live, and the loop's boundary
	// poll delivers it into that run.
	const keyGate = Promise.withResolvers<void>();
	const dispatched = Promise.withResolvers<void>();
	let keyCalls = 0;
	const gatedApiKey = (): Promise<string> | string => {
		keyCalls++;
		if (keyCalls === 1) {
			dispatched.resolve();
			return keyGate.promise.then(() => "test-key");
		}
		return "test-key";
	};
	const bridge: ClientBridge = { capabilities: {} };
	session = await createSessionWithMockModel(
		[],
		bridge,
		[{ content: ["first answer"] }, { content: ["steer answer"] }],
		{ getApiKey: gatedApiKey },
	);

	const promptDone = session.prompt("first");
	// Hold open the pre-dispatch window: the prompt is in flight (its
	// in-flight bracket raised — `isStreaming` true) while the agent has
	// not started streaming.
	await dispatched.promise;
	expect(session.isStreaming).toBe(true);
	expect(session.agent.state.isStreaming).toBe(false);

	const admitted = session.joinActiveTurn("steer the dispatching turn");
	// The steer parks rather than settling: give it a beat to prove it
	// neither admitted early nor refused.
	await Bun.sleep(20);
	let settled = false;
	void admitted.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await Bun.sleep(20);
	expect(settled).toBe(false);

	// The owning prompt goes live: the parked steer admits and injects into
	// the now-running turn.
	keyGate.resolve();
	expect(await admitted).toBe(true);
	await promptDone;
	await session.waitForIdle();

	// The run went live; the loop's boundary poll injected the parked steer
	// after the first response, and the continuation answered it in turn.
	const messages = session.agent.state.messages;
	const steerIndex = messages.findIndex(
		message => message.role === "user" && JSON.stringify(message.content).includes("steer the dispatching turn"),
	);
	const answerIndex = messages.findIndex(
		message => message.role === "assistant" && JSON.stringify(message.content).includes("steer answer"),
	);
	expect(steerIndex).toBeGreaterThanOrEqual(0);
	expect(answerIndex).toBeGreaterThan(steerIndex);
});

it("refuses a steer into an agent-initiated turn whose output has no client forwarder", async () => {
	// An idle `triggerTurn` custom message starts an agent-initiated turn:
	// `#beginInFlight` counts it, but no client prompt owns it, so its
	// output has no promptTurn forwarder. A steer arriving mid-run must be
	// refused (the host keeps its content and resubmits via session/prompt)
	// instead of being admitted into a run whose answer would be dropped.
	const turnStarted = Promise.withResolvers<void>();
	const releaseTurn = Promise.withResolvers<void>();
	session = await createSessionWithMockModel([], { capabilities: {} }, [
		async () => {
			turnStarted.resolve();
			await releaseTurn.promise;
			return { content: ["agent-initiated done"] };
		},
	]);
	const sent = session.sendCustomMessage(
		{ customType: "background", content: "do work", display: false },
		{
			deliverAs: "nextTurn",
			triggerTurn: true,
		},
	);
	await turnStarted.promise;
	expect(session.agent.state.isStreaming).toBe(true);
	expect(session.isStreaming).toBe(true);

	expect(await session.joinActiveTurn("steer the agent-initiated turn")).toBe(false);
	expect(session.getQueuedMessages().steering).toEqual([]);

	releaseTurn.resolve();
	await sent;
	await session.waitForIdle();
	const messages = session.agent.state.messages;
	expect(
		messages.some(
			message =>
				message.role === "user" && JSON.stringify(message.content).includes("steer the agent-initiated turn"),
		),
	).toBe(false);
});

async function createSessionWithMockModel(
	tools: AgentTool[],
	bridge: ClientBridge,
	responses: NonNullable<MockModelOptions["responses"]>,
	options?: { getApiKey?: () => Promise<string> | string; loopSteeringSignal?: AbortSignal },
): Promise<AgentSession> {
	const mock = createMockModel({ responses });
	const settings = Settings.isolated({ "compaction.enabled": false });
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const getApiKey = options?.getApiKey ?? (() => "test-key");
	const agent = new Agent({
		getApiKey,
		// With a loop steering signal the tool calls run under a ctx
		// (`ctx.toolCall.steeringSignal`), the path the production loop
		// wires; the test aborts it on command to simulate the loop's
		// any-source steering abort.
		...(options?.loopSteeringSignal
			? {
					getToolContext: (() => ({ toolCall: { steeringSignal: options.loopSteeringSignal } }) as never) as never,
				}
			: {}),
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
		modelRegistry: { getApiKey } as never,
		toolRegistry: new Map(tools.map(t => [t.name, t])),
	});
	sess.setClientBridge(bridge);
	return sess;
}

it("delivers two steers admitted in one dialog window first-arrival-first", async () => {
	// Two admissions can land while one permission dialog is open, before
	// the gate's abort wake runs: the first group must stay first (the
	// promotion is FIFO within the window), not be shadowed by the second
	// group's latest-slot write.
	const deleteTool = makeFakeTool("delete");
	const permissionPending = Promise.withResolvers<ClientBridgePermissionOutcome>();
	const permissionOpened = Promise.withResolvers<void>();
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(_toolCall, _options, _signal) {
			permissionOpened.resolve();
			return await permissionPending.promise;
		},
	};
	const turnStreamStarted = Promise.withResolvers<void>();
	const releaseTurnStream = Promise.withResolvers<void>();
	session = await createSessionWithMockModel([deleteTool as AgentTool], bridge, [
		async () => {
			turnStreamStarted.resolve();
			await releaseTurnStream.promise;
			return {
				content: [{ type: "toolCall", id: "call-delete-1", name: "delete", arguments: { path: "/tmp/gone.ts" } }],
			};
		},
		{ content: ["answered first steer"] },
		{ content: ["answered second steer"] },
	]);

	const promptDone = session.prompt("delete something");
	await turnStreamStarted.promise;
	releaseTurnStream.resolve();
	await permissionOpened.promise;

	// Both admissions in the same dialog window, with no await between the
	// calls: each call's enqueue fires before the gate's abort wake runs.
	const first = session.joinActiveTurn("first steering question");
	const second = session.joinActiveTurn("second steering question");
	expect(await first).toBe(true);
	expect(await second).toBe(true);

	await promptDone;
	await session.waitForIdle();
	expect(deleteTool.executeCalls).toBe(0);

	const messages = session.agent.state.messages;
	const contentIndexOf = (needle: string) =>
		messages.findIndex(message => message.role === "user" && JSON.stringify(message.content).includes(needle));
	expect(contentIndexOf("first steering question")).toBeLessThan(contentIndexOf("second steering question"));

	permissionPending.resolve({ outcome: "cancelled" });
});

it("parks a steer submitted before the owning prompt's dispatch preprocessing", async () => {
	const session = await createSessionWithMockModel([makeFakeTool("noop")], makeBridge({ outcome: "cancelled" }), [
		{ content: ["ok"] },
	]);

	// The submission's synchronous prefix must reserve the client claim
	// before any dispatch preprocessing await (maintenance wait, command
	// expansion, image normalization): a steer landing in that window parks
	// until the run goes live and injects into it, instead of being declined
	// (the pre-fix claim appeared only after normalization, so this steer
	// answered false and the host's resubmission implicitly cancelled the
	// still-dispatching prompt).
	const dispatched = session.prompt("hello there");
	const steer = session.joinActiveTurn("steer the dispatching prompt");
	expect(await steer).toBe(true);
	expect(await dispatched).toBe(true);
	await session.waitForIdle();
});
