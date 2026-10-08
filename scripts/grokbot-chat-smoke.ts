#!/usr/bin/env bun
/** Live root-SDK text inference and isolated-agent cleanup. Uses existing credentials; may be billed. */
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { createGrokbotRpcClient } from "@oh-my-pi/pi-catalog/discovery/grokbot-rpc";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { streamSimple } from "../packages/ai/src/stream";
import { getEnvApiKey } from "../packages/ai/src/env-api-key";
import { grokbotChatUsageProvider } from "../packages/ai/src/usage/grokbot";
import challengePrompt from "./grokbot-catalog-matrix/text-user.md" with { type: "text" };

const outputPath = process.argv[2];
if (outputPath && (await Bun.file(outputPath).exists()))
	throw new Error("Evidence target already exists; choose a new path");
const apiKey = getEnvApiKey("grokbot-chat");
if (!apiKey) throw new Error("Grok Bot host credentials missing");
const model = buildModel(seedModels<"grokbot-chat">("grokbot-chat")[0]!);
const client = await createGrokbotRpcClient({ apiKey });
const before = await client.rpc("/aiserver.v1.GrokBotService/ListGrokBotAgents");
const beforeIds = new Set(
	Array.isArray(before.agents) ? before.agents.filter(isRecord).map(agent => String(agent.id)) : [],
);
const token = `omp-chat-smoke-${crypto.randomUUID()}`;
let createdAgentId: string | undefined;
let sentFields: string[] = [];
const began = performance.now();
const stream = streamSimple(
	model,
	{ messages: [{ role: "user", content: prompt.render(challengePrompt, { token }).trim(), timestamp: Date.now() }] },
	{
		apiKey,
		toolChoice: "none",
		signal: AbortSignal.timeout(300_000),
		onPayload: payload => {
			if (isRecord(payload)) {
				createdAgentId = typeof payload.agentId === "string" ? payload.agentId : undefined;
				sentFields = Object.keys(payload);
			}
		},
	},
);
for await (const _event of stream) {
	/* Actual public SDK dispatch, not a retained-response replay. */
}
const result = await stream.result();
const text = result.content
	.filter(part => part.type === "text")
	.map(part => part.text)
	.join("");
const after = await client.rpc("/aiserver.v1.GrokBotService/ListGrokBotAgents");
const agents = Array.isArray(after.agents) ? after.agents.filter(isRecord) : [];
const preserved = [...beforeIds].every(id => agents.some(agent => agent.id === id));
const removed =
	!!createdAgentId &&
	!agents.some(agent => agent.agentId === createdAgentId || agent.legacyAgentId === createdAgentId);
const usage = await grokbotChatUsageProvider.fetchUsage(
	{ provider: "grokbot-chat", credential: { type: "api_key", apiKey } },
	{ fetch },
);
const receipt = {
	finishedAt: new Date().toISOString(),
	selector: "grokbot-chat/host-managed",
	route: "GrokBotService",
	sourceSdk: true,
	builtBinary: false,
	stopReason: result.stopReason,
	error: result.errorMessage ?? null,
	elapsedMs: Math.round(performance.now() - began),
	challengeMatched: text.trim() === token,
	verifiedReply: text.trim() === token ? text.trim() : null,
	servedModel: result.upstreamModel ?? null,
	declaredModel: result.model,
	sentFields,
	originalAgentCount: beforeIds.size,
	remainingAgentCount: agents.length,
	priorAgentsPreserved: preserved,
	temporaryAgentRemoved: removed,
	sandUsage: usage?.limits[0]?.amount ?? null,
	sharedHostSettingsChanged: false,
	pass:
		result.stopReason === "stop" &&
		text.trim() === token &&
		preserved &&
		removed &&
		!sentFields.includes("requestedModel") &&
		!sentFields.includes("modelId"),
};
if (outputPath) await Bun.write(outputPath, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
process.exitCode = receipt.pass ? 0 : 1;
