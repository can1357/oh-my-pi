/**
 * Live Wafer Serverless smoke. NOT part of the bun test suite — run manually:
 *   WAFER_SERVERLESS_API_KEY=wfr_... bun packages/ai/test/wafer.live.ts
 *
 * Validates that the bundled `wafer-serverless/GLM-5.1` entry round-trips a
 * real streaming chat completion against `https://pass.wafer.ai/v1`, with the
 * wire `model` field preserved verbatim (`GLM-5.1`, not lowercased) and a
 * non-empty assistant text returned.
 */

import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const apiKey = process.env.WAFER_SERVERLESS_API_KEY;
if (!apiKey) {
	console.error("WAFER_SERVERLESS_API_KEY env var is required");
	process.exit(2);
}

const model = getBundledModel<"openai-completions">("wafer-serverless", "GLM-5.1");
console.log(`Model: ${model.provider}/${model.id} -> ${model.baseUrl}`);
console.log(`compat.thinkingFormat: ${model.compat?.thinkingFormat ?? "(none)"}`);

interface CapturedRequest {
	url: string;
	body: string | null;
}

const originalFetch = fetch;
const captured: { value: CapturedRequest | null } = { value: null };
type FetchInput = string | URL | Request;
const fetchImpl: FetchImpl = async (input: FetchInput, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	captured.value = { url, body: typeof init?.body === "string" ? init.body : null };
	return originalFetch(input, init);
};

const context: Context = {
	systemPrompt: ["Reply with exactly two words."],
	messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }],
};

const stream = streamOpenAICompletions(model as Model<"openai-completions">, context, { apiKey, fetch: fetchImpl });
let text = "";
let stopReason: string | undefined;
let cost = 0;
let firstError: unknown;
let inputTokens = 0;
let outputTokens = 0;
for await (const ev of stream) {
	if (ev.type === "text_delta") text += ev.delta;
	else if (ev.type === "done") {
		stopReason = ev.reason;
		const usage = ev.message.usage;
		cost = usage?.cost?.total ?? 0;
		inputTokens = usage?.input ?? 0;
		outputTokens = usage?.output ?? 0;
	} else if (ev.type === "error") {
		firstError = ev.error.errorMessage ?? ev.error;
		stopReason = ev.reason;
	}
}

const snapshot = (captured as { value: CapturedRequest | null }).value;
const parsedBody = snapshot?.body ? (JSON.parse(snapshot.body) as { model?: unknown }) : null;
console.log("wire url:", snapshot?.url);
console.log("wire model:", parsedBody?.model);
console.log("text:", JSON.stringify(text.slice(0, 200)));
console.log("stopReason:", stopReason);
console.log("usage:", { input: inputTokens, output: outputTokens, costUSD: cost });

if (firstError) {
	console.error("\nLIVE FAIL — Wafer rejected the request:", firstError);
	process.exit(1);
}
if (snapshot?.url !== "https://pass.wafer.ai/v1/chat/completions") {
	console.error("\nLIVE FAIL — wire url was not the documented endpoint");
	process.exit(1);
}
if (parsedBody?.model !== "GLM-5.1") {
	console.error("\nLIVE FAIL — wire model id was not preserved verbatim:", parsedBody?.model);
	process.exit(1);
}
if (text.trim().length === 0) {
	console.error("\nLIVE FAIL — assistant returned empty text");
	process.exit(1);
}

console.log(
	`\nLIVE OK — Wafer Serverless round-trip: GLM-5.1 endpoint preserved, ` +
		`${inputTokens}→${outputTokens} tokens, stopReason=${stopReason}.`,
);
