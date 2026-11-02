import { describe, expect, it } from "bun:test";
import { renderDemotedThinking } from "@oh-my-pi/pi-ai/dialect";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	Message,
	Model,
	ModelSpec,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Cross-model `anthropic-messages` continuations must preserve the prior
 * turn's reasoning chain. Anthropic enforces an all-or-none contract on
 * thinking blocks ("if you include thinking blocks in prior assistant turns,
 * you must include ALL thinking blocks (including redacted ones)") but the
 * legacy transform only honored that for the LATEST surviving assistant.
 * Every earlier turn fell through to the cross-API text-demotion path
 * whenever the conversation crossed a model boundary — silently dropping the
 * reasoning chain on continuation for custom anthropic-messages providers
 * configured via `models.yaml` and for session-level model swaps (#2257).
 *
 * The signature policy is a second axis. Same-deployment official Anthropic
 * replays preserve signatures across model switches so Anthropic can apply
 * its model-compatibility rules. Deployment-boundary replays strip signatures;
 * unsigned-replay third-party fixtures treat them as opaque continuation hints
 * and preserve them to keep the reasoning chain signed (#2265).
 */
function makeAnthropicModel(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "custom-anthropic",
		id: "reasoning-model",
		name: "Reasoning Anthropic-Compatible Model",
		baseUrl: "https://llm.example.com/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

function makeUser(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function makeAssistant(
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "custom-anthropic",
		model: "reasoning-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
		...overrides,
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

interface WireThinkingBlock {
	type: "thinking";
	thinking: string;
	signature: string;
}
interface WireTextBlock {
	type: "text";
	text: string;
}
interface WireRedactedBlock {
	type: "redacted_thinking";
	data: string;
}
interface WireToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}
type WireBlock =
	| WireThinkingBlock
	| WireTextBlock
	| WireRedactedBlock
	| WireToolUseBlock
	| { type: string; [key: string]: unknown };

describe("Anthropic prior-turn thinking preservation (#2257, #2265)", () => {
	it("preserves the prior thinking block as native `thinking` across compatible endpoints", () => {
		// Source v1, target v2, both on the same custom anthropic-messages
		// provider. The first assistant turn is PRIOR, so the latest-only
		// preservation path doesn't help — without the fix the prior thinking
		// block is demoted to plain `text` and the reasoning chain disappears.
		const target = makeAnthropicModel({ id: "reasoning-model-v2" });
		const priorThinkingText = "Plan: read README, then summarize.";
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: priorThinkingText, thinkingSignature: "sig_v1" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ model: "reasoning-model-v1" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "Got the body, now translating", thinkingSignature: "sig_v2" },
					{ type: "text", text: "Voici le résumé en français." },
				],
				{ model: "reasoning-model-v2", stopReason: "stop" },
			),
			makeUser("Now translate it to Spanish"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		expect(assistants).toHaveLength(2);
		const priorBlocks = assistants[0].content as WireBlock[];
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking).toBeDefined();
		expect(thinking?.thinking).toBe(priorThinkingText);
		// 3p ↔ 3p replay: the source signature is opaque continuation metadata
		// that compatible endpoints pass through. Stripping it (the pre-fix
		// behavior) silently demotes the reasoning chain on the next turn.
		expect(thinking?.signature).toBe("sig_v1");
		// And the paired tool_use must still be present right after it.
		const toolUse = priorBlocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
		expect(toolUse?.id).toBe("toolu_prior");
	});

	it("keeps the signature on prior turns when the source model matches the target", () => {
		// Same provider+api+id throughout: signatures are valid and must ride
		// the wire untouched (prompt-cache stability + Anthropic's all-or-none
		// invariant).
		const target = makeAnthropicModel();
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant([
				{ type: "thinking", thinking: "plan", thinkingSignature: "sig_same" },
				{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
			]),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "summarising", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{ stopReason: "stop" },
			),
			makeUser("And now in Spanish"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("plan");
		expect(thinking?.signature).toBe("sig_same");
	});

	it("preserves redacted_thinking blocks from prior anthropic-messages turns", () => {
		// Anthropic's "include ALL thinking blocks (including redacted ones)"
		// rule means redacted_thinking from earlier turns must survive whenever
		// any thinking content from the same turn is replayed.
		const target = makeAnthropicModel({ id: "reasoning-model-v2" });
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "sig" },
					{ type: "redactedThinking", data: "encrypted-blob" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ model: "reasoning-model-v1" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "later", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{ model: "reasoning-model-v2", stopReason: "stop" },
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const redacted = priorBlocks.find(b => b.type === "redacted_thinking") as WireRedactedBlock | undefined;
		expect(redacted).toBeDefined();
		expect(redacted?.data).toBe("encrypted-blob");
	});

	it("strips foreign signatures and drops redacted_thinking when the target is official Anthropic", () => {
		// 3p → official Anthropic. The official endpoint rejects foreign
		// signatures cryptographically, and `replayUnsignedThinking: false`
		// demotes the unsigned visible thinking to text downstream, so the
		// matching redacted sibling must not remain as a lone native
		// redacted_thinking block.
		const target = makeAnthropicModel({
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			baseUrl: "https://api.anthropic.com",
		});
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "visible reasoning", thinkingSignature: "sig_custom" },
					{ type: "redactedThinking", data: "foreign-encrypted-blob" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ model: "reasoning-model-v1" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "official latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{
					provider: "anthropic",
					model: "claude-sonnet-4-6",
					stopReason: "stop",
				},
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const text = priorBlocks.find(b => b.type === "text") as WireTextBlock | undefined;
		expect(text?.text).toBe(renderDemotedThinking(target.id, "visible reasoning"));
		expect(priorBlocks.find(b => b.type === "thinking")).toBeUndefined();
		expect(priorBlocks.find(b => b.type === "redacted_thinking")).toBeUndefined();
	});

	it("preserves official Anthropic prior signatures across a same-deployment model switch", () => {
		// Official Anthropic can validate signatures minted by another model in
		// the same deployment and apply its one-way model-compatibility rules.
		// Keep the native block so the API can retain or drop it authoritatively.
		const cases = [
			{ id: "claude-opus-4-8", name: "Claude Opus 4.8" },
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
			{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
			{ id: "claude-fable-5", name: "Claude Fable 5" },
			{ id: "claude-mythos-5", name: "Claude Mythos 5" },
		] as const;

		for (const targetCase of cases) {
			const target = makeAnthropicModel({
				provider: "anthropic",
				id: targetCase.id,
				name: targetCase.name,
				baseUrl: "https://api.anthropic.com",
			});
			const sourceModel = targetCase.id === "claude-sonnet-4-6" ? "claude-opus-4-8" : "claude-sonnet-4-6";
			const reasoning = `Need to preserve the plan while switching to ${targetCase.name}.`;
			const messages: Message[] = [
				makeUser("Read the project notes"),
				makeAssistant(
					[
						{ type: "thinking", thinking: reasoning, thinkingSignature: "sig_source" },
						{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "NOTES.md" } },
					],
					{ provider: "anthropic", model: sourceModel },
				),
				toolResult("toolu_prior", "notes body"),
				makeAssistant([{ type: "text", text: "I found the relevant notes." }], {
					provider: "anthropic",
					model: targetCase.id,
					stopReason: "stop",
				}),
				makeUser("Continue from those notes."),
			];

			const params = convertAnthropicMessages(messages, target, false);
			const assistants = params.filter(p => p.role === "assistant");
			expect(assistants).toHaveLength(2);
			const priorBlocks = assistants[0].content as WireBlock[];
			const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
			expect(thinking).toEqual({
				type: "thinking",
				thinking: reasoning,
				signature: "sig_source",
			});
			expect(priorBlocks.find(b => b.type === "text")).toBeUndefined();
		}
	});

	it("strips retained-tail thinking produced before a client-side compaction", () => {
		const target = makeAnthropicModel({
			provider: "anthropic",
			id: "claude-fable-5-1",
			baseUrl: "https://api.anthropic.com",
		});
		const messages: Message[] = [
			{
				role: "user",
				content: "Compacted session summary",
				historyRewriteAt: 100,
				timestamp: 100,
			},
			makeAssistant(
				[
					{ type: "thinking", thinking: "reasoning from the old prefix", thinkingSignature: "sig_old" },
					{ type: "text", text: "Retained visible answer." },
				],
				{
					provider: "anthropic",
					model: target.id,
					stopReason: "stop",
					timestamp: 50,
				},
			),
			makeUser("Continue after compaction."),
			makeAssistant(
				[
					{ type: "thinking", thinking: "reasoning from the new prefix", thinkingSignature: "sig_new" },
					{ type: "text", text: "New answer." },
				],
				{
					provider: "anthropic",
					model: target.id,
					stopReason: "stop",
					timestamp: 200,
				},
			),
			makeUser("One more step."),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(param => param.role === "assistant");
		const retainedBlocks = assistants[0]?.content;
		const newBlocks = assistants[1]?.content;
		if (!Array.isArray(retainedBlocks) || !Array.isArray(newBlocks)) {
			throw new Error("expected assistant content blocks");
		}
		expect(retainedBlocks.find(block => block.type === "thinking")).toBeUndefined();
		expect(retainedBlocks).toContainEqual({ type: "text", text: "Retained visible answer." });
		expect(newBlocks.find(block => block.type === "thinking")).toEqual({
			type: "thinking",
			thinking: "reasoning from the new prefix",
			signature: "sig_new",
		});
	});

	it("does not demote same-model official Anthropic unsigned thinking to text", () => {
		// Same-model Anthropic replay is not a dialect transition. If a committed
		// tool-use turn lacks a usable thinking signature, the native thinking block
		// is unreplayable, but serializing it as target-dialect text would
		// incorrectly apply the cross-model fallback intended for real transitions.
		for (const modelCase of [
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
			{ id: "claude-fable-5", name: "Claude Fable 5" },
		]) {
			const target = makeAnthropicModel({
				provider: "anthropic",
				id: modelCase.id,
				name: modelCase.name,
				baseUrl: "https://api.anthropic.com",
			});
			const reasoning = `Need to inspect the layout before editing with ${modelCase.id}.`;
			const toolCallId = `toolu_${modelCase.id.replaceAll("-", "_")}`;
			const messages: Message[] = [
				makeUser("Fix the layout"),
				makeAssistant(
					[
						{ type: "thinking", thinking: reasoning, thinkingSignature: "" },
						{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/view.ts" } },
					],
					{ provider: "anthropic", model: modelCase.id },
				),
				toolResult(toolCallId, "view body"),
				makeUser("Continue."),
			];

			const params = convertAnthropicMessages(messages, target, false);
			const assistant = params.find(p => p.role === "assistant");
			if (!assistant) throw new Error("expected assistant wire message");
			const blocks = assistant.content as WireBlock[];
			const textBlocks = blocks.filter((b): b is WireTextBlock => b.type === "text");
			expect(textBlocks).toHaveLength(0);
			expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
			const toolUse = blocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
			expect(toolUse?.id).toBe(toolCallId);
		}
	});

	it("drops same-model Anthropic thinking blocks with undefined signatures (regression test for 018b3dc61, restoring 93996bc48)", () => {
		// Regression: commit 018b3dc61 narrowed the drop guard to catch only
		// empty-string signatures, but same-model thinking blocks from aborted
		// or prior turns may have undefined signatures (marked by the
		// untrustworthy-turn recovery at :410-414). These must also be dropped,
		// not demoted to text, because demotion triggers the reasoning_extraction
		// safety classifier and causes hard refusals from Fable 5 and Opus 4.8.
		for (const modelCase of [
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
			{ id: "claude-fable-5", name: "Claude Fable 5" },
		]) {
			const target = makeAnthropicModel({
				provider: "anthropic",
				id: modelCase.id,
				name: modelCase.name,
				baseUrl: "https://api.anthropic.com",
			});
			const reasoning = `Internal reasoning that should not leak for ${modelCase.id}.`;
			const toolCallId = `toolu_${modelCase.id.replaceAll("-", "_")}`;
			const messages: Message[] = [
				makeUser("Fix the layout"),
				makeAssistant(
					[
						{ type: "thinking", thinking: reasoning, thinkingSignature: undefined },
						{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/view.ts" } },
					],
					{ provider: "anthropic", model: modelCase.id },
				),
				toolResult(toolCallId, "view body"),
				makeUser("Continue."),
			];

			const params = convertAnthropicMessages(messages, target, false);
			const assistant = params.find(p => p.role === "assistant");
			if (!assistant) throw new Error("expected assistant wire message");
			const blocks = assistant.content as WireBlock[];
			// Must not produce a native thinking block
			expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
			// Must not demote to text (neither <thinking> tags nor plain text containing the reasoning)
			const textBlocks = blocks.filter((b): b is WireTextBlock => b.type === "text");
			expect(textBlocks).toHaveLength(0);
			// Tool call must still be present
			const toolUse = blocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
			expect(toolUse?.id).toBe(toolCallId);
		}
	});

	it("drops redacted siblings when same-model unsigned visible thinking is discarded", () => {
		const target = makeAnthropicModel({
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			baseUrl: "https://api.anthropic.com",
		});
		const toolCallId = "toolu_redacted_dropped";
		const messages: Message[] = [
			makeUser("Fix the layout"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "Private discarded reasoning.", thinkingSignature: undefined },
					{ type: "redactedThinking", data: "encrypted-sibling" },
					{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/view.ts" } },
				],
				{ provider: "anthropic", model: "claude-sonnet-4-6" },
			),
			toolResult(toolCallId, "view body"),
			makeUser("Continue."),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistant = params.find(p => p.role === "assistant");
		if (!assistant) throw new Error("expected assistant wire message");
		const blocks = assistant.content as WireBlock[];
		expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
		expect(blocks.find(b => b.type === "redacted_thinking")).toBeUndefined();
		expect(blocks.filter((b): b is WireTextBlock => b.type === "text")).toHaveLength(0);
		const toolUse = blocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
		expect(toolUse?.id).toBe(toolCallId);
	});

	it("keeps redacted siblings when signed same-model thinking survives beside a discarded final block", () => {
		const target = makeAnthropicModel({
			provider: "anthropic",
			id: "claude-sonnet-4-6",
			baseUrl: "https://api.anthropic.com",
		});
		const messages: Message[] = [
			makeUser("Fix the layout"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "Completed signed reasoning.", thinkingSignature: "sig_complete" },
					{ type: "redactedThinking", data: "encrypted-complete-sibling" },
					{ type: "text", text: "Visible anchor." },
					{ type: "thinking", thinking: "Partial final reasoning.", thinkingSignature: "sig_partial" },
				],
				{ provider: "anthropic", model: "claude-sonnet-4-6", stopReason: "error" },
			),
			makeUser("Continue."),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistant = params.find(p => p.role === "assistant");
		if (!assistant) throw new Error("expected assistant wire message");
		const blocks = assistant.content as WireBlock[];
		const thinking = blocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("Completed signed reasoning.");
		expect(thinking?.signature).toBe("sig_complete");
		const redacted = blocks.find(b => b.type === "redacted_thinking") as WireRedactedBlock | undefined;
		expect(redacted?.data).toBe("encrypted-complete-sibling");
		expect(blocks.some(b => b.type === "thinking" && b.thinking === "Partial final reasoning.")).toBe(false);
	});

	it("strips official Anthropic source signatures on cross-model replay to a 3p target", () => {
		// official Anthropic → 3p. Anthropic's signature is bound to the
		// issuing model+session, so the 3p target cannot reverify or
		// meaningfully continue from it; passing it through would leak
		// private continuation metadata for no benefit. The unsigned thinking
		// is still emitted natively because the 3p target's compat advertises
		// `replayUnsignedThinking: true`.
		const target = makeAnthropicModel({ id: "reasoning-model-v2" });
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "anthropic reasoning", thinkingSignature: "sig_anthropic" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ provider: "anthropic", model: "claude-sonnet-4-6" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "v2 reasoning", thinkingSignature: "sig_v2" },
					{ type: "text", text: "summary" },
				],
				{ model: "reasoning-model-v2", stopReason: "stop" },
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("anthropic reasoning");
		expect(thinking?.signature).toBe("");
	});

	it("preserves prior unsigned thinking from non-anthropic sources on unsigned-replay targets", () => {
		// Anthropic-compatible targets that advertise `replayUnsignedThinking`
		// accept unsigned native thinking as their semantic-carry analogue.
		const target = makeAnthropicModel();
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "openai chain-of-thought", thinkingSignature: "" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{
					api: "openai-responses",
					provider: "openai",
					model: "o1-preview",
				} as Partial<AssistantMessage>,
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "anthropic latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{ stopReason: "stop" },
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("openai chain-of-thought");
		expect(thinking?.signature).toBe("");
	});

	it("strips stale cross-model signatures when the target is a Cloudflare AI Gateway Anthropic proxy (#4297)", () => {
		// cf-anthropic gateway forwards to signature-enforcing Anthropic but
		// resolves `officialEndpoint: false`. A prior Claude Sonnet 4.6 turn's
		// signature is bound to the source model+session, so replaying it to
		// Claude Opus 4.8 on the same gateway would 400 with `Invalid signature
		// in thinking block`. Signature stripping must key off the
		// `signingEndpoint` classification, not `officialEndpoint`.
		const target = makeAnthropicModel({
			provider: "cloudflare-ai-gateway",
			id: "cf-anthropic/claude-opus-4-8",
			name: "Claude Opus 4.8 via Cloudflare AI Gateway",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gate/anthropic",
		});
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "prior reasoning", thinkingSignature: "sig_prior" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ provider: "cloudflare-ai-gateway", model: "cf-anthropic/claude-sonnet-4-6" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "opus latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{ provider: "cloudflare-ai-gateway", model: "cf-anthropic/claude-opus-4-8", stopReason: "stop" },
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		// Signature-only replay is unsafe on a signing target with a stale
		// (cross-model) source signature — that's the whole 400 failure class.
		// The transform strips the signature (so `signingEndpoint` demotes the
		// unsigned block to text) and no stale `sig_prior` reaches the wire.
		expect(thinking).toBeUndefined();
		const text = priorBlocks.find(b => b.type === "text") as WireTextBlock | undefined;
		expect(text?.text).toContain("prior reasoning");
		const wireBlobs = JSON.stringify(priorBlocks);
		expect(wireBlobs).not.toContain("sig_prior");
	});

	it("strips stale cross-model signatures on Google Vertex publishers/anthropic (#4297)", () => {
		const target = makeAnthropicModel({
			provider: "google-vertex",
			id: "claude-opus-4-8@20260215",
			name: "Claude Opus 4.8 via Vertex",
			baseUrl:
				"https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/anthropic/models/claude-opus-4-8@20260215:streamRawPredict",
		});
		const messages: Message[] = [
			makeUser("Summarize README"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "sonnet reasoning", thinkingSignature: "sig_sonnet" },
					{ type: "toolCall", id: "toolu_prior", name: "read", arguments: { path: "README.md" } },
				],
				{ provider: "google-vertex", model: "claude-sonnet-4-6@20260101" },
			),
			toolResult("toolu_prior", "README body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "opus latest", thinkingSignature: "sig_latest" },
					{ type: "text", text: "summary" },
				],
				{ provider: "google-vertex", model: "claude-opus-4-8@20260215", stopReason: "stop" },
			),
			makeUser("Translate"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const priorBlocks = assistants[0].content as WireBlock[];
		const thinking = priorBlocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking).toBeUndefined();
		const text = priorBlocks.find(b => b.type === "text") as WireTextBlock | undefined;
		expect(text?.text).toContain("sonnet reasoning");
		const wireBlobs = JSON.stringify(priorBlocks);
		expect(wireBlobs).not.toContain("sig_sonnet");
	});
});

describe("Latest-turn foreign thinking signatures (model switch mid tool-loop)", () => {
	// Production forensics: a session ran on kimi-code/k3 (an Anthropic-
	// compatible endpoint that signs thinking blocks with its own scheme —
	// per-turn signatures Anthropic can never verify), the user switched back
	// to official Anthropic while the kimi turn was still the LATEST assistant
	// message of an in-flight tool loop, and every request 400'd with
	// `messages.N.content.M: Invalid \`signature\` in \`thinking\` block`,
	// wedging the session onto its fallback model. The signature strip used to
	// be gated on `!isLatestSurvivingAssistant`; the latest turn replayed the
	// foreign signature verbatim. The latest-turn strip keys on the ISSUER
	// (source provider ≠ target provider): same-provider cross-model-id
	// switches keep the byte-for-byte latest turn pinned by the prefill suite.
	const officialFable = () =>
		makeAnthropicModel({
			provider: "anthropic",
			id: "claude-fable-5",
			name: "Claude Fable 5",
			baseUrl: "https://api.anthropic.com",
		});
	const KIMI_SIG = "kimi-issued-foreign-signature";

	it("strips a foreign signature from the latest in-flight tool-use turn for official Anthropic", () => {
		const reasoning = "The PR body is final and verified. One formatting nit remains.";
		const target = officialFable();
		const messages: Message[] = [
			makeUser("Fix the PR body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: reasoning, thinkingSignature: KIMI_SIG },
					{ type: "text", text: "한 군데 렌더링 닛: 빈 줄 하나 추가." },
					{ type: "toolCall", id: "toolu_send", name: "send", arguments: { text: "patch" } },
				],
				{ provider: "kimi-code", model: "k3" },
			),
			toolResult("toolu_send", "sent"),
			makeUser("<user_interjection>switch happened here</user_interjection>"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		expect(assistants).toHaveLength(1);
		const blocks = assistants[0].content as WireBlock[];
		// No native thinking block may survive: the foreign signature cannot
		// verify, and official Anthropic never replays unsigned thinking.
		expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
		expect(JSON.stringify(blocks)).not.toContain(KIMI_SIG);
		// The reasoning survives as demoted text ahead of the visible text.
		const texts = blocks.filter(b => b.type === "text") as WireTextBlock[];
		expect(texts[0]?.text).toBe(renderDemotedThinking(target.id, reasoning));
		expect(texts.some(t => t.text.includes("렌더링"))).toBe(true);
		// The pending tool loop stays intact.
		const toolUse = blocks.find(b => b.type === "tool_use") as WireToolUseBlock | undefined;
		expect(toolUse?.id).toBe("toolu_send");
	});

	it("keeps the latest same-model official Anthropic turn byte-for-byte", () => {
		const target = officialFable();
		const messages: Message[] = [
			makeUser("Fix the PR body"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "own reasoning", thinkingSignature: "sig_fable" },
					{ type: "toolCall", id: "toolu_send", name: "send", arguments: {} },
				],
				{ provider: "anthropic", model: "claude-fable-5" },
			),
			toolResult("toolu_send", "sent"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const blocks = assistants[0].content as WireBlock[];
		const thinking = blocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("own reasoning");
		expect(thinking?.signature).toBe("sig_fable");
	});

	it("strips a foreign signature from the latest ABANDONED tool-use turn for official Anthropic", () => {
		// stopReason !== "toolUse" with toolCall blocks = abandoned turn. The
		// byte-for-byte exemption only covers Anthropic's own latest response,
		// not a foreign one.
		const reasoning = "kimi reasoning on an abandoned turn";
		const target = officialFable();
		const messages: Message[] = [
			makeUser("Do the thing"),
			makeAssistant(
				[
					{ type: "thinking", thinking: reasoning, thinkingSignature: KIMI_SIG },
					{ type: "toolCall", id: "toolu_left", name: "read", arguments: { path: "a" } },
				],
				{ provider: "kimi-code", model: "k3", stopReason: "stop" },
			),
			toolResult("toolu_left", "placeholder"),
			makeUser("continue"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const blocks = assistants[0].content as WireBlock[];
		expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
		expect(JSON.stringify(blocks)).not.toContain(KIMI_SIG);
		const text = blocks.find(b => b.type === "text") as WireTextBlock | undefined;
		expect(text?.text).toBe(renderDemotedThinking(target.id, reasoning));
	});

	it("keeps the latest ABANDONED same-model turn untouched (byte-for-byte rule)", () => {
		const target = officialFable();
		const messages: Message[] = [
			makeUser("Do the thing"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "fable reasoning", thinkingSignature: "sig_fable" },
					{ type: "toolCall", id: "toolu_left", name: "read", arguments: { path: "a" } },
				],
				{ provider: "anthropic", model: "claude-fable-5", stopReason: "stop" },
			),
			toolResult("toolu_left", "placeholder"),
			makeUser("continue"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const blocks = assistants[0].content as WireBlock[];
		const thinking = blocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("fable reasoning");
		expect(thinking?.signature).toBe("sig_fable");
	});

	it("drops a foreign redacted_thinking sibling on the latest turn for signing targets", () => {
		const target = officialFable();
		const messages: Message[] = [
			makeUser("Fix it"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "visible", thinkingSignature: KIMI_SIG },
					{ type: "redactedThinking", data: "foreign-blob" },
					{ type: "toolCall", id: "toolu_x", name: "read", arguments: {} },
				],
				{ provider: "kimi-code", model: "k3" },
			),
			toolResult("toolu_x", "ok"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const blocks = assistants[0].content as WireBlock[];
		expect(blocks.find(b => b.type === "redacted_thinking")).toBeUndefined();
		expect(blocks.find(b => b.type === "thinking")).toBeUndefined();
	});

	it("strips the latest official Anthropic signature when replaying to an unsigned-replay 3p target", () => {
		// Reverse direction: official → 3p. The signature is bound to
		// Anthropic's key+session+model; the 3p target replays the thinking
		// natively but unsigned.
		const target = makeAnthropicModel();
		const messages: Message[] = [
			makeUser("Fix it"),
			makeAssistant(
				[
					{ type: "thinking", thinking: "fable reasoning", thinkingSignature: "sig_fable" },
					{ type: "toolCall", id: "toolu_y", name: "read", arguments: {} },
				],
				{ provider: "anthropic", model: "claude-fable-5" },
			),
			toolResult("toolu_y", "ok"),
		];

		const params = convertAnthropicMessages(messages, target, false);
		const assistants = params.filter(p => p.role === "assistant");
		const blocks = assistants[0].content as WireBlock[];
		const thinking = blocks.find(b => b.type === "thinking") as WireThinkingBlock | undefined;
		expect(thinking?.thinking).toBe("fable reasoning");
		expect(thinking?.signature ?? "").toBe("");
		expect(JSON.stringify(blocks)).not.toContain("sig_fable");
	});
});
