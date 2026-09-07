#!/usr/bin/env bun
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
const concat = (b) => Buffer.concat(b.filter((x) => x?.length));
const encVarint = (v) => {
	let n = BigInt(v);
	const o = [];
	while (n > 0x7fn) {
		o.push(Number((n & 0x7fn) | 0x80n));
		n >>= 7n;
	}
	o.push(Number(n));
	return Buffer.from(o);
};
const encTag = (f, w) => encVarint((f << 3) | w);
const encStr = (f, s) => {
	const p = Buffer.from(s, "utf8");
	return concat([encTag(f, 2), encVarint(p.length), p]);
};

function parse(buf) {
	let o = 0,
		t = "",
		e,
		m = "";
	while (o + 5 <= buf.length) {
		const fl = buf[o],
			l = buf.readUInt32BE(o + 1);
		o += 5;
		const b = buf.subarray(o, o + l);
		o += l;
		if (fl & 2) {
			try {
				e = JSON.parse(b.toString("utf8"));
			} catch {}
		} else
			try {
				const x = decodeInferenceStreamResponse(b);
				if (x.textPart?.text) t += x.textPart.text;
				if (x.responseInfo?.model) m = String(x.responseInfo.model);
			} catch {}
	}
	return {
		ok: !e?.error,
		t,
		m,
		status: e?.error?.details?.[0]?.debug?.details?.additionalInfo?.providerStatusCode,
		err: e?.error?.details?.[0]?.debug?.error || e?.error?.message,
	};
}

async function probe(label, body, extra = []) {
	const cfg = await loadGrokbotConfig();
	const token = await mintGrokbotAccessToken(cfg, fetch, GROKBOT_BACKEND);
	const h = {
		...grokbotClientHeaders(cfg),
		authorization: `Bearer ${token}`,
		"x-cursor-checksum": createGrokbotChecksum(cfg.machineId),
		"x-ghost-mode": "true",
		"content-type": "application/connect+proto",
		accept: "application/connect+proto",
		"connect-protocol-version": "1",
		"x-request-id": crypto.randomUUID(),
	};
	const bytes = concat([encodeInferenceStreamRequest(body), ...extra]);
	const res = await fetch(joinGrokbotBackendUrl(GROKBOT_BACKEND, STREAM), {
		method: "POST",
		headers: h,
		body: frameConnectProto(bytes),
	});
	const r = parse(Buffer.from(await res.arrayBuffer()));
	const pass = r.ok && r.t.includes(TOKEN);
	console.log(`${pass ? "PASS" : "FAIL"}  ${label.padEnd(42)} status=${r.status ?? "-"} model=${r.m || "-"}`);
	if (!pass) console.log(`       ${r.err || "?"}`);
	return pass;
}

const tools = [
	{
		name: "read",
		description: "Read",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
];
const rm = resolveGrokbotRequestedModel("claude-opus-5", {
	effort: "low",
	sandParameterIds: ["thinking", "context", "effort", "fast"],
});
const base = {
	messages: [
		{ role: 4, text: "a" },
		{ role: 1, text: `Reply exactly: ${TOKEN}` },
	],
	tools,
	requestedModel: rm,
	modelConfig: { maxTokens: 128 },
	invocationId: crypto.randomUUID(),
	conversationId: crypto.randomUUID(),
};

const f9 = ["read", "bash", "Shell"].flatMap((n) => [encStr(9, n)]);

await probe("baseline", base);
await probe("field9 repeated names", base, f9);
await probe("field9 + subagent computerUse", base, [...f9, encStr(16, "computerUse")]);
await probe("field9, empty field2 tools", { ...base, tools: [] }, f9);
await probe("maxMode true", { ...base, requestedModel: { ...rm, maxMode: true } });
