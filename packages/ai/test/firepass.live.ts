/**
 * Live Fire Pass smoke. NOT part of the bun test suite — run manually:
 *   FIREPASS_API_KEY=fpk_... bun packages/ai/test/firepass.live.ts
 *
 * Validates:
 *   1. The bundled `firepass/kimi-k2.6-turbo` entry round-trips a real
 *      streaming chat completion against the Fire Pass router.
 *   2. The PR #1199 P2 fix (xhigh → max) actually clears the wire — without
 *      the mapping Fireworks 400s the request.
 */

import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const apiKey = process.env.FIREPASS_API_KEY;
if (!apiKey) {
	console.error("FIREPASS_API_KEY env var is required");
	process.exit(2);
}

const model = getBundledModel<"openai-completions">("firepass", "kimi-k2.6-turbo");
console.log(`Model: ${model.provider}/${model.id} -> ${model.baseUrl}`);
console.log(`thinking.effortMap:`, model.thinking?.effortMap ?? "(none)");

// Capture the outbound request body so we can verify the wire-id translation
// and the reasoning_effort mapping locally before reading the network result.
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

async function runEffort(label: string, reasoning: "xhigh" | undefined) {
	console.log(`\n=== ${label} ===`);
	captured.value = null;
	const stream = streamOpenAICompletions(model as Model<"openai-completions">, context, {
		apiKey,
		// Intentionally omit maxTokens here so we can also assert that the Kimi-family
		// safety net (openai-completions.ts isKimi) injects the catalog default.
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

	// Cast through the wrapper to defeat tsgo's control-flow narrowing, which assumes
	// `captured.value` is always null because the closure-side mutation is invisible.
	const snapshot = (captured as { value: CapturedRequest | null }).value;
	const parsedBody = snapshot?.body ? JSON.parse(snapshot.body) : null;
	console.log("wire url:", snapshot?.url);
	console.log("wire model:", parsedBody?.model);
	console.log("wire reasoning_effort:", parsedBody?.reasoning_effort ?? "(omitted)");
	console.log("wire max_tokens:", parsedBody?.max_tokens ?? "(omitted)");
	console.log("text:", JSON.stringify(text.slice(0, 80)));
	console.log("stopReason:", stopReason);
	console.log("cost.total:", cost);
	if (firstError) console.log("error:", firstError);

	return { parsedBody, stopReason, firstError };
}

const baseline = await runEffort("baseline (no reasoning effort, no maxTokens)", undefined);
if (baseline.firstError) {
	console.error("\nbaseline call failed — key, network, or router rejected the request");
	process.exit(1);
}
if (baseline.parsedBody?.model !== "accounts/fireworks/routers/kimi-k2p6-turbo") {
	console.error("\nwire model id was not translated to the router endpoint");
	process.exit(1);
}
if (baseline.parsedBody?.max_tokens !== model.maxTokens) {
	console.error(
		`\nmax_tokens default did not fire (got ${baseline.parsedBody?.max_tokens}, expected ${model.maxTokens}); ` +
			"isKimi detection is not matching the firepass catalog id",
	);
	process.exit(1);
}

const xhigh = await runEffort("xhigh effort (Codex P2 — should pass through verbatim)", "xhigh");
if (xhigh.firstError) {
	console.error("\nxhigh call failed — router rejected the documented effort tier");
	process.exit(1);
}
if (xhigh.parsedBody?.reasoning_effort !== "xhigh") {
	console.error(
		`\nxhigh was rewritten on the wire (got ${xhigh.parsedBody?.reasoning_effort}); ` +
			"expected verbatim passthrough — adding thinking.effortMap would silently downgrade the user",
	);
	process.exit(1);
}

// Bonus: prove the router actually enforces an effort allowlist so callers can trust the
// "xhigh is accepted" claim above. A clearly-invalid value MUST 400.
console.log("\n=== negative probe: garbage_value should 400 at the router ===");
const negative = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
	method: "POST",
	headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
	body: JSON.stringify({
		model: "accounts/fireworks/routers/kimi-k2p6-turbo",
		messages: [{ role: "user", content: "ping" }],
		max_tokens: 4,
		reasoning_effort: "garbage_value",
	}),
});
const negativeBody = await negative.text();
console.log("status:", negative.status);
console.log("body:", negativeBody.slice(0, 300));
if (negative.status !== 400) {
	console.error("\nrouter accepted an unknown effort — the accepted-set assertion is unreliable");
	process.exit(1);
}

console.log(
	"\nLIVE OK — Fire Pass router translated the wire id, applied the Kimi K2 max_tokens default, " +
		"forwarded `xhigh` verbatim, and rejected `garbage_value` with 400.",
);
