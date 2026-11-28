import { afterEach, beforeEach, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Agent } from "../src/agent";
import type { AgentTool } from "../src/types";

function agentTool(name: string, description: string, extraArg = false): AgentTool {
	const parameters = extraArg ? type({ arg: type("string"), extra: type("string") }) : type({ arg: type("string") });
	return {
		name,
		label: name,
		description,
		parameters: parameters as unknown as AgentTool["parameters"],
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

const reply: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
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
	timestamp: 0,
};

function agent(tools: AgentTool[], contexts: Context[] = []): Agent {
	return new Agent({
		initialState: { model: createMockModel({ responses: [] }), systemPrompt: ["system"], tools },
		streamFn: (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: reply }));
			return stream;
		},
	});
}

let previousDialect: string | undefined;
beforeEach(() => {
	previousDialect = Bun.env.PI_DIALECT;
	delete Bun.env.PI_DIALECT;
});
afterEach(() => {
	if (previousDialect === undefined) delete Bun.env.PI_DIALECT;
	else Bun.env.PI_DIALECT = previousDialect;
});

it("sends the owner's wording only for same-schema tools, until the fork's own wording changes", async () => {
	const owner = agent([agentTool("read", "owner read"), agentTool("grep", "owner grep")]);
	const contexts: Context[] = [];
	const fork = agent([agentTool("read", "fork read"), agentTool("grep", "fork grep", true)], contexts);
	fork.inheritToolDescriptions(owner.normalizedTools());

	await fork.prompt("first");
	fork.setTools([agentTool("read", "fork read, reworded"), agentTool("grep", "fork grep", true)]);
	await fork.prompt("second");

	expect(
		contexts.map(context => Object.fromEntries((context.tools ?? []).map(tool => [tool.name, tool.description]))),
	).toEqual([
		// The fork's `grep` declares an argument the owner's lacks, so it keeps its own spec.
		{ read: "owner read", grep: "fork grep" },
		// A reworded fork tool no longer matches the pin and sends its own wording.
		{ read: "fork read, reworded", grep: "fork grep" },
	]);
});
