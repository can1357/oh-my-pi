/**
 * Test context overflow error handling across providers.
 *
 * Context overflow occurs when the input (prompt + history) exceeds
 * the model's context window. This is different from output token limits.
 *
 * Expected behavior: All providers should return stopReason: "error"
 * with an errorMessage that indicates the context was too large,
 * OR (for z.ai) return successfully with usage.input > contextWindow.
 *
 * The isContextOverflow() function must return true for all providers.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { execSync, spawn } from "node:child_process";
import { isContextOverflow as originalIsContextOverflow } from "@oh-my-pi/pi-ai/error";
import { complete } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, Model, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { $which } from "@oh-my-pi/pi-utils";

function isContextOverflow(message: AssistantMessage, contextWindow: number | null): boolean {
	return originalIsContextOverflow(message, contextWindow ?? 0);
}

import { e2eApiKey, resolveApiKey } from "./oauth";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("github-copilot"),
	resolveApiKey("google-gemini-cli"),
	resolveApiKey("google-antigravity"),
	resolveApiKey("openai-codex"),
]);
const [githubCopilotToken, geminiCliToken, antigravityToken, openaiCodexToken] = oauthTokens;

// Lorem ipsum paragraph for realistic token estimation
const LOREM_IPSUM = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. `;

// Generate a string that will exceed the context window
// Using chars/4 as token estimate (works better with varied text than repeated chars)
function generateOverflowContent(contextWindow: number): string {
	const targetTokens = contextWindow + 10000; // Exceed by 10k tokens
	const targetChars = targetTokens * 4 * 1.5;
	const repetitions = Math.ceil(targetChars / LOREM_IPSUM.length);
	return LOREM_IPSUM.repeat(repetitions);
}

interface OverflowResult {
	provider: string;
	model: string;
	contextWindow: number;
	stopReason: string;
	errorMessage: string | undefined;
	usage: Usage;
	hasUsageData: boolean;
	response: AssistantMessage;
}

async function testContextOverflow(model: Model, apiKey: string): Promise<OverflowResult> {
	const overflowContent = generateOverflowContent(model.contextWindow ?? 0);

	const context: Context = {
		systemPrompt: ["You are a helpful assistant."],
		messages: [
			{
				role: "user",
				content: overflowContent,
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(model, context, { apiKey });

	const hasUsageData = response.usage.input > 0 || response.usage.cacheRead > 0;

	return {
		provider: model.provider,
		model: model.id,
		contextWindow: model.contextWindow ?? 0,
		stopReason: response.stopReason,
		errorMessage: response.errorMessage,
		usage: response.usage,
		hasUsageData,
		response,
	};
}

function logResult(result: OverflowResult) {
	console.log(`\n${result.provider} / ${result.model}:`);
	console.log(`  contextWindow: ${result.contextWindow}`);
	console.log(`  stopReason: ${result.stopReason}`);
	console.log(`  errorMessage: ${result.errorMessage}`);
	console.log(`  usage: ${JSON.stringify(result.usage)}`);
	console.log(`  hasUsageData: ${result.hasUsageData}`);
}

const LM_STUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const LM_STUDIO_DEFAULT_CONTEXT_WINDOW = 8192;
const LM_STUDIO_MODEL_DISCOVERY_TIMEOUT_MS = 1000;

interface LmStudioDiscoveredModel {
	id: string;
	name: string;
	contextWindow: number;
	baseUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLmStudioBaseUrl(rawBaseUrl: string | undefined): string {
	const baseUrl = (rawBaseUrl ?? LM_STUDIO_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
	return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

function toLmStudioNativeBaseUrl(openAIBaseUrl: string): string {
	return openAIBaseUrl.endsWith("/v1") ? openAIBaseUrl.slice(0, -3) : openAIBaseUrl;
}

async function fetchLmStudioJson(url: string): Promise<unknown | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), LM_STUDIO_MODEL_DISCOVERY_TIMEOUT_MS);
	const headers: Record<string, string> = { Accept: "application/json" };
	if (Bun.env.LM_STUDIO_API_KEY) {
		headers.Authorization = `Bearer ${Bun.env.LM_STUDIO_API_KEY}`;
	}

	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		if (!response.ok) return undefined;
		return await response.json();
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

function getModelRecords(payload: unknown): Record<string, unknown>[] {
	if (Array.isArray(payload)) {
		return payload.filter(isRecord);
	}
	if (!isRecord(payload)) {
		return [];
	}

	for (const key of ["data", "models", "result", "items"]) {
		const value = payload[key];
		if (Array.isArray(value)) {
			return value.filter(isRecord);
		}
	}

	return [];
}

function toPositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

async function discoverLmStudioModel(): Promise<LmStudioDiscoveredModel | undefined> {
	if (!Bun.env.PI_LOCAL_LLM || Bun.env.PI_NO_LOCAL_LLM) return undefined;

	const baseUrl = normalizeLmStudioBaseUrl(Bun.env.LM_STUDIO_BASE_URL);
	const openAIModels = getModelRecords(await fetchLmStudioJson(`${baseUrl}/models`))
		.map(entry => ({
			id: typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined,
			name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : undefined,
		}))
		.filter((entry): entry is { id: string; name: string | undefined } => entry.id !== undefined);
	if (openAIModels.length === 0) return undefined;
	const firstOpenAIModel = openAIModels[0];
	if (!firstOpenAIModel) return undefined;

	const visibleIds = new Set(openAIModels.map(entry => entry.id));
	const nativeBaseUrl = toLmStudioNativeBaseUrl(baseUrl);
	const nativeModels = getModelRecords(await fetchLmStudioJson(`${nativeBaseUrl}/api/v0/models`)).filter(
		entry => typeof entry.id === "string" && visibleIds.has(entry.id),
	);
	const nativeCandidate =
		nativeModels.find(
			entry =>
				entry.state === "loaded" && (entry.type === "llm" || entry.type === "vlm" || entry.type === undefined),
		) ?? nativeModels.find(entry => entry.type === "llm" || entry.type === "vlm" || entry.type === undefined);
	const openAICandidate =
		(nativeCandidate && openAIModels.find(entry => entry.id === nativeCandidate.id)) ?? firstOpenAIModel;

	return {
		id: openAICandidate.id,
		name:
			openAICandidate.name ??
			(typeof nativeCandidate?.publisher === "string" ? nativeCandidate.publisher : undefined) ??
			openAICandidate.id,
		contextWindow: toPositiveInteger(nativeCandidate?.max_context_length) ?? LM_STUDIO_DEFAULT_CONTEXT_WINDOW,
		baseUrl,
	};
}

const lmStudioModel = await discoverLmStudioModel();
// =============================================================================
// Anthropic
// Expected pattern: "prompt is too long: X tokens > Y maximum"
// =============================================================================

describe("Context overflow error handling", () => {
	describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("Anthropic (API Key)", () => {
		it("claude-haiku-4-5 - should detect overflow via isContextOverflow", async () => {
			const model = getBundledModel("anthropic", "claude-haiku-4-5-20251001");
			const result = await testContextOverflow(model, Bun.env.ANTHROPIC_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/prompt is too long/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("Anthropic (OAuth)", () => {
		it("claude-sonnet-4 - should detect overflow via isContextOverflow", async () => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-20250514");
			const result = await testContextOverflow(model, e2eApiKey("ANTHROPIC_API_KEY")!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/prompt is too long/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// GitHub Copilot (OAuth)
	// Tests both OpenAI and Anthropic models via Copilot
	// =============================================================================

	describe("GitHub Copilot (OAuth)", () => {
		// OpenAI model via Copilot
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should detect overflow via isContextOverflow",
			async () => {
				const model = getBundledModel("github-copilot", "gpt-4o");
				const result = await testContextOverflow(model, githubCopilotToken!);
				logResult(result);

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toMatch(/exceeds the limit of \d+/i);
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			},
			120000,
		);

		// Anthropic model via Copilot
		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should detect overflow via isContextOverflow",
			async () => {
				const model = getBundledModel("github-copilot", "claude-sonnet-4");
				const result = await testContextOverflow(model, githubCopilotToken!);
				logResult(result);

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toMatch(/exceeds the limit of \d+/i);
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			},
			120000,
		);
	});

	// =============================================================================
	// OpenAI
	// Expected pattern: "exceeds the context window"
	// =============================================================================

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Completions", () => {
		it("gpt-4o-mini - should detect overflow via isContextOverflow", async () => {
			const model = { ...getBundledModel("openai", "gpt-4o-mini"), api: "openai-completions" as const };
			const result = await testContextOverflow(model, Bun.env.OPENAI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Responses", () => {
		it("gpt-4o - should detect overflow via isContextOverflow", async () => {
			const model = getBundledModel("openai", "gpt-4o");
			const result = await testContextOverflow(model, Bun.env.OPENAI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/exceeds the context window/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Google
	// Expected pattern: "input token count (X) exceeds the maximum"
	// =============================================================================

	describe.skipIf(!e2eApiKey("GEMINI_API_KEY"))("Google", () => {
		it("gemini-2.0-flash - should detect overflow via isContextOverflow", async () => {
			const model = getBundledModel("google", "gemini-2.0-flash");
			const result = await testContextOverflow(model, Bun.env.GEMINI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/input token count.*exceeds the maximum/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Google Gemini CLI (OAuth)
	// Uses same API as Google, expects same error pattern
	// =============================================================================

	describe("Google Gemini CLI (OAuth)", () => {
		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should detect overflow via isContextOverflow",
			async () => {
				const model = getBundledModel("google-gemini-cli", "gemini-2.5-flash");
				const result = await testContextOverflow(model, geminiCliToken!);
				logResult(result);

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toMatch(/input token count.*exceeds the maximum/i);
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			},
			120000,
		);
	});

	// =============================================================================
	// Google Antigravity (OAuth)
	// Tests both Gemini and Anthropic models via Antigravity
	// =============================================================================

	describe("Google Antigravity (OAuth)", () => {
		// Gemini model
		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should detect overflow via isContextOverflow",
			async () => {
				const model = getBundledModel("google-antigravity", "gemini-3-flash");
				const result = await testContextOverflow(model, antigravityToken!);
				logResult(result);

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toMatch(/input token count.*exceeds the maximum/i);
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			},
			120000,
		);

		// Anthropic model via Antigravity
		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should detect overflow via isContextOverflow",
			async () => {
				const model = getBundledModel("google-antigravity", "claude-sonnet-4-5");
				const result = await testContextOverflow(model, antigravityToken!);
				logResult(result);

				expect(result.stopReason).toBe("error");
				// Anthropic models return "prompt is too long" pattern
				expect(result.errorMessage).toMatch(/prompt is too long/i);
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			},
			120000,
		);
	});

	// =============================================================================
	// OpenAI Codex (OAuth)
	// Uses ChatGPT Plus/Pro subscription via OAuth
	// =============================================================================

	describe("OpenAI Codex (OAuth)", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should detect overflow via isContextOverflow",
			async () => {
				const model = getBundledModel("openai-codex", "gpt-5.2-codex");
				const result = await testContextOverflow(model, openaiCodexToken!);
				logResult(result);

				expect(result.stopReason).toBe("error");
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			},
			120000,
		);
	});

	// =============================================================================
	// xAI
	// Expected pattern: "maximum prompt length is X but the request contains Y"
	// =============================================================================

	describe.skipIf(!e2eApiKey("XAI_API_KEY"))("xAI", () => {
		it("grok-3-fast - should detect overflow via isContextOverflow", async () => {
			const model = getBundledModel("xai", "grok-3-fast");
			const result = await testContextOverflow(model, Bun.env.XAI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum prompt length is \d+/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Groq
	// Expected pattern: "reduce the length of the messages"
	// =============================================================================

	describe.skipIf(!e2eApiKey("GROQ_API_KEY"))("Groq", () => {
		it("llama-3.3-70b-versatile - should detect overflow via isContextOverflow", async () => {
			const model = getBundledModel("groq", "llama-3.3-70b-versatile");
			const result = await testContextOverflow(model, Bun.env.GROQ_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/reduce the length of the messages/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Cerebras
	// Expected: 400/413 status code with no body
	// =============================================================================

	describe.skipIf(!e2eApiKey("CEREBRAS_API_KEY"))("Cerebras", () => {
		it("qwen-3-235b - should detect overflow via isContextOverflow", async () => {
			const model = getBundledModel("cerebras", "qwen-3-235b-a22b-instruct-2507");
			const result = await testContextOverflow(model, Bun.env.CEREBRAS_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			// Cerebras returns status code with no body (400, 413, or 429 for token rate limit)
			expect(result.errorMessage).toMatch(/4(00|13|29).*\(no body\)/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// z.ai
	// Special case: Sometimes accepts overflow silently, sometimes rate limits
	// Detection via usage.input > contextWindow when successful
	// =============================================================================

	describe.skipIf(!e2eApiKey("ZAI_API_KEY"))("z.ai", () => {
		it("glm-4.5-flash - should detect overflow via isContextOverflow (silent overflow or rate limit)", async () => {
			const model = getBundledModel("zai", "glm-4.5-flash");
			const result = await testContextOverflow(model, Bun.env.ZAI_API_KEY!);
			logResult(result);

			// z.ai behavior is inconsistent:
			// - Sometimes accepts overflow and returns successfully with usage.input > contextWindow
			// - Sometimes returns rate limit error
			// Either way, isContextOverflow should detect it (via usage check or we skip if rate limited)
			if (result.stopReason === "stop") {
				expect(result.hasUsageData).toBe(true);
				expect(result.usage.input).toBeGreaterThan(model.contextWindow ?? 0);
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			} else {
				// Rate limited or other error - just log and pass
				console.log("  z.ai returned error (possibly rate limited), skipping overflow detection");
			}
		}, 120000);
	});

	// =============================================================================
	// Mistral
	// Expected pattern: TBD - need to test actual error message
	// =============================================================================

	describe.skipIf(!e2eApiKey("MISTRAL_API_KEY"))("Mistral", () => {
		it("devstral-medium-latest - should detect overflow via isContextOverflow", async () => {
			const model = getBundledModel("mistral", "devstral-medium-latest");
			const result = await testContextOverflow(model, Bun.env.MISTRAL_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// OpenRouter - Multiple backend providers
	// Expected pattern: "maximum context length is X tokens"
	// =============================================================================

	describe.skipIf(!e2eApiKey("OPENROUTER_API_KEY"))("OpenRouter", () => {
		// Anthropic backend
		it("anthropic/claude-sonnet-4 via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getBundledModel("openrouter", "anthropic/claude-sonnet-4");
			const result = await testContextOverflow(model, Bun.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);

		// DeepSeek backend
		it("deepseek/deepseek-v3.2 via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getBundledModel("openrouter", "deepseek/deepseek-v3.2");
			const result = await testContextOverflow(model, Bun.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);

		// Mistral backend
		it("mistralai/mistral-large-2512 via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getBundledModel("openrouter", "mistralai/mistral-large-2512");
			const result = await testContextOverflow(model, Bun.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);

		// Google backend
		it("google/gemini-2.5-flash via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getBundledModel("openrouter", "google/gemini-2.5-flash");
			const result = await testContextOverflow(model, Bun.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);

		// Meta/Llama backend
		it("meta-llama/llama-4-maverick via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getBundledModel("openrouter", "meta-llama/llama-4-maverick");
			const result = await testContextOverflow(model, Bun.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Ollama (local)
	// =============================================================================

	// Ollama tests require PI_LOCAL_LLM=1 and ollama installed
	const ollamaInstalled = !!Bun.env.PI_LOCAL_LLM && !!$which("ollama");

	describe.skipIf(!ollamaInstalled)("Ollama (local)", () => {
		let ollamaProcess: ChildProcess | null = null;
		let model: Model<"openai-completions"> | undefined;

		beforeAll(async () => {
			if (!ollamaInstalled) return;
			// Check if model is available, if not pull it
			try {
				execSync("ollama list | grep -q 'gpt-oss:20b'", { stdio: "ignore" });
			} catch {
				console.log("Pulling gpt-oss:20b model for Ollama overflow tests...");
				try {
					execSync("ollama pull gpt-oss:20b", { stdio: "inherit" });
				} catch {
					console.warn("Failed to pull gpt-oss:20b model, tests will be skipped");
					return;
				}
			}

			// Start ollama server
			ollamaProcess = spawn("ollama", ["serve"], {
				stdio: "ignore",
			});

			// Wait for server to be ready
			await new Promise<void>(resolve => {
				const checkServer = async () => {
					try {
						const response = await fetch("http://localhost:11434/api/tags");
						if (response.ok) {
							resolve();
						} else {
							setTimeout(checkServer, 500);
						}
					} catch {
						setTimeout(checkServer, 500);
					}
				};
				setTimeout(checkServer, 1000);
			});

			model = buildModel({
				id: "gpt-oss:20b",
				api: "openai-completions",
				provider: "ollama",
				baseUrl: "http://localhost:11434/v1",
				reasoning: true,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 16000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				name: "Ollama GPT-OSS 20B",
			});
		}, 60000);

		afterAll(() => {
			if (ollamaProcess) {
				ollamaProcess.kill("SIGTERM");
				ollamaProcess = null;
			}
		});

		it("gpt-oss:20b - should detect overflow via isContextOverflow (ollama silently truncates)", async () => {
			if (!model) return;
			const result = await testContextOverflow(model, "ollama");
			logResult(result);

			// Ollama silently truncates input instead of erroring
			// It returns stopReason "stop" with truncated usage
			// We cannot detect overflow via error message, only via usage comparison
			if (result.stopReason === "stop" && result.hasUsageData) {
				// Ollama truncated - check if reported usage is less than what we sent
				// This is a "silent overflow" - we can detect it if we know expected input size
				console.log("  Ollama silently truncated input to", result.usage.input, "tokens");
				// For now, we accept this behavior - Ollama doesn't give us a way to detect overflow
			} else if (result.stopReason === "error") {
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			}
		}, 300000); // 5 min timeout for local model
	});

	// =============================================================================
	// LM Studio (local) - requires PI_LOCAL_LLM=1 and a visible local model
	// =============================================================================

	describe.skipIf(lmStudioModel === undefined)("LM Studio (local)", () => {
		it("should detect overflow via isContextOverflow", async () => {
			if (!lmStudioModel) return;
			const model: Model<"openai-completions"> = buildModel({
				id: lmStudioModel.id,
				api: "openai-completions",
				provider: "lm-studio",
				baseUrl: lmStudioModel.baseUrl,
				reasoning: false,
				input: ["text"],
				contextWindow: lmStudioModel.contextWindow,
				maxTokens: 2048,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				name: lmStudioModel.name,
			});

			const result = await testContextOverflow(model, Bun.env.LM_STUDIO_API_KEY || "lm-studio");
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// llama.cpp server (local) - Skip if not running
	// =============================================================================

	let llamaCppRunning = false;
	try {
		execSync("curl -s --max-time 1 http://localhost:8081/health > /dev/null", { stdio: "ignore" });
		llamaCppRunning = true;
	} catch {
		llamaCppRunning = false;
	}

	describe.skipIf(!llamaCppRunning)("llama.cpp (local)", () => {
		it("should detect overflow via isContextOverflow", async () => {
			// Using small context (4096) to match server --ctx-size setting
			const model: Model<"openai-completions"> = buildModel({
				id: "local-model",
				api: "openai-completions",
				provider: "llama.cpp",
				baseUrl: "http://localhost:8081/v1",
				reasoning: false,
				input: ["text"],
				contextWindow: 4096,
				maxTokens: 2048,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				name: "llama.cpp Local Model",
			});

			const result = await testContextOverflow(model, "llama.cpp");
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});
});
