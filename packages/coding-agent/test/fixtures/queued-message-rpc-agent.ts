import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";

// Real RPC dispatch and session queues; only the external model response is scripted.
const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
// The first turn stays in flight long enough for a test to send a second prompt
// while streaming and promote it — the delay dwarfs a local RPC round trip.
const started: MockResponse = { content: ["Started"], delayMs: 1000 };
// QUEUED_RPC_SCRIPT varies only the first model call:
// - "internal-steer": queues a non-user (agent-attributed) steer as the call starts.
// - "live-steer": the provider claims the first user steer into the streaming response,
//   as a live-steering provider (Codex `response.steer`) does.
// - "hold": streams until aborted, for tests whose queueing outlasts the default delay.
const firstCall: Record<string, MockHandler> = {
	hold: { content: ["Started"], delayMs: 60_000 },
	"internal-steer": () => {
		void session.sendCustomMessage(
			{ customType: "test-internal-steer", content: "internal steer", display: true, attribution: "agent" },
			{ deliverAs: "steer" },
		);
		return started;
	},
	"live-steer": async (_context, options) => {
		const live = options?.liveSteering;
		const signal = options?.signal;
		if (live && signal) {
			await live.wait(signal);
			(await live.claim(signal))?.accept();
		}
		return started;
	},
};
const script = Bun.env.QUEUED_RPC_SCRIPT ?? "";
const mock = createMockModel({
	responses:
		script === "todo-error"
			? [
					{ content: [{ type: "toolCall", name: "todo", arguments: { op: "append", items: ["task"] } }] },
					{ content: ["Handled failed todo"], delayMs: 1000 },
				]
			: [firstCall[script] ?? started],
	handler: { content: ["Handled queued request"] },
});
const settings = Settings.isolated({ "compaction.enabled": false });
const todo =
	script === "todo-error"
		? new TodoTool({
				cwd: process.cwd(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings,
				getTodoPhases: () => session.getTodoPhases(),
				setTodoPhases: phases => session.setTodoPhases(phases),
			})
		: undefined;
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: {
		model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
		systemPrompt: ["Test"],
		tools: todo ? [todo] : [],
	},
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(process.cwd()),
	settings,
	modelRegistry,
});
await runRpcMode(session);
