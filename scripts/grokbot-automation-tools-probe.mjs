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
	encodeInferenceStreamRequest,
	frameConnectProto,
} from "../packages/ai/src/providers/grokbot/proto.ts";
import { parseConnectStreamFrames } from "./grokbot-probes/parse-connect-stream.mjs";
import * as prompt from "../packages/utils/src/prompt.ts";
import automationShellUserPrompt from "./grokbot-probes/automation-shell-user.md" with { type: "text" };
import automationSystemPrompt from "./grokbot-probes/automation-system.md" with { type: "text" };
import { probeOmpToolsAutomation } from "./grokbot-probes/probe-omp-tools.ts";

const STREAM = "/aiserver.v1.InferenceService/Stream";

const ompTools = probeOmpToolsAutomation();

function parseFrames(buf) {
	const parsed = parseConnectStreamFrames(buf);
	return {
		ok: parsed.ok,
		toolNames: parsed.toolNames,
		responseModel: parsed.responseModel,
		message: parsed.message,
		completedShell: parsed.completedShell,
	};
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
			{ role: 4, text: prompt.render(automationSystemPrompt).trim() },
			{
				role: 1,
				text: prompt.render(automationShellUserPrompt, { token: "automation-probe-ok" }).trim(),
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
	const pass = res.ok && parsed.ok && parsed.completedShell === true;
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
