/**
 * Live Fire Pass smoke. NOT part of the bun test suite — run manually:
 *
 *   FIREPASS_API_KEY=fpk_... bun packages/ai/test/firepass.live.ts
 *
 * Asserts that:
 *   1. The provider resolves the active Fire Pass models (`glm-5.2-fast`, `kimi-k3-fast`).
 *   2. Friendly IDs translate to their router wire endpoints (`accounts/fireworks/routers/...`).
 *   3. Supported reasoning efforts pass through to the router.
 *   4. Invalid efforts are rejected with 400 by the router.
 */

import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const apiKey = process.env.FIREPASS_API_KEY;
if (!apiKey) {
	console.error("FIREPASS_API_KEY env var is required");
	process.exit(2);
}

const glmModel = getBundledModel<"openai-completions">("firepass", "glm-5.2-fast");
const kimiModel = getBundledModel<"openai-completions">("firepass", "kimi-k3-fast");

console.log(`GLM Model: ${glmModel.provider}/${glmModel.id} -> ${glmModel.baseUrl}`);
console.log(`Kimi Model: ${kimiModel.provider}/${kimiModel.id} -> ${kimiModel.baseUrl}`);

interface CapturedRequest {
	url: string;
	body: string | null;
}

const originalFetch = fetch;
const capturedRequests: CapturedRequest[] = [];
type FetchInput = string | URL | Request;
const fetchImpl: FetchImpl = async (input: FetchInput, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	capturedRequests.push({ url, body: typeof init?.body === "string" ? init.body : null });
	return originalFetch(input, init);
};

const context: Context = {
	systemPrompt: ["Reply with exactly two words."],
	messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }],
};

async function runModel(targetModel: Model<"openai-completions">, label: string, reasoning: "high" | undefined) {
	console.log(`\n=== ${label} (${targetModel.id}) ===`);
	const stream = streamOpenAICompletions(targetModel, context, {
		apiKey,
		...(reasoning ? { reasoning } : {}),
		fetch: fetchImpl,
	});
	let text = "";
	let stopReason: string | undefined;
	let cost = 0;
	let firstError: unknown;
	for await (const ev of stream) {
		if (ev.type === "text_delta") text += ev.delta;
		else if (ev.type === "done") {
			stopReason = ev.reason;
			cost = ev.message.usage?.cost?.total ?? 0;
		} else if (ev.type === "error") {
			firstError = ev.error.errorMessage ?? ev.error;
			stopReason = ev.reason;
		}
	}

	const snapshot = capturedRequests.at(-1);
	const parsedBody = snapshot?.body ? JSON.parse(snapshot.body) : null;
	console.log("wire url:", snapshot?.url);
	console.log("wire model:", parsedBody?.model);
	console.log("wire reasoning_effort:", parsedBody?.reasoning_effort ?? "(omitted)");
	console.log("text:", JSON.stringify(text.slice(0, 80)));
	console.log("stopReason:", stopReason);
	console.log("cost.total:", cost);
	if (firstError) console.log("error:", firstError);

	return { parsedBody, stopReason, firstError };
}

const glmBaseline = await runModel(glmModel, "GLM baseline", undefined);
if (glmBaseline.firstError) {
	console.error("\nGLM baseline call failed — key, network, or router rejected request");
	process.exit(1);
}
if (glmBaseline.parsedBody?.model !== "accounts/fireworks/routers/glm-5p2-fast") {
	console.error("\nGLM wire model id was not translated to the router endpoint");
	process.exit(1);
}

const glmHigh = await runModel(glmModel, "GLM high effort", "high");
if (glmHigh.firstError) {
	console.error("\nGLM high effort call failed — router rejected effort tier");
	process.exit(1);
}
if (glmHigh.parsedBody?.reasoning_effort !== "high") {
	console.error(`\nGLM high effort was not forwarded (got ${glmHigh.parsedBody?.reasoning_effort})`);
	process.exit(1);
}

const kimiBaseline = await runModel(kimiModel, "Kimi baseline", undefined);
if (kimiBaseline.firstError) {
	console.error("\nKimi baseline call failed — key, network, or router rejected request");
	process.exit(1);
}
if (kimiBaseline.parsedBody?.model !== "accounts/fireworks/routers/kimi-k3-fast") {
	console.error("\nKimi wire model id was not translated to the router endpoint");
	process.exit(1);
}

console.log("\n=== negative probe: garbage_value should 400 at router ===");
const negative = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
	method: "POST",
	headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
	body: JSON.stringify({
		model: "accounts/fireworks/routers/glm-5p2-fast",
		messages: [{ role: "user", content: "ping" }],
		max_tokens: 4,
		reasoning_effort: "garbage_value",
	}),
});
const negativeBody = await negative.text();
console.log("status:", negative.status);
console.log("body:", negativeBody.slice(0, 300));
if (negative.status !== 400) {
	console.error("\nrouter accepted unknown effort — accepted-set assertion unreliable");
	process.exit(1);
}

console.log(
	"\nLIVE OK — Fire Pass routers translated wire ids for GLM 5.2 Fast and Kimi K3 Fast, " +
		"forwarded `high` effort, and rejected `garbage_value` with 400.",
);
