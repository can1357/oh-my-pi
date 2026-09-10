import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createApiKeyResolver } from "@oh-my-pi/pi-coding-agent/config/api-key-resolver";

/** Minimal successful chat-completions SSE stream for the openai-completions provider. */
function okChatCompletionStream(): Response {
	const chunks = [
		JSON.stringify({
			id: "cmpl",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
		}),
		JSON.stringify({
			id: "cmpl",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		}),
		"[DONE]",
	];
	return new Response(chunks.map(c => `data: ${c}\n\n`).join(""), {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

describe("provider API key auto-rotation on auth failure", () => {
	let tempDir = "";
	let authStorage: AuthStorage;
	let modelsPath = "";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-provider-api-key-rotation-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		authStorage.close();
		if (!tempDir || !fs.existsSync(tempDir)) return;
		try {
			removeSyncWithRetries(tempDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		}
	});

	test("user can survive one dead key: with keys [bad, good], a 401 on the first attempt is followed by a success on the second key", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: ["bad-key", "good-key"],
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");

		const seen: Array<string | undefined> = [];
		const fetchImpl: FetchImpl = async (_url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			seen.push(headers.Authorization);
			if (headers.Authorization !== "Bearer good-key") {
				return new Response(JSON.stringify({ error: { message: "invalid api key", type: "authentication_error" } }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
			return okChatCompletionStream();
		};

		const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const streamHandle = streamSimple(model, context, {
			apiKey: registry.resolver(model),
			fetch: fetchImpl,
			maxTokens: 16,
		});
		for await (const _event of streamHandle) {
			// drain
		}
		const result = await streamHandle.result();

		expect(result.stopReason).toBe("stop");
		expect(seen).toEqual(["Bearer bad-key", "Bearer good-key"]);
	});

	test("user can fail over on quota: with keys [exhausted, fresh], a usage-limit 429 on the first key is followed by a success on the second key", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: ["exhausted-key", "fresh-key"],
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");

		const seen: Array<string | undefined> = [];
		const fetchImpl: FetchImpl = async (_url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			seen.push(headers.Authorization);
			if (headers.Authorization !== "Bearer fresh-key") {
				return new Response(
					JSON.stringify({
						error: { message: "insufficient_quota: quota exhausted", type: "insufficient_quota" },
					}),
					// retry-after: 0 keeps the provider transport retries (which own
					// every 429 first) instant, so this test exercises session
					// rotation instead of the transport backoff schedule.
					{ status: 429, headers: { "Content-Type": "application/json", "retry-after": "0" } },
				);
			}
			return okChatCompletionStream();
		};

		const context: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const streamHandle = streamSimple(model, context, {
			apiKey: registry.resolver(model),
			fetch: fetchImpl,
			maxTokens: 16,
		});
		for await (const _event of streamHandle) {
			// drain
		}
		const result = await streamHandle.result();

		expect(result.stopReason).toBe("stop");
		// The provider transport owns every 429 first (instant here via
		// retry-after: 0); once it gives up, exactly one fresh-key attempt
		// follows and succeeds — no second fresh attempt, no exhausted reuse.
		expect(seen.length).toBeGreaterThan(1);
		expect(seen[0]).toBe("Bearer exhausted-key");
		expect(seen.at(-1)).toBe("Bearer fresh-key");
		expect(seen.slice(0, -1).every(key => key === "Bearer exhausted-key")).toBe(true);
	});

	test("concurrent refresh-path failures serialize per provider: two interleaved recoveries advance twice and re-resolve distinct siblings", async () => {
		const keys = ["key-one", "key-two", "key-three"];
		let cursor = 0;
		const advances: number[] = [];
		const fakeRegistry = {
			getApiKeyForProvider: async (_provider: string): Promise<string | undefined> => {
				// Suspend one microtask before reading: both resolvers start
				// synchronously (so both cycles land first), then each reads.
				// A registry shell that resolves asynchronously (the structural
				// ApiKeyResolverRegistry permits it) exposes the interleave the
				// per-provider lock must close. No wall-clock involved.
				await Promise.resolve();
				return keys[cursor];
			},
			authStorage: { rotateSessionCredential: async () => false },
			cycleProviderApiKey: (_provider: string): boolean => {
				cursor = (cursor + 1) % keys.length;
				advances.push(cursor);
				return true;
			},
		};
		const first = createApiKeyResolver(fakeRegistry, "custom-proxy");
		const second = createApiKeyResolver(fakeRegistry, "custom-proxy");
		const failure = { lastChance: false as const, error: new Error("socket hang up"), signal: undefined };
		const [keyA, keyB] = await Promise.all([first(failure), second(failure)]);
		expect(advances).toEqual([1, 2]);
		expect([keyA, keyB].sort()).toEqual(["key-three", "key-two"]);
	});
});
