import { describe, expect, it } from "bun:test";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model, OptionsForApi } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { e2eApiKey, resolveApiKey } from "./oauth";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("google-gemini-cli"),
	resolveApiKey("google-antigravity"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, geminiCliToken, antigravityToken, openaiCodexToken] = oauthTokens;

async function testTokensOnAbort<TApi extends Api>(llm: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Write a long poem with 20 stanzas about the beauty of nature.",
				timestamp: Date.now(),
			},
		],
	};

	const controller = new AbortController();
	const response = stream(llm, context, { ...options, signal: controller.signal });

	let abortFired = false;
	let text = "";
	for await (const event of response) {
		if (!abortFired && (event.type === "text_delta" || event.type === "thinking_delta")) {
			text += event.delta;
			if (text.length >= 1000) {
				abortFired = true;
				controller.abort();
			}
		}
	}

	const msg = await response.result();

	expect(msg.stopReason).toBe("aborted");

	// OpenAI providers, OpenAI Codex, Gemini CLI, zai, and the GPT-OSS model on Antigravity only send usage in the final chunk,
	// so when aborted they have no token stats Anthropic and Google send usage information early in the stream
	if (
		llm.api === "openai-completions" ||
		llm.api === "openai-responses" ||
		llm.api === "openai-codex-responses" ||
		llm.provider === "google-gemini-cli" ||
		llm.provider === "zai" ||
		(llm.provider === "google-antigravity" && llm.id.includes("gpt-oss"))
	) {
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.output).toBe(0);
	} else {
		expect(msg.usage.input).toBeGreaterThan(0);
		expect(msg.usage.output).toBeGreaterThan(0);

		// Antigravity Gemini and Claude models report token usage, but no cost
		if (llm.provider !== "google-antigravity") {
			expect(msg.usage.cost.input).toBeGreaterThan(0);
			expect(msg.usage.cost.total).toBeGreaterThan(0);
		}
	}
}

describe("Token Statistics on Abort", () => {
	describe.skipIf(!e2eApiKey("GEMINI_API_KEY"))("Google Provider", () => {
		const llm = getBundledModel("google", "gemini-2.5-flash");

		it(
			"should include token stats when aborted mid-stream",
			async () => {
				await testTokensOnAbort(llm, { thinking: { enabled: true } });
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Completions Provider", () => {
		const llm: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">)!,
			api: "openai-completions",
		};

		it(
			"should include token stats when aborted mid-stream",
			async () => {
				await testTokensOnAbort(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Responses Provider", () => {
		const llm = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

		it(
			"should include token stats when aborted mid-stream",
			async () => {
				await testTokensOnAbort(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("Anthropic Provider", () => {
		const llm = getBundledModel("anthropic", "claude-haiku-4-5-20251001");

		it(
			"should include token stats when aborted mid-stream",
			async () => {
				await testTokensOnAbort(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("XAI_API_KEY"))("xAI Provider", () => {
		const llm = getBundledModel("xai", "grok-3-fast");

		it(
			"should include token stats when aborted mid-stream",
			async () => {
				await testTokensOnAbort(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("GROQ_API_KEY"))("Groq Provider", () => {
		const llm = getBundledModel("groq", "openai/gpt-oss-20b");

		it(
			"should include token stats when aborted mid-stream",
			async () => {
				await testTokensOnAbort(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("CEREBRAS_API_KEY"))("Cerebras Provider", () => {
		const llm = getBundledModel("cerebras", "gpt-oss-120b");

		it(
			"should include token stats when aborted mid-stream",
			async () => {
				await testTokensOnAbort(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("ZAI_API_KEY"))("zAI Provider", () => {
		const llm = getBundledModel("zai", "glm-4.5-flash");

		it(
			"should include token stats when aborted mid-stream",
			async () => {
				await testTokensOnAbort(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe.skipIf(!e2eApiKey("MISTRAL_API_KEY"))("Mistral Provider", () => {
		const llm = getBundledModel("mistral", "devstral-medium-latest");

		it(
			"should include token stats when aborted mid-stream",
			async () => {
				await testTokensOnAbort(llm);
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("Anthropic OAuth Provider", () => {
		const llm = getBundledModel("anthropic", "claude-haiku-4-5-20251001");

		it.skipIf(!anthropicOAuthToken)(
			"should include token stats when aborted mid-stream",
			async () => {
				await testTokensOnAbort(llm, { apiKey: anthropicOAuthToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("GitHub Copilot Provider", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should include token stats when aborted mid-stream",
			async () => {
				const llm = getBundledModel("github-copilot", "gpt-4o");
				await testTokensOnAbort(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should include token stats when aborted mid-stream",
			async () => {
				const llm = getBundledModel("github-copilot", "claude-sonnet-4");
				await testTokensOnAbort(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("Google Gemini CLI Provider", () => {
		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should include token stats when aborted mid-stream",
			async () => {
				const llm = getBundledModel("google-gemini-cli", "gemini-2.5-flash");
				await testTokensOnAbort(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("Google Antigravity Provider", () => {
		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should include token stats when aborted mid-stream",
			async () => {
				const llm = getBundledModel("google-antigravity", "gemini-3-flash");
				await testTokensOnAbort(llm, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should include token stats when aborted mid-stream",
			async () => {
				const llm = getBundledModel("google-antigravity", "claude-sonnet-4-5");
				await testTokensOnAbort(llm, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should include token stats when aborted mid-stream",
			async () => {
				const llm = getBundledModel("google-antigravity", "gpt-oss-120b-medium");
				await testTokensOnAbort(llm, { apiKey: antigravityToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});

	describe("OpenAI Codex Provider", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should include token stats when aborted mid-stream",
			async () => {
				const llm = getBundledModel("openai-codex", "gpt-5.2-codex");
				await testTokensOnAbort(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3, timeout: 30000 },
		);
	});
});
