import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real RPC dispatch and bash execution with composer predictions on; the prediction side turn
// answers "ship it" at once, and any other model request is forbidden.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const agent = new Agent({
	initialState: { model, systemPrompt: [], tools: [] },
	convertToLlm,
	streamFn: () => {
		throw new Error("prediction-rpc-agent must not call a model");
	},
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(cwd),
	settings: Settings.isolated({ "compaction.enabled": false, "composer.predictions": true }),
	modelRegistry,
});
session.runEphemeralTurn = async () => ({
	replyText: "ship it",
	assistantMessage: {
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 1, output: 1 },
		stopReason: "stop",
	} as unknown as AssistantMessage,
});
// A command starting with `: slow-hook` waits first, as a slow extension `user_bash` hook does before
// the session counts the shell as running.
const executeBash = session.executeBash.bind(session);
session.executeBash = async (command, onChunk, options) => {
	if (command.startsWith(": slow-hook")) await Bun.sleep(1000);
	return executeBash(command, onChunk, options);
};
await runRpcMode(session);
