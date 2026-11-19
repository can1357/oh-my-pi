import { describe, expect, it } from "bun:test";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ProviderResponseMetadata,
	StreamOptions,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const geminiModel: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const vertexModel: Model<"google-vertex"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (Vertex)",
	api: "google-vertex",
	provider: "google-vertex",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const cliModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (CLI)",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const cliAuth = JSON.stringify({ token: "token", projectId: "proj-123" });

interface BodyState {
	/** True once the provider, not the runtime's response prefetch, has read the answer bytes. */
	delivered: boolean;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}

function chunk(text: string, finishReason: string, continuationToken?: string): unknown {
	return {
		candidates: [
			{
				content: { role: "model", parts: [{ text }] },
				finishReason,
				...(continuationToken ? { continuationToken } : {}),
			},
		],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	};
}

/**
 * SSE body that withholds its bytes from the first pull. Bun prefetches a
 * Response body once when the response is created; the provider's own read is
 * the pull that actually receives the answer.
 */
function trackedSse(payload: unknown, requestId: string, state: BodyState, headerName = "x-goog-request-id"): Response {
	const bytes = new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
	let primed = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (!primed) {
				primed = true;
				return;
			}
			state.delivered = true;
			controller.enqueue(bytes);
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream", [headerName]: requestId },
	});
}

function queue(responses: Response[]): FetchImpl {
	return async () => {
		const response = responses.shift();
		if (!response) throw new Error("unexpected request");
		return response;
	};
}

interface Held {
	response: ProviderResponseMetadata;
	modelId: string | undefined;
	provider: string | undefined;
	delivered: boolean;
}

/**
 * Parks inside the first observer call. Fails if the stream finishes with no
 * notification, if the answer bytes were already handed to the provider, or if
 * the answer is delivered while the observer is still waiting.
 */
async function holdFirstNotification(
	state: BodyState,
	start: (onResponse: NonNullable<StreamOptions["onResponse"]>) => Promise<AssistantMessage>,
): Promise<{ held: Held; result: AssistantMessage }> {
	const entered = Promise.withResolvers<Held>();
	const gate = Promise.withResolvers<void>();
	const resultPromise = start(async (response, model) => {
		entered.resolve({
			response,
			modelId: model?.id,
			provider: model?.provider,
			delivered: state.delivered,
		});
		await gate.promise;
	});
	try {
		const winner = await Promise.race([
			entered.promise.then(held => ({ kind: "notified" as const, held })),
			resultPromise.then(() => ({ kind: "done" as const })),
		]);
		expect(winner.kind).toBe("notified");
		if (winner.kind !== "notified") throw new Error("response observer was not called");
		let finished = false;
		void resultPromise.then(
			() => {
				finished = true;
			},
			() => {
				finished = true;
			},
		);
		for (let i = 0; i < 100; i++) await Promise.resolve();
		expect(finished).toBe(false);
		expect(winner.held.delivered).toBe(false);
		gate.resolve();
		return { held: winner.held, result: await resultPromise };
	} finally {
		gate.resolve();
		// Preserve an assertion or stream error while still leaving no pending work.
		await resultPromise.catch(() => undefined);
	}
}

describe("direct Google response observers", () => {
	it("tells the Gemini observer about headers before the answer is read, and waits for that observer", async () => {
		const state: BodyState = { delivered: false };
		const { held, result } = await holdFirstNotification(state, onResponse =>
			streamGoogle(geminiModel, context, {
				apiKey: "k",
				fetch: queue([trackedSse(chunk("hello", "STOP"), "gem-1", state)]),
				onResponse,
			}).result(),
		);

		expect(result.stopReason).toBe("stop");
		expect(assistantText(result)).toBe("hello");
		expect(state.delivered).toBe(true);
		expect(held.modelId).toBe(geminiModel.id);
		expect(held.provider).toBe("google");
		expect(held.response.status).toBe(200);
		expect(held.response.requestId).toBe("gem-1");
		expect(held.response.headers["x-goog-request-id"]).toBe("gem-1");
	});

	it("tells the observer about a resumed Gemini segment and skips a rejected resume", async () => {
		const first: BodyState = { delivered: false };
		const resume: BodyState = { delivered: false };
		const seen: Array<{ status: number; requestId: string | null | undefined; delivered: boolean }> = [];
		const result = await streamGoogle(geminiModel, context, {
			apiKey: "k",
			maxRetryDelayMs: 0,
			fetch: queue([
				trackedSse(chunk("Hello", "CONTINUATION", "seg-1"), "gem-1", first),
				new Response("busy", { status: 503, headers: { "x-goog-request-id": "gem-rejected" } }),
				trackedSse(chunk(" world", "STOP"), "gem-2", resume, "x-request-id"),
			]),
			onResponse: response => {
				const body = response.requestId === "gem-2" ? resume : first;
				seen.push({ status: response.status, requestId: response.requestId, delivered: body.delivered });
			},
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(assistantText(result)).toBe("Hello world");
		expect(first.delivered).toBe(true);
		expect(resume.delivered).toBe(true);
		expect(seen).toEqual([
			{ status: 200, requestId: "gem-1", delivered: false },
			{ status: 200, requestId: "gem-2", delivered: false },
		]);
	});

	const vertexFallbackTestName = "tells the observer about the accepted Vertex fallback and skips the regional miss";
	it(
		vertexFallbackTestName,
		async () => {
			if (Bun.env.OMP_TEST_VERTEX_RESPONSE_OBSERVER_CHILD !== "1") {
				// Only an ambient location enables global fallback. Keep it out of this
				// runner's shared environment by exercising that path in a child process.
				const child = Bun.spawn(
					[process.execPath, "test", import.meta.path, "--test-name-pattern", vertexFallbackTestName],
					{
						env: {
							...process.env,
							GOOGLE_VERTEX_LOCATION: "us-central1",
							OMP_TEST_VERTEX_RESPONSE_OBSERVER_CHILD: "1",
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
				return;
			}

			const urls: string[] = [];
			const state: BodyState = { delivered: false };
			const seen: Array<{ status: number; requestId: string | null | undefined; delivered: boolean }> = [];
			const fetch: FetchImpl = async input => {
				const url = String(input);
				urls.push(url);
				if (url.includes("us-central1-aiplatform.googleapis.com")) {
					return new Response("missing", { status: 404, headers: { "x-goog-request-id": "vertex-miss" } });
				}
				return trackedSse(chunk("ok", "STOP"), "vertex-hit", state);
			};
			const result = await streamGoogleVertex(vertexModel, context, {
				apiKey: "k",
				fetch,
				onResponse: response => {
					seen.push({ status: response.status, requestId: response.requestId, delivered: state.delivered });
				},
			}).result();

			expect(urls[0]).toContain("us-central1-aiplatform.googleapis.com");
			expect(urls[1]).toContain("https://aiplatform.googleapis.com/");
			expect(result.stopReason).toBe("stop");
			expect(assistantText(result)).toBe("ok");
			expect(state.delivered).toBe(true);
			expect(seen).toEqual([{ status: 200, requestId: "vertex-hit", delivered: false }]);
		},
		60_000,
	);
});

describe("Cloud Code Assist response observers", () => {
	it("tells the Gemini CLI observer about headers before the answer is read, and waits for that observer", async () => {
		const state: BodyState = { delivered: false };
		const { held, result } = await holdFirstNotification(state, onResponse =>
			streamGoogleGeminiCli(cliModel, context, {
				apiKey: cliAuth,
				fetch: queue([trackedSse({ response: chunk("hello", "STOP") }, "cli-1", state)]),
				onResponse,
			}).result(),
		);

		expect(result.stopReason).toBe("stop");
		expect(assistantText(result)).toBe("hello");
		expect(state.delivered).toBe(true);
		expect(held.modelId).toBe(cliModel.id);
		expect(held.provider).toBe("google-gemini-cli");
		expect(held.response.status).toBe(200);
		expect(held.response.requestId).toBe("cli-1");
		expect(held.response.headers["x-goog-request-id"]).toBe("cli-1");
	});

	it("tells the Gemini CLI observer about a resumed segment and skips a rejected resume", async () => {
		const first: BodyState = { delivered: false };
		const resume: BodyState = { delivered: false };
		const seen: Array<{ status: number; requestId: string | null | undefined; delivered: boolean }> = [];
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const resultPromise = streamGoogleGeminiCli(cliModel, context, {
			apiKey: cliAuth,
			maxRetryDelayMs: 0,
			fetch: queue([
				trackedSse({ response: chunk("Hello", "CONTINUATION", "seg-1") }, "cli-1", first),
				new Response("busy", { status: 503, headers: { "x-goog-request-id": "cli-rejected" } }),
				trackedSse({ response: chunk(" world", "STOP") }, "cli-2", resume, "request-id"),
			]),
			onResponse: async response => {
				const body = response.requestId === "cli-2" ? resume : first;
				seen.push({ status: response.status, requestId: response.requestId, delivered: body.delivered });
				if (response.requestId !== "cli-2") return;
				entered.resolve();
				await gate.promise;
			},
		}).result();

		try {
			const winner = await Promise.race([
				entered.promise.then(() => "notified" as const),
				resultPromise.then(() => "done" as const),
			]);
			expect(winner).toBe("notified");
			let finished = false;
			void resultPromise.then(
				() => {
					finished = true;
				},
				() => {
					finished = true;
				},
			);
			for (let i = 0; i < 100; i++) await Promise.resolve();
			expect(finished).toBe(false);
			expect(resume.delivered).toBe(false);
			gate.resolve();
			const result = await resultPromise;

			expect(result.stopReason).toBe("stop");
			expect(assistantText(result)).toBe("Hello world");
			expect(first.delivered).toBe(true);
			expect(resume.delivered).toBe(true);
			expect(seen).toEqual([
				{ status: 200, requestId: "cli-1", delivered: false },
				{ status: 200, requestId: "cli-2", delivered: false },
			]);
		} finally {
			gate.resolve();
			// Preserve an assertion or stream error while still leaving no pending work.
			await resultPromise.catch(() => undefined);
		}
	});
});
