/**
 * E2E test: exercise an Anthropic conversation through a live auth-gateway and
 * assert prompt caching round-trips. Defends against regressions where the
 * gateway either strips `cache_control` markers, places them on the wrong
 * block, drops them from the upstream wire, or fails to surface
 * `cache_creation_input_tokens` / `cache_read_input_tokens` in the response.
 *
 * Skips unless a local gateway is reachable at the default `127.0.0.1:4000`
 * (override via `OMP_E2E_GATEWAY_URL`) AND the bearer token file exists at
 * `~/.omp/auth-gateway.token`.
 *
 * To run: `bun --cwd packages/ai test test/auth-gateway-anthropic-caching.test.ts`
 * with the gateway live (`omp auth-gateway serve` or pm2).
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

const MODEL = Bun.env.OMP_E2E_ANTHROPIC_MODEL ?? "claude-sonnet-4-5";

const gateway = await checkAuthGatewayE2EAvailable();

// Build a system prompt that comfortably exceeds Anthropic's 1024-token cache
// floor for Sonnet. Using a deterministic repeated paragraph so cache keys are
// stable across runs of this test.
const SYSTEM_PARAGRAPH = `
You are a precise assistant participating in an automated end-to-end test of
the omp auth-gateway's Anthropic prompt-caching pipeline. The same system
prompt will be reused across two turns; the gateway must place a cache
breakpoint on the final system block so that the second request hits the
ephemeral cache instead of being re-tokenized from scratch. Always respond
with extreme brevity: a single short word or phrase, never more than five
tokens. Do not add filler, do not add explanations, do not add punctuation
beyond what is strictly necessary. If asked to confirm something, respond
with "yes". If asked to deny, respond with "no". If asked to repeat your
previous reply, repeat it verbatim. Reasoning, hedging, and conversational
preamble are strictly forbidden. This block is intentionally verbose so the
caching threshold is comfortably cleared on every run; please disregard the
verbosity itself and follow the brevity rule above.
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

describe.skipIf(!gateway.ok)("auth-gateway: anthropic prompt caching e2e", () => {
	if (!gateway.ok) {
		// Surface the skip reason once so a quick rerun with `-v` shows it.
		console.warn(`[skip] anthropic caching e2e: ${gateway.reason}`);
		return;
	}
	const token = gateway.token;
	if (!token) throw new Error("invariant: token must be present when gateway.ok is true");

	it("writes the system prefix to ephemeral cache on turn 1 and reads it on turn 2", async () => {
		// Per-run nonce ensures we always start with a cold cache. The bytes
		// before the breakpoint must be unique to this run; otherwise a
		// previously-warm Anthropic cache entry hits on turn 1 and we lose the
		// ability to assert "first turn writes, second turn reads" cleanly.
		const nonce = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
		const systemTextWithNonce = `${SYSTEM_TEXT}\n\n[run-nonce: ${nonce}]`;
		const system = [{ type: "text", text: systemTextWithNonce, cache_control: { type: "ephemeral" } }];

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

		// Anthropic populates cache_creation_input_tokens with the size of the
		// content written to the cache. Above the 1024-token floor this MUST
		// be > 0 on the first turn or the gateway stripped our cache_control.
		const turn1Created = turn1.usage.cache_creation_input_tokens ?? 0;
		const turn1Read = turn1.usage.cache_read_input_tokens ?? 0;
		expect(turn1Created).toBeGreaterThan(0);
		// First turn cannot hit the cache (nothing to read yet).
		expect(turn1Read).toBe(0);

		// ── Turn 2: append assistant + new user, re-send with same system ──
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

		// Second turn MUST read from the cache populated by turn 1. If
		// cache_read_input_tokens is 0 the gateway either dropped the marker,
		// rewrote the cached prefix bytes, or routed the request without
		// Anthropic's cache-aware OAuth headers.
		const turn2Read = turn2.usage.cache_read_input_tokens ?? 0;
		expect(turn2Read).toBeGreaterThan(0);
		// The cache read should cover at least the system block we wrote.
		expect(turn2Read).toBeGreaterThanOrEqual(turn1Created);
	}, 60_000);
});
