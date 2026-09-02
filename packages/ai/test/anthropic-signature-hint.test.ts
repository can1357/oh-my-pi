import { describe, expect, it } from "bun:test";
import {
	isInvalidThinkingSignatureError,
	isThinkingPrefixBindingError,
	maybeAddReplayUnsignedThinkingHint,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Regression for #4297 — an unmarked custom `anthropic-messages` signing proxy
 * must return an actionable remediation instead of the raw Anthropic 400.
 */
function buildAnthropicMessagesModel(
	overrides: Partial<ModelSpec<"anthropic-messages">> = {},
): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "cf-anthropic",
		id: "cf-anthropic/claude-opus-4-8",
		name: "Claude Opus 4.8 via cloudflared",
		baseUrl: "https://opencode.cloudflare.dev/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

const SIGNATURE_400 =
	'400 {"message":"messages.1.content.0: Invalid `signature` in `thinking` block","type":"invalid_request_error"}';
const PREFIX_BINDING_400 =
	'400 {"message":"messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \\"drop_block\\".","type":"invalid_request_error"}';

describe("#4297 anthropic-messages replay-unsigned-thinking hint", () => {
	it("recognises the Anthropic 400 invalid-thinking-signature body", () => {
		expect(isInvalidThinkingSignatureError(SIGNATURE_400)).toBe(true);
		expect(isInvalidThinkingSignatureError("Invalid `signature` in `thinking` block")).toBe(true);
		expect(isInvalidThinkingSignatureError("Invalid signature in thinking block")).toBe(true);
		// #4192 fixture wording — no trailing `block`. The pattern MUST accept
		// both because ZenMux / #4192 documents the failure this shorter way.
		expect(isInvalidThinkingSignatureError("messages.1.content.0: Invalid `signature` in `thinking`")).toBe(true);
		expect(isInvalidThinkingSignatureError("messages.1.content.0: Invalid signature in thinking")).toBe(true);
	});

	it("separates conversation binding failures from malformed signatures", () => {
		expect(isThinkingPrefixBindingError(PREFIX_BINDING_400)).toBe(true);
		expect(isThinkingPrefixBindingError(SIGNATURE_400)).toBe(false);
		const model = buildAnthropicMessagesModel();
		expect(maybeAddReplayUnsignedThinkingHint(model, PREFIX_BINDING_400)).toBe(PREFIX_BINDING_400);
	});

	it("does not fire on unrelated errors", () => {
		expect(isInvalidThinkingSignatureError("400 rate_limit_error")).toBe(false);
		expect(isInvalidThinkingSignatureError("Bad Request: missing 'model'")).toBe(false);
	});

	it("prepends a provider-scoped remediation on unmarked custom signing proxies", () => {
		const model = buildAnthropicMessagesModel();
		const surfaced = maybeAddReplayUnsignedThinkingHint(model, SIGNATURE_400);
		expect(surfaced).not.toBe(SIGNATURE_400);
		expect(surfaced).toContain('Provider "cf-anthropic"');
		expect(surfaced).toContain("compat.replayUnsignedThinking: false");
		expect(surfaced).toContain("providers.cf-anthropic");
		expect(surfaced).toContain(SIGNATURE_400);
	});

	it("passes through when the user already set `compat.replayUnsignedThinking`", () => {
		const model = buildAnthropicMessagesModel({ compat: { replayUnsignedThinking: false } });
		expect(maybeAddReplayUnsignedThinkingHint(model, SIGNATURE_400)).toBe(SIGNATURE_400);
	});

	it("passes through on official Anthropic (already demoting)", () => {
		const model = buildAnthropicMessagesModel({
			provider: "anthropic",
			id: "claude-opus-4-8",
			baseUrl: "https://api.anthropic.com",
		});
		expect(maybeAddReplayUnsignedThinkingHint(model, SIGNATURE_400)).toBe(SIGNATURE_400);
	});

	it("passes through when the error is unrelated (no false positives)", () => {
		const model = buildAnthropicMessagesModel();
		expect(maybeAddReplayUnsignedThinkingHint(model, "400 rate_limit_error")).toBe("400 rate_limit_error");
	});
});
