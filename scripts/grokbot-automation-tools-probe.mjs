#!/usr/bin/env bun
/**
 * Live probe: sand-automation product wire for claude-opus-5 + Shell/Read tools.
 *
 * Usage:
 *   GROKBOT_ANTHROPIC_TOOLS_WIRE=automation bun scripts/grokbot-automation-tools-probe.mjs
 *
 * Success marker: AUTOMATION_TOOLS_PROBE_PASS
 */
import {
	GROKBOT_BACKEND,
	createGrokbotChecksum,
	grokbotClientHeaders,
	joinGrokbotBackendUrl,
	loadGrokbotConfig,
	mintGrokbotAccessToken,
} from "../packages/catalog/src/discovery/grokbot-auth.ts";
import {
	applyAnthropicSandToolWire,
} from "../packages/ai/src/providers/grokbot/anthropic-sand-wire.ts";
import { resolveGrokbotRequestedModel } from "../packages/ai/src/providers/grokbot/model-request.ts";
import {
	CONNECT_END_STREAM_FLAG,
	decodeInferenceStreamResponse,
	encodeInferenceStreamRequest,
	frameConnectProto,
} from "../packages/ai/src/providers/grokbot/proto.ts";

const STREAM = "/aiserver.v1.InferenceService/Stream";

const ompTools = [
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

function parseFrames(buf) {
	let o = 0;
	const toolNames = [];
	let responseModel = "";
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
			if (msg.toolCallPart?.toolName) toolNames.push(String(msg.toolCallPart.toolName));
			if (msg.responseInfo?.model) responseModel = String(msg.responseInfo.model);
		} catch {
			/* partial frame */
		}
	}
	return { ok: !end?.error, toolNames, responseModel, message: end?.error?.message };
}

async function main() {
	const cfg = await loadGrokbotConfig();
	const token = await mintGrokbotAccessToken(cfg, fetch, GROKBOT_BACKEND);
	const requestedModel = resolveGrokbotRequestedModel("claude-opus-5", {
		sandParameterIds: ["thinking", "context", "effort", "fast"],
		effort: "low",
	});
	const wired = applyAnthropicSandToolWire(
		{
			requestedModel,
			tools: ompTools,
			modelId: "claude-opus-5",
			ompTools,
		},
		"automation",
	);
	const body = {
		messages: [
			{ role: 4, text: "You are a coding agent with shell and read tools." },
			{
				role: 1,
				text: "Use the Shell tool to run: echo automation-probe-ok. Do not explain.",
			},
		],
		tools: wired.tools,
		requestedModel: wired.requestedModel,
		invocationId: crypto.randomUUID(),
		conversationId: crypto.randomUUID(),
		subagentType: wired.subagentType,
		automationId: wired.automationId,
		acceptedUnadvertisedToolNames: wired.acceptedUnadvertisedToolNames,
		modelConfig: { maxTokens: 512 },
	};
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
	const parsed = parseFrames(Buffer.from(await res.arrayBuffer()));
	const pass = res.ok && parsed.ok && parsed.toolNames.includes("Shell");
	console.log(
		`${pass ? "PASS" : "FAIL"}  automation-tools  http=${res.status}  tools=${parsed.toolNames.join(",") || "none"}  model=${parsed.responseModel || "?"}`,
	);
	if (!pass) {
		console.error(parsed.message || "probe failed");
		process.exitCode = 1;
		return;
	}
	console.log("AUTOMATION_TOOLS_PROBE_PASS");
}

await main();
