#!/usr/bin/env bun
/**
 * Full streamGrokBot pipeline test: calls the actual provider stream function
 * with a real Model, Context (system + user + tools), and GrokbotOptions.
 *
 * Verifies end-to-end:
 *  - streamGrokBot accepts a grokbot-sand Model with Anthropic id + tools
 *  - The stream emits toolcall_end events with correct product tool names
 *  - The stream emits a done event with stopReason "toolUse"
 *  - The assistant message has the correct routed model
 *  - Tool calls can be fed back as ToolResultMessage for a second turn
 *  - History replay (rewriteInferenceMessagesForProductWire) works on turn 2+3
 *
 * Usage:
 *   bun scripts/grokbot-keep-model-pipeline-probe.ts
 *
 * Success marker: PIPELINE_PROBE_PASS
 */
import { buildModel } from "../packages/catalog/src/build.ts";
import type { ModelSpec } from "../packages/catalog/src/types.ts";
import { streamGrokBot } from "../packages/ai/src/providers/grokbot.ts";
import type { Context, Tool, Message, AssistantMessage, ToolCall } from "../packages/ai/src/types.ts";

const modelSpec: ModelSpec<"grokbot-sand"> = {
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "grokbot-sand" as const,
	provider: "grokbot",
	baseUrl: "https://api2.cursor.sh",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
	sandMaxMode: false,
	sandParameterIds: ["thinking", "context", "effort", "fast"],
};

const model = buildModel(modelSpec);

const tools: Tool[] = [
	{
		name: "bash",
		description: "Run a shell command.",
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		} as const,
	},
	{
		name: "read",
		description: "Read a file.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		} as const,
	},
	{
		name: "write",
		description: "Write a file.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		} as const,
	},
	{
		name: "edit",
		description: "Patch a file.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
			required: ["path", "old", "new"],
		} as const,
	},
	{
		name: "grep",
		description: "Search files.",
		parameters: {
			type: "object",
			properties: { pattern: { type: "string" } },
			required: ["pattern"],
		} as const,
	},
	{
		name: "glob",
		description: "Find files.",
		parameters: {
			type: "object",
			properties: { glob: { type: "string" } },
			required: ["glob"],
		} as const,
	},
];

function makeContext(messages: Message[]): Context {
	return {
		systemPrompt: [
			"You are a coding agent with Shell, Read, Write, Grep, and Glob tools. When asked to use a tool, call it immediately without explanation.",
		],
		messages,
		tools,
	};
}

async function runTurn(
	messages: Message[],
): Promise<{ assistant: AssistantMessage; toolCalls: ToolCall[]; error?: string }> {
	const context = makeContext(messages);
	const stream = streamGrokBot(model, context, {
		effort: "low",
		maxTokens: 512,
		// auto → keep-model for Anthropic+tools (the default we're testing)
	});

	const toolCalls: ToolCall[] = [];
	let assistant: AssistantMessage | undefined;
	let error: string | undefined;

	for await (const event of stream) {
		switch (event.type) {
			case "toolcall_end":
				toolCalls.push(event.toolCall);
				break;
			case "done":
				assistant = event.message;
				break;
			case "error":
				error = event.error.errorMessage || "stream error";
				assistant = event.error;
				break;
		}
	}

	return { assistant: assistant!, toolCalls, error };
}

async function main() {
	console.log(`model: ${model.id} api=${model.api} provider=${model.provider}`);
	console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);
	console.log(`identity: class=${model.identity.class} family=${model.identity.family}`);

	// ─── Turn 1: ask model to call Shell ───
	console.log(`\n=== Turn 1: ask Shell call ===`);
	const turn1Messages: Message[] = [
		{
			role: "user",
			content: "Use the Shell tool to run: echo pipeline-probe-ok. Do not explain, just call the tool.",
			timestamp: Date.now(),
		},
	];

	const turn1 = await runTurn(turn1Messages);
	const t1Calls = turn1.toolCalls.map((tc) => `${tc.name}(${tc.id})`);
	console.log(`  toolCalls: [${t1Calls.join(", ")}]`);
	console.log(`  stopReason: ${turn1.assistant.stopReason}`);
	console.log(`  model: ${turn1.assistant.model}`);
	console.log(`  error: ${turn1.error || "-"}`);

	if (turn1.error) {
		console.log(`\nPIPELINE_PROBE_FAIL: turn1 error: ${turn1.error}`);
		process.exitCode = 1;
		return;
	}

	const shellCall = turn1.toolCalls.find((tc) => tc.name === "Shell" || tc.name === "bash");
	if (!shellCall) {
		console.log(`\nPIPELINE_PROBE_FAIL: no Shell/bash tool call in turn1`);
		console.log(`  calls were: ${t1Calls.join(", ")}`);
		process.exitCode = 1;
		return;
	}
	console.log(`  Shell call id: ${shellCall.id}`);
	console.log(`  Shell call args: ${JSON.stringify(shellCall.arguments).slice(0, 100)}`);

	const stopOk = turn1.assistant.stopReason === "toolUse";
	console.log(`  stopReason=toolUse: ${stopOk ? "✓" : "✗"}`);

	const modelOk = /claude|fable|opus|sonnet|haiku|anthropic/i.test(turn1.assistant.model);
	console.log(`  model is Anthropic: ${modelOk ? "✓" : "✗"}`);

	// ─── Turn 2: feed tool result back, get final text ───
	console.log(`\n=== Turn 2: feed Shell result, get final response ===`);
	const turn2Messages: Message[] = [
		...turn1Messages,
		turn1.assistant,
		{
			role: "toolResult",
			toolCallId: shellCall.id,
			toolName: shellCall.name,
			content: [{ type: "text", text: "pipeline-probe-ok" }],
			isError: false,
			timestamp: Date.now(),
		},
	];

	const turn2 = await runTurn(turn2Messages);
	const t2Text = turn2.assistant.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("");
	console.log(`  stopReason: ${turn2.assistant.stopReason}`);
	console.log(`  model: ${turn2.assistant.model}`);
	console.log(`  text: "${t2Text.slice(0, 200)}"`);
	console.log(`  toolCalls: [${turn2.toolCalls.map((tc) => tc.name).join(", ")}]`);
	console.log(`  error: ${turn2.error || "-"}`);

	if (turn2.error) {
		console.log(`\nPIPELINE_PROBE_FAIL: turn2 error: ${turn2.error}`);
		process.exitCode = 1;
		return;
	}

	const turn2Ok = turn2.assistant.stopReason === "stop" || turn2.assistant.stopReason === "toolUse";
	console.log(`  turn2 completed: ${turn2Ok ? "✓" : "✗"}`);

	// ─── Turn 3: ask for a different tool (Read) to verify multi-tool history ───
	console.log(`\n=== Turn 3: ask Read call (history has Shell call+result) ===`);
	const turn3Messages: Message[] = [
		...turn2Messages,
		turn2.assistant,
		{
			role: "user",
			content: "Now use the Read tool to read /tmp/pipeline-test.txt. Do not explain, just call the tool.",
			timestamp: Date.now(),
		},
	];

	const turn3 = await runTurn(turn3Messages);
	const t3Calls = turn3.toolCalls.map((tc) => `${tc.name}(${tc.id})`);
	console.log(`  toolCalls: [${t3Calls.join(", ")}]`);
	console.log(`  stopReason: ${turn3.assistant.stopReason}`);
	console.log(`  model: ${turn3.assistant.model}`);
	console.log(`  error: ${turn3.error || "-"}`);

	if (turn3.error) {
		console.log(`\nPIPELINE_PROBE_FAIL: turn3 error: ${turn3.error}`);
		process.exitCode = 1;
		return;
	}

	const readCall = turn3.toolCalls.find((tc) => tc.name === "Read" || tc.name === "read");
	console.log(`  Read call: ${readCall ? `✓ id=${readCall.id}` : "✗"}`);

	// ─── Summary ───
	console.log(`\n${"=".repeat(60)}`);
	console.log(`=== PIPELINE SUMMARY ===`);
	const checks: [string, boolean][] = [
		["turn1 Shell tool call", !!shellCall],
		["turn1 stopReason=toolUse", stopOk],
		["turn1 model Anthropic", modelOk],
		["turn2 no error", !turn2.error],
		["turn2 completed", turn2Ok],
		["turn3 Read tool call", !!readCall],
		["turn3 no error", !turn3.error],
	];
	let allPass = true;
	for (const [name, ok] of checks) {
		console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
		if (!ok) allPass = false;
	}

	if (allPass) {
		console.log(`\nPIPELINE_PROBE_PASS`);
	} else {
		console.log(`\nPIPELINE_PROBE_FAIL`);
		process.exitCode = 1;
	}
}

await main();
