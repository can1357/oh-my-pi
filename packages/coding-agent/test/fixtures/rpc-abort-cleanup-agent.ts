import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const url = process.env.NATIVE_INPUT_PROBE_URL;
if (!url) throw new Error("NATIVE_INPUT_PROBE_URL is required");
const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
const mock = createMockModel({
	handler: async (context, options) => {
		// Only the external model is scripted; the parent controls each turn's completion.
		await fetch(`${url}/v1/chat/completions`, {
			method: "POST",
			body: JSON.stringify({ model: "probe", messages: context.messages }),
			signal: options?.signal,
		});
		return { content: ["LOCAL_PROVIDER_DONE"] };
	},
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

// Hold the first real abort after the agent has stopped, before session cleanup/finally.
const waitForIdle = agent.waitForIdle.bind(agent);
let firstIdle = true;
agent.waitForIdle = async () => {
	await waitForIdle();
	if (!firstIdle) return;
	firstIdle = false;
	await fetch(`${url}/gates`, { method: "POST", body: JSON.stringify({ name: "abort-cleanup" }) });
};

// Observe real cleanup promises, without replacing abort's queue/bookkeeping behavior.
const abort = session.abort.bind(session);
const aborts: Promise<void>[] = [];
let activeAborts = 0;
let maxActiveAborts = 0;
session.abort = options => {
	activeAborts++;
	maxActiveAborts = Math.max(maxActiveAborts, activeAborts);
	const completion = abort(options).finally(() => activeAborts--);
	aborts.push(completion);
	return completion;
};
const queuedTurn = Promise.withResolvers<void>();
session.subscribe(event => {
	if (
		event.type === "message_end" &&
		event.message.role === "user" &&
		Array.isArray(event.message.content) &&
		event.message.content.some(block => block.type === "text" && block.text === "QUEUED_STEER")
	) {
		queuedTurn.resolve();
	}
});
process.on("message", async message => {
	if (message !== "checkpoint") return;
	const overlapping = aborts.slice(1);
	await Promise.allSettled(overlapping);
	// On broken production, let the overlapping cleanup's real queue drain become visible.
	// Fixed production has no second cleanup to settle while the first remains gated.
	if (overlapping.length > 0) await queuedTurn.promise;
	await fetch(`${url}/events`, {
		method: "POST",
		body: JSON.stringify({
			event: "abort-cleanup-checkpoint",
			isStreaming: session.isStreaming,
			...session.getQueuedMessages(),
			maxActiveAborts,
		}),
	});
});
await runRpcMode(session);
