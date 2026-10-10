import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	openCodexCompactionEventStream,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import { withEnv } from "./helpers";

const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
	__resetProxyCache();
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	__resetProxyCache();
	vi.restoreAllMocks();
});

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestModel(baseUrl = "https://chatgpt.com/backend-api"): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl,
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	});
}

function createCodexTestContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createCompletedCodexSse(text: string): string {
	return `${[
		`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}`,
		`data: ${JSON.stringify({ type: "response.content_part.added", output_index: 0, item_id: "msg_1", content_index: 0, part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: text })}`,
		`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}`,
		`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
	].join("\n\n")}\n\n`;
}

// A fixed replacement payload pins the outgoing wire body so the serialized
// JSON is byte-deterministic across the compress/decompress round-trip.
const PINNED_PAYLOAD: Record<string, unknown> = {
	model: "gpt-5.3-codex-spark",
	input: [{ role: "user", content: [{ type: "input_text", text: "Say hello" }] }],
	stream: true,
	prompt_cache_key: "zstd-test-cache-key",
};

interface CapturedRequest {
	body: RequestInit["body"];
	headers: Headers;
}

async function runAndCaptureRequests(options?: { baseUrl?: string; statuses?: number[] }): Promise<CapturedRequest[]> {
	const token = createCodexTestToken();
	const model = createCodexTestModel(options?.baseUrl);
	const statuses = options?.statuses ?? [200];
	const captured: CapturedRequest[] = [];
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured.push({
			body: init?.body,
			headers: init?.headers instanceof Headers ? new Headers(init.headers) : new Headers(init?.headers),
		});
		const status = statuses[Math.min(captured.length - 1, statuses.length - 1)]!;
		return new Response(status === 200 ? createCompletedCodexSse("Hello") : "unsupported content encoding", {
			status,
			headers: { "content-type": status === 200 ? "text/event-stream" : "text/plain" },
		});
	});

	const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
		apiKey: token,
		fetch: fetchMock as FetchImpl,
		onPayload: async () => PINNED_PAYLOAD,
	}).result();

	expect(result.stopReason).toBe("stop");
	return captured;
}

async function runAndCaptureRequest(): Promise<CapturedRequest> {
	const [captured] = await runAndCaptureRequests();
	if (captured === undefined) throw new Error("expected the SSE request to reach fetch");
	return captured;
}

describe("codex SSE request body zstd compression", () => {
	it("compresses the request body with zstd and sets content-encoding by default", async () => {
		await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
			const { body, headers } = await runAndCaptureRequest();

			expect(headers.get("content-encoding")).toBe("zstd");
			expect(headers.get("content-type")).toContain("application/json");
			if (!(body instanceof Uint8Array)) throw new Error("expected a compressed binary body");
			// A zstd frame begins with the magic number 0xFD2FB528 (little-endian).
			expect(body[0]).toBe(0x28);
			expect(body[1]).toBe(0xb5);
			expect(body[2]).toBe(0x2f);
			expect(body[3]).toBe(0xfd);

			const decompressed = new TextDecoder().decode(Bun.zstdDecompressSync(body));
			expect(decompressed).toBe(JSON.stringify(PINNED_PAYLOAD));
		});
	});

	it("sends the plain JSON string without content-encoding when PI_CODEX_ZSTD=0", async () => {
		await withEnv({ PI_CODEX_ZSTD: "0" }, async () => {
			const { body, headers } = await runAndCaptureRequest();

			expect(headers.has("content-encoding")).toBe(false);
			expect(headers.get("content-type")).toContain("application/json");
			expect(typeof body).toBe("string");
			expect(body).toBe(JSON.stringify(PINNED_PAYLOAD));
		});
	});

	it("keeps custom Codex-compatible endpoints on plain JSON", async () => {
		await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
			const [captured] = await runAndCaptureRequests({ baseUrl: "https://relay.example/v1" });
			if (captured === undefined) throw new Error("expected the SSE request to reach fetch");

			expect(captured.headers.has("content-encoding")).toBe(false);
			expect(captured.body).toBe(JSON.stringify(PINNED_PAYLOAD));
		});
	});

	it("retries once with plain JSON when an official endpoint rejects zstd", async () => {
		await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
			for (const rejectedStatus of [400, 415]) {
				const captured = await runAndCaptureRequests({ statuses: [rejectedStatus, 200] });

				expect(captured).toHaveLength(2);
				expect(captured[0]?.headers.get("content-encoding")).toBe("zstd");
				expect(captured[0]?.body).toBeInstanceOf(Uint8Array);
				expect(captured[1]?.headers.has("content-encoding")).toBe(false);
				expect(captured[1]?.body).toBe(JSON.stringify(PINNED_PAYLOAD));
			}
		});
	});

	it("falls back to plain JSON when local compression fails", async () => {
		await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
			vi.spyOn(Bun, "zstdCompress").mockImplementation(async () => {
				throw new Error("zstd unavailable");
			});
			const { body, headers } = await runAndCaptureRequest();

			expect(headers.has("content-encoding")).toBe(false);
			expect(body).toBe(JSON.stringify(PINNED_PAYLOAD));
		});
	});

	it("replays the compressed bytes on transient HTTP retries", async () => {
		await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
			const captured = await runAndCaptureRequests({ statuses: [500, 200] });

			expect(captured).toHaveLength(2);
			for (const request of captured) {
				expect(request.headers.get("content-encoding")).toBe("zstd");
				if (!(request.body instanceof Uint8Array)) throw new Error("expected a compressed binary body");
				expect(new TextDecoder().decode(Bun.zstdDecompressSync(request.body))).toBe(JSON.stringify(PINNED_PAYLOAD));
			}
		});
	});

	for (const status of [503, 415]) {
		for (const revoke of [false, true]) {
			it(`${revoke ? "denies revoked" : "permits approved"} admission before a ${status} SSE resend`, async () => {
				await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
					let allowed = true;
					let hooks = 0;
					const bodies: Array<string | Uint8Array> = [];
					const result = await streamOpenAICodexResponses(createCodexTestModel(), createCodexTestContext(), {
						apiKey: createCodexTestToken(),
						reasoning: "high",
						preserveModelSelection: true,
						preserveThinkingEffort: true,
						onPayload: () => {
							hooks++;
						},
						onBeforeRequest: () => {
							if (!allowed) throw new Error("Codex grant revoked before replay.");
						},
						fetch: async (_input, init) => {
							bodies.push(init?.body as string | Uint8Array);
							if (bodies.length === 1) {
								if (revoke) allowed = false;
								return new Response(status === 415 ? "unsupported content encoding" : "unavailable", {
									status,
									headers: { "retry-after": "0" },
								});
							}
							return new Response(createCompletedCodexSse("approved response"), {
								headers: { "content-type": "text/event-stream" },
							});
						},
					}).result();
					expect(result.stopReason).toBe(revoke ? "error" : "stop");
					expect(bodies).toHaveLength(revoke ? 1 : 2);
					expect(hooks).toBe(1);
					expect(bodies[0]).toBeInstanceOf(Uint8Array);
					const captures = bodies.map(body =>
						typeof body === "string" ? body : new TextDecoder().decode(Bun.zstdDecompressSync(body)),
					);
					expect(JSON.parse(captures[0]!)).toMatchObject({
						model: "gpt-5.3-codex-spark",
						reasoning: { effort: "high" },
					});
					if (revoke) expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
					else {
						expect(captures[1]).toBe(captures[0]);
						expect(
							result.content.some(block => block.type === "text" && block.text === "approved response"),
						).toBe(true);
					}
				});
			}, 10_000);
		}
	}

	it("rejects a governed Codex SSE serializer before compression or HTTP", async () => {
		let requests = 0;
		let serializers = 0;
		const result = await streamOpenAICodexResponses(createCodexTestModel(), createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			reasoning: "high",
			preserveModelSelection: true,
			preserveThinkingEffort: true,
			fetch: async () => {
				requests++;
				return new Response(createCompletedCodexSse("unapproved"), {
					headers: { "content-type": "text/event-stream" },
				});
			},
			onPayload: payload => ({
				...(payload as Record<string, unknown>),
				toJSON() {
					serializers++;
					return { model: "different-codex-model", reasoning: { effort: "low" }, input: [] };
				},
			}),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
		expect(requests).toBe(0);
		expect(serializers).toBe(0);
	});

	for (const unsafe of ["proxy", "then-getter"] as const) {
		it(`rejects a governed synchronous ${unsafe} payload before assimilation or HTTP`, async () => {
			let requests = 0;
			let executions = 0;
			const result = await streamOpenAICodexResponses(createCodexTestModel(), createCodexTestContext(), {
				apiKey: createCodexTestToken(),
				reasoning: "high",
				preserveModelSelection: true,
				preserveThinkingEffort: true,
				fetch: async () => {
					requests++;
					return new Response(createCompletedCodexSse("unapproved"), {
						headers: { "content-type": "text/event-stream" },
					});
				},
				onPayload: payload => {
					if (unsafe === "proxy") {
						return new Proxy(payload as Record<string, unknown>, {
							get(target, key, receiver) {
								executions++;
								return Reflect.get(target, key, receiver);
							},
							getOwnPropertyDescriptor(target, key) {
								executions++;
								return Reflect.getOwnPropertyDescriptor(target, key);
							},
						});
					}
					const replacement = { ...(payload as Record<string, unknown>) };
					// oxlint-disable-next-line unicorn/no-thenable -- Adversarial fixture must never invoke the then accessor.
					Object.defineProperty(replacement, "then", {
						enumerable: true,
						get() {
							executions++;
							return undefined;
						},
					});
					return replacement;
				},
			}).result();
			expect(result.stopReason).toBe("error");
			expect(AIError.is(result.errorId, AIError.Flag.HostAdmission)).toBe(true);
			expect(requests).toBe(0);
			expect(executions).toBe(0);
		});
	}

	it("serves a governed native-Promise payload replacement without weakening encoded controls", async () => {
		await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
			let body: RequestInit["body"];
			let hooks = 0;
			let admissions = 0;
			const replacementInstructions = "An amended system instruction.";
			const result = await streamOpenAICodexResponses(createCodexTestModel(), createCodexTestContext(), {
				apiKey: createCodexTestToken(),
				reasoning: "high",
				preserveModelSelection: true,
				preserveThinkingEffort: true,
				onPayload: async payload => {
					hooks++;
					return { ...(payload as Record<string, unknown>), instructions: replacementInstructions };
				},
				onBeforeRequest: () => {
					admissions++;
				},
				fetch: async (_input, init) => {
					body = init?.body;
					return new Response(createCompletedCodexSse("approved replacement"), {
						headers: { "content-type": "text/event-stream" },
					});
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content.some(block => block.type === "text" && block.text === "approved replacement")).toBe(
				true,
			);
			if (!(body instanceof Uint8Array)) throw new Error("expected a compressed binary body");
			expect(JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(body)))).toMatchObject({
				model: "gpt-5.3-codex-spark",
				reasoning: { effort: "high" },
				instructions: replacementInstructions,
			});
			expect(hooks).toBe(1);
			expect(admissions).toBe(1);
		});
	});

	it("retains ordinary thenable payload replacement behavior", async () => {
		await withEnv({ PI_CODEX_ZSTD: undefined }, async () => {
			let body: RequestInit["body"];
			let thenCalls = 0;
			const result = await streamOpenAICodexResponses(createCodexTestModel(), createCodexTestContext(), {
				apiKey: createCodexTestToken(),
				onPayload: () => ({
					// oxlint-disable-next-line unicorn/no-thenable -- Deliberate fixture preserves ordinary hook assimilation.
					then(resolve: (payload: unknown) => void) {
						thenCalls++;
						resolve(PINNED_PAYLOAD);
					},
				}),
				fetch: async (_input, init) => {
					body = init?.body;
					return new Response(createCompletedCodexSse("ordinary response"), {
						headers: { "content-type": "text/event-stream" },
					});
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content.some(block => block.type === "text" && block.text === "ordinary response")).toBe(true);
			if (!(body instanceof Uint8Array)) throw new Error("expected a compressed binary body");
			expect(new TextDecoder().decode(Bun.zstdDecompressSync(body))).toBe(JSON.stringify(PINNED_PAYLOAD));
			expect(thenCalls).toBe(1);
		});
	});

	for (const mismatch of ["model", "effort", "missing-effort"] as const) {
		it(`rejects native compaction ${mismatch} before any transport request`, async () => {
			const model = { ...createCodexTestModel(), requestModelId: "authorized-native-wire" };
			let requests = 0;
			let caught: unknown;
			try {
				await openCodexCompactionEventStream(
					model,
					{
						model: mismatch === "model" ? "unapproved-native-wire" : "authorized-native-wire",
						reasoning: { effort: mismatch === "effort" ? "low" : "high" },
						input: [],
					},
					{
						apiKey: createCodexTestToken(),
						reasoning: mismatch === "missing-effort" ? undefined : "high",
						preserveModelSelection: true,
						preserveThinkingEffort: true,
						fetch: async () => {
							requests++;
							return new Response(createCompletedCodexSse("unexpected"), {
								headers: { "content-type": "text/event-stream" },
							});
						},
					},
				);
			} catch (error) {
				caught = error;
			}
			expect(AIError.is(AIError.classify(caught), AIError.Flag.HostAdmission)).toBe(true);
			expect(requests).toBe(0);
		});
	}
});
