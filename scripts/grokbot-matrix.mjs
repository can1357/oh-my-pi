#!/usr/bin/env bun
/**
 * Live grokbot multi-model matrix for ompa / sand InferenceService.
 *
 * Usage:
 *   bun scripts/grokbot-matrix.mjs --mode text|tools|ompa-smoke|all
 *
 * Success markers (EXPECT tokens):
 *   MATRIX_TEXT_PASS | MATRIX_TOOLS_PASS | OMPA_SMOKE_PASS
 */
import { spawnSync } from "node:child_process";
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
			} catch {
				/* ignore partial */
			}
		}
	}
	const dbg = end?.error?.details?.[0]?.debug;
	return {
		ok: !end?.error,
		texts,
		responseModel,
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

function ompaSmoke(model) {
	const ompa = resolveOmpaBin();
	const args = [
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-title",
		"--no-tools",
		"--model",
		model,
		"--thinking",
		"low",
		`Reply with exactly: ${TOKEN}`,
	];
	const r = spawnSync(ompa, args, {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env, PI_NO_MCP: "1" },
	});
	const out = `${r.stdout || ""}\n${r.stderr || ""}`;
	const pass = r.status === 0 && out.includes(TOKEN);
	return { model, status: r.status, pass, out: out.slice(-400) };
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

function runOmpaSmoke() {
	console.log("=== OMPA SMOKE ===");
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

if (mode === "text" || mode === "all") await runText();
if (mode === "tools" || mode === "all") await runTools();
if (mode === "ompa-smoke" || mode === "all") runOmpaSmoke();
