#!/usr/bin/env bun
/**
 * Live grokbot multi-model matrix for ompa / sand InferenceService.
 *
 * Usage:
 *   bun scripts/grokbot-matrix.mjs --mode text|tools|opus-tools|ompa-smoke|ompa-integration|all
 *
 * Success markers (EXPECT tokens):
 *   MATRIX_TEXT_PASS | MATRIX_TOOLS_PASS | MATRIX_OPUS_TOOLS_PASS | OMPA_SMOKE_PASS | OMPA_INTEGRATION_PASS
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	GROKBOT_BACKEND,
	createGrokbotChecksum,
	grokbotClientHeaders,
	joinGrokbotBackendUrl,
	loadGrokbotConfig,
	mintGrokbotAccessToken,
} from "../packages/catalog/src/discovery/grokbot-auth.ts";
import { applyAnthropicSandToolWire } from "../packages/ai/src/providers/grokbot/anthropic-sand-wire.ts";
import { resolveGrokbotRequestedModel } from "../packages/ai/src/providers/grokbot/model-request.ts";
import {
	CONNECT_END_STREAM_FLAG,
	decodeInferenceStreamResponse,
	encodeInferenceStreamRequest,
	frameConnectProto,
} from "../packages/ai/src/providers/grokbot/proto.ts";

const ROOT = resolve(import.meta.dir, "..");
const STREAM = "/aiserver.v1.InferenceService/Stream";
const TOKEN = "pong42";

/** Models exercised for tool-capable agent use (non-Anthropic sand paths). */
const TOOL_MODELS = [
	{ id: "grok-4.6", sandParameterIds: ["effort", "fast"], effort: "low" },
	{ id: "composer-2.5", sandParameterIds: ["fast"] },
	{ id: "gemini-3.7-flash", sandParameterIds: ["effort"], effort: "low" },
	{ id: "gpt-5.6-sol", sandParameterIds: ["reasoning", "context", "fast"], effort: "low" },
	{ id: "kimi-k3", sandParameterIds: ["reasoning"], effort: "low" },
	{ id: "glm-5.2", sandParameterIds: ["reasoning"], effort: "high" },
];

/** grok-4.5 text works; tools return sand HTTP 422 (upstream). */
const GROK45_INFO = { id: "grok-4.5", sandParameterIds: ["effort", "fast"], effort: "low" };

/** Anthropic family — text-only is expected to pass; tools currently 400 upstream. */
const CLAUDE_TEXT_MODELS = [
	{ id: "claude-opus-5", sandParameterIds: ["thinking", "context", "effort", "fast"], effort: "low" },
	{ id: "claude-sonnet-5", sandParameterIds: ["thinking", "context", "effort"], effort: "low" },
	{ id: "claude-haiku-4-5", sandParameterIds: ["thinking"] },
];

const mode = (() => {
	const i = process.argv.indexOf("--mode");
	return i >= 0 ? process.argv[i + 1] : "all";
})();

function parseFrames(buf) {
	let o = 0;
	let texts = "";
	let end;
	let responseModel = "";
	const toolNames = [];
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
		} else {
			try {
				const msg = decodeInferenceStreamResponse(bytes);
				if (msg.textPart?.text) texts += msg.textPart.text;
				if (msg.responseInfo?.model) responseModel = String(msg.responseInfo.model);
				if (msg.toolCallPart?.toolName) toolNames.push(String(msg.toolCallPart.toolName));
			} catch {
				/* ignore partial */
			}
		}
	}
	const dbg = end?.error?.details?.[0]?.debug;
	return {
		ok: end !== undefined && !end?.parseError && !end?.error && o === buf.length,
		texts,
		responseModel,
		toolNames,
		message: end?.error?.message,
		status: dbg?.details?.additionalInfo?.providerStatusCode,
		providerError: dbg?.error,
		detail: dbg?.details?.detail,
	};
}

async function sandProbe({ id, sandParameterIds, effort, tools }) {
	const cfg = await loadGrokbotConfig();
	const token = await mintGrokbotAccessToken(cfg, fetch, GROKBOT_BACKEND);
	const headers = {
		...grokbotClientHeaders(cfg),
		authorization: `Bearer ${token}`,
		"x-cursor-checksum": createGrokbotChecksum(cfg.machineId),
		"x-ghost-mode": "true",
		"content-type": "application/connect+proto",
		accept: "application/connect+proto",
		"connect-protocol-version": "1",
		"x-request-id": crypto.randomUUID(),
	};
	// Omit `fast`/`thinking` so resolveGrokbotRequestedModel applies catalog defaults:
	// thinking models → thinking=true when effort is set, fast=false;
	// Grok/composer/etc → fast=true. Explicit fast=false on Grok+tools → HTTP 422.
	const requestedModel = resolveGrokbotRequestedModel(id, {
		effort,
		sandParameterIds,
		sandMaxMode: false,
	});
	const body = {
		messages: [
			{ role: 4, text: "You are a concise assistant." },
			{ role: 1, text: `Reply with exactly: ${TOKEN}. Do not call tools.` },
		],
		tools: tools
			? [
					{
						name: "read",
						description: "Read a file from disk.",
						parameters: {
							type: "object",
							properties: { path: { type: "string", description: "Absolute path" } },
							required: ["path"],
						},
					},
				]
			: [],
		requestedModel,
		modelConfig: { maxTokens: 256 },
		invocationId: crypto.randomUUID(),
		conversationId: crypto.randomUUID(),
	};
	const res = await fetch(joinGrokbotBackendUrl(GROKBOT_BACKEND, STREAM), {
		method: "POST",
		headers,
		body: frameConnectProto(encodeInferenceStreamRequest(body)),
	});
	const result = parseFrames(Buffer.from(await res.arrayBuffer()));
	const hasToken = result.texts.includes(TOKEN) || result.texts.toLowerCase().includes("pong");
	return { id, tools: Boolean(tools), ...result, hasToken, pass: result.ok && hasToken };
}

function resolveOmpaBin() {
	if (process.env.OMPA_BIN) return process.env.OMPA_BIN;
	const dist = resolve(ROOT, "packages/coding-agent/dist/omp");
	if (existsSync(dist)) return dist;
	return `${process.env.HOME}/.local/bin/ompa`;
}

function runOmpa(args, { timeout = 120_000, cwd = ROOT } = {}) {
	const ompa = resolveOmpaBin();
	const r = Bun.spawnSync([ompa, ...args], {
		cwd,
		encoding: "utf8",
		timeout,
		env: { ...process.env, PI_NO_MCP: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = `${r.stdout?.toString() ?? ""}\n${r.stderr?.toString() ?? ""}`;
	return { status: r.exitCode, out, signal: r.signalCode };
}

function ompaPrint(model, { tools = false, thinking = "low", prompt = `Reply with exactly: ${TOKEN}` } = {}) {
	const args = [
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-title",
		...(tools ? [] : ["--no-tools"]),
		"--model",
		model,
		"--thinking",
		thinking,
		prompt,
	];
	const r = runOmpa(args);
	const pass = r.status === 0 && r.out.includes(TOKEN);
	return { model, tools, status: r.status, pass, out: r.out.slice(-600) };
}

function ompaSmoke(model) {
	return ompaPrint(model);
}

function printRow(row) {
	const flag = row.pass ? "PASS" : "FAIL";
	const extra = row.pass
		? row.responseModel || ""
		: `${row.message || ""} ${row.providerError || ""} ${row.status || ""} ${row.detail || ""}`.trim();
	console.log(`${flag}  ${row.tools ? "tools" : "text "}  ${row.id.padEnd(28)} ${extra}`);
}

async function runText() {
	console.log("=== TEXT MATRIX ===");
	const rows = [];
	for (const m of [...TOOL_MODELS, ...CLAUDE_TEXT_MODELS, GROK45_INFO]) {
		const row = await sandProbe({ ...m, tools: false });
		printRow(row);
		rows.push(row);
	}
	const failed = rows.filter(r => !r.pass);
	if (failed.length) {
		console.error("TEXT failures:", failed.map(f => f.id).join(", "));
		process.exitCode = 1;
		return;
	}
	console.log("MATRIX_TEXT_PASS");
}

async function runTools() {
	console.log("=== TOOLS MATRIX (non-Anthropic) ===");
	const rows = [];
	for (const m of TOOL_MODELS) {
		const row = await sandProbe({ ...m, tools: true });
		printRow(row);
		rows.push(row);
	}
	// grok-4.5 tools: expected upstream failure — record but do not fail the gate.
	console.log("=== GROK-4.5 TOOLS (informational; upstream sand HTTP 422) ===");
	{
		const row = await sandProbe({ ...GROK45_INFO, tools: true });
		printRow({ ...row, pass: false });
		if (row.ok) console.log("UNEXPECTED_GROK45_TOOLS_OK");
	}
	console.log("=== CLAUDE TOOLS (informational; upstream Anthropic adapter) ===");
	for (const m of CLAUDE_TEXT_MODELS) {
		const row = await sandProbe({ ...m, tools: true });
		printRow({ ...row, pass: false }); // display only
		if (row.ok) {
			console.log(`UNEXPECTED_CLAUDE_TOOLS_OK ${m.id}`);
		}
	}
	const failed = rows.filter(r => !r.pass);
	if (failed.length) {
		console.error("TOOLS failures:", failed.map(f => f.id).join(", "));
		process.exitCode = 1;
		return;
	}
	console.log("MATRIX_TOOLS_PASS");
}

const AUTOMATION_OMP_TOOLS = [
	{
		name: "bash",
		description: "Run a shell command.",
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		},
	},
	{
		name: "read",
		description: "Read a file.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
];

async function sandAutomationProbe() {
	const cfg = await loadGrokbotConfig();
	const token = await mintGrokbotAccessToken(cfg, fetch, GROKBOT_BACKEND);
	const headers = {
		...grokbotClientHeaders(cfg),
		authorization: `Bearer ${token}`,
		"x-cursor-checksum": createGrokbotChecksum(cfg.machineId),
		"x-ghost-mode": "true",
		"content-type": "application/connect+proto",
		accept: "application/connect+proto",
		"connect-protocol-version": "1",
		"x-request-id": crypto.randomUUID(),
	};
	const requestedModel = resolveGrokbotRequestedModel("claude-opus-5", {
		effort: "low",
		sandParameterIds: ["thinking", "context", "effort", "fast"],
		sandMaxMode: false,
	});
	const wired = applyAnthropicSandToolWire(
		{
			requestedModel,
			tools: AUTOMATION_OMP_TOOLS,
			modelId: "claude-opus-5",
			ompTools: AUTOMATION_OMP_TOOLS,
		},
		"automation",
	);
	const body = {
		messages: [
			{ role: 4, text: "You are a coding agent." },
			{ role: 1, text: "Use Shell to run: echo opus-tools-matrix. Reply briefly after." },
		],
		tools: wired.tools,
		requestedModel: wired.requestedModel,
		subagentType: wired.subagentType,
		automationId: wired.automationId,
		acceptedUnadvertisedToolNames: wired.acceptedUnadvertisedToolNames,
		modelConfig: { maxTokens: 512 },
		invocationId: crypto.randomUUID(),
		conversationId: crypto.randomUUID(),
	};
	const res = await fetch(joinGrokbotBackendUrl(GROKBOT_BACKEND, STREAM), {
		method: "POST",
		headers,
		body: frameConnectProto(encodeInferenceStreamRequest(body)),
	});
	const result = parseFrames(Buffer.from(await res.arrayBuffer()));
	const sawShell = result.toolNames?.includes("Shell");
	const pass = res.ok && result.ok && sawShell;
	return {
		id: "claude-opus-5:automation",
		tools: true,
		...result,
		toolNames: result.toolNames || [],
		pass,
	};
}

async function runOpusTools() {
	console.log("=== OPUS AUTOMATION TOOLS (G5 sand probe) ===");
	const row = await sandAutomationProbe();
	printRow({
		...row,
		id: row.id,
		responseModel: `${row.responseModel || ""} tools=${(row.toolNames || []).join(",")}`,
	});
	if (!row.pass) {
		process.exitCode = 1;
		return;
	}
	console.log("=== OPUS OMPA SMOKE (G5 integration; requires grokbot renewal) ===");
	const prevWire = process.env.GROKBOT_ANTHROPIC_TOOLS_WIRE;
	process.env.GROKBOT_ANTHROPIC_TOOLS_WIRE = "automation";
	const g5 = ompaPrint("grokbot/claude-opus-5:max", {
		tools: true,
		thinking: "low",
		prompt: `Use bash to run: echo ${TOKEN}. Then reply with exactly: ${TOKEN}`,
	});
	if (prevWire === undefined) delete process.env.GROKBOT_ANTHROPIC_TOOLS_WIRE;
	else process.env.GROKBOT_ANTHROPIC_TOOLS_WIRE = prevWire;
	console.log(`${g5.pass ? "PASS" : "FAIL"}  G5  ompa  grokbot/claude-opus-5:max  exit=${g5.status}`);
	if (!g5.pass) console.log(g5.out);
	if (!g5.pass) {
		console.log("MATRIX_OPUS_TOOLS_SAND_PASS (ompa step failed; sand probe ok)");
		process.exitCode = 1;
		return;
	}
	console.log("MATRIX_OPUS_TOOLS_PASS");
}

function runOmpaSmoke() {
	console.log("=== OMPA SMOKE (G3) ===");
	const models = ["grokbot/grok-4.6", "grokbot/composer-2.5", "grokbot/gpt-5.6-sol"];
	const rows = models.map(ompaSmoke);
	for (const r of rows) {
		console.log(`${r.pass ? "PASS" : "FAIL"}  ompa  ${r.model}  exit=${r.status}`);
		if (!r.pass) console.log(r.out);
	}
	if (rows.some(r => !r.pass)) {
		process.exitCode = 1;
		return;
	}
	console.log("OMPA_SMOKE_PASS");
}

function runOmpaIntegration() {
	console.log("=== OMPA INTEGRATION (G5–G8) ===");
	const rows = [];

	// G5: agent turn with built-in tools enabled
	const g5 = ompaPrint("grokbot/grok-4.6", {
		tools: true,
		prompt: `Use bash to run: echo ${TOKEN}. Then reply with exactly: ${TOKEN}.`,
	});
	rows.push({ gate: "G5", label: "ompa tools grok-4.6", ...g5 });
	console.log(`${g5.pass ? "PASS" : "FAIL"}  G5  ompa+tools  grokbot/grok-4.6  exit=${g5.status}`);
	if (!g5.pass) console.log(g5.out);

	// G6: sand-default bare router
	const g6 = ompaPrint("grokbot/sand-default", {
		thinking: "off",
		prompt: `Reply with exactly: ${TOKEN}`,
	});
	rows.push({ gate: "G6", label: "sand-default", ...g6 });
	console.log(`${g6.pass ? "PASS" : "FAIL"}  G6  sand-default  exit=${g6.status}`);
	if (!g6.pass) console.log(g6.out);

	// G7: composer alias → composer-2.5
	const g7 = ompaPrint("grokbot/composer", { prompt: `Reply with exactly: ${TOKEN}` });
	rows.push({ gate: "G7", label: "composer alias", ...g7 });
	console.log(`${g7.pass ? "PASS" : "FAIL"}  G7  grokbot/composer  exit=${g7.status}`);
	if (!g7.pass) console.log(g7.out);

	// G8: live catalog lists sand routers + grok-4.6
	const g8r = runOmpa(["models", "grokbot", "--json"], { timeout: 180_000 });
	let g8pass = false;
	let g8detail = "";
	try {
		const payload = JSON.parse(g8r.out);
		const ids = new Set((payload.models || []).map(m => String(m.id)));
		const need = ["sand-default", "sand-cua", "sand-automation", "grok-4.6", "composer-2.5"];
		const missing = need.filter(id => !ids.has(id));
		g8pass = g8r.status === 0 && missing.length === 0;
		g8detail = g8pass ? `${ids.size} models` : `missing: ${missing.join(", ")}`;
	} catch {
		g8detail = g8r.out.slice(-200);
	}
	rows.push({ gate: "G8", pass: g8pass, status: g8r.status, detail: g8detail });
	console.log(`${g8pass ? "PASS" : "FAIL"}  G8  models grokbot  ${g8detail}  exit=${g8r.status}`);

	// G8b: bare Model.aliases selector (no grokbot/ prefix)
	const g8b = ompaPrint("composer", { prompt: `Reply with exactly: ${TOKEN}` });
	rows.push({ gate: "G8b", label: "bare composer alias", ...g8b });
	console.log(`${g8b.pass ? "PASS" : "FAIL"}  G8b  bare composer  exit=${g8b.status}`);
	if (!g8b.pass) console.log(g8b.out);

	if (rows.some(r => !r.pass)) {
		process.exitCode = 1;
		return;
	}
	console.log("OMPA_INTEGRATION_PASS");
}

if (mode === "text" || mode === "all") await runText();
if (mode === "tools" || mode === "all") await runTools();
if (mode === "opus-tools" || mode === "all") await runOpusTools();
if (mode === "ompa-smoke" || mode === "all") runOmpaSmoke();
if (mode === "ompa-integration" || mode === "all") runOmpaIntegration();
