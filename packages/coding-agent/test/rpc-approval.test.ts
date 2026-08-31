import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import type { PendingExtensionRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { registerRpcApprovalHandlers, requestRpcSelect } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const TOOL_CALL_ID = "call_abc123";

/** Captured output callback receiving every RPC frame the harness emits. */
type OutputFn = (obj: object) => void;

function noOpExtensionActions(): ExtensionActions {
	return {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: () => {},
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
		getServiceTiers: () => [],
		setServiceTier: () => {},
		getSessionName: () => undefined,
		setSessionName: () => {},
		registerProvider: () => {},
		unregisterProvider: () => {},
	} as unknown as ExtensionActions;
}

function noOpExtensionContextActions(): ExtensionContextActions {
	return {
		getModel: () => undefined,
		isIdle: () => false,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: async () => {},
		getSystemPrompt: () => [],
	} as unknown as ExtensionContextActions;
}

function noOpUiMethod(): void {}

/** ExtensionUIContext stub whose `select` drives the real RPC select wire path. */
function rpcUiContextStub(pendingRequests: Map<string, PendingExtensionRequest>, output: OutputFn): ExtensionUIContext {
	return {
		select: (title, options, dialogOptions) =>
			requestRpcSelect(pendingRequests, output, title, options, dialogOptions),
		confirm: async () => false,
		input: async () => undefined,
		notify: noOpUiMethod,
		onTerminalInput: () => () => {},
		setStatus: noOpUiMethod,
		setWorkingMessage: noOpUiMethod,
		setWidget: noOpUiMethod,
		setFooter: noOpUiMethod,
		setHeader: noOpUiMethod,
		setTitle: noOpUiMethod,
		custom: async () => undefined as never,
		setEditorText: noOpUiMethod,
		pasteToEditor: noOpUiMethod,
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: noOpUiMethod,
		setEditorComponent: noOpUiMethod,
		get theme() {
			return theme;
		},
		getAllThemes: async () => [],
		getTheme: async () => undefined,
		setTheme: async () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: noOpUiMethod,
	};
}

function mockExecTool(options: { approvedDetails?: string[] | string; reason?: string } = {}): AgentTool {
	return {
		name: "mock_exec",
		description: "Mock exec-tier tool",
		parameters: {},
		label: "Mock Exec",
		strict: false,
		approval: {
			tier: "exec",
			policy: "prompt",
			...(options.reason ? { reason: options.reason } : {}),
		},
		...(options.approvedDetails ? { formatApprovalDetails: () => options.approvedDetails } : {}),
		async execute(_toolCallId: string, _params: Record<string, unknown>): Promise<AgentToolResult> {
			return { content: [{ type: "text", text: "executed" }] };
		},
	} as unknown as AgentTool;
}

let tempDir: TempDir;
let sessionManager: SessionManager;
let output = vi.fn<OutputFn>();
let pendingRequests: Map<string, PendingExtensionRequest> = new Map();

beforeAll(() => {
	tempDir = TempDir.createSync("@pi-rpc-approval-");
	sessionManager = SessionManager.inMemory(tempDir.path());
});

afterAll(() => {
	tempDir.remove();
});

function setupRunner(): ExtensionRunner {
	const modelRegistry = new ModelRegistry(
		new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:"))),
		path.join(tempDir.path(), "models.yml"),
	);
	const runner = new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
	output = vi.fn<OutputFn>();
	pendingRequests = new Map();
	runner.initialize(
		noOpExtensionActions(),
		noOpExtensionContextActions(),
		undefined,
		rpcUiContextStub(pendingRequests, output),
		"rpc",
	);
	registerRpcApprovalHandlers(runner, output);
	return runner;
}

function approvalContext(): AgentToolContext {
	return {
		settings: Settings.isolated({ "tools.approvalMode": "yolo" }),
		sessionManager,
	} as unknown as AgentToolContext;
}

function emittedFrames(): object[] {
	return output.mock.calls.map(call => call[0] as object);
}

/** Poll until at least `count` frames have been emitted (approval gate emission is async). */
async function waitForEmittedFrames(count: number): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (emittedFrames().length >= count) return;
		await Bun.sleep(1);
	}
	throw new Error(`Timed out waiting for ${count} RPC frames`);
}

function emittedSelectFrame(frame: object): { id: string } {
	if (!("type" in frame) || !("method" in frame) || !("id" in frame)) {
		throw new Error("Expected an extension_ui_request select frame");
	}
	if (frame.type !== "extension_ui_request" || frame.method !== "select" || typeof frame.id !== "string") {
		throw new Error("Expected an extension_ui_request select frame");
	}
	return { id: frame.id };
}

function resolveSelect(id: string, value: string): void {
	const pending = pendingRequests.get(id);
	if (!pending) throw new Error(`Expected pending select request ${id}`);
	pending.resolve({ type: "extension_ui_response", id, value });
}

describe("RPC structured tool approval frames", () => {
	it("emits tool_approval_request before the paired select and tool_approval_resolved on approval", async () => {
		const runner = setupRunner();
		const wrapper = new ExtensionToolWrapper(
			mockExecTool({
				approvedDetails: ["detail line one", "", "detail line two"],
				reason: "requires manual review",
			}),
			runner,
		);

		const executePromise = wrapper.execute(
			TOOL_CALL_ID,
			{ command: "echo hi" },
			undefined,
			undefined,
			approvalContext(),
		);

		// The approval gate emits tool_approval_request, then the paired select on
		// subsequent microtasks. Wait for both so the frame-sequence assertion below
		// is deterministic; the mock preserves emission order.
		await waitForEmittedFrames(2);
		const early = emittedFrames();
		expect(early).toHaveLength(2);
		expect(early[0]).toEqual({
			type: "tool_approval_request",
			id: TOOL_CALL_ID,
			sessionId: sessionManager.getSessionId(),
			toolCallId: TOOL_CALL_ID,
			toolName: "mock_exec",
			tier: "exec",
			policy: "prompt",
			source: "tool",
			reason: "requires manual review",
			approvalMode: "yolo",
			details: ["detail line one", "detail line two"],
		});
		const selectFrame = emittedSelectFrame(early[1]!);
		expect(early[1]).toMatchObject({ type: "extension_ui_request", method: "select", options: ["Approve", "Deny"] });

		resolveSelect(selectFrame.id, "Approve");
		await executePromise;

		const all = emittedFrames();
		expect(all).toHaveLength(3);
		expect(all[2]).toEqual({
			type: "tool_approval_resolved",
			id: TOOL_CALL_ID,
			toolCallId: TOOL_CALL_ID,
			approved: true,
			by: "user",
		});
	});

	it("reports a user denial via tool_approval_resolved and blocks execution", async () => {
		const runner = setupRunner();
		const wrapper = new ExtensionToolWrapper(mockExecTool(), runner);

		const executePromise = wrapper.execute(TOOL_CALL_ID, {}, undefined, undefined, approvalContext());

		await waitForEmittedFrames(2);
		const early = emittedFrames();
		expect(early).toHaveLength(2);
		const selectFrame = emittedSelectFrame(early[1]!);

		resolveSelect(selectFrame.id, "Deny");
		await expect(executePromise).rejects.toThrow("Tool call denied by user: mock_exec");

		const all = emittedFrames();
		expect(all).toHaveLength(3);
		expect(all[2]).toEqual({
			type: "tool_approval_resolved",
			id: TOOL_CALL_ID,
			toolCallId: TOOL_CALL_ID,
			approved: false,
			by: "user",
		});
	});
});

describe("ExtensionRunner.registerHostHandler", () => {
	it("is visible to hasHandlers and reverts on dispose", () => {
		const runner = setupRunner();
		expect(runner.hasHandlers("tool_approval_requested")).toBe(true);
		expect(runner.hasHandlers("tool_approval_resolved")).toBe(true);
		expect(runner.hasHandlers("session_start")).toBe(false);
		const dispose = runner.registerHostHandler("custom_wire_event", () => {});
		expect(runner.hasHandlers("custom_wire_event")).toBe(true);
		dispose();
		expect(runner.hasHandlers("custom_wire_event")).toBe(false);
	});

	it("dispatches host handlers through emit with the enriched event payload", async () => {
		const runner = setupRunner();
		const received: unknown[] = [];
		const dispose = runner.registerHostHandler("tool_approval_requested", event => {
			received.push(event);
		});
		try {
			await runner.emit({
				type: "tool_approval_requested",
				sessionId: "test-session",
				toolCallId: TOOL_CALL_ID,
				toolName: "mock_exec",
				tier: "exec",
				policy: "prompt",
				source: "tool",
				approvalMode: "yolo",
				details: ["line"],
			});
			expect(received).toEqual([
				{
					type: "tool_approval_requested",
					sessionId: "test-session",
					toolCallId: TOOL_CALL_ID,
					toolName: "mock_exec",
					tier: "exec",
					policy: "prompt",
					source: "tool",
					approvalMode: "yolo",
					details: ["line"],
				},
			]);
		} finally {
			dispose();
		}
	});

	it("does not dispatch after the handler is disposed", async () => {
		const runner = setupRunner();
		const received: unknown[] = [];
		const dispose = runner.registerHostHandler("tool_approval_requested", event => {
			received.push(event);
		});
		dispose();
		await runner.emit({
			type: "tool_approval_requested",
			sessionId: "test-session",
			toolCallId: TOOL_CALL_ID,
			toolName: "mock_exec",
			tier: "exec",
			policy: "prompt",
			source: "tool",
			approvalMode: "yolo",
		});
		expect(received).toHaveLength(0);
	});
});
