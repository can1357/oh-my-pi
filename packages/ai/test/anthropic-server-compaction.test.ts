/**
 * Anthropic server-side compaction (`compact-2026-01-12`).
 *
 * Verifies the provider contract the agent's compaction backend relies on:
 *   • Request — `anthropicCompaction` emits the `compact_20260112` edit beside
 *     `clear_thinking`, clamps the trigger to the API floor, and attaches the
 *     beta; requests without the option (and endpoints without context
 *     management) stay untouched.
 *   • Response — the streamed `compaction` block becomes the assistant
 *     message's `anthropicCompaction` payload, the `compaction` stop reason is
 *     a normal stop tagged in `stopDetails`, usage is the sum over
 *     `usage.iterations`, and a `null` summary yields no payload.
 *   • Replay — a user-role summary carrying this provider's payload is sent as
 *     a leading assistant `compaction` block; other providers' payloads and
 *     endpoints without context management keep the text.
 *   • The empty-completion retry does not re-issue a compaction pause.
 */
import {
	convertAnthropicMessages,
	streamAnthropic,
	supportsAnthropicCompaction,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { configureCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Context, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import { kConversationalUser } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withEnv, withOfficialAnthropicEndpoint } from "./helpers";

const fableSpec: ModelSpec<"anthropic-messages"> = {
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

const fableModel: Model<"anthropic-messages"> = buildModel(fableSpec);

const noContextManagementModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5 (proxy)",
	api: "anthropic-messages",
	provider: "custom-anthropic-proxy",
	baseUrl: "https://models.example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
	compat: { supportsContextManagement: false },
} as ModelSpec<"anthropic-messages">);

const SUMMARY = "## Goal\nAudit the handlers.\n\n## Next Steps\n1. Continue with chunk 11.";

const context: Context = {
	messages: [{ role: "user", content: "Continue the audit.", timestamp: Date.now() }],
};

type MockAnthropicEvent = Record<string, unknown>;

function createMockRequest(events: MockAnthropicEvent[]) {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
	const stream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: response.headers.get("request-id") };
		},
	};
}

const ENCRYPTED = "enc_opaque_compaction_state";

/**
 * The stream observed live on 2026-09-11 for a paused compaction request. The
 * block and its delta carry `encrypted_content` per the SDK contract
 * (`BetaCompactionBlock` / `BetaCompactionContentBlockDelta`); `iterations`
 * appends further sampling iterations after the compaction one.
 */
function createPausedCompactionEvents(
	content: string | null,
	iterations: Record<string, unknown>[] = [],
): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_compact",
				model: "claude-fable-5",
				usage: {
					input_tokens: 64,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 80_082,
				},
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "compaction", content: "", encrypted_content: null },
		},
		{ type: "ping" },
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "compaction_delta", content, encrypted_content: content === null ? null : ENCRYPTED },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "compaction" },
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				iterations: [
					{
						type: "compaction",
						input_tokens: 64,
						output_tokens: 2002,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 80_082,
					},
					...iterations,
				],
			},
		},
		{ type: "message_stop" },
	];
}

async function captureRequest(
	model: Model<"anthropic-messages">,
	options: Parameters<typeof streamAnthropic>[2],
	messages: Context["messages"] = context.messages,
): Promise<{ beta: string; payload: Record<string, unknown> }> {
	let beta = "";
	const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
		beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
		return new Response(
			JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	await streamAnthropic(
		model,
		{ systemPrompt: ["auditor"], messages },
		{
			apiKey: "sk-ant-test",
			...options,
			fetch: fetchMock,
			onPayload: payload => resolve(payload as Record<string, unknown>),
		},
	).result();
	return { beta, payload: await promise };
}

function compactionSummaryMessage(provider: string, content = SUMMARY, encryptedContent?: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text: `Prior model work available.\n\n<summary>\n${content}\n</summary>` }],
		providerPayload: {
			type: "anthropicCompaction",
			provider,
			content,
			...(encryptedContent ? { encryptedContent } : {}),
		},
		timestamp: 1,
	};
}

withOfficialAnthropicEndpoint();

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic server-side compaction request", () => {
	it("emits the compact edit beside clear_thinking and attaches the compaction beta", async () => {
		const { beta, payload } = await captureRequest(fableModel, {
			thinkingEnabled: true,
			anthropicCompaction: { triggerInputTokens: 120_000, pauseAfterCompaction: true, instructions: "Summarize." },
		});

		expect(payload.context_management).toEqual({
			edits: [
				{ type: "clear_thinking_20251015", keep: "all" },
				{
					type: "compact_20260112",
					trigger: { type: "input_tokens", value: 120_000 },
					pause_after_compaction: true,
					instructions: "Summarize.",
				},
			],
		});
		expect(beta).toContain("compact-2026-01-12");
	});

	it("clamps the trigger to the API floor and omits unset fields", async () => {
		const { payload } = await captureRequest(fableModel, {
			thinkingEnabled: false,
			anthropicCompaction: { triggerInputTokens: 1_000 },
		});

		expect(payload.context_management).toEqual({
			edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 50_000 } }],
		});
	});

	it("sends neither the edit nor the beta without the option", async () => {
		const { beta, payload } = await captureRequest(fableModel, { thinkingEnabled: false });

		expect(payload.context_management).toBeUndefined();
		expect(beta).not.toContain("compact-2026-01-12");
	});

	it("stays inert on endpoints without context management", async () => {
		const { beta, payload } = await captureRequest(noContextManagementModel, {
			thinkingEnabled: false,
			anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true },
		});

		expect(payload.context_management).toBeUndefined();
		expect(beta).not.toContain("compact-2026-01-12");
	});

	it("stays inert on a model line the beta rejects, even on the official endpoint", async () => {
		// Sonnet 4.5 is budget-thinking: the catalog rule (`supports-server-compaction`)
		// leaves it unsupported, so a route opt-in cannot resurrect the edit either.
		const sonnet45Spec: ModelSpec<"anthropic-messages"> = {
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		};
		const sonnet45 = buildModel(sonnet45Spec);
		const { beta, payload } = await captureRequest(sonnet45, {
			thinkingEnabled: false,
			anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true },
		});

		expect(sonnet45.compat.supportsServerCompaction).toBe(false);
		expect(payload.context_management).toBeUndefined();
		expect(beta).not.toContain("compact-2026-01-12");

		const optedIn = buildModel({ ...sonnet45Spec, remoteCompaction: { enabled: true } });
		const optedInRequest = await captureRequest(optedIn, {
			thinkingEnabled: false,
			anthropicCompaction: { triggerInputTokens: 50_000 },
		});
		expect(optedInRequest.payload.context_management).toBeUndefined();
	});

	it("reads first-party provider from catalog policy, not the endpoint flag", async () => {
		// The gate pairs the KDL `first-party-provider` fact with the runtime
		// URL check. A custom provider on the official URL stays inert (no
		// provider-id literal to match), while the first-party row carries the
		// resolved fact.
		expect(fableModel.compat.firstPartyProvider).toBe(true);
		const alias = buildModel({ ...fableSpec, provider: "custom-anthropic-proxy" });
		expect(alias.compat.firstPartyProvider).toBe(false);
		const { beta, payload } = await captureRequest(alias, {
			thinkingEnabled: false,
			anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true },
		});

		expect(payload.context_management).toBeUndefined();
		expect(beta).not.toContain("compact-2026-01-12");
	});

	it("treats pi-native gateways as transports, not upstream endpoints", () => {
		// A pi-native baseUrl names the auth gateway; the gateway resolves
		// official Anthropic server-side, so no opt-in is needed. An
		// explicitly supplied foreign endpoint is still judged on its merits.
		const gateway = buildModel({
			...fableSpec,
			transport: "pi-native",
			baseUrl: "https://gateway.example.test",
		});
		expect(supportsAnthropicCompaction(gateway)).toBe(true);
		expect(
			supportsAnthropicCompaction(
				gateway,
				"https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-fable-5:rawPredict",
			),
		).toBe(false);
		// A custom provider rides the same gateway to its own upstream, whose
		// server-side gate stays off: only an explicit opt-in enables it.
		const customGateway = buildModel({
			...fableSpec,
			provider: "custom-anthropic-proxy",
			transport: "pi-native",
			baseUrl: "https://gateway.example.test",
		});
		expect(customGateway.compat.firstPartyProvider).toBe(false);
		expect(supportsAnthropicCompaction(customGateway)).toBe(false);
		const optedInCustomGateway = buildModel({
			...fableSpec,
			provider: "custom-anthropic-proxy",
			transport: "pi-native",
			baseUrl: "https://gateway.example.test",
			remoteCompaction: { enabled: true },
		});
		expect(supportsAnthropicCompaction(optedInCustomGateway)).toBe(true);
	});

	/**
	 * Runs one request on a caller-owned client (its `baseURL` is the endpoint
	 * the SDK would target) and returns the params and per-request headers.
	 */
	async function captureOnClient(
		model: Model<"anthropic-messages">,
		baseURL: string | undefined,
		options: Parameters<typeof streamAnthropic>[2],
		messages = context.messages,
	) {
		let params: Record<string, unknown> | undefined;
		let headers: Record<string, string> | undefined;
		await streamAnthropic(
			model,
			{ systemPrompt: ["auditor"], messages },
			{
				apiKey: "sk-ant-test",
				...options,
				client: {
					...(baseURL === undefined ? {} : { baseURL }),
					messages: {
						create: (requestParams, requestOptions) => {
							params = requestParams as unknown as Record<string, unknown>;
							headers = (requestOptions as { headers?: Record<string, string> } | undefined)?.headers;
							throw new Error("stop-after-capture");
						},
					},
				},
			},
		)
			.result()
			.catch(() => undefined);
		return { params, beta: headers?.["anthropic-beta"] ?? "" };
	}

	it("attaches the compaction beta per request for injected clients, on compaction and on replay", async () => {
		// Injected SDK clients own their default headers, so the beta rides the
		// per-request headers exactly like the effort and control betas do.
		const capture = (options: Parameters<typeof streamAnthropic>[2], messages = context.messages) =>
			captureOnClient(fableModel, "https://api.anthropic.com", options, messages);

		const live = await capture({ anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true } });
		expect(live.params?.context_management).toEqual({
			edits: [
				{
					type: "compact_20260112",
					trigger: { type: "input_tokens", value: 50_000 },
					pause_after_compaction: true,
				},
			],
		});
		expect(live.beta).toContain("compact-2026-01-12");

		const replay = await capture({}, [
			compactionSummaryMessage("anthropic"),
			{ role: "user", content: "next", timestamp: 2 },
		]);
		expect(replay.params?.context_management).toEqual({
			edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 1_000_000 } }],
		});
		expect(replay.beta).toContain("compact-2026-01-12");

		const plain = await capture({});
		expect(plain.params?.context_management).toBeUndefined();
		expect(plain.beta).not.toContain("compact-2026-01-12");
	});

	it("resolves eligibility from the injected client's own endpoint, never from the model", async () => {
		const request = { anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true } };
		// An `AnthropicVertex`-style client carries the first-party model elsewhere.
		const vertex = await captureOnClient(fableModel, "https://us-east5-aiplatform.googleapis.com", request);
		expect(vertex.params?.context_management).toBeUndefined();
		expect(vertex.beta).not.toContain("compact-2026-01-12");
		// A client that exposes no endpoint is unknown: only an explicit opt-in counts.
		const opaque = await captureOnClient(fableModel, undefined, request);
		expect(opaque.params?.context_management).toBeUndefined();
		expect(opaque.beta).not.toContain("compact-2026-01-12");
		const optedIn = buildModel({ ...fableSpec, remoteCompaction: { enabled: true } });
		const opaqueOptedIn = await captureOnClient(optedIn, undefined, request);
		expect(opaqueOptedIn.params?.context_management).toEqual({
			edits: [
				{
					type: "compact_20260112",
					trigger: { type: "input_tokens", value: 50_000 },
					pause_after_compaction: true,
				},
			],
		});
		expect(opaqueOptedIn.beta).toContain("compact-2026-01-12");
	});

	it("routes injected-client compaction betas by the client's endpoint, not the model's", async () => {
		const vertexUrl =
			"https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-fable-5:rawPredict";
		const request = { anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true } };
		const edit = {
			edits: [
				{
					type: "compact_20260112",
					trigger: { type: "input_tokens", value: 50_000 },
					pause_after_compaction: true,
				},
			],
		};
		// Vertex client on an official model: body channel, never the header.
		const optedIn = buildModel({ ...fableSpec, remoteCompaction: { enabled: true } });
		const vertexClient = await captureOnClient(optedIn, vertexUrl, request);
		expect(vertexClient.params?.context_management).toEqual(edit);
		expect(vertexClient.beta).not.toContain("compact-2026-01-12");
		expect(vertexClient.params?.["anthropic_beta"]).toContain("compact-2026-01-12");

		// Official client on a Vertex-routed model: header channel, never the body.
		const vertexRouted = buildModel({
			...fableSpec,
			provider: "custom-vertex-route",
			baseUrl: vertexUrl,
			remoteCompaction: { enabled: true },
		});
		const officialClient = await captureOnClient(vertexRouted, "https://api.anthropic.com", request);
		expect(officialClient.params?.context_management).toEqual(edit);
		expect(officialClient.beta).toContain("compact-2026-01-12");
		expect(officialClient.params?.["anthropic_beta"] ?? []).not.toContain("compact-2026-01-12");
	});

	it("routes the compaction beta through the body on Vertex rawPredict, never the header", async () => {
		// Vertex 400s on `anthropic-beta` headers; a route there must still
		// advertise the beta in `anthropic_beta` beside the edit. Stock Vertex
		// disables context management by deployment contract, so the reachable
		// shape is a custom provider routed at a Vertex URL with an opt-in.
		const vertexModel = buildModel({
			...fableSpec,
			provider: "custom-vertex-route",
			baseUrl:
				"https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-fable-5:rawPredict",
			remoteCompaction: { enabled: true },
		});
		let capturedBeta: string | undefined;
		let capturedBody: { anthropic_beta?: unknown; context_management?: unknown } | undefined;
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBeta = new Headers(init?.headers).get("anthropic-beta") ?? "";
			capturedBody = JSON.parse(String(init?.body ?? "{}"));
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		await streamAnthropic(vertexModel, context, {
			apiKey: "vertex-adc",
			thinkingEnabled: false,
			anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true },
			fetch: fetchMock,
		}).result();

		expect(capturedBeta ?? "").not.toContain("compact-2026-01-12");
		expect(capturedBody?.anthropic_beta).toContain("compact-2026-01-12");
		expect(capturedBody?.context_management).toMatchObject({
			edits: [{ type: "compact_20260112" }],
		});
	});

	it("routes environment-rerouted Vertex compaction betas through the body", async () => {
		// ANTHROPIC_BASE_URL moves the effective endpoint without touching the
		// spec URL: the header stays clean and the body carries the beta.
		await withEnv(
			{
				ANTHROPIC_BASE_URL:
					"https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-fable-5:rawPredict",
			},
			async () => {
				const optedIn = buildModel({ ...fableSpec, remoteCompaction: { enabled: true } });
				let capturedBeta: string | undefined;
				let capturedBody: { anthropic_beta?: unknown; context_management?: unknown } | undefined;
				const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
					capturedBeta = new Headers(init?.headers).get("anthropic-beta") ?? "";
					capturedBody = JSON.parse(String(init?.body ?? "{}"));
					return new Response(
						JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}) as typeof fetch;

				await streamAnthropic(optedIn, context, {
					apiKey: "sk-ant-test",
					thinkingEnabled: false,
					anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true },
					fetch: fetchMock,
				}).result();

				expect(capturedBeta ?? "").not.toContain("compact-2026-01-12");
				expect(capturedBody?.anthropic_beta).toContain("compact-2026-01-12");
				expect(capturedBody?.context_management).toMatchObject({
					edits: [{ type: "compact_20260112" }],
				});
			},
		);
	});

	it("replays a block held by its originating assistant message, at the head of that turn", async () => {
		// A raw caller that appends the compacting response itself (no pause)
		// keeps the block on the assistant message; the next request must still
		// send it with the beta and the never-firing edit.
		const compacted: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Continuing from the summary." }],
			providerPayload: {
				type: "anthropicCompaction",
				provider: "anthropic",
				content: SUMMARY,
				encryptedContent: ENCRYPTED,
			},
			timestamp: 1,
			provider: "anthropic",
			model: "claude-fable-5",
			api: "anthropic-messages",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		};
		const { beta, payload } = await captureRequest(fableModel, { thinkingEnabled: false }, [
			{ role: "user", content: "old prompt", timestamp: 0 },
			compacted,
			{ role: "user", content: "next", timestamp: 2 },
		]);

		const messages = payload.messages as Array<{ role: string; content: unknown }>;
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
		const assistantBlocks = messages[1].content as Array<Record<string, unknown>>;
		expect(assistantBlocks).toHaveLength(2);
		expect(assistantBlocks[0]).toEqual({ type: "compaction", content: SUMMARY, encrypted_content: ENCRYPTED });
		expect(assistantBlocks[1]).toMatchObject({ type: "text", text: "Continuing from the summary." });
		expect(payload.context_management).toEqual({
			edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 1_000_000 } }],
		});
		expect(beta).toContain("compact-2026-01-12");
	});
});

describe("anthropic server-side compaction response", () => {
	it("surfaces the summary as the assistant payload with a tagged stop and iteration-summed usage", async () => {
		const create = vi
			.spyOn(AnthropicMessages.prototype, "create")
			.mockImplementation(() => createMockRequest(createPausedCompactionEvents(SUMMARY)) as never);

		const s = streamAnthropic(fableModel, context, {
			apiKey: "sk-ant-test",
			anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true },
		});
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		expect(result.providerPayload).toEqual({
			type: "anthropicCompaction",
			provider: "anthropic",
			content: SUMMARY,
			encryptedContent: ENCRYPTED,
		});
		expect(result.content).toEqual([]);
		expect(result.stopReason).toBe("stop");
		expect(result.stopDetails).toEqual({ type: "compaction" });
		expect(result.errorMessage).toBeUndefined();
		// The top-level counts exclude the compaction iteration; the iteration
		// list is the billed total (64 input, 2002 output, 80,082 cache write).
		expect(result.usage.input).toBe(64);
		expect(result.usage.output).toBe(2002);
		expect(result.usage.cacheWrite).toBe(80_082);
		expect(result.usage.cacheRead).toBe(0);
		expect(result.usage.totalTokens).toBe(64 + 2002 + 80_082);
		expect(result.usage.contextTokens).toBeUndefined();
		expect(result.usage.cost.output).toBeCloseTo((2002 * 50) / 1_000_000, 10);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((80_082 * 12.5) / 1_000_000, 10);
		// A compaction pause is a legitimate empty stop: no empty-completion retry.
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("prices each sampling iteration on its own prompt size, not the summed total", async () => {
		// Two sub-threshold iterations (80,146 + 130,000 prompt tokens) whose
		// sum crosses a 200k long-context threshold stay at base rates.
		const longContextModel: Model<"anthropic-messages"> = buildModel({
			...fableSpec,
			cost: {
				input: 10,
				output: 50,
				cacheRead: 1,
				cacheWrite: 12.5,
				longContext: { inputThreshold: 200_000, input: 20, output: 100, cacheRead: 2, cacheWrite: 25 },
			},
		});
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				createMockRequest(
					createPausedCompactionEvents(SUMMARY, [
						{
							type: "message",
							input_tokens: 30_000,
							output_tokens: 500,
							cache_read_input_tokens: 100_000,
							cache_creation_input_tokens: 0,
						},
					]),
				) as never,
		);

		const s = streamAnthropic(longContextModel, context, {
			apiKey: "sk-ant-test",
			anthropicCompaction: { triggerInputTokens: 50_000 },
		});
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		expect(result.usage.input).toBe(30_064);
		expect(result.usage.output).toBe(2_502);
		expect(result.usage.cacheRead).toBe(100_000);
		expect(result.usage.cacheWrite).toBe(80_082);
		expect(result.usage.cost.input).toBeCloseTo((30_064 * 10) / 1_000_000, 10);
		expect(result.usage.cost.output).toBeCloseTo((2_502 * 50) / 1_000_000, 10);
		expect(result.usage.cost.cacheRead).toBeCloseTo((100_000 * 1) / 1_000_000, 10);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((80_082 * 12.5) / 1_000_000, 10);
		// Billing still sums both samplings, but resident context is the
		// post-compaction message sampling alone (30,000 + 100,000 + 0).
		expect(result.usage.contextTokens).toBe(130_000);
	});

	it("yields no payload when the model called a tool instead of summarizing", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createPausedCompactionEvents(null)) as never,
		);

		const s = streamAnthropic(fableModel, context, {
			apiKey: "sk-ant-test",
			anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true },
		});
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		expect(result.providerPayload).toBeUndefined();
		expect(result.stopDetails).toEqual({ type: "compaction" });
		expect(result.errorMessage).toBeUndefined();
	});
});

describe("anthropic server-side compaction replay", () => {
	it("replays this provider's summary as a leading assistant compaction block", () => {
		const params = convertAnthropicMessages(
			[compactionSummaryMessage("anthropic"), { role: "user", content: "next", timestamp: 2 }],
			fableModel,
			false,
			{ replayCompaction: true },
		);

		expect(params).toEqual([
			{ role: "assistant", content: [{ type: "compaction", content: SUMMARY }] },
			{ role: "user", content: "next", [kConversationalUser]: true },
		]);
	});

	it("round-trips the opaque encrypted_content verbatim with the block", () => {
		const params = convertAnthropicMessages(
			[compactionSummaryMessage("anthropic", SUMMARY, ENCRYPTED), { role: "user", content: "next", timestamp: 2 }],
			fableModel,
			false,
			{ replayCompaction: true },
		);

		expect(params[0]).toEqual({
			role: "assistant",
			content: [{ type: "compaction", content: SUMMARY, encrypted_content: ENCRYPTED }],
		});
	});

	it("replays harness file metadata after the native block, not inside it", () => {
		const filesText = "<files>\n# /repo/src/\nhandlers.ts (Read)\n</files>";
		const summary: UserMessage = {
			...compactionSummaryMessage("anthropic", SUMMARY, ENCRYPTED),
			providerPayload: {
				type: "anthropicCompaction",
				provider: "anthropic",
				content: SUMMARY,
				encryptedContent: ENCRYPTED,
				filesText,
			},
		};
		const params = convertAnthropicMessages(
			[summary, { role: "user", content: "next", timestamp: 2 }],
			fableModel,
			false,
			{ replayCompaction: true },
		);

		expect(params).toEqual([
			{ role: "assistant", content: [{ type: "compaction", content: SUMMARY, encrypted_content: ENCRYPTED }] },
			{ role: "user", content: filesText },
			{ role: "user", content: "next", [kConversationalUser]: true },
		]);
	});

	it("keeps file metadata clear of a folded retained assistant turn", () => {
		// The fold joins the block with a following assistant turn; the files
		// message must wait past that turn or the thinking prefix changes.
		const filesText = "<files>\n# /repo/src/\nhandlers.ts (Read)\n</files>";
		const summary: UserMessage = {
			...compactionSummaryMessage("anthropic", SUMMARY, ENCRYPTED),
			providerPayload: {
				type: "anthropicCompaction",
				provider: "anthropic",
				content: SUMMARY,
				encryptedContent: ENCRYPTED,
				filesText,
			},
		};
		const tail: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Retained answer." }],
			timestamp: 2,
			provider: "anthropic",
			model: "claude-fable-5",
			api: "anthropic-messages",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		};
		const params = convertAnthropicMessages(
			[summary, tail, { role: "user", content: "next", timestamp: 3 }],
			fableModel,
			false,
			{ replayCompaction: true },
		);

		expect(params).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "compaction", content: SUMMARY, encrypted_content: ENCRYPTED },
					{ type: "text", text: "Retained answer." },
				],
			},
			{ role: "user", content: filesText },
			{ role: "user", content: "next", [kConversationalUser]: true },
		]);
	});

	it("holds file metadata past an open tool_use turn until its results land", () => {
		const filesText = "<files>\n# /repo/src/\nhandlers.ts (Read)\n</files>";
		const summary: UserMessage = {
			...compactionSummaryMessage("anthropic", SUMMARY, ENCRYPTED),
			providerPayload: {
				type: "anthropicCompaction",
				provider: "anthropic",
				content: SUMMARY,
				encryptedContent: ENCRYPTED,
				filesText,
			},
		};
		const turn: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "toolu_1", name: "read", arguments: {} }],
			timestamp: 2,
			provider: "anthropic",
			model: "claude-fable-5",
			api: "anthropic-messages",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		};
		const params = convertAnthropicMessages(
			[
				summary,
				turn,
				{
					role: "toolResult",
					toolCallId: "toolu_1",
					toolName: "read",
					content: [{ type: "text", text: "file bytes" }],
					timestamp: 3,
				},
			],
			fableModel,
			false,
			{ replayCompaction: true },
		);

		const roles = params.map(message => message.role);
		expect(roles).toEqual(["assistant", "user", "user"]);
		expect(params[0]).toEqual({
			role: "assistant",
			content: [
				{ type: "compaction", content: SUMMARY, encrypted_content: ENCRYPTED },
				{ type: "tool_use", id: "toolu_1", name: "read", input: {} },
			],
		});
		expect(params[2]).toEqual({ role: "user", content: filesText });
	});

	it("redacts credential-shaped tokens in replayed file metadata", () => {
		configureCredentialRedaction(true);
		try {
			const token = `sk-ant-${"AbC123".repeat(7)}`;
			const summary: UserMessage = {
				...compactionSummaryMessage("anthropic", SUMMARY, ENCRYPTED),
				providerPayload: {
					type: "anthropicCompaction",
					provider: "anthropic",
					content: SUMMARY,
					encryptedContent: ENCRYPTED,
					filesText: `<files>\n# /repo/\n${token}.key (Read)\n</files>`,
				},
			};
			const params = convertAnthropicMessages(
				[summary, { role: "user", content: "next", timestamp: 2 }],
				fableModel,
				false,
				{ replayCompaction: true },
			);

			expect(params[1]).toEqual({
				role: "user",
				content: `<files>\n# /repo/\n[anthropic_token_redacted].key (Read)\n</files>`,
			});
		} finally {
			configureCredentialRedaction(false);
		}
	});

	it("keeps the summary text for another provider's payload and when replay is off", () => {
		const foreign = convertAnthropicMessages(
			[compactionSummaryMessage("umans"), { role: "user", content: "next", timestamp: 2 }],
			fableModel,
			false,
			{ replayCompaction: true },
		);
		const replayOff = convertAnthropicMessages(
			[compactionSummaryMessage("anthropic"), { role: "user", content: "next", timestamp: 2 }],
			fableModel,
			false,
		);

		for (const params of [foreign, replayOff]) {
			expect(params[0]?.role).toBe("user");
			expect(JSON.stringify(params[0]?.content)).toContain("<summary>");
			expect(params.some(param => JSON.stringify(param.content).includes('"compaction"'))).toBe(false);
		}
	});

	it("attaches the compaction beta when the context replays a summary, and keeps the text elsewhere", async () => {
		const official = await captureRequest(fableModel, { thinkingEnabled: false }, [
			compactionSummaryMessage("anthropic"),
			{ role: "user", content: "next", timestamp: 2 },
		]);
		expect(official.beta).toContain("compact-2026-01-12");
		// The API rejects a replayed block without a strategy; the replay edit's
		// trigger sits at the context window so the live turn never compacts.
		expect(official.payload.context_management).toEqual({
			edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 1_000_000 } }],
		});
		// Both tail breakpoints land here: the API accepts cache_control on a
		// compaction block, so a short post-compaction tail caches the summary.
		expect(official.payload.messages).toEqual([
			{
				role: "assistant",
				content: [{ type: "compaction", content: SUMMARY, cache_control: { type: "ephemeral" } }],
			},
			{
				role: "user",
				content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }],
				[kConversationalUser]: true,
			},
		]);

		const proxy = await captureRequest(noContextManagementModel, { thinkingEnabled: false }, [
			compactionSummaryMessage("custom-anthropic-proxy"),
			{ role: "user", content: "next", timestamp: 2 },
		]);
		expect(proxy.beta).not.toContain("compact-2026-01-12");
		expect(JSON.stringify(proxy.payload.messages)).not.toContain('"compaction"');
		expect(JSON.stringify(proxy.payload.messages)).toContain("<summary>");
	});

	it("keeps the text and sends no beta once the same model is rerouted to a gateway, unless the route opts in", async () => {
		// compat.officialEndpoint is built from the catalog URL, so the reroute
		// is only visible at request time — the gate must resolve the URL the
		// way the transport does.
		await withEnv({ ANTHROPIC_BASE_URL: "https://gateway.example.com" }, async () => {
			const rerouted = await captureRequest(fableModel, { thinkingEnabled: false }, [
				compactionSummaryMessage("anthropic"),
				{ role: "user", content: "next", timestamp: 2 },
			]);
			expect(rerouted.beta).not.toContain("compact-2026-01-12");
			expect(rerouted.payload.context_management).toBeUndefined();
			expect(JSON.stringify(rerouted.payload.messages)).not.toContain('"compaction"');
			expect(JSON.stringify(rerouted.payload.messages)).toContain("<summary>");

			const optedIn = await captureRequest(
				buildModel({ ...fableModel, remoteCompaction: { enabled: true } } as ModelSpec<"anthropic-messages">),
				{ thinkingEnabled: false },
				[compactionSummaryMessage("anthropic"), { role: "user", content: "next", timestamp: 2 }],
			);
			expect(optedIn.beta).toContain("compact-2026-01-12");
			expect(JSON.stringify(optedIn.payload.messages)).toContain('"compaction"');
		});
	});

	it("opens the retained assistant turn with the block instead of padding a synthetic user turn", () => {
		const retainedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Reading chunk 11 now." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		const params = convertAnthropicMessages(
			[compactionSummaryMessage("anthropic"), retainedAssistant, { role: "user", content: "next", timestamp: 3 }],
			fableModel,
			false,
			{ replayCompaction: true },
		);

		expect(params).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "compaction", content: SUMMARY },
					{ type: "text", text: "Reading chunk 11 now." },
				],
			},
			{ role: "user", content: "next", [kConversationalUser]: true },
		]);
	});
});
