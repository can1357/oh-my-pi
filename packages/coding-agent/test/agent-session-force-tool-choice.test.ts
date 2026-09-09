import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let tempDir: TempDir;
let authStorage: AuthStorage | undefined;
let session: AgentSession;
let sessionManager: SessionManager;
let mock: MockModel;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-agent-session-force-tool-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	authStorage = createInMemoryAuthStorage();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({ "compaction.enabled": false });
	sessionManager = SessionManager.inMemory(tempDir.path());

	const emptyObjectSchema = type("object");

	const bashTool: AgentTool = {
		name: "bash",
		label: "Bash",
		description: "Mock bash tool",
		parameters: emptyObjectSchema,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
	const writeTool: AgentTool = {
		name: "write",
		label: "Write",
		description: "Mock write tool",
		parameters: emptyObjectSchema,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};

	mock = createMockModel({ handler: () => ({ content: ["done"] }) });

	const agent = new Agent({
		getToolChoice: () => session.nextToolChoiceDirective(),
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [bashTool, writeTool],
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});

	session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map([
			[bashTool.name, bashTool],
			[writeTool.name, writeTool],
		]),
	});
});

afterEach(async () => {
	await session.dispose();
	authStorage?.close();
	authStorage = undefined;
	tempDir.removeSync();
});

async function deferForcedWrite(): Promise<void> {
	session.setForcedToolChoice("write");
	session.agent.setBeforeModelCall(() => ({ stop: true, reason: "session transition" }));
	await session.agent.prompt("defer");
	session.agent.setBeforeModelCall(undefined);
	expect(mock.calls).toHaveLength(0);
}

it("forces specific tool, then transitions to none, then clears", () => {
	session.setForcedToolChoice("write");

	const first = session.nextToolChoiceDirective();
	const second = session.nextToolChoiceDirective();
	const third = session.nextToolChoiceDirective();

	expect(first).toEqual({ type: "tool", name: "write" });
	// After the forced call, "none" prevents the loop from making more tool calls
	expect(second).toBe("none");
	// After "none" is consumed, override clears entirely
	expect(third).toBeUndefined();
});

it("drops an unavailable forced choice with the rest of its sequence", async () => {
	session.setForcedToolChoice("write");

	await session.setActiveToolsByName(["bash"]);
	expect(session.nextToolChoiceDirective()).toBeUndefined();
	expect(session.toolChoiceQueue.hasInFlight).toBe(false);
	expect(session.nextToolChoiceDirective()).toBeUndefined();

	await session.setActiveToolsByName(["bash", "write"]);
	expect(session.nextToolChoiceDirective()).toBeUndefined();
});

it("throws when forcing a non-active tool", () => {
	expect(() => session.setForcedToolChoice("read")).toThrow('Tool "read" is not currently active.');
});

it("drops a deferred forced choice when branching", async () => {
	const entryId = sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "branch target" }],
		timestamp: Date.now(),
	});
	await deferForcedWrite();

	await session.branch(entryId);
	await session.agent.prompt("new branch");

	expect(mock.calls).toHaveLength(1);
	expect(mock.calls[0]?.options?.toolChoice).toBeUndefined();
});

it("retains a deferred forced choice when session switching rolls back", async () => {
	await deferForcedWrite();
	const failure = new Error("switch failed");
	vi.spyOn(sessionManager, "setSessionFile").mockRejectedValueOnce(failure);

	await expect(session.switchSession(path.join(tempDir.path(), "target.jsonl"))).rejects.toBe(failure);
	await session.agent.prompt("retry current session");

	expect(mock.calls).toHaveLength(1);
	expect(mock.calls[0]?.options?.toolChoice).toEqual({ type: "tool", name: "write" });
});
