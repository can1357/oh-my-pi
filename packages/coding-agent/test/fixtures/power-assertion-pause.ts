import { spyOn } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, agentPauseGate, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { cfgPowerSleepPrevention } from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as power from "@oh-my-pi/pi-coding-agent/session/power-assertion-backend";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const events: Array<[string, string | null]> = [];
let held: string | null = null;
const start = spyOn(power, "startPowerAssertion").mockImplementation(options => {
	const mode = options.display ? "display" : "idle";
	held = mode;
	events.push(["acquire", mode]);
	return {
		stop() {
			events.push(["release", mode]);
			held = null;
		},
	};
});
const schema = type({});
const tool: AgentTool<typeof schema> = {
	name: "probe",
	label: "Probe",
	description: "Observe the sleep hold during tool execution",
	parameters: schema,
	async execute() {
		events.push(["tool", held]);
		return { content: [{ type: "text", text: "done" }], details: {} };
	},
};
const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Missing bundled test model");
const mock = createMockModel({
	responses: [
		{ content: [{ type: "toolCall", name: "probe", arguments: {} }], stopReason: "toolUse" },
		{ content: ["finished"] },
	],
});
const auth = createInMemoryAuthStorage();
auth.keys.setRuntime("anthropic", "test-key");
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model, systemPrompt: ["Power assertion probe"], tools: [tool], messages: [] },
	convertToLlm,
	streamFn: (m, c, o) => mock.stream(m, c, o),
});
const settings = Settings.isolated({ "compaction.enabled": false, "power.sleepPrevention": "idle" });
using tempDir = TempDir.createSync("@omp-power-pause-");
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(),
	modelRegistry: new ModelRegistry(auth, tempDir.join("models.yml")),
	settings,
	toolRegistry: new Map([[tool.name, tool]]),
});
const parked = Promise.withResolvers<void>();
const originalWait = agentPauseGate.waitUntilResumed.bind(agentPauseGate);
const wait = spyOn(agentPauseGate, "waitUntilResumed").mockImplementation(signal => {
	parked.resolve();
	return originalWait(signal);
});
let pauseInjected = false;
const unsubscribe = agent.subscribe(event => {
	if (event.type === "message_start" && event.message.role === "assistant" && !pauseInjected) {
		pauseInjected = true;
		events.push(["request-pause", held]);
		agentPauseGate.pause();
	}
});
let running: Promise<unknown> | undefined;
try {
	running = session.prompt("Run the probe");
	await parked.promise;
	events.push(["parked", held]);
	cfgPowerSleepPrevention.override(settings, "display");
	events.push(["changed-setting", held]);
	agentPauseGate.resume();
	await running;
	events.push(["settled", held]);
	process.stdout.write(JSON.stringify(events));
} finally {
	agentPauseGate.resume();
	await session.abort();
	await running?.catch(() => undefined);
	unsubscribe();
	wait.mockRestore();
	await session.dispose();
	start.mockRestore();
	auth.close();
}
