/**
 * E2E test: send an Anthropic Messages request to an OPENAI CODEX backend
 * through the auth-gateway and assert prompt caching survives the
 * cross-protocol translate path in the other direction.
 *
 * Pipeline under test:
 *   client → POST /v1/messages (Anthropic shape, cache_control markers)
 *     → anthropic-messages parser → omp Context (cacheRetention derived)
 *     → pi-ai openai-codex-responses provider
 *     → upstream Codex (ChatGPT-subscription Responses API)
 *     → assistant stream → anthropic-messages encoder
 *     → Anthropic-shape response with cache_read_input_tokens carrying
 *       Codex's cached_tokens (mapped via usage.cacheRead)
 *
 * Regression surface: the inbound parser strips cache_control hints into
 * `cacheRetention`, but the codex provider doesn't consume `cacheRetention`
 * directly — caching only works if pi-ai's codex transport reaches Codex
 * with an effective cache identity (prompt_cache_key from sessionId, or
 * implicit session reuse). If that path breaks, this test catches it.
 *
 * Skips unless a local gateway is reachable at the default `127.0.0.1:4000`
 * (override via `OMP_E2E_GATEWAY_URL`) AND the bearer token file exists at
 * `~/.omp/auth-gateway.token`.
 *
 * To run: `bun --cwd packages/ai test test/auth-gateway-anthropic-to-codex-caching.test.ts`
 */
import { describe, expect, it } from "bun:test";
import { AUTH_GATEWAY_E2E_URL, checkAuthGatewayE2EAvailable } from "./helpers";

interface AnthropicUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

interface AnthropicResponse {
	type?: string;
	stop_reason?: string;
	content?: Array<{ type: string; text?: string }>;
	usage: AnthropicUsage;
	error?: { type: string; message: string };
}

const MODEL = Bun.env.OMP_E2E_CODEX_MODEL ?? "gpt-5.3-codex";

const gateway = await checkAuthGatewayE2EAvailable();

// Long deterministic instructions, repeated to clear Codex's 1024-token
// cache floor with headroom.
const SYSTEM_PARAGRAPH = `
You are a precise assistant participating in an automated end-to-end test of
the omp auth-gateway's cross-protocol prompt-caching pipeline. The request
arrives over the Anthropic Messages wire format but is fulfilled by an
OpenAI Codex backend, so the gateway must preserve the cached prefix across
the translation. Always respond with extreme brevity: a single short word or
phrase, never more than five tokens. Do not add filler, do not add
explanations, do not add punctuation beyond what is strictly necessary. If
asked to confirm, respond "yes". If asked to deny, respond "no". If asked
to repeat a previous reply, repeat it verbatim. Reasoning, hedging, and
conversational preamble are strictly forbidden. This block is intentionally
verbose so the caching threshold is comfortably cleared on every run;
disregard the verbosity itself and follow the brevity rule above.
`.trim();

const SYSTEM_TEXT = Array.from({ length: 12 }, () => SYSTEM_PARAGRAPH).join("\n\n");

interface MessageBlock {
	role: "user" | "assistant";
	content: string | Array<{ type: string; text?: string }>;
}

async function callGateway(body: unknown, token: string): Promise<AnthropicResponse> {
	const res = await fetch(`${AUTH_GATEWAY_E2E_URL}/v1/messages`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let parsed: AnthropicResponse;
	try {
		parsed = JSON.parse(text) as AnthropicResponse;
	} catch {
		throw new Error(`gateway returned non-JSON (status=${res.status}): ${text.slice(0, 200)}`);
	}
	if (parsed.error) {
		throw new Error(`gateway error: ${parsed.error.type}: ${parsed.error.message}`);
	}
	return parsed;
}

function extractAssistantText(res: AnthropicResponse): string {
	const block = res.content?.find(c => c.type === "text");
	return block?.text ?? "";
}

describe.skipIf(!gateway.ok)("auth-gateway: anthropic-messages → openai-codex caching e2e", () => {
	if (!gateway.ok) {
		console.warn(`[skip] anthropic→codex caching e2e: ${gateway.reason}`);
		return;
	}
	const token = gateway.token;
	if (!token) throw new Error("invariant: token must be present when gateway.ok is true");

	it("caches the system prefix across a cross-protocol translate (messages→codex)", async () => {
		// Prepend nonce so prefix-tree caching (chunk-level) starts cold on
		// every run. Appending wouldn't help — earlier chunks in the prefix
		// would still match warm cache entries from prior runs.
		const nonce = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
		const systemWithNonce = `[run-nonce: ${nonce}]\n\n${SYSTEM_TEXT}`;
		const system = [{ type: "text", text: systemWithNonce, cache_control: { type: "ephemeral" } }];

		// ── Turn 1 ───────────────────────────────────────────────────────
		const turn1Messages: MessageBlock[] = [{ role: "user", content: "Respond with the single word: alpha" }];
		const turn1 = await callGateway(
			{
				model: MODEL,
				max_tokens: 4,
				system,
				messages: turn1Messages,
			},
			token,
		);

		const turn1Text = extractAssistantText(turn1);
		expect(turn1Text.length).toBeGreaterThan(0);

		// First turn cannot hit the cache (nonce ensures cold start).
		const turn1Read = turn1.usage.cache_read_input_tokens ?? 0;
		expect(turn1Read).toBe(0);
		// Confirm the prefix actually crossed the 1024-token caching floor.
		expect(turn1.usage.input_tokens).toBeGreaterThan(1024);

		// ── Turn 2 ───────────────────────────────────────────────────────
		const turn2Messages: MessageBlock[] = [
			...turn1Messages,
			{ role: "assistant", content: turn1Text },
			{ role: "user", content: "Respond with the single word: beta" },
		];
		const turn2 = await callGateway(
			{
				model: MODEL,
				max_tokens: 4,
				system,
				messages: turn2Messages,
			},
			token,
		);

		const turn2Text = extractAssistantText(turn2);
		expect(turn2Text.length).toBeGreaterThan(0);

		// Second turn MUST read the cached prefix. If cache_read_input_tokens
		// is 0, one of:
		//   - anthropic-messages parser stripped the cache_control hint and
		//     downstream lost the cache-retention signal;
		//   - the codex provider didn't surface a stable cache identity to
		//     Codex (no prompt_cache_key, no session reuse, etc.);
		//   - the anthropic-messages encoder forgot to map pi-ai's
		//     `usage.cacheRead` to `cache_read_input_tokens` on the wire.
		const turn2Read = turn2.usage.cache_read_input_tokens ?? 0;
		expect(turn2Read).toBeGreaterThan(0);
		// Cached read should cover at least the system block we sent.
		expect(turn2Read).toBeGreaterThan(1024);
	}, 90_000);
});
