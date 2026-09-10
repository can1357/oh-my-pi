#!/usr/bin/env bun
/**
 * Live empirical probe: ALL Anthropic-family grokbot models with full tool set.
 *
 * 1. Fetches live AvailableModels from sand backend.
 * 2. Filters to Anthropic class via isAnthropicSandModelId.
 * 3. For each: keep-model wire, 2-turn Shell round-trip, verify routed model
 *    stays Anthropic family.
 * 4. Also tests an extended omp tool set (bash/read/write/edit/grep/glob +
 *    todoWrite/webSearch/webFetch) to verify unmapped tools pass through
 *    with jsonSchema and don't trigger ERROR_PROVIDER_ERROR.
 *
 * Usage:
 *   bun scripts/grokbot-keep-model-full-anthropic-probe.mjs
 *
 * Success marker: FULL_ANTHROPIC_PROBE_PASS
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
import * as prompt from "../packages/utils/src/prompt.ts";
import codingAgentSystemPrompt from "./grokbot-probes/coding-agent-system.md" with { type: "text" };
import shellEchoUserPrompt from "./grokbot-probes/shell-echo-user.md" with { type: "text" };

import {
	GROKBOT_BACKEND,
	GROKBOT_AVAILABLE_MODELS_PATH,
	loadGrokbotConfig,
	grokbotClientHeaders,
	createGrokbotChecksum,
	joinGrokbotBackendUrl,
	mintGrokbotAccessToken,
} from "./grokbot-probe-config.mjs";
import { probeOmpTools, probeOmpToolsExtended } from "./grokbot-probes/probe-omp-tools.ts";

// ─── AvailableModels ───

async function fetchAvailableModels(token, cfg) {
	const res = await fetch(joinGrokbotBackendUrl(GROKBOT_BACKEND, GROKBOT_AVAILABLE_MODELS_PATH), {
		method: "POST",
		headers: {
			...grokbotClientHeaders(cfg),
			authorization: `Bearer ${token}`,
			"x-cursor-checksum": createGrokbotChecksum(cfg.machineId),
			"x-ghost-mode": "true",
			"content-type": "application/json",
			accept: "application/json",
			"connect-protocol-version": "1",
		},
		body: JSON.stringify({ useModelParameters: true, includeLongContextModels: true }),
	});
	if (!res.ok) throw new Error(`AvailableModels HTTP ${res.status}`);
	const data = await res.json();
	const models = data.models || [];
	return models.map(m => ({
		id: m.id || m.name || "",
		name: m.name || m.id || "",
		parameterIds: m.parameterIds || m.modelParameters || [],
	}));
}

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
			try {
				end = JSON.parse(bytes.toString("utf8"));
			} catch {
				end = { parseError: true };
			}
			continue;
		}
		try {
			const msg = decodeInferenceStreamResponse(bytes);
			if (msg.toolCallPart?.toolName) {
				const id = String(msg.toolCallPart.toolCallId || "");
				const chunk = msg.toolCallPart.args == null ? "" : String(msg.toolCallPart.args);
				const existing = toolCalls.find(t => t.id === id && t.name === String(msg.toolCallPart.toolName));
				if (existing) {
					existing.args = `${existing.args || ""}${chunk}`;
					if (msg.toolCallPart.isComplete) existing.complete = true;
				} else {
					toolCalls.push({
						name: String(msg.toolCallPart.toolName),
						id,
						args: chunk,
						complete: Boolean(msg.toolCallPart.isComplete),
					});
				}
			}
			if (msg.responseInfo?.model) responseModel = String(msg.responseInfo.model);
			if (msg.textPart?.text) textParts.push(String(msg.textPart.text));
		} catch {
			/* partial frame */
		}
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

// ─── Tool sets ───

// Standard 6 omp tools (maps to 5 product tools — edit+write dedupe to Write)
const ompTools = probeOmpTools();

// Extended set: adds unmapped tools (todoWrite, webSearch, webFetch) that pass
// through with their original names + jsonSchema. These are in the field-9
// allowlist so sand should accept them as unadvertised tools.
const ompToolsExtended = probeOmpToolsExtended();

// ─── Tests ───

function describeWire(wired) {
	const toolNames = (wired.tools || []).map(t => t.name);
	return `model=${wired.requestedModel?.modelId} tools=[${toolNames.join(",")}] field9=${wired.acceptedUnadvertisedToolNames?.length || 0}`;
}

function isAnthropicRouted(model) {
	return isAnthropicSandModelId(model);
}

/** Decode Shell args and require an echo/printf of the probe token (no fabricated command). */
function parseValidatedShellArgs(call, token) {
	const raw = typeof call?.args === "string" ? call.args.trim() : "";
	if (!raw) return { ok: false, reason: "empty-shell-args" };
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "shell-args-not-json" };
	}
	const command = typeof parsed?.command === "string" ? parsed.command : "";
	if (!command) return { ok: false, reason: "shell-args-missing-command" };
	// Reject redirects that discard stdout; require the token as an echo/printf argv.
	if (/(?:^|[\s;|&])(?:tee\b|>|>>)/.test(command.replace(/\$\(.*?\)/g, ""))) {
		return { ok: false, reason: "shell-redirect-or-tee" };
	}
	const echoesToken =
		new RegExp(
			String.raw`(?:^|[\s;|&])(?:echo|printf)\b(?:\s+(?:-[nEe]+))*\s+(?:(['"])${token}\1|${token})(?:\s|$|[;&|])`,
		).test(command) || new RegExp(String.raw`(?:^|[\s;|&])(?:echo|printf)\b[^\n#]*\b${token}\b`).test(command);
	if (!echoesToken) return { ok: false, reason: "shell-command-missing-token" };
	return { ok: true, args: { command }, result: `${token}\n` };
}

async function testModel(token, cfg, modelId, tools, label) {
	const requestedModel = resolveGrokbotRequestedModel(modelId, {
		sandParameterIds: ["thinking", "context", "effort", "fast"],
		effort: "low",
	});
	const wired = applyAnthropicSandToolWire({ requestedModel, tools, modelId, ompTools: tools }, "keep-model");

	// Wire invariants
	const toolNames = wired.tools.map(t => t.name);
	const wireOk =
		wired.requestedModel.modelId === modelId &&
		wired.subagentType === undefined &&
		wired.automationId === undefined &&
		(wired.acceptedUnadvertisedToolNames?.length ?? 0) > 20 &&
		wired.tools.every(t => t.parameters?.jsonSchema);

	if (!wireOk) {
		return { modelId, pass: false, reason: "wire-fail", wire: describeWire(wired), routed: "" };
	}

	const conversationId = crypto.randomUUID();
	const systemText = prompt.render(codingAgentSystemPrompt).trim();
	const userText = prompt.render(shellEchoUserPrompt, { token: "probe-ok" }).trim();

	// Turn 1: ask model to call Shell
	const body1 = {
		messages: [
			{ role: 4, text: systemText },
			{ role: 1, text: userText },
		],
		tools: wired.tools,
		requestedModel: wired.requestedModel,
		invocationId: crypto.randomUUID(),
		conversationId,
		acceptedUnadvertisedToolNames: wired.acceptedUnadvertisedToolNames,
		modelConfig: { maxTokens: 512 },
	};

	const { res: res1, parsed: parsed1 } = await sendStream(token, cfg, body1);

	if (!res1.ok || !parsed1.ok) {
		return {
			modelId,
			pass: false,
			reason: `turn1-http-${res1.status}`,
			wire: describeWire(wired),
			routed: parsed1.responseModel,
			err: parsed1.message,
		};
	}

	const shellCall = parsed1.toolCalls.find(t => t.name === "Shell");
	if (!shellCall) {
		return {
			modelId,
			pass: false,
			reason: `no-shell-call(${parsed1.toolCalls.map(t => t.name).join(",")})`,
			wire: describeWire(wired),
			routed: parsed1.responseModel,
		};
	}

	const validated = parseValidatedShellArgs(shellCall, "probe-ok");
	if (!validated.ok) {
		return {
			modelId,
			pass: false,
			reason: validated.reason,
			wire: describeWire(wired),
			routed: parsed1.responseModel,
			detail: (shellCall.args || "").slice(0, 160),
		};
	}

	// Turn 2: replay the model's exact Shell args + a result matching that command.
	const shellArgs = validated.args;
	const body2 = {
		messages: [
			{ role: 4, text: systemText },
			{ role: 1, text: userText },
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
					parts: [{ toolCallId: shellCall.id, toolName: "Shell", result: validated.result }],
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

	const routedModel = parsed2.responseModel || parsed1.responseModel;
	const routedAnthropic = isAnthropicRouted(routedModel);
	// History replay is only proven if turn 2 emits a final answer with the probe token.
	const finalResponse = parsed2.toolCalls.length === 0 && (parsed2.text || "").includes("probe-ok");

	const pass = res2.ok && parsed2.ok && routedAnthropic && finalResponse;
	return {
		modelId,
		pass,
		reason: pass
			? "ok"
			: !finalResponse
				? parsed2.toolCalls.length > 0
					? `turn2-retried-tools(${parsed2.toolCalls.map(t => t.name).join(",")})`
					: "turn2-missing-token"
				: `turn2-http-${res2.status}-${routedModel}`,
		wire: describeWire(wired),
		routed: routedModel,
		toolCallId: shellCall.id,
		tools: toolNames.join(","),
		err: parsed2.message,
	};
}

async function main() {
	const cfg = await loadGrokbotConfig();
	console.log(
		`config: machineId=${cfg.machineId.slice(0, 8)}… namespace=${cfg.namespace} client=${cfg.clientVersion}`,
	);
	const token = await mintGrokbotAccessToken(cfg, fetch, "inference");
	console.log(`token minted ✓`);

	// Fetch all available models
	console.log(`\nfetching AvailableModels…`);
	const allModels = await fetchAvailableModels(token, cfg);
	console.log(`total models: ${allModels.length}`);

	// Filter to Anthropic
	const anthropicModels = allModels.filter(m => isAnthropicSandModelId(m.id));
	console.log(`anthropic models: ${anthropicModels.length}`);
	for (const m of anthropicModels) {
		console.log(`  ${m.id}`);
	}

	if (anthropicModels.length === 0) {
		console.log(`\nFAIL: no anthropic models found in AvailableModels`);
		process.exitCode = 1;
		return;
	}

	// Test each with standard tools
	console.log(`\n${"=".repeat(60)}`);
	console.log(`=== Standard tool set (bash/read/write/edit/grep/glob → 5 product) ===`);
	const results = [];
	for (const m of anthropicModels) {
		const r = await testModel(token, cfg, m.id, ompTools, "standard");
		console.log(
			`  ${r.pass ? "PASS" : "FAIL"}  ${m.id}  routed=${r.routed}  tools=${r.tools || "?"}  reason=${r.reason}  err=${r.err || "-"}`,
		);
		results.push({ ...r, set: "standard" });
	}

	// Test a representative subset with extended tools (adds unmapped todoWrite/webSearch/webFetch)
	console.log(`\n${"=".repeat(60)}`);
	console.log(`=== Extended tool set (+todoWrite/webSearch/webFetch unmapped passthrough) ===`);
	const extendedSubset = anthropicModels.filter(
		m =>
			["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"].includes(m.id) ||
			anthropicModels.length <= 6,
	);
	for (const m of extendedSubset.length > 0 ? extendedSubset : anthropicModels.slice(0, 4)) {
		const r = await testModel(token, cfg, m.id, ompToolsExtended, "extended");
		console.log(
			`  ${r.pass ? "PASS" : "FAIL"}  ${m.id}  routed=${r.routed}  tools=${r.tools || "?"}  reason=${r.reason}  err=${r.err || "-"}`,
		);
		results.push({ ...r, set: "extended" });
	}

	// Summary
	console.log(`\n${"=".repeat(60)}`);
	console.log(`=== SUMMARY ===`);
	let passCount = 0;
	let failCount = 0;
	const failures = [];
	for (const r of results) {
		if (r.pass) {
			passCount++;
		} else {
			failCount++;
			failures.push(r);
		}
	}
	console.log(`  ${passCount} pass, ${failCount} fail out of ${results.length} tests`);
	if (failures.length > 0) {
		console.log(`\n  FAILURES:`);
		for (const f of failures) {
			console.log(`    ${f.modelId} [${f.set}]: ${f.reason} routed=${f.routed} err=${f.err || "-"}`);
		}
	}

	if (failCount === 0) {
		console.log(`\nFULL_ANTHROPIC_PROBE_PASS`);
	} else {
		console.log(`\nFULL_ANTHROPIC_PROBE_FAIL`);
		process.exitCode = 1;
	}
}

await main();
