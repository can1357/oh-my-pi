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

// Real RPC dispatch and session queues; only the external model response is scripted.
const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
const started: MockResponse = { content: ["Started"] };
// Streams until the test aborts the turn; the delay only bounds a leaked process.
const held: MockResponse = { content: ["Started"], delayMs: 600_000 };
// QUEUED_RPC_SCRIPT varies only the first model call, which otherwise answers at once:
// - "hold": streams until aborted.
// - "until-steer": streams until a steer is queued (e.g. a follow-up promoted mid-turn), then
//   answers without taking it, so the steer runs as the next turn.
// - "internal-steer": queues a non-user (agent-attributed) steer as the call starts, then holds.
// - "live-steer": the provider claims the first user steer into the streaming response,
//   as a live-steering provider (Codex `response.steer`) does, then holds.
const firstCall: Record<string, MockHandler> = {
	hold: held,
	"until-steer": async (_context, options) => {
		const live = options?.liveSteering;
		const signal = options?.signal;
		if (!live || !signal) throw new Error("queued-message-rpc-agent: the mock call has no live steering channel");
		await live.wait(signal);
		return started;
	},
	"internal-steer": () => {
		void session.sendCustomMessage(
			{ customType: "test-internal-steer", content: "internal steer", display: true, attribution: "agent" },
			{ deliverAs: "steer" },
		);
		return held;
	},
	"live-steer": async (_context, options) => {
		const live = options?.liveSteering;
		const signal = options?.signal;
		if (live && signal) {
			await live.wait(signal);
			(await live.claim(signal))?.accept();
		}
		return held;
	},
};
const mock = createMockModel({
	responses: [firstCall[Bun.env.QUEUED_RPC_SCRIPT ?? ""] ?? started],
	handler: { content: ["Handled queued request"] },
});
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(process.cwd()),
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
});
await runRpcMode(session);
