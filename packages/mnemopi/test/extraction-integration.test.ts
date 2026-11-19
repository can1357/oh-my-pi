import { afterEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { extractFacts } from "@oh-my-pi/pi-mnemopi/core/extraction";
import { type ChatMessage, ExtractionClient } from "@oh-my-pi/pi-mnemopi/core/extraction/client";
import { getExtractionStats, resetExtractionStats } from "@oh-my-pi/pi-mnemopi/core/extraction/diagnostics";
import { resetHostLlmBackendForTests } from "@oh-my-pi/pi-mnemopi/core/llm-backends";

const OLD_ENV = { ...process.env };

function restoreEnv(): void {
	for (const key in process.env) {
		if (!(key in OLD_ENV)) delete process.env[key];
	}
	for (const key in OLD_ENV) {
		const value = OLD_ENV[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	restoreEnv();
	resetHostLlmBackendForTests();
	resetExtractionStats();
});

describe("extraction integration", () => {
	it("uses a fake OpenAI-compatible remote endpoint for extractFacts", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_LLM_BASE_URL = "http://fake-remote/v1";
		let payloadJson = "";
		const fetchMock: FetchImpl = async (_input, init) => {
			payloadJson = String(init?.body);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: '{"facts":["Ada prefers deterministic tests"]}' } }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const facts = await extractFacts("I prefer deterministic tests.", { fetch: fetchMock });
		expect(facts).toEqual(["Ada prefers deterministic tests"]);
		const payload = JSON.parse(payloadJson) as {
			temperature?: number;
			messages?: Array<{ content: string }>;
		};
		expect(payload.temperature).toBe(0);
		const firstMessage = payload.messages?.[0];
		if (firstMessage === undefined) throw new Error("expected first request message");
		expect(firstMessage.content).toContain("I prefer deterministic tests");
		expect(getExtractionStats().by_tier.remote.successes).toBe(1);
	});

	it("parses structured fact objects through ExtractionClient with fake HTTP", async () => {
		let requestedUrl = "";
		const fetchMock: FetchImpl = async input => {
			requestedUrl = String(input);
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content:
									'[{"subject":"Ada","predicate":"prefers","object":"deterministic tests","timestamp":"","source":0,"confidence":0.95}]',
							},
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const client = new ExtractionClient({
			apiKey: "sk-test",
			baseUrl: "http://openrouter.test/api/v1",
			fetch: fetchMock,
		});
		const facts = await client.extractFacts([{ role: "user", content: "Ada prefers deterministic tests." }]);
		expect(requestedUrl).toBe("http://openrouter.test/api/v1/chat/completions");
		expect(facts).toHaveLength(1);
		const fact = facts[0];
		if (fact === undefined) throw new Error("expected one extracted fact");
		expect(fact.subject).toBe("Ada");
		expect(getExtractionStats().totals.successes).toBe(1);
		expect(getExtractionStats().by_tier.cloud.successes).toBe(1);
	});

	it("records malformed cloud JSON as a diagnostic failure", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ choices: [{ message: { content: "Here: [oops, not json]" } }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const client = new ExtractionClient({
			apiKey: "sk-test",
			baseUrl: "http://openrouter.test/api/v1",
			fetch: fetchMock,
		});
		expect(await client.extractFacts([{ role: "user", content: "Ada prefers tea." }])).toEqual([]);
		const cloud = getExtractionStats().by_tier.cloud;
		expect(cloud.failures).toBe(1);
		expect(cloud.error_samples.some(sample => sample.reason === "json_parse_failed")).toBe(true);
	});

	it("uses millisecond-scale rate-limit and fallback backoff delays", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const delays: number[] = [];
		globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => {
			delays.push(Number(timeout ?? 0));
			if (typeof handler === "function") {
				const callback = handler as (...callbackArgs: unknown[]) => void;
				queueMicrotask(() => callback(...args));
			}
			return 0 as unknown as Timer;
		}) as typeof setTimeout;

		class RateLimitedClient extends ExtractionClient {
			override callApi(
				_model: string,
				_messages: readonly ChatMessage[],
				_temperature: number,
				_maxTokens: number,
			): Promise<string> {
				return Promise.reject(new Error("429 rate limited"));
			}
		}

		try {
			const client = new RateLimitedClient({ model: "primary", apiKey: "sk-test", baseUrl: "http://remote.test" });
			expect(await client.chat([{ role: "user", content: "Ada prefers deterministic tests." }])).toBe("");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}

		expect(delays.slice(0, 3)).toEqual([1000, 2000, 4000]);
		expect(delays.every(delay => delay >= 1000)).toBe(true);
	});
});
