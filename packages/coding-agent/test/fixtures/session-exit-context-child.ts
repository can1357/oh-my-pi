/**
 * An omp session process for session-exit-context.test.ts: it opens a session
 * in `<dir>` with one tool call pending, prints `ready <session file>`, and then
 * - `signal`: waits for a signal; postmortem teardown records the exit, as in
 *   InteractiveMode;
 * - `normal`: waits for stdin to close, then disposes the session and exits.
 */
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

const [dir, mode] = process.argv.slice(2);
if (!dir || (mode !== "signal" && mode !== "normal")) throw new Error("usage: <dir> <signal|normal>");

const pendingAssistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "toolu_exit", name: "bash", arguments: { command: "sleep 600" } }],
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

const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected built-in anthropic model to exist");
const sessionManager = SessionManager.create(dir, dir);
const agent = new Agent({
	initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	convertToLlm,
});
const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry: new ModelRegistry(authStorage),
});
agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
await Promise.resolve();
agent.emitExternalEvent({
	type: "tool_execution_start",
	toolCallId: "toolu_exit",
	toolName: "bash",
	args: { command: "sleep 600" },
});
await Promise.resolve();

postmortem.register("session-teardown", reason => session.dispose({ reason }));
process.stdout.write(`ready ${sessionManager.getSessionFile()}\n`);

if (mode === "signal") {
	setInterval(() => {}, 60_000);
} else {
	for await (const _chunk of Bun.stdin.stream()) {
		// Drain until the parent closes stdin.
	}
	await session.dispose();
	authStorage.close();
	process.exit(0);
}
