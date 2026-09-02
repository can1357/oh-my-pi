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
import * as fs from "node:fs";
import * as path from "node:path";
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

// ─── Inlined auth (avoids @oh-my-pi/pi-utils barrel → pi_natives) ───

const GROKBOT_BACKEND = "https://api2.cursor.sh";
const GROKBOT_RENEWAL_PATH = "/sand-box/inference-credential";
const GROKBOT_AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";
const GROKBOT_CLIENT_TYPE = "sand";
const GROKBOT_STAMPED_CLIENT_VERSION = "0.30.0-pre.16";
const GROKBOT_DEFAULT_NAMESPACE = "prod";
const STAMPED_VERSION_BASE = /^(\d+\.\d+\.\d+)(?:-.+)?$/;

function stampedVersionBaseOf(stamped) {
	const match = STAMPED_VERSION_BASE.exec(stamped?.trim() ?? "");
	return match?.[1];
}

function resolveGrokbotClientVersion(namespace, stamped, explicitOverride) {
	if (explicitOverride?.trim()) return explicitOverride.trim();
	const base = stampedVersionBaseOf(stamped) ?? stamped;
	switch (namespace) {
		case "dev": return `${base}-dev`;
		case "lab": return `${base}-lab`;
		default: return base;
	}
}

function parseEnvFile(filePath) {
	const text = fs.readFileSync(filePath, "utf8");
	const out = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
	}
	return out;
}

function grokbotSecretsPath() {
	const agentDir = process.env.OMP_AGENT_DIR || path.join(process.env.HOME, ".omp", "agent");
	return path.join(agentDir, "secrets", "grokbot.env");
}

function loadGrokbotConfig() {
	const file = parseEnvFile(grokbotSecretsPath());
	const namespace = process.env.GROKBOT_NAMESPACE || file.GROKBOT_NAMESPACE || GROKBOT_DEFAULT_NAMESPACE;
	const explicitVersion = process.env.GROKBOT_CLIENT_VERSION || file.GROKBOT_CLIENT_VERSION || undefined;
	return {
		renewal:
			process.env.GROKBOT_RENEWAL_CREDENTIAL ||
			process.env.SAND_INFERENCE_RENEWAL_CREDENTIAL ||
			file.GROKBOT_RENEWAL_CREDENTIAL ||
			file.SAND_INFERENCE_RENEWAL_CREDENTIAL ||
			"",
		machineId: process.env.GROKBOT_MACHINE_ID || file.GROKBOT_MACHINE_ID || "",
		namespace,
		clientVersion: resolveGrokbotClientVersion(namespace, GROKBOT_STAMPED_CLIENT_VERSION, explicitVersion),
	};
}

function grokbotClientHeaders(cfg) {
	return {
		"x-cursor-client-type": GROKBOT_CLIENT_TYPE,
		"x-cursor-client-version": cfg.clientVersion,
		"x-sand-box-namespace": cfg.namespace,
	};
}

function enhancedObfuscate(bytes) {
	let lastByte = 165;
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = (bytes[i] ^ lastByte) + (i % 256);
		lastByte = bytes[i];
	}
	return bytes;
}

function createGrokbotChecksum(machineId, nowMs = Date.now()) {
	const uks = Math.floor(nowMs / 1e6);
	const bytes = Uint8Array.from([
		(uks >> 8) & 255, (uks) & 255,
		(uks >> 24) & 255, (uks >> 16) & 255,
		(uks >> 8) & 255, (uks) & 255,
	]);
	const checksum = Buffer.from(enhancedObfuscate(bytes)).toString("base64url");
	return `${checksum}${machineId}`;
}

function joinGrokbotBackendUrl(baseUrl, p) {
	const normalized = (baseUrl.trim() || GROKBOT_BACKEND).replace(/\/+$/, "") || GROKBOT_BACKEND;
	const suffix = p.startsWith("/") ? p : `/${p}`;
	return new URL(`${normalized}${suffix}`);
}

async function mintGrokbotAccessToken(cfg) {
	if (!cfg.renewal) throw new Error(`Grok Bot renewer missing. Read ${grokbotSecretsPath()}`);
	const response = await fetch(joinGrokbotBackendUrl(GROKBOT_BACKEND, GROKBOT_RENEWAL_PATH), {
		method: "POST",
		headers: { "content-type": "application/json", ...grokbotClientHeaders(cfg) },
		body: JSON.stringify({ credential: cfg.renewal }),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Grok Bot token renew failed (HTTP ${response.status}): ${body.slice(0, 200)}`);
	}
	const parsed = await response.json();
	const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken : "";
	if (!accessToken) throw new Error("Grok Bot token renew returned no accessToken");
	return accessToken;
}

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
	return models.map((m) => ({
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

// ─── Tool sets ───

// Standard 6 omp tools (maps to 5 product tools — edit+write dedupe to Write)
const ompTools = [
	{ name: "bash", description: "Run a shell command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
	{ name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	{ name: "write", description: "Write a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
	{ name: "edit", description: "Patch a file.", parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] } },
	{ name: "grep", description: "Search files.", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
	{ name: "glob", description: "Find files.", parameters: { type: "object", properties: { glob: { type: "string" } }, required: ["glob"] } },
];

// Extended set: adds unmapped tools (todoWrite, webSearch, webFetch) that pass
// through with their original names + jsonSchema. These are in the field-9
// allowlist so sand should accept them as unadvertised tools.
const ompToolsExtended = [
	...ompTools,
	{ name: "todoWrite", description: "Write a todo list.", parameters: { type: "object", properties: { todos: { type: "array" } }, required: ["todos"] } },
	{ name: "webSearch", description: "Search the web.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
	{ name: "webFetch", description: "Fetch a URL.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
];

// ─── Tests ───

function describeWire(wired) {
	const toolNames = (wired.tools || []).map((t) => t.name);
	return `model=${wired.requestedModel?.modelId} tools=[${toolNames.join(",")}] field9=${wired.acceptedUnadvertisedToolNames?.length || 0}`;
}

function isAnthropicRouted(model) {
	return isAnthropicSandModelId(model) || /claude|fable|opus|sonnet|haiku|mythos|anthropic/i.test(model);
}

async function testModel(token, cfg, modelId, tools, label) {
	const requestedModel = resolveGrokbotRequestedModel(modelId, {
		sandParameterIds: ["thinking", "context", "effort", "fast"],
		effort: "low",
	});
	const wired = applyAnthropicSandToolWire(
		{ requestedModel, tools, modelId, ompTools: tools },
		"keep-model",
	);

	// Wire invariants
	const toolNames = wired.tools.map((t) => t.name);
	const wireOk =
		wired.requestedModel.modelId === modelId &&
		wired.subagentType === undefined &&
		wired.automationId === undefined &&
		(wired.acceptedUnadvertisedToolNames?.length ?? 0) > 20 &&
		wired.tools.every((t) => t.parameters?.jsonSchema);

	if (!wireOk) {
		return { modelId, pass: false, reason: "wire-fail", wire: describeWire(wired), routed: "" };
	}

	const conversationId = crypto.randomUUID();

	// Turn 1: ask model to call Shell
	const body1 = {
		messages: [
			{ role: 4, text: "You are a coding agent with shell, read, write, grep, and glob tools." },
			{ role: 1, text: `Use the Shell tool to run: echo probe-ok. Do not explain, just call the tool.` },
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
		return { modelId, pass: false, reason: `turn1-http-${res1.status}`, wire: describeWire(wired), routed: parsed1.responseModel, err: parsed1.message };
	}

	const shellCall = parsed1.toolCalls.find((t) => t.name === "Shell");
	if (!shellCall) {
		return { modelId, pass: false, reason: `no-shell-call(${parsed1.toolCalls.map((t) => t.name).join(",")})`, wire: describeWire(wired), routed: parsed1.responseModel };
	}

	// Turn 2: feed tool result back
	const body2 = {
		messages: [
			{ role: 4, text: "You are a coding agent with shell, read, write, grep, and glob tools." },
			{ role: 1, text: `Use the Shell tool to run: echo probe-ok. Do not explain, just call the tool.` },
			{ role: 2, toolCallPart: { toolName: "Shell", toolCallId: shellCall.id, input: JSON.stringify({ command: "echo probe-ok" }) } },
			{ role: 3, toolResponse: { toolCallId: shellCall.id, content: "probe-ok" } },
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

	const pass = res2.ok && parsed2.ok && routedAnthropic;
	return {
		modelId,
		pass,
		reason: pass ? "ok" : `turn2-http-${res2.status}-${routedModel}`,
		wire: describeWire(wired),
		routed: routedModel,
		toolCallId: shellCall.id,
		tools: toolNames.join(","),
		err: parsed2.message,
	};
}

async function main() {
	const cfg = loadGrokbotConfig();
	console.log(`config: machineId=${cfg.machineId.slice(0, 8)}… namespace=${cfg.namespace} client=${cfg.clientVersion}`);
	const token = await mintGrokbotAccessToken(cfg);
	console.log(`token minted ✓`);

	// Fetch all available models
	console.log(`\nfetching AvailableModels…`);
	const allModels = await fetchAvailableModels(token, cfg);
	console.log(`total models: ${allModels.length}`);

	// Filter to Anthropic
	const anthropicModels = allModels.filter((m) => isAnthropicSandModelId(m.id));
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
		console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${m.id}  routed=${r.routed}  tools=${r.tools || "?"}  reason=${r.reason}  err=${r.err || "-"}`);
		results.push({ ...r, set: "standard" });
	}

	// Test a representative subset with extended tools (adds unmapped todoWrite/webSearch/webFetch)
	console.log(`\n${"=".repeat(60)}`);
	console.log(`=== Extended tool set (+todoWrite/webSearch/webFetch unmapped passthrough) ===`);
	const extendedSubset = anthropicModels.filter((m) =>
		["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"].includes(m.id) ||
		anthropicModels.length <= 6
	);
	for (const m of extendedSubset.length > 0 ? extendedSubset : anthropicModels.slice(0, 4)) {
		const r = await testModel(token, cfg, m.id, ompToolsExtended, "extended");
		console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${m.id}  routed=${r.routed}  tools=${r.tools || "?"}  reason=${r.reason}  err=${r.err || "-"}`);
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
