import { describe, expect, it } from "bun:test";
import { type AnthropicOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { withEnv } from "./helpers";
import { DEEP_LEVELS, nestedChain, nestingOf } from "./helpers/deep-nesting";

const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const GATEWAY_ENV = { CLAUDE_CODE_USE_FOUNDRY: undefined, ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" };

/**
 * Defaults to the model from the gateway report:
 * `thinking.adaptive.block_binding: Extra inputs are not permitted`.
 */
function anthropicModel(id = "claude-sonnet-5-5"): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

interface CapturedRequest {
	url: string;
	body: {
		thinking?: { type: string; block_binding?: unknown };
		context_management?: unknown;
		fallback_credit_token?: string;
		fallbacks?: unknown;
		messages?: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
		output_config?: { effort?: string; task_budget?: unknown };
		tools?: Array<Record<string, unknown>>;
	};
	beta: string;
}

async function captureRequest(
	model: Model<"anthropic-messages">,
	extra: AnthropicOptions = {},
	messages: Context["messages"] = [{ role: "user", content: "hi", timestamp: 1 }],
	tools?: Context["tools"],
): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	await streamAnthropic(
		model,
		{ messages, tools },
		{
			apiKey: "sk-ant-api-test",
			thinkingEnabled: true,
			reasoning: Effort.High,
			...extra,
			fetch: async (url, init) => {
				captured ??= {
					url: String(url),
					body: JSON.parse(String(init?.body)),
					beta: new Headers(init?.headers).get("anthropic-beta") ?? "",
				};
				return Response.json({ error: { type: "invalid_request_error", message: "captured" } }, { status: 400 });
			},
		},
	).result();
	if (!captured) throw new Error("expected a captured request");
	return captured;
}

describe("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", () => {
	it("withholds block_binding and context_management (and their betas) on an ANTHROPIC_BASE_URL gateway", async () => {
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: undefined }, async () => {
			const enabled = await captureRequest(anthropicModel());
			expect(enabled.url.startsWith("https://llm-gateway.example.com")).toBe(true);
			expect(enabled.body.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
			expect(enabled.body.context_management).toBeDefined();
			expect(enabled.beta).toContain(BINDING_BETA);
			expect(enabled.beta).toContain(CONTEXT_MANAGEMENT_BETA);
		});

		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const disabled = await captureRequest(anthropicModel());
			expect(disabled.body.thinking?.type).toBe("adaptive");
			expect(disabled.body.thinking?.block_binding).toBeUndefined();
			expect(disabled.body.context_management).toBeUndefined();
			expect(disabled.beta).not.toContain(BINDING_BETA);
			expect(disabled.beta).not.toContain(CONTEXT_MANAGEMENT_BETA);
		});
	});

	it("withholds beta tool fields and task budgets but keeps effort, per Claude Code's gateway contract", async () => {
		const tools: Context["tools"] = [
			// `edit` is strict-eligible; `find` is deferred.
			{ name: "edit", description: "Edit a file.", parameters: { type: "object", properties: {} } },
			{
				name: "find",
				description: "Find files.",
				parameters: { type: "object", properties: {} },
				deferLoading: true,
			},
		];
		const options: AnthropicOptions = { taskBudget: { type: "tokens", total: 50_000 } };
		const messages: Context["messages"] = [{ role: "user", content: "hi", timestamp: 1 }];

		await withEnv({ CLAUDE_CODE_USE_FOUNDRY: undefined, ANTHROPIC_BASE_URL: undefined }, async () => {
			const enabled = await captureRequest(anthropicModel(), options, messages, tools);
			expect(enabled.body.output_config?.task_budget).toBeDefined();
			expect(enabled.beta).toContain("task-budgets-2026-03-13");
			expect(enabled.body.tools?.some(tool => "defer_loading" in tool)).toBe(true);
		});

		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				ANTHROPIC_BASE_URL: undefined,
				CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
			},
			async () => {
				const disabled = await captureRequest(anthropicModel(), options, messages, tools);
				expect(disabled.body.output_config).toEqual({ effort: "high" });
				expect(disabled.beta).toContain("effort-2025-11-24");
				expect(disabled.beta).not.toContain("task-budgets-2026-03-13");
				expect(disabled.beta).not.toContain("structured-outputs-2025-12-15");
				expect(disabled.beta).not.toContain("mid-conversation-tool-changes-2026-07-01");
				// Only the standard tool fields stay, as in Claude Code.
				const standard: Record<string, true> = {
					name: true,
					description: true,
					input_schema: true,
					cache_control: true,
				};
				for (const tool of disabled.body.tools ?? []) {
					expect(Object.keys(tool).filter(key => standard[key] !== true)).toEqual([]);
				}
			},
		);
	});

	it("strips the withheld betas from caller-supplied options.betas", async () => {
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(anthropicModel(), {
				betas: [BINDING_BETA, CONTEXT_MANAGEMENT_BETA, "custom-beta-2026-01-01"],
			});
			expect(request.beta).not.toContain(BINDING_BETA);
			expect(request.beta).not.toContain(CONTEXT_MANAGEMENT_BETA);
			expect(request.beta).toContain("custom-beta-2026-01-01");
		});
	});

	it("strips the withheld betas from caller headers an injected client's per-request betas merge into", async () => {
		await withEnv({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			let beta = "";
			await streamAnthropic(
				anthropicModel(),
				{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
				{
					apiKey: "sk-ant-api-test",
					thinkingEnabled: true,
					reasoning: Effort.High,
					headers: { "anthropic-beta": `${BINDING_BETA},${CONTEXT_MANAGEMENT_BETA},custom-beta-2026-01-01` },
					client: {
						messages: {
							create: (_value, requestOptions) => {
								beta = new Headers(requestOptions?.headers).get("anthropic-beta") ?? "";
								throw new Error("captured");
							},
						},
					},
				},
			).result();
			// The effort beta proves the per-request merge ran over the caller header.
			expect(beta).toContain("effort-2025-11-24");
			expect(beta).toContain("custom-beta-2026-01-01");
			expect(beta).not.toContain(BINDING_BETA);
			expect(beta).not.toContain(CONTEXT_MANAGEMENT_BETA);
		});
	});

	it("forfeits a fallback-credit redemption frozen with withheld fields and builds a fresh request", async () => {
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(anthropicModel(), {
				fallbackCreditRedemption: {
					token: "fct_frozen",
					prefillClaim: false,
					params: {
						model: "claude-fable-5-1",
						messages: [{ role: "user", content: "hi" }],
						max_tokens: 1024,
						stream: true,
						thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
						context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
					},
					betas: [BINDING_BETA, CONTEXT_MANAGEMENT_BETA],
					expiresAt: Date.now() + 60_000,
				},
			});
			expect(request.body.fallback_credit_token).toBeUndefined();
			expect(request.body.thinking?.block_binding).toBeUndefined();
			expect(request.body.context_management).toBeUndefined();
			expect(request.beta).not.toContain(BINDING_BETA);
			expect(request.beta).not.toContain(CONTEXT_MANAGEMENT_BETA);
			// The fresh body's own betas ride, not the saved list describing the old body.
			expect(request.beta).toContain("effort-2025-11-24");
		});
	});

	// A frozen request replays the conversation, whose tool calls' arguments are any JSON, as deep as a transcript
	// line holds; `structuredClone` runs out of stack near 40,000 levels.
	it("redeems a frozen fallback-credit request whose tool arguments nest 50,000 levels", async () => {
		const input = nestedChain();
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(anthropicModel(), {
				fallbackCreditRedemption: {
					token: "fct_frozen",
					prefillClaim: false,
					params: {
						model: "claude-fable-5-1",
						messages: [
							{ role: "user", content: "hi" },
							{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "inspect", input }] },
							{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
						],
						max_tokens: 1024,
						stream: true,
					},
					betas: [],
					expiresAt: Date.now() + 60_000,
				},
			});
			// The frozen body carries no withheld field, so it is redeemed as frozen.
			expect(request.body.fallback_credit_token).toBe("fct_frozen");
			const replayed = request.body.messages?.[1]?.content;
			expect(nestingOf(typeof replayed === "string" ? undefined : replayed?.[0]?.input)).toEqual({
				levels: DEEP_LEVELS,
				bottom: { leaf: "bottom" },
			});
		});
	}, 30_000);

	// The check compares the body with a copy the switch's fields were withheld from: the copy keeps a value that is
	// not JSON data (a `Date` stays one), so a body that holds one, and nothing withheld, equals its copy.
	it("redeems a frozen fallback-credit request whose tool arguments hold a value that is not JSON data", async () => {
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(anthropicModel(), {
				fallbackCreditRedemption: {
					token: "fct_frozen",
					prefillClaim: false,
					params: {
						model: "claude-fable-5-1",
						messages: [
							{ role: "user", content: "hi" },
							{
								role: "assistant",
								content: [{ type: "tool_use", id: "toolu_1", name: "inspect", input: { when: new Date(0) } }],
							},
							{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
						],
						max_tokens: 1024,
						stream: true,
					},
					betas: [],
					expiresAt: Date.now() + 60_000,
				},
			});
			expect(request.body.fallback_credit_token).toBe("fct_frozen");
		});
	});

	it("withholds the switch's controls inside server-side fallback entries", async () => {
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(anthropicModel(), {
				fallbacks: [
					{
						model: "claude-opus-5",
						thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
						output_config: { effort: "high", task_budget: { type: "tokens", total: 50_000 } },
					},
				],
			});
			expect(request.body.fallbacks).toEqual([
				{ model: "claude-opus-5", thinking: { type: "adaptive" }, output_config: { effort: "high" } },
			]);
			expect(request.beta).not.toContain("task-budgets-2026-03-13");
		});
	});

	it("withholds fields an onPayload hook puts back", async () => {
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(anthropicModel(), {
				onPayload: payload => {
					const body = payload as Record<string, unknown>;
					return {
						...body,
						thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
						context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
						messages: [
							{ role: "user", content: [{ type: "compaction", content: "Earlier summary.", signature: "sig" }] },
							{ role: "user", content: "hi" },
						],
					};
				},
			});
			expect(request.body.thinking).toEqual({ type: "adaptive" });
			expect(request.body.context_management).toBeUndefined();
			expect(request.body.messages).toEqual([
				{ role: "user", content: [{ type: "text", text: "Earlier summary." }] },
				{ role: "user", content: "hi" },
			]);
			expect(request.beta).not.toContain(BINDING_BETA);
			expect(request.beta).not.toContain("compact-2026-09-04");
		});
	});

	it("leaves non-Anthropic providers' context_management intact (#3288)", async () => {
		const zai = buildModel({
			id: "glm-4.6",
			name: "GLM 4.6",
			api: "anthropic-messages",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/anthropic",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 128_000,
		});
		await withEnv({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(zai);
			expect(request.body.context_management).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
			expect(request.beta).toContain(CONTEXT_MANAGEMENT_BETA);
		});
	});

	it("replays a legacy encrypted compaction summary as text, without its context_management edit", async () => {
		const fable = anthropicModel("claude-fable-5");
		const summary = "## Goal\nAudit the handlers.";
		const messages: Context["messages"] = [
			{
				role: "user",
				content: `<summary>${summary}</summary>`,
				providerPayload: {
					type: "anthropicCompaction",
					provider: "anthropic",
					content: summary,
					exactTail: true,
					encryptedContent: "enc_opaque_legacy",
				},
				timestamp: 1,
			},
			{ role: "user", content: "next", timestamp: 2 },
		];
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				ANTHROPIC_BASE_URL: undefined,
				CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
			},
			async () => {
				const request = await captureRequest(fable, {}, messages);
				expect(request.body.context_management).toBeUndefined();
				expect(request.beta).not.toContain("compact-2026-01-12");
				expect(JSON.stringify(request.body.messages)).not.toContain("enc_opaque_legacy");
				expect(JSON.stringify(request.body.messages)).toContain("<summary>");
			},
		);
	});
});
