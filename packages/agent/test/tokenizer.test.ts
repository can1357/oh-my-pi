import { afterEach, describe, expect, test, vi } from "bun:test";
import type { Api, AssistantMessage, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as natives from "@oh-my-pi/pi-natives";
import { Agent } from "../src/agent";
import type { SessionMessageEntry } from "../src/compaction/entries";
import { applyShakeRegions, collectShakeRegions, RESCUE_SHAKE_CONFIG } from "../src/compaction/shake";
import { Tokenizer, tokenizerEncodingForModel } from "../src/tokenizer";
import type { AgentMessage } from "../src/types";

afterEach(() => {
	vi.restoreAllMocks();
});

// Contract: the catalog resolves model identity once as Model.tokenizer; the
// agent maps that catalog property to the matching native counter. A wrong
// row silently skews every context-budget and compaction decision.
describe("tokenizerEncodingForModel", () => {
	test("maps every catalog tokenizer family to its native counter", () => {
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v3" })).toBe(natives.Encoding.ClaudeV3);
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v47" })).toBe(natives.Encoding.ClaudeV47);
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v5" })).toBe(natives.Encoding.ClaudeV5);
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v5-sonnet" })).toBe(natives.Encoding.ClaudeV5Sonnet);
		expect(tokenizerEncodingForModel({ tokenizer: "qwen3" })).toBe(natives.Encoding.Qwen3);
		expect(tokenizerEncodingForModel({ tokenizer: "deepseek-v3" })).toBe(natives.Encoding.DeepSeekV3);
		expect(tokenizerEncodingForModel({ tokenizer: "kimi-k2" })).toBe(natives.Encoding.KimiK2);
		expect(tokenizerEncodingForModel({ tokenizer: "glm5" })).toBe(natives.Encoding.Glm5);
		expect(tokenizerEncodingForModel({ tokenizer: "o200k" })).toBe(natives.Encoding.O200kBase);
	});

	test("leaves unknown catalog models on the estimate policy", () => {
		expect(tokenizerEncodingForModel({})).toBeNull();
		expect(tokenizerEncodingForModel(undefined)).toBeNull();
	});
});

describe("Tokenizer", () => {
	test("defaults to null encoding and byte estimation", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.encoding).toBeNull();
		expect(tokenizer.countTokens("hello world")).toBe(3);
	});

	test("separate instances do not interfere with each other", () => {
		const t1 = new Tokenizer({ tokenizer: "claude-v47" });
		const t2 = new Tokenizer({ tokenizer: "qwen3" });
		const t3 = new Tokenizer({});

		expect(t1.encoding).toBe(natives.Encoding.ClaudeV47);
		expect(t2.encoding).toBe(natives.Encoding.Qwen3);
		expect(t3.encoding).toBeNull();

		const t4 = new Tokenizer({ tokenizer: "claude-v3" });
		expect(t4.encoding).toBe(natives.Encoding.ClaudeV3);
		expect(t1.encoding).toBe(natives.Encoding.ClaudeV47);
		expect(t2.encoding).toBe(natives.Encoding.Qwen3);
		expect(t3.encoding).toBeNull();
	});
});

describe("countTokens with modes", () => {
	test("approximate mode uses fast estimation", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.countTokens("hello world", "approximate")).toBe(3);
	});

	test("upperbound mode uses byte length", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.countTokens("hello world", "upperbound")).toBe(11);
	});

	test("strict mode uses native counting regardless of encoding", () => {
		const noEncoding = new Tokenizer();
		expect(noEncoding.countTokens("hello world", "strict")).toBe(2);
		expect(noEncoding.countTokens("hello world", "approximate")).toBe(3);
		expect(noEncoding.countTokens("hello world", "upperbound")).toBe(11);
		const claudeEncoding = new Tokenizer({ tokenizer: "claude-v47" });
		expect(claudeEncoding.countTokens("hello world", "strict")).toBeGreaterThan(0);
	});

	test("mode is per-call; encoding stays independently model-scoped in strict mode", () => {
		// approximate/upperbound skip the encoding entirely under NODE_ENV=test
		// (fast estimate for a snappy suite); strict is testEnv-independent, so
		// it is the mode that proves per-instance encoding isolation here.
		const claude = new Tokenizer({ tokenizer: "claude-v47" });
		const generic = new Tokenizer({});
		expect(claude.countTokens("hello world", "strict")).not.toBe(generic.countTokens("hello world", "strict"));
	});

	test("counts current fragment values without merging boundaries or retaining mutable arrays", () => {
		const tokenizer = new Tokenizer();
		const fragments = ["hel", "lo", "こんにちは 🌏", "e\u0301\u0000\ud800", ""];
		const initial = natives.countTokens(fragments);
		expect(tokenizer.countTokens(fragments, "strict")).toBe(initial);
		expect(tokenizer.countTokens([...fragments], "strict")).toBe(initial);
		for (const fragment of fragments) {
			expect(tokenizer.countTokens(fragment, "strict")).toBe(natives.countTokens(fragment));
		}

		fragments[1] = "changed streaming content";
		fragments.push("hel");
		expect(tokenizer.countTokens(fragments, "strict")).toBe(natives.countTokens(fragments));
		fragments.splice(0, 4);
		expect(tokenizer.countTokens(fragments, "strict")).toBe(natives.countTokens(fragments));
		fragments.length = 0;
		expect(tokenizer.countTokens(fragments, "strict")).toBe(0);
	});

	test("falls back conservatively when native encoding is unknown", () => {
		const nativeCount = vi.spyOn(natives, "countTokens").mockImplementation(() => {
			throw new Error('value "DeepSeekV3" does not match any variant of enum Encoding');
		});
		const tokenizer = new Tokenizer({ tokenizer: "deepseek-v3" });
		expect(tokenizer.countTokens("hello world", "strict")).toBe(11);
		expect(tokenizer.countTokens("hello world", "upperbound")).toBe(11);
		expect(tokenizer.checkTokenBudget("x".repeat(40), 20)).toEqual({
			fits: false,
			tokens: 40,
			exact: false,
		});
		expect(tokenizer.checkTokenBudget([], -1)).toEqual({ fits: false, tokens: 0, exact: false });

		// A failed native attempt must never seed an "exact" fallback entry.
		nativeCount.mockRestore();
		const exact = natives.countTokens("hello world", tokenizer.encoding);
		expect(tokenizer.countTokens("hello world", "strict")).toBe(exact);
		expect(tokenizer.checkTokenBudget("hello world", 0)).toEqual({
			fits: false,
			tokens: exact,
			exact: true,
		});
	});

	test("does not swallow unrelated native tokenizer errors", () => {
		vi.spyOn(natives, "countTokens").mockImplementation(() => {
			throw new Error("native tokenizer exploded");
		});
		const tokenizer = new Tokenizer({ tokenizer: "deepseek-v3" });
		expect(() => tokenizer.countTokens("hello world", "strict")).toThrow("native tokenizer exploded");
		expect(() => tokenizer.countTokens(["hello world"], "strict")).toThrow("native tokenizer exploded");
	});
});

// Contract: countMessage charges for every part of a message the provider will
// bill for. A role or block type the switch does not name reads as free, and the
// transcript, pruning and compaction math built on these numbers then plans
// against a context window larger than the real one.
describe("countMessage", () => {
	const TEXT = "x".repeat(4000);
	const IMAGE = { type: "image", data: "A".repeat(40_000), mimeType: "image/png" };

	test("counts a developer message like the user message it mirrors", () => {
		const tokenizer = new Tokenizer();
		const user = tokenizer.countMessage({ role: "user", content: TEXT, timestamp: 0 } as AgentMessage);
		const developer = tokenizer.countMessage({ role: "developer", content: TEXT, timestamp: 0 } as AgentMessage);

		expect(user).toBeGreaterThan(0);
		// developer is a core role: convertMessageToLlm ships it to the provider next
		// to user. It used to miss the switch and land on `default: return 0`.
		expect(developer).toBe(user);
	});

	test("charges the image estimate on user and developer content, as tool results do", () => {
		const tokenizer = new Tokenizer();
		const inToolResult = tokenizer.countMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [IMAGE],
			isError: false,
			timestamp: 0,
		} as unknown as AgentMessage);

		expect(inToolResult).toBeGreaterThan(0);
		expect(tokenizer.countMessage({ role: "user", content: [IMAGE], timestamp: 0 } as unknown as AgentMessage)).toBe(
			inToolResult,
		);
		expect(
			tokenizer.countMessage({ role: "developer", content: [IMAGE], timestamp: 0 } as unknown as AgentMessage),
		).toBe(inToolResult);
	});

	test("adds the image estimate on top of the text beside it", () => {
		const tokenizer = new Tokenizer();
		const textOnly = tokenizer.countMessage({
			role: "user",
			content: [{ type: "text", text: TEXT }],
			timestamp: 0,
		} as AgentMessage);
		const withImage = tokenizer.countMessage({
			role: "user",
			content: [{ type: "text", text: TEXT }, IMAGE],
			timestamp: 0,
		} as unknown as AgentMessage);

		expect(textOnly).toBeGreaterThan(0);
		expect(withImage).toBe(textOnly + inToolResultImageEstimate(tokenizer));
	});
});

// Ollama chat drops historical assistant thinking even when the stored turn
// contains it; a false compaction floor can discard most of a usable window.
describe("Ollama chat history estimate", () => {
	const model = buildModel({
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "ollama-chat",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	});
	const turn: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{ type: "thinking", thinking: "r".repeat(8000), thinkingSignature: "s".repeat(8000) },
			{ type: "text", text: "Done." },
		],
		usage: {
			input: 10,
			output: 4000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4010,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	test("counts foreign thinking demoted into visible Ollama text, without its native signature", () => {
		const foreign: AssistantMessage = {
			...turn,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
		};
		const stripping = new Tokenizer(model);
		const floor = { excludeEncryptedReasoning: true };
		const estimate = stripping.countMessage(foreign, floor);
		expect(estimate).toBeGreaterThan(1000);
		expect(stripping.countMessage(foreign)).toBe(estimate);
		const replaying = new Tokenizer({ ...model, compat: { ...model.compat, stripThinkingHistory: false } });
		expect(replaying.countMessage(foreign, floor)).toBe(estimate);
	});

	test("counts only replayed content and recounts after the stripping policy changes", () => {
		const visible = { ...turn, content: [{ type: "text", text: "Done." }] } satisfies AssistantMessage;
		const agent = new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } });
		const floor = { excludeEncryptedReasoning: true };
		const visibleCount = agent.tokenizer.countMessage(visible);
		expect(agent.tokenizer.countMessage(turn)).toBe(visibleCount);
		expect(agent.tokenizer.countMessage(turn, floor)).toBe(visibleCount);

		const replaying = { ...model, compat: { ...model.compat, stripThinkingHistory: false } };
		expect(agent.tokenizer.countsAlike(replaying)).toBe(false);
		agent.setModel(replaying);
		expect(agent.tokenizer.countMessage(turn, floor)).toBeGreaterThan(visibleCount + 1000);
		expect(agent.tokenizer.countMessage(turn)).toBeGreaterThan(agent.tokenizer.countMessage(turn, floor));
		agent.setModel(model);
		expect(agent.tokenizer.countMessage(turn, floor)).toBe(visibleCount);
	});
});

// Contract: a replayed signed thinking block costs what the reading model bills
// for it: Claude rebuilds the full reasoning from the signature and bills it at
// the size the turn billed as output; other readers are charged the
// signature's bytes.
describe("countMessage replayed thinking", () => {
	const SIGNATURE = "s".repeat(4000);
	const VISIBLE = "Check the call sites first.";
	// What the visible blocks count to in the test env (bytes/4 per fragment).
	const VISIBLE_TOKENS = 9;
	const OUTPUT_TOKENS = 3000;

	function reader(provider: "anthropic" | "openrouter" | "amazon-bedrock" | "google", id: string): Model {
		const model = getBundledModel(provider, id);
		if (!model) throw new Error(`missing bundled model ${provider}/${id}`);
		return model as Model;
	}

	function signedTurn(
		from: Pick<Model, "api" | "provider" | "id">,
		thinking: string,
		thinkingSignature?: string,
		stopReason: AssistantMessage["stopReason"] = "toolUse",
	): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "thinking", thinking, thinkingSignature },
				{ type: "text", text: "Done." },
			],
			api: from.api,
			provider: from.provider,
			model: from.id,
			usage: {
				input: 100,
				output: OUTPUT_TOKENS,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100 + OUTPUT_TOKENS,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: 1,
		};
	}

	const opus = reader("anthropic", "claude-opus-5-5");
	const bedrockOpus = reader("amazon-bedrock", "global.anthropic.claude-opus-5-5");
	const openRouterOpus = reader("openrouter", "~anthropic/claude-opus-latest");

	test.each([
		["on the Claude API", opus, opus, VISIBLE, "toolUse"],
		["on Bedrock", bedrockOpus, bedrockOpus, VISIBLE, "toolUse"],
		// Omitted display: no visible thinking, the same reasoning billed.
		["with its thinking omitted", opus, opus, "", "toolUse"],
		// The Claude API keeps another model's signature from the same deployment,
		// and Opus 5.5 reads Opus 5's thinking.
		[
			"from another Claude model on the same deployment",
			opus,
			reader("anthropic", "claude-opus-5"),
			VISIBLE,
			"toolUse",
		],
		// The thinking finished, signed, before the text hit max_tokens.
		["that stopped on length", opus, opus, VISIBLE, "length"],
		// The thinking finished, signed, before the abort cut the text short.
		["aborted after its thinking", opus, opus, VISIBLE, "aborted"],
	] as const)("charges a Claude turn replayed natively %s its output size", (_case, model, from, thinking, stop) => {
		expect(new Tokenizer(model).countMessage(signedTurn(from, thinking, SIGNATURE, stop))).toBe(OUTPUT_TOKENS);
	});

	test.each([
		// A signature is bound to the deployment that minted it.
		["a turn from another host", bedrockOpus, opus],
		// Bedrock binds it to the model too: another model's turn replays as text.
		[
			"another Claude model's turn on Bedrock",
			bedrockOpus,
			reader("amazon-bedrock", "global.anthropic.claude-opus-5"),
		],
		// OpenRouter filters reasoning history out of the request.
		["a reader that filters reasoning history", openRouterOpus, openRouterOpus],
	] as const)("charges only the visible blocks for %s, never the signature", (_case, model, from) => {
		expect(new Tokenizer(model).countMessage(signedTurn(from, VISIBLE, SIGNATURE))).toBe(VISIBLE_TOKENS);
	});

	test("charges only the visible thinking of an aborted turn's final, partly signed block", () => {
		// The replay drops that block's signature, so no reasoning rides along.
		const turn: AssistantMessage = {
			...signedTurn(opus, VISIBLE, SIGNATURE, "aborted"),
			content: [{ type: "thinking", thinking: VISIBLE, thinkingSignature: SIGNATURE }],
		};
		const tokenizer = new Tokenizer(opus);
		expect(tokenizer.countMessage(turn)).toBe(tokenizer.countMessage(turn, { excludeEncryptedReasoning: true }));
	});

	test("charges only the visible blocks of a turn that abandoned its tool calls", () => {
		// The replay strips every signature of a turn whose tool calls ended
		// without a tool-use stop: the model ended its turn, or max_tokens cut it.
		const toolCall = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } } as const;
		const tokenizer = new Tokenizer(opus);
		for (const stop of ["stop", "length"] as const) {
			const turn = signedTurn(opus, VISIBLE, SIGNATURE, stop);
			turn.content = [...turn.content, toolCall];
			expect(tokenizer.countMessage(turn)).toBe(tokenizer.countMessage(turn, { excludeEncryptedReasoning: true }));
		}
		const ranTools = signedTurn(opus, VISIBLE, SIGNATURE, "toolUse");
		ranTools.content = [...ranTools.content, toolCall];
		expect(tokenizer.countMessage(ranTools)).toBe(OUTPUT_TOKENS);
	});

	test("charges the reasoning of the latest turn that abandoned its tool calls on the Claude API only", () => {
		// The Anthropic Messages replay keeps the latest assistant turn
		// byte-for-byte, signatures included; Bedrock's Converse replay strips them.
		const toolCall = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } } as const;
		for (const stop of ["stop", "length"] as const) {
			const tokenizer = new Tokenizer(opus);
			const turn = signedTurn(opus, VISIBLE, SIGNATURE, stop);
			turn.content = [...turn.content, toolCall];
			expect(tokenizer.countLatestTurn(turn)).toBe(OUTPUT_TOKENS);
			// An older position, counted after it, still gets the stripped count.
			expect(tokenizer.countMessage(turn)).toBe(tokenizer.countMessage(turn, { excludeEncryptedReasoning: true }));

			const bedrock = new Tokenizer(bedrockOpus);
			const bedrockTurn = signedTurn(bedrockOpus, VISIBLE, SIGNATURE, stop);
			bedrockTurn.content = [...bedrockTurn.content, toolCall];
			expect(bedrock.countLatestTurn(bedrockTurn)).toBe(bedrock.countMessage(bedrockTurn));
		}
	});

	test("lowers a native Claude replay by the visible text a shake rewrite removes, after a reload too", () => {
		// The turn's output was mostly a 2,000-token code block; shake replaces it
		// in place, the reasoning still replays.
		const block = `\`\`\`\n${"x".repeat(7_992)}\n\`\`\``;
		const turn = signedTurn(opus, VISIBLE, SIGNATURE);
		turn.content = [turn.content[0], { type: "text", text: block }];
		const tokenizer = new Tokenizer(opus);
		expect(tokenizer.countMessage(turn)).toBe(OUTPUT_TOKENS);
		const entry: SessionMessageEntry = { type: "message", id: "a", parentId: null, timestamp: "", message: turn };
		applyShakeRegions(
			collectShakeRegions([entry], tokenizer, RESCUE_SHAKE_CONFIG).map(region => ({
				region,
				replacement: "[shaken]",
				replacementTokens: tokenizer.countTokens("[shaken]"),
			})),
		);
		// 3,000 output − (7 thinking + 2,000 block) visible = 993 reasoning, plus 7 + 2 visible now.
		expect(tokenizer.countMessage(turn)).toBe(993 + 7 + 2);
		// A reopened session, or a model switch, counts the saved turn in a new tokenizer.
		const saved = JSON.parse(JSON.stringify(turn)) as AssistantMessage;
		expect(new Tokenizer(opus).countMessage(saved)).toBe(993 + 7 + 2);
	});

	test("keeps the compaction floor at the visible blocks of a native Claude replay", () => {
		const model = reader("anthropic", "claude-opus-5-5");
		const floored = new Tokenizer(model).countMessage(signedTurn(model, VISIBLE, SIGNATURE), {
			excludeEncryptedReasoning: true,
		});
		expect(floored).toBe(VISIBLE_TOKENS);
	});

	test("charges the signature's bytes for a reader whose catalog prices them", () => {
		const model = reader("google", "gemini-3-pro-preview");
		expect(new Tokenizer(model).countMessage(signedTurn(model, VISIBLE, SIGNATURE))).toBe(VISIBLE_TOKENS + 1000);
	});
});

// Contract: an assistant turn's native Responses history replays its reasoning
// items only to the api, model and provider that produced it, and Codex bills
// each replayed turn at that turn's reported reasoning tokens. The ciphertext
// is not that price (it runs ~3x larger), and reasoning that is not replayed,
// or that replay drops with its turn, costs nothing.
describe("replayed Responses reasoning", () => {
	const sol = bundledModel<"openai-codex-responses">("openai-codex", "gpt-6.1-sol");
	const otherCodex = bundledModel<"openai-codex-responses">("openai-codex", "gpt-6-sol");
	const REASONING_TOKENS = 5_000;
	const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "e".repeat(16_000) };
	const callItem = { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}' };
	const emptyAnswerItem = {
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text: "", annotations: [] }],
	};
	// Replayable native output a thinking-only turn can still carry.
	const searchItem = {
		type: "web_search_call",
		id: "ws_1",
		status: "completed",
		action: { type: "search", query: "q" },
	};
	const signedThinking = { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoningItem) } as const;
	const toolCall = { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } } as const;
	const floored = { excludeEncryptedReasoning: true } as const;

	function responsesTurn(
		model: Model,
		payload: AssistantMessage["providerPayload"],
		content: AssistantMessage["content"] = [signedThinking, toolCall],
		stopReason: AssistantMessage["stopReason"] = "toolUse",
	): AssistantMessage {
		return {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content,
			providerPayload: payload,
			usage: {
				input: 0,
				output: 6_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 6_000,
				reasoningTokens: REASONING_TOKENS,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: 0,
		};
	}
	const codexTurn = (payload: AssistantMessage["providerPayload"], signed = true): AssistantMessage =>
		responsesTurn(sol, payload, [signed ? signedThinking : { type: "thinking", thinking: "" }, toolCall]);
	const history = (
		provider: string,
		items: Array<Record<string, unknown>> = [reasoningItem, callItem],
	): AssistantMessage["providerPayload"] => ({ type: "openaiResponsesHistory", provider, dt: true, items });
	const replayed = (provider: string = sol.provider) => history(provider);
	const visibleTokens = (tokenizer: Tokenizer) => tokenizer.countMessage(codexTurn(undefined, false));
	/** Reasoning items the real Codex request carries for `turn`. */
	const wireReasoning = (turn: AssistantMessage) =>
		convertCodexResponsesMessages(sol, { messages: [turn] }).filter(item => item.type === "reasoning").length;

	test("charges the turn's reported reasoning tokens, not its ciphertext, to the model it replays to", () => {
		const tokenizer = new Tokenizer(sol);
		const expected = visibleTokens(tokenizer) + REASONING_TOKENS;
		expect(tokenizer.countMessage(codexTurn(replayed()))).toBe(expected);
		// The provider's own count is a token price, so the stored-context floor keeps it too.
		expect(tokenizer.countMessage(codexTurn(replayed()), floored)).toBe(expected);
	});

	test("charges nothing for reasoning that does not replay to the reader", () => {
		const tokenizer = new Tokenizer(sol);
		// Control: the reader that produced the turn is charged.
		expect(tokenizer.countMessage(codexTurn(replayed()), floored)).toBe(visibleTokens(tokenizer) + REASONING_TOKENS);
		// Minted for another provider, or carrying no reasoning item: nothing replays.
		expect(tokenizer.countMessage(codexTurn(replayed("openai")), floored)).toBe(visibleTokens(tokenizer));
		expect(tokenizer.countMessage(codexTurn(history(sol.provider, [callItem])), floored)).toBe(
			visibleTokens(tokenizer),
		);
		// Another model on the same provider gets the turn re-encoded without its reasoning.
		const other = new Tokenizer(otherCodex);
		expect(other.countMessage(codexTurn(replayed()), floored)).toBe(visibleTokens(other));
	});

	test("charges nothing to a reader that filters reasoning history out of its requests", () => {
		const openai = bundledModel<"openai-responses">("openai", "gpt-6.1-sol");
		const turn = responsesTurn(openai, history(openai.provider));
		const visible = (tokenizer: Tokenizer) =>
			tokenizer.countMessage(responsesTurn(openai, undefined, [{ type: "thinking", thinking: "" }, toolCall]));
		const replaying = new Tokenizer(openai);
		expect(replaying.countMessage(turn, floored)).toBe(visible(replaying) + REASONING_TOKENS);
		const filtering = new Tokenizer({ ...openai, compat: { ...openai.compat, filterReasoningHistory: true } });
		expect(filtering.countMessage(turn, floored)).toBe(visible(filtering));
	});

	test("charges nothing, signature included, for a turn whose replay sends no reasoning", () => {
		const tokenizer = new Tokenizer(sol);
		const dropped: Array<[string, AssistantMessage]> = [
			// The sanitizer turns these native payloads into nothing replayable.
			[
				"hidden-empty",
				responsesTurn(
					sol,
					history(sol.provider, [reasoningItem, emptyAnswerItem]),
					[signedThinking, { type: "text", text: "" }],
					"stop",
				),
			],
			["reasoning-only", responsesTurn(sol, history(sol.provider, [reasoningItem]), [signedThinking], "stop")],
			// transformMessages drops thinking-only turns that were cut off, even
			// when their native items would otherwise replay.
			...(["length", "error", "aborted"] as const).map((stopReason): [string, AssistantMessage] => [
				`thinking-only ${stopReason}`,
				responsesTurn(sol, history(sol.provider, [reasoningItem, searchItem]), [signedThinking], stopReason),
			]),
		];
		for (const [name, turn] of dropped) {
			expect({ name, wire: wireReasoning(turn) }).toEqual({ name, wire: 0 });
			// Nothing of the turn reaches the wire: no reasoning price, no signature bytes.
			expect({ name, count: tokenizer.countMessage(turn) }).toEqual({ name, count: 0 });
			expect({ name, floor: tokenizer.countMessage(turn, floored) }).toEqual({ name, floor: 0 });
		}
		// Controls: the same items replay when the turn finished, and reasoning
		// ahead of a tool call replays even when the turn was cut off.
		const finished = responsesTurn(sol, history(sol.provider, [reasoningItem, searchItem]), [signedThinking], "stop");
		expect(wireReasoning(finished)).toBe(1);
		expect(tokenizer.countMessage(finished, floored)).toBe(REASONING_TOKENS);
		const cutOffCall = responsesTurn(sol, replayed(), [signedThinking, toolCall], "length");
		expect(wireReasoning(cutOffCall)).toBe(1);
		expect(tokenizer.countMessage(cutOffCall, floored)).toBe(visibleTokens(tokenizer) + REASONING_TOKENS);
	});

	test("an Agent recounts replayed reasoning after switching to a model it does not replay to", () => {
		const agent = new Agent({ initialState: { model: sol, systemPrompt: [], tools: [], messages: [] } });
		const turn = codexTurn(replayed());
		expect(agent.tokenizer.countMessage(turn, floored)).toBe(visibleTokens(agent.tokenizer) + REASONING_TOKENS);
		agent.setModel(otherCodex);
		expect(agent.tokenizer.countMessage(turn, floored)).toBe(visibleTokens(agent.tokenizer));
	});

	test("prices a replayed turn whose backend reported no reasoning tokens at its signature", () => {
		const unreported = codexTurn(replayed());
		delete unreported.usage.reasoningTokens;
		// The reasoning item still goes on the wire, so the turn is not free.
		expect(wireReasoning(unreported)).toBe(1);
		const tokenizer = new Tokenizer(sol);
		// Its only price is the ciphertext, counted as a reader that re-encodes the turn counts it.
		const reencoding = new Tokenizer(otherCodex);
		expect(tokenizer.countMessage(unreported)).toBe(reencoding.countMessage(unreported));
		expect(tokenizer.countMessage(unreported)).toBeGreaterThan(visibleTokens(tokenizer));
		expect(tokenizer.countMessage(unreported, floored)).toBe(visibleTokens(tokenizer));
	});

	test("follows a cold Responses session, which rebuilds encrypted reasoning out of the request", async () => {
		const copilot = getBundledModel<"openai-responses">("github-copilot", "gpt-5.4");
		const encrypted = responsesTurn(copilot, history(copilot.provider));
		// Plaintext reasoning bound to no server state replays natively even cold.
		const plaintext = responsesTurn(
			copilot,
			history(copilot.provider, [
				{ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "Reasoning." }] },
				callItem,
			]),
		);
		const visible = (tokenizer: Tokenizer) =>
			tokenizer.countMessage(responsesTurn(copilot, undefined, [{ type: "thinking", thinking: "" }, toolCall]));
		const providerSessionState = new Map<string, ProviderSessionState>();
		const agent = new Agent({
			initialState: { model: copilot, systemPrompt: [], tools: [], messages: [] },
			providerSessionState,
		});
		const observe = async () => ({
			wire: await responsesWireReasoning(copilot, encrypted, providerSessionState),
			count: agent.tokenizer.countMessage(encrypted),
			floor: agent.tokenizer.countMessage(encrypted, floored),
		});

		const cold = await observe();
		expect(cold).toEqual({ wire: 0, count: visible(agent.tokenizer), floor: visible(agent.tokenizer) });
		expect(await responsesWireReasoning(copilot, plaintext, providerSessionState)).toBe(1);
		expect(agent.tokenizer.countMessage(plaintext, floored)).toBe(visible(agent.tokenizer) + REASONING_TOKENS);
		// The first successful response warms the session (as the provider does).
		for (const state of providerSessionState.values()) {
			(state as ProviderSessionState & { nativeHistoryReplayWarmed: boolean }).nativeHistoryReplayWarmed = true;
		}
		const warm = visible(agent.tokenizer) + REASONING_TOKENS;
		expect(await observe()).toEqual({ wire: 1, count: warm, floor: warm });
		for (const state of providerSessionState.values()) state.close();
		expect(await observe()).toEqual(cold);
	});
});

function bundledModel<TApi extends Api = Api>(provider: "openai" | "openai-codex", id: string): Model<TApi> {
	const model = getBundledModel<TApi>(provider, id);
	if (!model) throw new Error(`Expected bundled ${provider}/${id}`);
	return model;
}

/** Reasoning items the real Responses request carries for `turn` under the session's replay state. */
async function responsesWireReasoning(
	model: Model<"openai-responses">,
	turn: AssistantMessage,
	providerSessionState: Map<string, ProviderSessionState>,
): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const controller = new AbortController();
	controller.abort();
	const messages = [
		{ role: "user" as const, content: "Question?", timestamp: 0 },
		turn,
		{ role: "user" as const, content: "Next.", timestamp: 0 },
	];
	streamOpenAIResponses(
		model,
		{ messages },
		{ apiKey: "test-key", signal: controller.signal, providerSessionState, onPayload: resolve },
	);
	const { input } = (await promise) as { input: Array<{ type?: string }> };
	return input.filter(item => item.type === "reasoning").length;
}

/** The per-image charge, read back through the arm that already applied it. */
function inToolResultImageEstimate(tokenizer: Tokenizer): number {
	return tokenizer.countMessage({
		role: "toolResult",
		toolCallId: "call-probe",
		toolName: "read",
		content: [{ type: "image", data: "A".repeat(40_000), mimeType: "image/png" }],
		isError: false,
		timestamp: 0,
	} as unknown as AgentMessage);
}
