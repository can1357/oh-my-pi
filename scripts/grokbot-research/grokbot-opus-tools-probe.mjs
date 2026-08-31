#!/usr/bin/env bun
/** Probe claude-opus-5 + tools across effort/thinking/fast combinations on sand. */
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
	fieldNumbers,
	frameConnectProto,
} from "../../packages/ai/src/providers/grokbot/proto.ts";

const STREAM = "/aiserver.v1.InferenceService/Stream";
const TOKEN = "pong42";
const PARAMS = ["thinking", "context", "effort", "fast"];

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

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

async function probe(label, body) {
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
	const protoBytes = encodeInferenceStreamRequest(body);
	const fields = [...new Set(fieldNumbers(protoBytes))].sort((a, b) => a - b);
	const res = await fetch(joinGrokbotBackendUrl(GROKBOT_BACKEND, STREAM), {
		method: "POST",
		headers,
		body: frameConnectProto(protoBytes),
	});
	const result = parseFrames(Buffer.from(await res.arrayBuffer()));
	const hasToken = result.texts.includes(TOKEN);
	const pass = result.ok && hasToken;
	console.log(
		`${pass ? "PASS" : "FAIL"}  ${label.padEnd(36)} status=${result.status ?? "-"} fields=[${fields.join(",")}] model=${result.responseModel || "-"}`,
	);
	if (!pass) {
		console.log(`       err=${result.providerError || result.message || "?"} ${result.detail || ""}`.trim());
	}
	return pass;
}

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

console.log("=== claude-opus-5 + read tool, effort sweep ===");
let anyPass = false;
for (const effort of EFFORTS) {
	for (const fast of [undefined, true, false]) {
		for (const thinking of [undefined, true, false]) {
			const requestedModel = resolveGrokbotRequestedModel("claude-opus-5", {
				effort,
				sandParameterIds: PARAMS,
				sandMaxMode: false,
				...(fast !== undefined ? { fast } : {}),
				...(thinking !== undefined ? { thinking } : {}),
			});
			const label = `effort=${effort} fast=${fast ?? "def"} think=${thinking ?? "def"}`;
			const pass = await probe(label, {
				messages: baseMessages,
				tools,
				requestedModel,
				modelConfig: { maxTokens: 256 },
				invocationId: crypto.randomUUID(),
				conversationId: crypto.randomUUID(),
			});
			if (pass) anyPass = true;
		}
	}
}

console.log("=== claude-opus-5 text-only control (effort sweep) ===");
for (const effort of EFFORTS) {
	const requestedModel = resolveGrokbotRequestedModel("claude-opus-5", {
		effort,
		sandParameterIds: PARAMS,
	});
	await probe(`text-only effort=${effort}`, {
		messages: baseMessages,
		tools: [],
		requestedModel,
		modelConfig: { maxTokens: 256 },
		invocationId: crypto.randomUUID(),
		conversationId: crypto.randomUUID(),
	});
}

console.log(anyPass ? "OPUS_TOOLS_ANY_PASS" : "OPUS_TOOLS_ALL_FAIL");
