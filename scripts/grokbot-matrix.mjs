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
import { buildModel } from "../packages/catalog/src/build.ts";
import { fetchGrokbotAvailableModels } from "../packages/catalog/src/discovery/grokbot.ts";
import {
	GROKBOT_BACKEND,
	createGrokbotChecksum,
	grokbotClientHeaders,
	joinGrokbotBackendUrl,
	loadGrokbotConfig,
	mintGrokbotAccessToken,
} from "../packages/catalog/src/discovery/grokbot-auth.ts";
import { GROKBOT_API } from "../packages/catalog/src/provider-models/grokbot.ts";
import { applyAnthropicSandToolWire } from "../packages/ai/src/providers/grokbot/anthropic-sand-wire.ts";
import { resolveGrokbotRequestedModel } from "../packages/ai/src/providers/grokbot/model-request.ts";
import {
	CONNECT_END_STREAM_FLAG,
	decodeInferenceStreamResponse,
	encodeInferenceStreamRequest,
	frameConnectProto,
} from "../packages/ai/src/providers/grokbot/proto.ts";
import * as prompt from "../packages/utils/src/prompt.ts";
import textSystemPrompt from "./grokbot-catalog-matrix/text-system.md" with { type: "text" };
import textUserPrompt from "./grokbot-catalog-matrix/text-user.md" with { type: "text" };
import matrixOpusSystemPrompt from "./grokbot-probes/matrix-opus-system.md" with { type: "text" };
import matrixOpusShellUserPrompt from "./grokbot-probes/matrix-opus-shell-user.md" with { type: "text" };
import matrixBashThenTokenUserPrompt from "./grokbot-probes/matrix-bash-then-token-user.md" with { type: "text" };
import matrixToolReadDescription from "./grokbot-probes/matrix-tool-read-description.md" with { type: "text" };
import matrixToolReadPathDescription from "./grokbot-probes/matrix-tool-read-path-description.md" with { type: "text" };
import automationOmpToolBashDescription from "./grokbot-probes/automation-omp-tool-bash-description.md" with { type: "text" };
import automationOmpToolReadDescription from "./grokbot-probes/automation-omp-tool-read-description.md" with { type: "text" };

const ROOT = resolve(import.meta.dir, "..");
const STREAM = "/aiserver.v1.InferenceService/Stream";
const TOKEN = "pong42";
const TEXT_SYSTEM = prompt.render(textSystemPrompt).trim();
const TEXT_USER = prompt.render(textUserPrompt, { token: TOKEN }).trim();
const OPUS_SYSTEM = prompt.render(matrixOpusSystemPrompt).trim();
const OPUS_SHELL_USER = prompt.render(matrixOpusShellUserPrompt, { token: "opus-tools-matrix" }).trim();
const BASH_THEN_TOKEN_USER = prompt.render(matrixBashThenTokenUserPrompt, { token: TOKEN }).trim();

/** Probe id sets — wire params/effort come from live catalog + buildModel policy. */
const TOOL_MODEL_IDS = ["grok-4.6", "composer-2.5", "gemini-3.7-flash", "gpt-5.6-sol", "kimi-k3", "glm-5.2"];
const CLAUDE_TEXT_MODEL_IDS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
const GROK45_ID = "grok-4.5";

/**
 * Build a matrix probe row from discovered/built catalog metadata.
 * Falls back to a neutral spec + buildModel so offline KDL still supplies
 * sand-parameter-ids / effort when AvailableModels omits the id.
 */
function matrixRowFromCatalog(id, byId) {
	const built =
		byId.get(id) ??
		buildModel({
			id,
			name: id,
			api: GROKBOT_API,
			provider: "grokbot",
			baseUrl: GROKBOT_BACKEND,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		});
	const sandParameterIds = built.sandParameterIds ? [...built.sandParameterIds] : [];
	const efforts = built.thinking?.efforts ?? [];
	const defaultEffort = built.sandParameterDefaults?.effort ?? built.sandParameterDefaults?.reasoning;
	const effort =
		typeof defaultEffort === "string" && efforts.includes(defaultEffort)
			? defaultEffort
			: efforts.includes("low")
				? "low"
				: efforts[0];
	const sandParameterDefaults = built.sandParameterDefaults ? { ...built.sandParameterDefaults } : undefined;
	const sandMaxMode = built.sandMaxMode === true;
	return {
		id,
		sandParameterIds,
		...(effort ? { effort } : {}),
		...(sandParameterDefaults ? { sandParameterDefaults } : {}),
		...(sandMaxMode ? { sandMaxMode: true } : {}),
	};
}

async function loadMatrixCatalogRows() {
	const specs = await fetchGrokbotAvailableModels({ timeoutMs: 30_000 });
	const byId = new Map((specs ?? []).map(spec => [spec.id, buildModel(spec)]));
	return {
		TOOL_MODELS: TOOL_MODEL_IDS.map(id => matrixRowFromCatalog(id, byId)),
		CLAUDE_TEXT_MODELS: CLAUDE_TEXT_MODEL_IDS.map(id => matrixRowFromCatalog(id, byId)),
		GROK45_INFO: matrixRowFromCatalog(GROK45_ID, byId),
	};
}

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

async function sandProbe({ id, sandParameterIds, effort, sandParameterDefaults, sandMaxMode, tools }) {
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
	// Omit explicit `fast`/`thinking`/`context` so resolveGrokbotRequestedModel
	// applies live AvailableModels defaults (and sandMaxMode) from the catalog row.
	const requestedModel = resolveGrokbotRequestedModel(id, {
		effort,
		sandParameterIds,
		sandParameterDefaults,
		sandMaxMode: sandMaxMode === true,
	});
	const body = {
		messages: [
			{ role: 4, text: TEXT_SYSTEM },
			{ role: 1, text: TEXT_USER },
		],
		tools: tools
			? [
					{
						name: "read",
						description: matrixToolReadDescription.trim(),
						parameters: {
							type: "object",
							properties: {
								path: { type: "string", description: matrixToolReadPathDescription.trim() },
							},
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
	const hasToken = result.texts.includes(TOKEN);
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

function ompaPrint(model, { tools = false, thinking = "low", promptText = TEXT_USER } = {}) {
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
		promptText,
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

async function runText(catalog) {
	console.log("=== TEXT MATRIX ===");
	const { TOOL_MODELS, CLAUDE_TEXT_MODELS, GROK45_INFO } = catalog;
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

async function runTools(catalog) {
	console.log("=== TOOLS MATRIX (non-Anthropic) ===");
	const { TOOL_MODELS, CLAUDE_TEXT_MODELS, GROK45_INFO } = catalog;
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
		description: automationOmpToolBashDescription.trim(),
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		},
	},
	{
		name: "read",
		description: automationOmpToolReadDescription.trim(),
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
];

async function sandAutomationProbe(catalog) {
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
	const opus =
		catalog.CLAUDE_TEXT_MODELS.find(m => m.id === "claude-opus-5") ??
		matrixRowFromCatalog("claude-opus-5", new Map());
	const requestedModel = resolveGrokbotRequestedModel("claude-opus-5", {
		effort: opus.effort,
		sandParameterIds: opus.sandParameterIds,
		sandParameterDefaults: opus.sandParameterDefaults,
		sandMaxMode: opus.sandMaxMode === true,
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
			{ role: 4, text: OPUS_SYSTEM },
			{ role: 1, text: OPUS_SHELL_USER },
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

async function runOpusTools(catalog) {
	console.log("=== OPUS AUTOMATION TOOLS (G5 sand probe) ===");
	const row = await sandAutomationProbe(catalog);
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
		promptText: BASH_THEN_TOKEN_USER,
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
		promptText: BASH_THEN_TOKEN_USER,
	});
	rows.push({ gate: "G5", label: "ompa tools grok-4.6", ...g5 });
	console.log(`${g5.pass ? "PASS" : "FAIL"}  G5  ompa+tools  grokbot/grok-4.6  exit=${g5.status}`);
	if (!g5.pass) console.log(g5.out);

	// G6: sand-default bare router
	const g6 = ompaPrint("grokbot/sand-default", {
		thinking: "off",
		promptText: TEXT_USER,
	});
	rows.push({ gate: "G6", label: "sand-default", ...g6 });
	console.log(`${g6.pass ? "PASS" : "FAIL"}  G6  sand-default  exit=${g6.status}`);
	if (!g6.pass) console.log(g6.out);

	// G7: composer alias → composer-2.5
	const g7 = ompaPrint("grokbot/composer", { promptText: TEXT_USER });
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
	const g8b = ompaPrint("composer", { promptText: TEXT_USER });
	rows.push({ gate: "G8b", label: "bare composer alias", ...g8b });
	console.log(`${g8b.pass ? "PASS" : "FAIL"}  G8b  bare composer  exit=${g8b.status}`);
	if (!g8b.pass) console.log(g8b.out);

	if (rows.some(r => !r.pass)) {
		process.exitCode = 1;
		return;
	}
	console.log("OMPA_INTEGRATION_PASS");
}

const needsCatalog = mode === "text" || mode === "tools" || mode === "opus-tools" || mode === "all";
const catalog = needsCatalog ? await loadMatrixCatalogRows() : null;
if (mode === "text" || mode === "all") await runText(catalog);
if (mode === "tools" || mode === "all") await runTools(catalog);
if (mode === "opus-tools" || mode === "all") await runOpusTools(catalog);
if (mode === "ompa-smoke" || mode === "all") runOmpaSmoke();
if (mode === "ompa-integration" || mode === "all") runOmpaIntegration();
