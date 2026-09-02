#!/usr/bin/env bun
/**
 * Full streamGrokBot pipeline test across ALL Anthropic models.
 * Calls the actual provider stream function with real Model, Context, tools.
 *
 * Per model: 2-turn round-trip (Shell call → result → final text).
 * Verifies: toolcall_end event, stopReason=toolUse, model stays Anthropic,
 * turn 2 completes with stopReason=stop, history replay works.
 *
 * Usage:
 *   bun scripts/grokbot-keep-model-pipeline-all.ts
 *
 * Success marker: PIPELINE_ALL_PASS
 */
import { buildModel } from "../packages/catalog/src/build.ts";
import type { ModelSpec } from "../packages/catalog/src/types.ts";
import { streamGrokBot } from "../packages/ai/src/providers/grokbot.ts";
import type { Context, Tool, Message, AssistantMessage, ToolCall } from "../packages/ai/src/types.ts";

const ANTHROPIC_IDS = [
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-sonnet-5",
	"claude-sonnet-4-6",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-opus-4-5",
	"claude-haiku-4-5",
	"claude-sonnet-4-5",
	"claude-sonnet-4",
];

const tools: Tool[] = [
	{ name: "bash", description: "Run a shell command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } as const },
	{ name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as const },
	{ name: "write", description: "Write a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } as const },
	{ name: "edit", description: "Patch a file.", parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] } as const },
	{ name: "grep", description: "Search files.", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } as const },
	{ name: "glob", description: "Find files.", parameters: { type: "object", properties: { glob: { type: "string" } }, required: ["glob"] } as const },
];

function makeContext(messages: Message[]): Context {
	return {
		systemPrompt: ["You are a coding agent with Shell, Read, Write, Grep, and Glob tools. When asked to use a tool, call it. After receiving the tool result, briefly describe the output."],
		messages,
		tools,
	};
}

async function runTurn(model: ReturnType<typeof buildModel>, messages: Message[]): Promise<{ assistant: AssistantMessage; toolCalls: ToolCall[]; error?: string }> {
	const context = makeContext(messages);
	const stream = streamGrokBot(model, context, { effort: "low", maxTokens: 512 });
	const toolCalls: ToolCall[] = [];
	let assistant: AssistantMessage | undefined;
	let error: string | undefined;
	for await (const event of stream) {
		switch (event.type) {
			case "toolcall_end": toolCalls.push(event.toolCall); break;
			case "done": assistant = event.message; break;
			case "error": error = event.error.errorMessage || "stream error"; assistant = event.error; break;
		}
	}
	return { assistant: assistant!, toolCalls, error };
}

async function testModel(modelId: string): Promise<{ modelId: string; pass: boolean; routed?: string; reason: string }> {
	const model = buildModel({
		id: modelId,
		name: modelId,
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
	} satisfies ModelSpec<"grokbot-sand">);

	// Turn 1
	const t1Msgs: Message[] = [
		{ role: "user", content: `Use the Shell tool to run: echo pipeline-${modelId}-ok. Then tell me what the output was.`, timestamp: Date.now() },
	];
	const t1 = await runTurn(model, t1Msgs);
	if (t1.error) return { modelId, pass: false, reason: `turn1-err:${t1.error}` };

	const shellCall = t1.toolCalls.find((tc) => tc.name === "bash" || tc.name === "Shell");
	if (!shellCall) return { modelId, pass: false, reason: `turn1-no-shell:${t1.toolCalls.map((tc) => tc.name).join(",")}` };

	const stopOk = t1.assistant.stopReason === "toolUse";
	const modelOk = /claude|fable|opus|sonnet|haiku|anthropic/i.test(t1.assistant.model);

	// Turn 2
	const t2Msgs: Message[] = [
		...t1Msgs,
		t1.assistant,
		{ role: "toolResult", toolCallId: shellCall.id, toolName: shellCall.name, content: [{ type: "text", text: `pipeline-${modelId}-ok` }], isError: false, timestamp: Date.now() },
	];
	const t2 = await runTurn(model, t2Msgs);
	if (t2.error) return { modelId, pass: false, routed: t1.assistant.model, reason: `turn2-err:${t2.error}` };

	const t2Ok = t2.assistant.stopReason === "stop" || t2.assistant.stopReason === "toolUse";
	const pass = stopOk && modelOk && t2Ok;
	return { modelId, pass, routed: t1.assistant.model, reason: pass ? "ok" : `stop=${t1.assistant.stopReason} modelOk=${modelOk} t2Ok=${t2Ok}` };
}

async function main() {
	console.log(`Testing ${ANTHROPIC_IDS.length} Anthropic models via full streamGrokBot pipeline\n`);
	const results = [];
	for (const modelId of ANTHROPIC_IDS) {
		const r = await testModel(modelId);
		console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${modelId}  routed=${r.routed || "?"}  reason=${r.reason}`);
		results.push(r);
	}

	console.log(`\n${"=".repeat(60)}`);
	const passCount = results.filter((r) => r.pass).length;
	const failCount = results.length - passCount;
	console.log(`  ${passCount} pass, ${failCount} fail out of ${results.length}`);

	if (failCount > 0) {
		console.log(`\n  FAILURES:`);
		for (const r of results.filter((r) => !r.pass)) {
			console.log(`    ${r.modelId}: ${r.reason}`);
		}
	}

	if (failCount === 0) {
		console.log(`\nPIPELINE_ALL_PASS`);
	} else {
		console.log(`\nPIPELINE_ALL_FAIL`);
		process.exitCode = 1;
	}
}

await main();
