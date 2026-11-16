// Child for the signal-sender session exit test: an AgentSession with a pending
// tool call under the CLI's process handlers. Prints its session file, then
// waits for the parent's signal.
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem } from "@oh-my-pi/pi-utils";

postmortem.installProcessHandlers();

const dir = process.argv[2];
if (!dir) throw new Error("usage: signal-sender-session.ts <dir>");
const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected built-in anthropic model to exist");
const sessionManager = SessionManager.create(dir, dir);
const agent = new Agent({
	initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	convertToLlm,
});
new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry: new ModelRegistry(authStorage),
});

const pendingAssistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "toolu_sender", name: "bash", arguments: { command: "sleep 60" } }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
};
agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
await Promise.resolve();
agent.emitExternalEvent({
	type: "tool_execution_start",
	toolCallId: "toolu_sender",
	toolName: "bash",
	args: { command: "sleep 60" },
});
await Promise.resolve();

fs.writeSync(1, `${sessionManager.getSessionFile()}\n`);
setInterval(() => {}, 1000);
