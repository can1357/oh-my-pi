import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { RpcSubagentRegistry } from "../src/modes/rpc/rpc-subagents";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { TASK_SUBAGENT_EVENT_CHANNEL } from "../src/task/types";
import { EventBus } from "../src/utils/event-bus";

const SESSION_EVENTS = 50_000;
const RPC_EVENTS = 500_000;
const MEASURE_RUNS = 9;

function median(values: number[]): number {
	return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

async function measure(label: string, count: number, run: () => Promise<void>): Promise<void> {
	await run();
	const cpuMs: number[] = [];
	for (let i = 0; i < MEASURE_RUNS; i++) {
		Bun.gc(true);
		const beforeCpu = process.cpuUsage();
		await run();
		const usage = process.cpuUsage(beforeCpu);
		cpuMs.push((usage.user + usage.system) / 1000);
	}
	console.log(`${label} count=${count} cpu_ms=${median(cpuMs).toFixed(2)}`);
}

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "x" }],
	api: "mock",
	provider: "mock",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};
const update: AgentEvent = {
	type: "message_update",
	message,
	assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
};

async function measureSession(hasHandler: boolean): Promise<void> {
	const agent = new Agent({ initialState: { systemPrompt: [], tools: [], messages: [] } });
	let extensionEmitted = 0;
	const runtime = new ExtensionRuntime();
	const manager = SessionManager.inMemory();
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const extension = await loadExtensionFromFactory(
		api => {
			if (hasHandler)
				api.on("message_update", () => {
					extensionEmitted++;
				});
		},
		manager.getCwd(),
		new EventBus(),
		runtime,
	);
	const runner = new ExtensionRunner([extension], runtime, manager.getCwd(), manager, registry);
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
		extensionRunner: runner,
	});
	let seen = 0;
	const unsubscribe = session.subscribe(event => {
		if (event.type === "message_update") seen++;
	});
	await measure(`session_handler_${hasHandler}`, SESSION_EVENTS, async () => {
		const before = seen;
		const beforeExtension = extensionEmitted;
		for (let i = 0; i < SESSION_EVENTS; i++) agent.emitExternalEvent(update);
		await Bun.sleep(0);
		if (seen - before !== SESSION_EVENTS) throw new Error(`Received ${seen - before} updates`);
		const expectedExtensions = hasHandler ? SESSION_EVENTS : 0;
		if (extensionEmitted - beforeExtension !== expectedExtensions) {
			throw new Error(`Emitted ${extensionEmitted - beforeExtension} extension updates`);
		}
	});
	unsubscribe();
	await session.dispose();
	authStorage.close();
}

async function measureRpc(): Promise<void> {
	const bus = new EventBus();
	const registry = new RpcSubagentRegistry(bus, () => {});
	const payload = { id: "subagent", event: { type: "message_update" } };
	await measure("rpc_subscription_off", RPC_EVENTS, async () => {
		for (let i = 0; i < RPC_EVENTS; i++) bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, payload);
		await Bun.sleep(0);
	});
	registry.dispose();
}

await measureSession(false);
await measureSession(true);
await measureRpc();
