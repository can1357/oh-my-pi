/**
 * E2E test: send an OpenAI Responses request to an ANTHROPIC backend through
 * the auth-gateway and assert that prompt caching still works across the
 * cross-protocol translate path. This is the canonical mixed-format use case
 * — clients targeting `/v1/responses` should keep their caching benefits
 * regardless of which credential the model resolves to.
 *
 * Pipeline under test:
 *   client → POST /v1/responses (OpenAI shape)
 *     → openai-responses parser → omp Context
 *     → pi-ai anthropic provider (auto cache_control via cacheRetention)
 *     → upstream Anthropic (Messages API)
 *     → assistant stream → openai-responses encoder
 *     → OpenAI Responses-shape response with input_tokens_details.cached_tokens
 *       carrying Anthropic's cache_read_input_tokens
 *
 * The cross-protocol path is exactly where regressions tend to hide: the
 * inbound parser silently strips info that the outbound provider needs, the
 * encoder forgets to surface a usage subfield, or the per-turn message rebuild
 * mutates the cached prefix bytes.
 *
 * Skips unless a local gateway is reachable at the default `127.0.0.1:4000`
 * (override via `OMP_E2E_GATEWAY_URL`) AND the bearer token file exists at
 * `~/.omp/auth-gateway.token`.
 *
 * To run: `bun --cwd packages/ai test test/auth-gateway-cross-protocol-caching.test.ts`
 * with the gateway live (`omp auth-gateway serve` or pm2).
 */
import { describe, expect, it } from "bun:test";
import { AUTH_GATEWAY_E2E_URL, checkAuthGatewayE2EAvailable } from "./helpers";

interface OpenAIResponsesUsage {
	input_tokens: number;
	output_tokens: number;
	input_tokens_details?: { cached_tokens?: number };
	output_tokens_details?: { reasoning_tokens?: number };
	total_tokens?: number;
}

interface OpenAIResponse {
	status?: string;
	output?: Array<{
		type: string;
		content?: Array<{ type: string; text?: string }>;
	}>;
	usage: OpenAIResponsesUsage;
	error?: { type?: string; message: string };
}

const MODEL = Bun.env.OMP_E2E_ANTHROPIC_MODEL ?? "claude-sonnet-4-5";

const gateway = await checkAuthGatewayE2EAvailable();

// Long deterministic instructions, repeated to clear Anthropic's 1024-token
// cache floor for Sonnet.
const INSTRUCTIONS_PARAGRAPH = `
You are a precise assistant participating in an automated end-to-end test of
the omp auth-gateway's cross-protocol prompt-caching pipeline. The request
arrives over the OpenAI Responses wire format but is fulfilled by an
Anthropic backend, so the gateway must preserve the cached prefix across the
translation. Always respond with extreme brevity: a single short word or
phrase, never more than five tokens. Do not add filler, do not add
explanations, do not add punctuation beyond what is strictly necessary. If
asked to confirm, respond "yes". If asked to deny, respond "no". If asked to
repeat a previous reply, repeat it verbatim. Reasoning, hedging, and
conversational preamble are strictly forbidden. This block is intentionally
verbose so the caching threshold is comfortably cleared on every run;
disregard the verbosity itself and follow the brevity rule above.
`.trim();

const INSTRUCTIONS = Array.from({ length: 12 }, () => INSTRUCTIONS_PARAGRAPH).join("\n\n");

interface ResponseInputMessage {
	role: "user" | "assistant" | "developer" | "system";
	content: string | Array<{ type: string; text?: string }>;
}

async function callGateway(body: unknown, token: string): Promise<OpenAIResponse> {
	const res = await fetch(`${AUTH_GATEWAY_E2E_URL}/v1/responses`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let parsed: OpenAIResponse;
	try {
		parsed = JSON.parse(text) as OpenAIResponse;
	} catch {
		throw new Error(`gateway returned non-JSON (status=${res.status}): ${text.slice(0, 200)}`);
	}
	if (parsed.error) {
		throw new Error(`gateway error: ${parsed.error.type ?? "unknown"}: ${parsed.error.message}`);
	}
	return parsed;
}

function extractAssistantText(res: OpenAIResponse): string {
	for (const item of res.output ?? []) {
		if (item.type !== "message") continue;
		const block = item.content?.find(c => c.type === "output_text");
		if (block?.text) return block.text;
	}
	return "";
}

describe.skipIf(!gateway.ok)("auth-gateway: openai-responses → anthropic caching e2e", () => {
	if (!gateway.ok) {
		console.warn(`[skip] cross-protocol caching e2e: ${gateway.reason}`);
		return;
	}
	const token = gateway.token;
	if (!token) throw new Error("invariant: token must be present when gateway.ok is true");

	it("caches the instructions prefix across a cross-protocol translate (responses→anthropic)", async () => {
		// Prepend nonce so prefix-tree caching (chunk-level) starts cold on every run.
		const nonce = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
		const instructionsWithNonce = `[run-nonce: ${nonce}]\n\n${INSTRUCTIONS}`;

		// ── Turn 1 ───────────────────────────────────────────────────────
		const turn1Input: ResponseInputMessage[] = [{ role: "user", content: "Respond with the single word: alpha" }];
		const turn1 = await callGateway(
			{
				model: MODEL,
				max_output_tokens: 4,
				instructions: instructionsWithNonce,
				input: turn1Input,
			},
			token,
		);

		const turn1Text = extractAssistantText(turn1);
		expect(turn1Text.length).toBeGreaterThan(0);

		// First turn cannot hit the cache (nothing to read yet thanks to the nonce).
		const turn1Cached = turn1.usage.input_tokens_details?.cached_tokens ?? 0;
		expect(turn1Cached).toBe(0);
		// Confirm the request actually crossed the 1024-token caching floor;
		// otherwise no cache entry gets created and turn 2 can't possibly read.
		expect(turn1.usage.input_tokens).toBeGreaterThan(1024);

		// ── Turn 2: append assistant + new user, re-send with same instructions ──
		const turn2Input: ResponseInputMessage[] = [
			...turn1Input,
			{ role: "assistant", content: turn1Text },
			{ role: "user", content: "Respond with the single word: beta" },
		];
		const turn2 = await callGateway(
			{
				model: MODEL,
				max_output_tokens: 4,
				instructions: instructionsWithNonce,
				input: turn2Input,
			},
			token,
		);

		const turn2Text = extractAssistantText(turn2);
		expect(turn2Text.length).toBeGreaterThan(0);

		// Second turn MUST hit the cache populated by turn 1. The Anthropic
		// provider auto-places cache markers via the default `short` retention,
		// and the openai-responses encoder maps Anthropic's
		// cache_read_input_tokens → input_tokens_details.cached_tokens.
		// If cached_tokens is 0, one of:
		//   - openai-responses parser stripped per-turn content into different
		//     bytes (so the cache prefix moved),
		//   - the anthropic provider failed to apply cache_control markers,
		//   - the encoder forgot to surface the cached-tokens subfield.
		const turn2Cached = turn2.usage.input_tokens_details?.cached_tokens ?? 0;
		expect(turn2Cached).toBeGreaterThan(0);
		// The cached prefix should cover at least the instructions block we
		// established on turn 1 — sanity check that we're not catching a
		// trivial overlap.
		expect(turn2Cached).toBeGreaterThan(1024);
	}, 90_000);
});
