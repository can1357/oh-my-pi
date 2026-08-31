#!/usr/bin/env bun
/** Probe harness fields 3/9/16 for claude-opus-5 + tools on sand. */
import {
	GROKBOT_BACKEND,
	createGrokbotChecksum,
	grokbotClientHeaders,
	joinGrokbotBackendUrl,
	loadGrokbotConfig,
	mintGrokbotAccessToken,
} from "../../packages/catalog/src/discovery/grokbot-auth.ts";
import { resolveGrokbotRequestedModel } from "../../packages/ai/src/providers/grokbot/model-request.ts";
import {
	CONNECT_END_STREAM_FLAG,
	decodeInferenceStreamResponse,
	encodeInferenceStreamRequest,
	frameConnectProto,
} from "../../packages/ai/src/providers/grokbot/proto.ts";

const STREAM = "/aiserver.v1.InferenceService/Stream";
const TOKEN = "pong42";

function concat(chunks) {
	return Buffer.concat(chunks.filter(c => c?.length));
}
function encodeVarint(value) {
	let n = typeof value === "bigint" ? value : BigInt(value >>> 0);
	const out = [];
	while (n > 0x7fn) {
		out.push(Number((n & 0x7fn) | 0x80n));
		n >>= 7n;
	}
	out.push(Number(n));
	return Buffer.from(out);
}
function encodeTag(fieldNo, wire) {
	return encodeVarint((fieldNo << 3) | wire);
}
function encodeString(fieldNo, s) {
	const payload = Buffer.from(String(s), "utf8");
	return concat([encodeTag(fieldNo, 2), encodeVarint(payload.length), payload]);
}
function encodeBool(fieldNo, v) {
	return concat([encodeTag(fieldNo, 0), encodeVarint(v ? 1 : 0)]);
}
function encodeMessage(fieldNo, bytes) {
	const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	return concat([encodeTag(fieldNo, 2), encodeVarint(buf.length), buf]);
}
function encodeStruct(obj) {
	const chunks = [];
	for (const [k, v] of Object.entries(obj)) {
		chunks.push(encodeMessage(1, concat([encodeString(1, k), encodeString(3, String(v))])));
	}
	return concat(chunks);
}
function encodeToolLike(msg) {
	const chunks = [];
	if (msg.name) chunks.push(encodeString(1, msg.name));
	if (msg.description) chunks.push(encodeString(2, msg.description));
	if (msg.parameters) chunks.push(encodeMessage(3, encodeStruct(msg.parameters)));
	if (msg.type) {
		chunks.push(
			encodeMessage(4, concat([encodeString(1, msg.type), encodeString(2, msg.definition || ""), encodeString(3, msg.syntax || "")])),
		);
	}
	if (msg.providerId) chunks.push(encodeString(5, msg.providerId));
	if (msg.id) chunks.push(encodeString(6, msg.id));
	return concat(chunks);
}

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
		err: dbg?.error || end?.error?.message,
	};
}

async function post(baseBody, harness = {}) {
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
	let bytes = encodeInferenceStreamRequest(baseBody);
	const extra = [];
	if (harness.providerTools?.length) {
		for (const t of harness.providerTools) extra.push(encodeMessage(3, encodeToolLike(t)));
	} else if (harness.providerDefinedFlag) {
		extra.push(encodeBool(3, true));
	}
	if (harness.acceptedUnadvertised) extra.push(encodeBool(9, true));
	if (harness.subagentType) extra.push(encodeString(16, harness.subagentType));
	if (extra.length) bytes = concat([bytes, ...extra]);
	const res = await fetch(joinGrokbotBackendUrl(GROKBOT_BACKEND, STREAM), {
		method: "POST",
		headers,
		body: frameConnectProto(bytes),
	});
	return parseFrames(Buffer.from(await res.arrayBuffer()));
}

const field2Tools = [
	{ name: "read", description: "Read file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	{ name: "Shell", description: "Run shell", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];
const requestedModel = resolveGrokbotRequestedModel("claude-opus-5", {
	effort: "low",
	sandParameterIds: ["thinking", "context", "effort", "fast"],
});
const baseBody = {
	messages: [
		{ role: 4, text: "You are a coding assistant." },
		{ role: 1, text: `Reply with exactly: ${TOKEN}.` },
	],
	tools: field2Tools,
	requestedModel,
	modelConfig: { maxTokens: 256 },
	invocationId: crypto.randomUUID(),
	conversationId: crypto.randomUUID(),
};

const cases = [
	{ label: "baseline field2 only", harness: {} },
	{ label: "field9 acceptedUnadvertised", harness: { acceptedUnadvertised: true } },
	{ label: "field16 browserUse", harness: { subagentType: "browserUse" } },
	{ label: "field16 computerUse", harness: { subagentType: "computerUse" } },
	{ label: "field16 browser", harness: { subagentType: "browser" } },
	{ label: "field9+16 browserUse", harness: { acceptedUnadvertised: true, subagentType: "browserUse" } },
	{ label: "field3 bool true", harness: { providerDefinedFlag: true } },
	{
		label: "field3 provider-defined computer",
		harness: {
			providerTools: [
				{
					type: "provider-defined",
					providerId: "anthropic.computer_20250124",
					id: "anthropic.computer_20250124",
					name: "computer",
					description: "Computer use",
					parameters: { display_width_px: 1280, display_height_px: 800 },
				},
			],
		},
	},
	{
		label: "field3 computer + field16 computerUse",
		harness: {
			subagentType: "computerUse",
			providerTools: [
				{
					type: "provider-defined",
					providerId: "anthropic.computer_20250124",
					id: "anthropic.computer_20250124",
					name: "computer",
					description: "Computer use",
					parameters: { display_width_px: 1280, display_height_px: 800 },
				},
			],
		},
	},
	{
		label: "field3 computer + field2 read only",
		harness: {
			subagentType: "computerUse",
			providerTools: [
				{
					type: "provider-defined",
					providerId: "anthropic.computer_20250124",
					id: "anthropic.computer_20250124",
					name: "computer",
					description: "Computer use",
					parameters: { display_width_px: 1280, display_height_px: 800 },
				},
			],
		},
		body: { ...baseBody, tools: [field2Tools[0]] },
	},
	{ label: "field2 empty + field9", harness: { acceptedUnadvertised: true }, body: { ...baseBody, tools: [] } },
];

console.log("=== claude-opus-5 harness probe ===");
let anyPass = false;
for (const c of cases) {
	const r = await post(c.body ?? baseBody, c.harness);
	const pass = r.ok && r.texts.includes(TOKEN);
	if (pass) anyPass = true;
	console.log(`${pass ? "PASS" : "FAIL"}  ${c.label.padEnd(40)} status=${r.status ?? "-"} model=${r.responseModel || "-"}`);
	if (!pass) console.log(`       ${r.err || "?"}`);
}
console.log(anyPass ? "HARNESS_ANY_PASS" : "HARNESS_ALL_FAIL");
