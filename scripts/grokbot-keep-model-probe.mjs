#!/usr/bin/env bun
/**
 * Live empirical probe: keep-model wire for Anthropic-labeled grokbot models.
 *
 * Auth helpers live in `grokbot-probe-config.mjs` (dependency-neutral mirror of
 * catalog/ai auth) so probes stay off the `@oh-my-pi/pi-utils` barrel.
 * Imports wire/proto logic directly from source.
 *
 * Tests:
 *  1. keep-model on claude-fable-5, claude-opus-5, claude-sonnet-5, claude-haiku-4-5
 *     with full 6-tool set (bash/read/write/edit/grep/glob → Shell/Read/Write/Grep/Glob)
 *     2-turn round-trip: ask model to call Shell, feed result back, get final text.
 *  2. auto mode resolves to keep-model for Anthropic+tools.
 *  3. Explicit automation still rewrites to sand-automation + generalPurpose.
 *  4. Non-Anthropic (grok-4.6) + keep-model is a no-op.
 *
 * Prints the wire payload (requestedModel, tool names, subagentType, automationId,
 * field-9 length) and the backend response (HTTP status, routed model, tool calls,
 * errors) so you can see exactly what executes in the backend.
 *
 * Usage:
 *   bun scripts/grokbot-keep-model-probe.mjs
 *
 * Success marker: KEEP_MODEL_PROBE_PASS
 */
import {
	applyAnthropicSandToolWire,
	resolveAnthropicSandToolsWire,
	isAnthropicSandModelId,
} from "../packages/ai/src/providers/grokbot/anthropic-sand-wire.ts";
import { resolveGrokbotRequestedModel } from "../packages/ai/src/providers/grokbot/model-request.ts";
import {
	CONNECT_END_STREAM_FLAG,
	decodeInferenceStreamResponse,
	encodeInferenceStreamRequest,
	frameConnectProto,
} from "../packages/ai/src/providers/grokbot/proto.ts";

import {
	GROKBOT_BACKEND,
	loadGrokbotConfig,
	grokbotClientHeaders,
	createGrokbotChecksum,
	joinGrokbotBackendUrl,
	mintGrokbotAccessToken,
} from "./grokbot-probe-config.mjs";

// ─── Proto stream helpers ───

const STREAM = "/aiserver.v1.InferenceService/Stream";

function parseFrames(buf) {
	let o = 0;
	const toolCalls = [];
	let responseModel = "";
	const textParts = [];
	let end;
	while (o + 5 <= buf.length) {
		const flags = buf[o];
		const len = buf.readUInt32BE(o + 1);
		o += 5;
		const bytes = buf.subarray(o, o + len);
		o += len;
		if (flags & CONNECT_END_STREAM_FLAG) {
			try { end = JSON.parse(bytes.toString("utf8")); } catch { end = { parseError: true }; }
			continue;
		}
		try {
			const msg = decodeInferenceStreamResponse(bytes);
			if (msg.toolCallPart?.toolName) {
				toolCalls.push({
					name: String(msg.toolCallPart.toolName),
					id: String(msg.toolCallPart.toolCallId || ""),
				});
			}
			if (msg.responseInfo?.model) responseModel = String(msg.responseInfo.model);
			if (msg.textPart?.text) textParts.push(String(msg.textPart.text));
		} catch { /* partial frame */ }
	}
	return { ok: !end?.error, toolCalls, responseModel, text: textParts.join(""), message: end?.error?.message, end };
}

async function sendStream(token, cfg, body) {
	const res = await fetch(joinGrokbotBackendUrl(GROKBOT_BACKEND, STREAM), {
		method: "POST",
		headers: {
			...grokbotClientHeaders(cfg),
			authorization: `Bearer ${token}`,
			"x-cursor-checksum": createGrokbotChecksum(cfg.machineId),
			"x-ghost-mode": "true",
			"content-type": "application/connect+proto",
			accept: "application/connect+proto",
			"connect-protocol-version": "1",
			"x-request-id": crypto.randomUUID(),
		},
		body: frameConnectProto(encodeInferenceStreamRequest(body)),
	});
	const buf = Buffer.from(await res.arrayBuffer());
	return { res, parsed: parseFrames(buf) };
}

// ─── Tool set ───

const ompTools = [
	{ name: "bash", description: "Run a shell command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
	{ name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	{ name: "write", description: "Write a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
	{ name: "edit", description: "Patch a file.", parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] } },
	{ name: "grep", description: "Search files.", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
	{ name: "glob", description: "Find files.", parameters: { type: "object", properties: { glob: { type: "string" } }, required: ["glob"] } },
];

// ─── Tests ───

function describeWire(wired, label) {
	const toolNames = (wired.tools || []).map((t) => t.name);
	const hasJsonSchema = (wired.tools || []).some((t) => t.parameters && t.parameters.jsonSchema);
	console.log(
		`  wire[${label}]: model=${wired.requestedModel?.modelId} tools=[${toolNames.join(",")}]` +
		` jsonSchema=${hasJsonSchema} subagent=${wired.subagentType || "-"}` +
		` automation=${wired.automationId || "-"} field9=${wired.acceptedUnadvertisedToolNames?.length || 0}`,
	);
}

async function testKeepModelRoundTrip(token, cfg, modelId) {
	console.log(`\n=== keep-model round-trip: ${modelId} ===`);
	const requestedModel = resolveGrokbotRequestedModel(modelId, {
		sandParameterIds: ["thinking", "context", "effort", "fast"],
		effort: "low",
	});
	const wired = applyAnthropicSandToolWire(
		{ requestedModel, tools: ompTools, modelId, ompTools },
		"keep-model",
	);
	describeWire(wired, "keep-model");

	const toolNames = wired.tools.map((t) => t.name);
	const asserts = [
		["requestedModel unchanged", wired.requestedModel.modelId === modelId],
		["no subagentType", wired.subagentType === undefined],
		["no automationId", wired.automationId === undefined],
		["field-9 present", (wired.acceptedUnadvertisedToolNames?.length ?? 0) > 20],
		["unique Write (edit+write deduped)", toolNames.filter((n) => n === "Write").length === 1],
		["5 product tools", toolNames.length === 5],
		["jsonSchema envelope", wired.tools.every((t) => t.parameters?.jsonSchema)],
	];
	for (const [name, ok] of asserts) console.log(`  assert ${ok ? "✓" : "✗"} ${name}`);
	const wireOk = asserts.every(([, ok]) => ok);

	const conversationId = crypto.randomUUID();

	// Turn 1: ask model to call Shell
	const body1 = {
		messages: [
			{ role: 4, text: "You are a coding agent with shell, read, write, grep, and glob tools." },
			{ role: 1, text: `Use the Shell tool to run: echo keep-model-${modelId}-ok. Do not explain, just call the tool.` },
		],
		tools: wired.tools,
		requestedModel: wired.requestedModel,
		invocationId: crypto.randomUUID(),
		conversationId,
		acceptedUnadvertisedToolNames: wired.acceptedUnadvertisedToolNames,
		modelConfig: { maxTokens: 512 },
	};

	const { res: res1, parsed: parsed1 } = await sendStream(token, cfg, body1);
	console.log(
		`  turn1: http=${res1.status} ok=${parsed1.ok} tools=${parsed1.toolCalls.map((t) => t.name).join(",") || "none"}` +
		` model=${parsed1.responseModel || "?"} err=${parsed1.message || "-"}`,
	);

	if (!res1.ok || !parsed1.ok || parsed1.toolCalls.length === 0) {
		console.log(`  FAIL: turn1 did not produce a tool call`);
		return { modelId, pass: false, reason: "turn1-no-toolcall", wireOk };
	}

	const shellCall = parsed1.toolCalls.find((t) => t.name === "Shell");
	if (!shellCall) {
		console.log(`  FAIL: no Shell tool call in turn1 (got: ${parsed1.toolCalls.map((t) => t.name).join(",")})`);
		return { modelId, pass: false, reason: "no-shell-call", wireOk };
	}
	console.log(`  turn1: Shell toolCall id=${shellCall.id}`);

	// Turn 2: feed tool result back using encodeCoreMessage fields (toolCalls / toolContent).
	const shellArgs = { command: `echo keep-model-${modelId}-ok` };
	const body2 = {
		messages: [
			{ role: 4, text: "You are a coding agent with shell, read, write, grep, and glob tools." },
			{ role: 1, text: `Use the Shell tool to run: echo keep-model-${modelId}-ok. Do not explain, just call the tool.` },
			{
				role: 2,
				toolCalls: [
					{
						toolCallId: shellCall.id,
						toolName: "Shell",
						args: shellArgs,
						rawToolCallArgs: JSON.stringify(shellArgs),
					},
				],
			},
			{
				role: 3,
				toolContent: {
					parts: [
						{
							toolCallId: shellCall.id,
							toolName: "Shell",
							result: `keep-model-${modelId}-ok`,
						},
					],
				},
			},
		],
		tools: wired.tools,
		requestedModel: wired.requestedModel,
		invocationId: crypto.randomUUID(),
		conversationId,
		acceptedUnadvertisedToolNames: wired.acceptedUnadvertisedToolNames,
		modelConfig: { maxTokens: 512 },
	};

	const { res: res2, parsed: parsed2 } = await sendStream(token, cfg, body2);
	console.log(
		`  turn2: http=${res2.status} ok=${parsed2.ok} model=${parsed2.responseModel || "?"}` +
		` tools=${parsed2.toolCalls.map((t) => t.name).join(",") || "none"}` +
		` text="${parsed2.text.slice(0, 120)}" err=${parsed2.message || "-"}`,
	);

	const routedModel = parsed2.responseModel || parsed1.responseModel;
	const routedIsAnthropic = isAnthropicSandModelId(routedModel) || /claude|fable|opus|sonnet|haiku/i.test(routedModel);
	console.log(`  routed model: ${routedModel} → ${routedIsAnthropic ? "Anthropic family ✓" : "NOT Anthropic ✗"}`);
	// History replay is only proven if turn 2 emits a final answer instead of another tool call.
	const finalResponse = parsed2.toolCalls.length === 0;

	const pass =
		wireOk &&
		res1.ok &&
		parsed1.ok &&
		shellCall &&
		res2.ok &&
		parsed2.ok &&
		routedIsAnthropic &&
		finalResponse;
	console.log(`  ${pass ? "PASS" : "FAIL"} keep-model ${modelId}`);
	return { modelId, pass, routedModel, wireOk, shellCallId: shellCall.id, finalResponse };
}

async function testAutoResolvesKeepModel() {
	console.log(`\n=== auto resolves to keep-model for Anthropic+tools ===`);
	const resolved = resolveAnthropicSandToolsWire(undefined, undefined, { modelId: "claude-fable-5", toolCount: 6 });
	console.log(`  auto(fable, 6 tools) → ${resolved}`);
	const pass = resolved === "keep-model";
	console.log(`  ${pass ? "PASS" : "FAIL"} auto→keep-model`);
	return { pass, resolved };
}

async function testAutoNonAnthropicError() {
	console.log(`\n=== auto for non-Anthropic+tools → error ===`);
	const resolved = resolveAnthropicSandToolsWire(undefined, undefined, { modelId: "grok-4.6", toolCount: 2 });
	console.log(`  auto(grok-4.6, 2 tools) → ${resolved}`);
	const pass = resolved === "error";
	console.log(`  ${pass ? "PASS" : "FAIL"} auto→error for non-Anthropic`);
	return { pass, resolved };
}

async function testAutomationStillGrok(token, cfg) {
	console.log(`\n=== explicit automation still rewrites to sand-automation ===`);
	const requestedModel = resolveGrokbotRequestedModel("claude-opus-5", {
		sandParameterIds: ["thinking", "context", "effort", "fast"],
		effort: "low",
	});
	const wired = applyAnthropicSandToolWire(
		{ requestedModel, tools: ompTools, modelId: "claude-opus-5", ompTools },
		"automation",
	);
	describeWire(wired, "automation");
	const asserts = [
		["requestedModel → sand-automation", wired.requestedModel.modelId === "sand-automation"],
		["subagentType = generalPurpose", wired.subagentType === "generalPurpose"],
		["automationId present", typeof wired.automationId === "string"],
		["field-9 present", (wired.acceptedUnadvertisedToolNames?.length ?? 0) > 20],
	];
	for (const [name, ok] of asserts) console.log(`  assert ${ok ? "✓" : "✗"} ${name}`);
	const wireOk = asserts.every(([, ok]) => ok);

	const body = {
		messages: [
			{ role: 4, text: "You are a coding agent with shell and read tools." },
			{ role: 1, text: "Use the Shell tool to run: echo automation-still-grok. Do not explain." },
		],
		tools: wired.tools,
		requestedModel: wired.requestedModel,
		invocationId: crypto.randomUUID(),
		conversationId: crypto.randomUUID(),
		subagentType: wired.subagentType,
		automationId: wired.automationId,
		acceptedUnadvertisedToolNames: wired.acceptedUnadvertisedToolNames,
		modelConfig: { maxTokens: 512 },
	};
	const { res, parsed } = await sendStream(token, cfg, body);
	console.log(
		`  live: http=${res.status} ok=${parsed.ok} tools=${parsed.toolCalls.map((t) => t.name).join(",") || "none"}` +
		` model=${parsed.responseModel || "?"} err=${parsed.message || "-"}`,
	);
	const routedGrok = /grok/i.test(parsed.responseModel || "");
	console.log(`  routed model: ${parsed.responseModel} → ${routedGrok ? "grok family ✓" : "NOT grok ✗"}`);
	const pass = wireOk && res.ok && parsed.ok && routedGrok;
	console.log(`  ${pass ? "PASS" : "FAIL"} automation-still-grok`);
	return { pass, routedModel: parsed.responseModel, wireOk };
}

async function testKeepModelNoopOnGrok() {
	console.log(`\n=== keep-model on non-Anthropic is a no-op ===`);
	const requestedModel = resolveGrokbotRequestedModel("grok-4.6", { sandParameterIds: ["effort", "fast"] });
	const input = { requestedModel, tools: ompTools, modelId: "grok-4.6", ompTools };
	const wired = applyAnthropicSandToolWire(input, "keep-model");
	const isNoop = wired === input;
	console.log(`  keep-model(grok-4.6) → ${isNoop ? "no-op ✓" : "rewrote ✗"}`);
	console.log(`  ${isNoop ? "PASS" : "FAIL"} keep-model-noop-grok`);
	return { pass: isNoop };
}

// ─── Main ───

async function main() {
	const cfg = loadGrokbotConfig();
	console.log(`config: machineId=${cfg.machineId.slice(0, 8)}… namespace=${cfg.namespace} client=${cfg.clientVersion}`);
	const token = await mintGrokbotAccessToken(cfg);
	console.log(`token minted ✓`);

	const results = [];

	for (const modelId of ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]) {
		results.push(await testKeepModelRoundTrip(token, cfg, modelId));
	}
	results.push(await testAutoResolvesKeepModel());
	results.push(await testAutoNonAnthropicError());
	results.push(await testAutomationStillGrok(token, cfg));
	results.push(await testKeepModelNoopOnGrok());

	console.log(`\n${"=".repeat(60)}`);
	console.log(`=== SUMMARY ===`);
	let allPass = true;
	for (const r of results) {
		const label = r.modelId || r.resolved || "test";
		console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${label}  routed=${r.routedModel || "-"}`);
		if (!r.pass) allPass = false;
	}

	if (allPass) {
		console.log(`\nKEEP_MODEL_PROBE_PASS`);
	} else {
		console.log(`\nKEEP_MODEL_PROBE_FAIL`);
		process.exitCode = 1;
	}
}

await main();
