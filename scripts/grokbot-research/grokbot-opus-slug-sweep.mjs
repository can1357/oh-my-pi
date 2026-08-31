#!/usr/bin/env bun
/**
 * Probe all claude-opus-5* slug variants for field-2 tool support on sand Stream.
 * Uses live AvailableModels to discover legacy slugs + variant params.
 */
import {
	GROKBOT_BACKEND,
	createGrokbotChecksum,
	grokbotClientHeaders,
	joinGrokbotBackendUrl,
	loadGrokbotConfig,
	mintGrokbotAccessToken,
} from "../../packages/catalog/src/discovery/grokbot-auth.ts";
import {
	decodeGrokbotAvailableModelsResponse,
	encodeGrokbotAvailableModelsRequest,
	GROKBOT_AVAILABLE_MODELS_PATH,
} from "../../packages/catalog/src/discovery/grokbot-available-models.ts";
import { resolveGrokbotRequestedModel } from "../../packages/ai/src/providers/grokbot/model-request.ts";
import {
	CONNECT_END_STREAM_FLAG,
	decodeInferenceStreamResponse,
	encodeInferenceStreamRequest,
	fieldNumbers,
	frameConnectProto,
} from "../../packages/ai/src/providers/grokbot/proto.ts";

const STREAM = "/aiserver.v1.InferenceService/Stream";
const TOKEN = "pong42";
const PARAMS = ["thinking", "context", "effort", "fast"];

const tools = [
	{
		name: "read",
		description: "Read a file from disk.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Absolute path" } },
			required: ["path"],
		},
	},
];

const baseMessages = [
	{ role: 4, text: "You are a concise assistant." },
	{ role: 1, text: `Reply with exactly: ${TOKEN}. Do not call tools.` },
];

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
				/* ignore */
			}
		}
	}
	const dbg = end?.error?.details?.[0]?.debug;
	return {
		ok: !end?.error,
		texts,
		responseModel,
		status: dbg?.details?.additionalInfo?.providerStatusCode,
		providerError: dbg?.error,
		detail: dbg?.details?.detail,
		message: end?.error?.message,
	};
}

let cfg;
let headersBase;

async function initAuth() {
	cfg = await loadGrokbotConfig();
	const token = await mintGrokbotAccessToken(cfg, fetch, GROKBOT_BACKEND);
	headersBase = {
		...grokbotClientHeaders(cfg),
		authorization: `Bearer ${token}`,
		"x-cursor-checksum": createGrokbotChecksum(cfg.machineId),
		"x-ghost-mode": "true",
		"content-type": "application/connect+proto",
		accept: "application/connect+proto",
		"connect-protocol-version": "1",
	};
}

async function probe(label, body) {
	const protoBytes = encodeInferenceStreamRequest(body);
	const fields = [...new Set(fieldNumbers(protoBytes))].sort((a, b) => a - b);
	const res = await fetch(joinGrokbotBackendUrl(GROKBOT_BACKEND, STREAM), {
		method: "POST",
		headers: { ...headersBase, "x-request-id": crypto.randomUUID() },
		body: frameConnectProto(protoBytes),
	});
	const result = parseFrames(Buffer.from(await res.arrayBuffer()));
	const hasToken = result.texts.includes(TOKEN);
	return {
		label,
		wireModelId: body.requestedModel.modelId,
		params: body.requestedModel.parameters ?? [],
		maxMode: body.requestedModel.maxMode ?? false,
		tools: (body.tools?.length ?? 0) > 0,
		fields,
		...result,
		pass: result.ok && hasToken,
	};
}

function paramsFromVariant(variant) {
	const out = {};
	for (const p of variant.parameterValues ?? []) {
		if (p.id === "thinking") out.thinking = p.value === "true";
		else if (p.id === "context") out.context = p.value;
		else if (p.id === "effort") out.effort = p.value;
		else if (p.id === "fast") out.fast = p.value === "true";
	}
	return out;
}

function fmtParams(params) {
	if (!params?.length) return "(bare)";
	return params.map(p => `${p.id}=${p.value}`).join(",");
}

async function fetchOpusRow() {
	const token = await mintGrokbotAccessToken(cfg, fetch, GROKBOT_BACKEND);
	const res = await fetch(joinGrokbotBackendUrl(GROKBOT_BACKEND, GROKBOT_AVAILABLE_MODELS_PATH), {
		method: "POST",
		headers: {
			...headersBase,
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json",
		},
		body: encodeGrokbotAvailableModelsRequest({
			useModelParameters: true,
			includeLongContextModels: true,
		}),
	});
	const models = decodeGrokbotAvailableModelsResponse(await res.json());
	return models?.find(m => m.name === "claude-opus-5") ?? null;
}

/** Build test cases: slug-as-modelId (bare) + slug-as-modelId + matching params + canonical claude-opus-5 + params */
function buildCases(opusRow) {
	const cases = [];
	const seen = new Set();

	const add = (slug, opts, note) => {
		const key = `${slug}|${JSON.stringify(opts)}|${note}`;
		if (seen.has(key)) return;
		seen.add(key);
		cases.push({ slug, opts, note });
	};

	// Primary + id aliases
	add("claude-opus-5", {}, "canonical bare");
	for (const alias of opusRow.idAliases ?? []) {
		add(alias, {}, `alias bare`);
	}

	// Legacy slugs: bare wire id + matching params
	for (const legacy of opusRow.legacySlugs ?? []) {
		add(legacy, {}, "legacy bare");
		const variant = (opusRow.variants ?? []).find(v => v.legacySlug === legacy);
		if (variant) {
			const vp = paramsFromVariant(variant);
			add(legacy, vp, "legacy+params");
			// Also test canonical id with same params (how omp should wire it)
			add("claude-opus-5", { ...vp, sandMaxMode: variant.isMaxMode === true }, "canonical+params");
		}
	}

	// Extra devin-compat slugs not in legacySlugs (xhigh/max without thinking prefix)
	for (const extra of ["claude-opus-5-xhigh", "claude-opus-5-max", "claude-opus-5-xhigh-fast", "claude-opus-5-max-fast"]) {
		add(extra, {}, "compat-only bare");
	}

	return cases;
}

function buildRequestedModel(slug, opts) {
	const { sandMaxMode, thinking, context, effort, fast, ...rest } = opts;
	return resolveGrokbotRequestedModel(slug, {
		sandParameterIds: PARAMS,
		sandMaxMode: sandMaxMode ?? false,
		...(effort ? { effort } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		...(context ? { context } : {}),
		...(fast !== undefined ? { fast } : {}),
		...rest,
	});
}

await initAuth();
const opusRow = await fetchOpusRow();
if (!opusRow) {
	console.error("Failed to fetch claude-opus-5 from AvailableModels");
	process.exit(1);
}

const cases = buildCases(opusRow);
console.log(`=== claude-opus-5 slug sweep: ${cases.length} cases ===\n`);

const results = [];
let anyToolsPass = false;

for (const { slug, opts, note } of cases) {
	const requestedModel = buildRequestedModel(slug, opts);
	if (requestedModel.maxMode === undefined && opts.sandMaxMode) {
		requestedModel.maxMode = true;
	}
	const label = `${slug} [${note}]`;
	const toolsResult = await probe(label + " +tools", {
		messages: baseMessages,
		tools,
		requestedModel,
		modelConfig: { maxTokens: 256 },
		invocationId: crypto.randomUUID(),
		conversationId: crypto.randomUUID(),
	});
	toolsResult.note = note;
	toolsResult.slug = slug;
	results.push(toolsResult);
	if (toolsResult.pass) anyToolsPass = true;

	// Text-only control for representative subset (every unique slug bare)
	if (note.endsWith("bare") || note === "canonical bare") {
		const textResult = await probe(label + " text", {
			messages: baseMessages,
			tools: [],
			requestedModel,
			modelConfig: { maxTokens: 256 },
			invocationId: crypto.randomUUID(),
			conversationId: crypto.randomUUID(),
		});
		textResult.note = note + " text-only";
		textResult.slug = slug;
		results.push(textResult);
	}
}

// Summary table
console.log("\n| slug | wire modelId | params | tools HTTP | tools pass | text HTTP | response model |");
console.log("|------|--------------|--------|------------|------------|-----------|----------------|");

const bySlug = new Map();
for (const r of results) {
	const key = `${r.slug}|${r.note}`;
	if (!bySlug.has(key)) bySlug.set(key, {});
	const row = bySlug.get(key);
	if (r.tools) {
		row.toolsStatus = r.status ?? (r.ok ? 200 : "?");
		row.toolsPass = r.pass;
		row.wireModelId = r.wireModelId;
		row.params = fmtParams(r.params);
		row.responseModel = r.responseModel;
		row.toolsErr = r.providerError || r.message;
	} else {
		row.textStatus = r.status ?? (r.ok ? 200 : "?");
		row.textPass = r.pass;
		if (!row.responseModel) row.responseModel = r.responseModel;
	}
}

for (const [key, row] of [...bySlug.entries()].sort()) {
	const [slug] = key.split("|");
	console.log(
		`| ${slug} | ${row.wireModelId ?? "-"} | ${row.params ?? "-"} | ${row.toolsStatus ?? "-"} | ${row.toolsPass ?? "-"} | ${row.textStatus ?? "-"} | ${row.responseModel || "-"} |`,
	);
}

console.log("\n=== FAILURES (tools) ===");
for (const r of results.filter(x => x.tools && !x.pass)) {
	console.log(
		`${r.slug} [${r.note}] wire=${r.wireModelId} params=${fmtParams(r.params)} status=${r.status ?? "?"} err=${r.providerError || r.message || "?"}`,
	);
}

console.log("\n=== UNIQUE wire modelIds seen ===");
console.log([...new Set(results.map(r => r.wireModelId))].sort().join(", "));

console.log("\n=== UNIQUE response models (tools requests) ===");
console.log(
	[...new Set(results.filter(r => r.tools && r.responseModel).map(r => r.responseModel))].sort().join(", ") ||
		"(none — all failed before response)",
);

console.log(anyToolsPass ? "\nOPUS_SLUG_TOOLS_ANY_PASS" : "\nOPUS_SLUG_TOOLS_ALL_FAIL");
