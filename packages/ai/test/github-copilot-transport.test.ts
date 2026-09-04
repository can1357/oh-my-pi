import { describe, expect, it } from "bun:test";
import { postOpenAIStream } from "@oh-my-pi/pi-ai/utils/openai-http";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { buildAnthropicClientOptions } from "@oh-my-pi/pi-ai/providers/anthropic";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";

describe("GitHub Copilot transport contract", () => {
	it("retries matching transient 403 and succeeds on next attempt", async () => {
		let attempts = 0;
		const mockFetch = async () => {
			attempts++;
			if (attempts === 1) {
				return new Response("unauthorized: not authorized to use this Copilot feature\n", {
					status: 403,
					statusText: "Forbidden",
				});
			}
			return new Response('data: {"type":"response.done"}\n\n[DONE]\n\n', {
				status: 200,
				statusText: "OK",
				headers: { "Content-Type": "text/event-stream" },
			});
		};

		const handle = await postOpenAIStream({
			url: "https://api.githubcopilot.com/responses",
			headers: { "Copilot-Integration-Id": "vscode-chat" },
			body: { model: "gpt-5.6-sol", input: "ping" },
			signal: new AbortController().signal,
			fetch: mockFetch as unknown as FetchImpl,
		});

		expect(handle.response.status).toBe(200);
		expect(attempts).toBe(2);
	});

	it("does not retry non-matching 403 and fails in one attempt", async () => {
		let attempts = 0;
		const mockFetch = async () => {
			attempts++;
			return new Response("403 Forbidden: Invalid token", {
				status: 403,
				statusText: "Forbidden",
			});
		};

		await expect(
			postOpenAIStream({
				url: "https://api.githubcopilot.com/responses",
				headers: { "Copilot-Integration-Id": "vscode-chat" },
				body: { model: "gpt-5.6-sol", input: "ping" },
				signal: new AbortController().signal,
				fetch: mockFetch as unknown as FetchImpl,
			}),
		).rejects.toThrow();

		expect(attempts).toBe(1);
	});

	it("preserves response body on retry exhaustion", async () => {
		const mockFetch = async () => {
			return new Response("unauthorized: not authorized to use this Copilot feature\n", {
				status: 403,
				statusText: "Forbidden",
			});
		};

		try {
			await postOpenAIStream({
				url: "https://api.githubcopilot.com/responses",
				headers: { "Copilot-Integration-Id": "vscode-chat" },
				body: { model: "gpt-5.6-sol", input: "ping" },
				signal: new AbortController().signal,
				fetch: mockFetch as unknown as FetchImpl,
				maxAttempts: 2,
			});
			expect().fail("Expected postOpenAIStream to throw");
		} catch (err: unknown) {
			const errorWithCaptured = err as { message?: string; captured?: { status?: number; bodyText?: string } };
			expect(errorWithCaptured.message).toContain("unauthorized: not authorized to use this Copilot feature");
			expect(errorWithCaptured.captured?.status).toBe(403);
			expect(errorWithCaptured.captured?.bodyText).toContain("not authorized to use this Copilot feature");
		}
	});

	it("performs bounded fallback from CLI to VS Code mode in auto mode on 403", async () => {
		let attempts = 0;
		const observedHeaders: Record<string, string>[] = [];
		const mockFetch = async (_url: unknown, init?: RequestInit) => {
			attempts++;
			const rawHeaders = init?.headers;
			const headersObj: Record<string, string> = {};
			if (rawHeaders instanceof Headers) {
				rawHeaders.forEach((v, k) => {
					headersObj[k] = v;
				});
			} else if (rawHeaders && typeof rawHeaders === "object") {
				Object.assign(headersObj, rawHeaders);
			}
			observedHeaders.push(headersObj);

			if (attempts === 1) {
				return new Response("unauthorized: not authorized to use this Copilot feature\n", {
					status: 403,
					statusText: "Forbidden",
				});
			}
			return new Response('data: {"type":"response.done"}\n\n[DONE]\n\n', {
				status: 200,
				statusText: "OK",
				headers: { "Content-Type": "text/event-stream" },
			});
		};

		const handle = await postOpenAIStream({
			url: "https://api.githubcopilot.com/responses",
			headers: { "Copilot-Integration-Id": "copilot-developer-cli" },
			body: { model: "gpt-5.6-sol", input: "ping" },
			signal: new AbortController().signal,
			fetch: mockFetch as unknown as FetchImpl,
		});

		expect(handle.response.status).toBe(200);
		expect(attempts).toBe(2);
		expect(observedHeaders[0]?.["copilot-integration-id"] ?? observedHeaders[0]?.["Copilot-Integration-Id"]).toBe(
			"copilot-developer-cli",
		);
		expect(observedHeaders[1]?.["copilot-integration-id"] ?? observedHeaders[1]?.["Copilot-Integration-Id"]).toBe(
			"vscode-chat",
		);
	});

	it("does not fall back to VS Code mode when Copilot-Mode is explicitly cli", async () => {
		let attempts = 0;
		const mockFetch = async () => {
			attempts++;
			return new Response("unauthorized: not authorized to use this Copilot feature\n", {
				status: 403,
				statusText: "Forbidden",
			});
		};

		await expect(
			postOpenAIStream({
				url: "https://api.githubcopilot.com/responses",
				headers: { "Copilot-Integration-Id": "copilot-developer-cli", "Copilot-Mode": "cli" },
				body: { model: "gpt-5.6-sol", input: "ping" },
				signal: new AbortController().signal,
				fetch: mockFetch as unknown as FetchImpl,
			}),
		).rejects.toThrow();

		expect(attempts).toBe(1);
	});
});

describe("GitHub Copilot final request header sanitization", () => {
	it("sanitizes final OpenAI headers in VS Code mode with no CLI leak or Copilot-Mode", () => {
		const model = getBundledModel("github-copilot", "gpt-5.6-sol") as Model<"openai-responses">;
		const setup = resolveOpenAIRequestSetup(model, {
			apiKey: "test_token",
			extraHeaders: { "Copilot-Mode": "vscode", "X-Custom": "custom-val" },
			messages: [],
		});

		expect(setup.headers["Copilot-Integration-Id"]).toBe("vscode-chat");
		expect(setup.headers["Editor-Version"]).toBe("vscode/1.136.0");
		expect(setup.headers["User-Agent"]).toBe("GitHubCopilotChat/0.64.0");
		expect(setup.headers["Openai-Intent"]).toBe("conversation-panel");
		expect(setup.headers["X-Custom"]).toBe("custom-val");

		// Managed CLI headers and synthetic control header must not be present
		expect(setup.headers["Copilot-Harness-Id"]).toBeUndefined();
		expect(setup.headers["Copilot-Mode"]).toBeUndefined();
		expect(setup.headers["copilot-mode"]).toBeUndefined();
	});

	it("sanitizes final Anthropic defaultHeaders in VS Code mode", () => {
		const model = getBundledModel("github-copilot", "claude-opus-5") as Model<"anthropic-messages">;
		const options = buildAnthropicClientOptions({
			model,
			apiKey: "test_token",
			headers: { "Copilot-Mode": "vscode", "X-Custom": "custom-val" },
			dynamicHeaders: { "Copilot-Integration-Id": "vscode-chat" },
			stream: false,
		});

		const defaultHeaders = options.defaultHeaders as Record<string, string>;
		expect(defaultHeaders["Copilot-Integration-Id"]).toBe("vscode-chat");
		expect(defaultHeaders["Editor-Version"]).toBe("vscode/1.136.0");
		expect(defaultHeaders["User-Agent"]).toBe("GitHubCopilotChat/0.64.0");
		expect(defaultHeaders["Openai-Intent"]).toBe("conversation-panel");
		expect(defaultHeaders["X-Custom"]).toBe("custom-val");

		// Managed CLI headers and synthetic control header must not be present
		expect(defaultHeaders["Copilot-Harness-Id"]).toBeUndefined();
		expect(defaultHeaders["Copilot-Mode"]).toBeUndefined();
		expect(defaultHeaders["copilot-mode"]).toBeUndefined();
	});
});
