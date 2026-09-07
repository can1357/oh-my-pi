#!/usr/bin/env bun
/** Move field-2 Tool bytes to field-3 only (empty field 2) for claude-opus-5. */
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

function decodeFields(buf) {
	const fields = [];
	let pos = 0;
	const decVarint = (b, p) => {
		let n = 0n,
			sh = 0n;
		while (p < b.length) {
			const x = BigInt(b[p++]);
			n |= (x & 0x7fn) << sh;
			if ((x & 0x80n) === 0n) return [Number(n), p];
			sh += 7n;
		}
		throw new Error("trunc");
	};
	while (pos < buf.length) {
		const [tag, p1] = decVarint(buf, pos);
		const fn = tag >>> 3,
			w = tag & 7;
		pos = p1;
		if (w === 2) {
			const [len, p2] = decVarint(buf, pos);
			pos = p2;
			fields.push({ fn, bytes: buf.subarray(pos, pos + len) });
			pos += len;
		} else if (w === 0) {
			const [, p2] = decVarint(buf, pos);
			pos = p2;
		} else throw new Error(`wire ${w}`);
	}
	return fields;
}

function retagField2AsField3(encoded) {
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
	const out = [];
	for (const f of decodeFields(encoded)) {
		if (f.fn === 2)
			out.push(Buffer.concat([encVarint((3 << 3) | 2), encVarint(f.bytes.length), f.bytes]));
	}
	return Buffer.concat(out);
}

function parseStream(buf) {
	let o = 0,
		texts = "",
		end,
		model = "",
		toolCalls = 0;
	while (o + 5 <= buf.length) {
		const fl = buf[o],
			l = buf.readUInt32BE(o + 1);
		o += 5;
		const b = buf.subarray(o, o + l);
		o += l;
		if (fl & 2) {
			try {
				end = JSON.parse(b.toString("utf8"));
			} catch {}
		} else
			try {
				const x = decodeInferenceStreamResponse(b);
				if (x.textPart?.text) texts += x.textPart.text;
				if (x.responseInfo?.model) model = String(x.responseInfo.model);
				if (x.toolCallPart) toolCalls++;
			} catch {}
	}
	return {
		ok: !end?.error,
		texts,
		model,
		toolCalls,
		status: end?.error?.details?.[0]?.debug?.details?.additionalInfo?.providerStatusCode,
		err: end?.error?.details?.[0]?.debug?.error || end?.error?.message,
	};
}

const tools = [
	{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	{ name: "Shell", description: "Shell", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];
const rm = resolveGrokbotRequestedModel("claude-opus-5", {
	effort: "low",
	sandParameterIds: ["thinking", "context", "effort", "fast"],
});

for (const [label, prompt] of [
	["text pong42", `Reply exactly: ${TOKEN}`],
	[
		"tool task",
		"Use Shell to run: echo f3only > /tmp/f3only.txt. Then use read on /tmp/f3only.txt. Reply with exactly the file contents.",
	],
]) {
	const base = {
		messages: [
			{ role: 4, text: "coding assistant" },
			{ role: 1, text: prompt },
		],
		tools: [],
		requestedModel: rm,
		modelConfig: { maxTokens: 512 },
		invocationId: crypto.randomUUID(),
		conversationId: crypto.randomUUID(),
	};
	const f3 = retagField2AsField3(encodeInferenceStreamRequest({ ...base, tools }));
	const bytes = Buffer.concat([encodeInferenceStreamRequest(base), f3]);

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
	const res = await fetch(joinGrokbotBackendUrl(GROKBOT_BACKEND, STREAM), {
		method: "POST",
		headers: h,
		body: frameConnectProto(bytes),
	});
	const r = parseStream(Buffer.from(await res.arrayBuffer()));
	console.log(
		`${r.ok ? "OK" : "FAIL"}  f3-only-tools ${label.padEnd(12)} status=${r.status ?? "-"} model=${r.model || "-"} toolCalls=${r.toolCalls} text=${JSON.stringify(r.texts.slice(0, 120))}`,
	);
	if (!r.ok) console.log(`       ${r.err}`);
}
