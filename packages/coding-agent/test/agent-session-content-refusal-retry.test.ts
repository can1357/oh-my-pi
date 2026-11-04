import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PRINT_MODE_REFUSAL_EXIT_CODE, runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// The refusal exactly as an OpenAI Responses route sends it: HTTP 200, then
// `response.failed` carrying `cyber_policy`, then `[DONE]`.
const REFUSAL_MESSAGE =
	"This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. Some cybersecurity requests are still limited, even when Daybreak is on.";
const REFUSAL_LINE = `Refusal (cyber_policy): ${REFUSAL_MESSAGE}`;

function refusalResponse(): Response {
	const response = { id: "resp_refused", status: "in_progress" };
	const frames = [
		`event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response })}`,
		`event: response.in_progress\ndata: ${JSON.stringify({ type: "response.in_progress", sequence_number: 1, response })}`,
		`event: response.failed\ndata: ${JSON.stringify({
			type: "response.failed",
			sequence_number: 2,
			response: { ...response, status: "failed", error: { code: "cyber_policy", message: REFUSAL_MESSAGE } },
		})}`,
		"data: [DONE]",
	];
	return new Response(`${frames.join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function answerResponse(): Response {
	return new Response(
		[
			'data: {"type":"response.created","response":{"id":"resp_answer","status":"in_progress"}}',
			'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_answer","role":"assistant","status":"in_progress","content":[]}}',
			'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_answer","delta":"Answer"}',
			'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Answer"}]}}',
			'data: {"type":"response.completed","response":{"id":"resp_answer","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
		].join("\n\n") + "\n\n",
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function responsesModel(baseUrl: string): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "Refusal Route",
		id: "refusal-route",
		provider: "openai",
		baseUrl,
		contextWindow: 200_000,
		maxTokens: 8192,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} satisfies ModelSpec<"openai-responses">);
}

// The other refusal shape on the wire: Anthropic refuses inside an ordinary HTTP 200
// stream, with `stop_reason: "refusal"` on the trailing `message_delta` and no error event.
const ANTHROPIC_REFUSAL_EXPLANATION = "I can't help with that request.";
const ANTHROPIC_REFUSAL_LINE = `Refusal (cyber): ${ANTHROPIC_REFUSAL_EXPLANATION}`;

function anthropicRefusalResponse(): Response {
	const frames = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_refused",
				type: "message",
				role: "assistant",
				model: "claude-refusal-route",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		})}`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: {
				stop_reason: "refusal",
				stop_details: { type: "refusal", category: "cyber", explanation: ANTHROPIC_REFUSAL_EXPLANATION },
			},
			usage: { output_tokens: 1 },
		})}`,
		'event: message_stop\ndata: {"type":"message_stop"}',
	];
	return new Response(`${frames.join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function anthropicModel(baseUrl: string): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		name: "Anthropic Refusal Route",
		id: "claude-refusal-route",
		provider: "anthropic",
		baseUrl,
		contextWindow: 200_000,
		maxTokens: 8192,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} satisfies ModelSpec<"anthropic-messages">);
}

/** HTTP 503 with hidden transport retries off, so each one reaches the session's retry policy. */
function transientResponse(): Response {
	return Response.json(
		{ error: { code: "server_error", message: "Transient upstream failure" } },
		{ status: 503, headers: { "x-should-retry": "false" } },
	);
}

type Harness = {
	session: AgentSession;
	requests: () => number;
	/** The `model` of each request, in order. */
	models: string[];
	retryEvents: Extract<AgentSessionEvent, { type: "auto_retry_start" | "auto_retry_end" }>[];
	cleanup: () => Promise<void>;
};

const CHAIN_PROVIDER = "refusal-chain";

/**
 * A real AgentSession on the real Responses provider; `respond` answers request N (1-based).
 * `chain` serves models `primary`, `middle` and `last` from models.yml, with the fallback chain
 * primary -> middle -> last. `anthropic` serves the real Anthropic provider instead, for the
 * refusal shape that arrives inside an ordinary 200 response.
 */
async function createHarness(
	respond: (request: number) => Response,
	settingsOverrides = {},
	options: { chain?: boolean; anthropic?: boolean } = {},
): Promise<Harness> {
	let requests = 0;
	const models: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async request => {
			const body = (await request.json()) as { model?: string };
			requests++;
			models.push(body.model ?? "");
			return respond(requests);
		},
	});
	const baseUrl = server.url.toString().replace(/\/$/, "");
	const tempDir = TempDir.createSync("@pi-content-refusal-");
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.keys.setRuntime(options.anthropic ? "anthropic" : "openai", "refusal-test-key");
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const settings = Settings.isolated({
		"retry.baseDelayMs": 1,
		...(options.chain
			? {
					"retry.modelFallback": true,
					"retry.fallbackChains": { default: [`${CHAIN_PROVIDER}/middle`, `${CHAIN_PROVIDER}/last`] },
				}
			: {}),
		...settingsOverrides,
	});
	if (options.chain) {
		await Bun.write(
			tempDir.join("models.yml"),
			[
				"providers:",
				`  ${CHAIN_PROVIDER}:`,
				`    baseUrl: ${baseUrl}`,
				"    apiKey: refusal-test-key",
				"    api: openai-responses",
				"    models:",
				...["primary", "middle", "last"].flatMap(id => [
					`      - id: ${id}`,
					`        name: ${id}`,
					"        reasoning: false",
					"        input: [text]",
					"        contextWindow: 200000",
					"        maxTokens: 8192",
				]),
			].join("\n"),
		);
		settings.setModelRole("default", `${CHAIN_PROVIDER}/primary`);
	}
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings });
	const model = options.chain
		? modelRegistry.find(CHAIN_PROVIDER, "primary")
		: options.anthropic
			? anthropicModel(baseUrl)
			: responsesModel(baseUrl);
	if (!model) throw new Error("models.yml did not register the chain's primary model");
	const agent = new Agent({
		getApiKey: () => "refusal-test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		streamFn: streamSimple,
	});
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
	const retryEvents: Harness["retryEvents"] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start" || event.type === "auto_retry_end") retryEvents.push(event);
	});
	return {
		session,
		requests: () => requests,
		models,
		retryEvents,
		cleanup: async () => {
			await session.dispose();
			authStorage.close();
			server.stop(true);
			tempDir.removeSync();
		},
	};
}

async function prompt(harness: Harness): Promise<void> {
	await harness.session.prompt("Review this exploit mitigation");
	await harness.session.waitForIdle();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AgentSession content-policy refusal retries", () => {
	it("retries a refusal three times by default, then ends on the refusal itself", async () => {
		const harness = await createHarness(() => refusalResponse());
		try {
			await prompt(harness);

			expect(harness.requests()).toBe(4);
			const final = harness.session.getLastAssistantMessage();
			expect(final?.stopReason).toBe("error");
			expect(final?.stopDetails).toEqual({
				type: "refusal",
				category: "cyber_policy",
				explanation: REFUSAL_MESSAGE,
			});
			expect(final?.errorMessage).toBe(REFUSAL_LINE);
			expect(harness.retryEvents).toEqual([
				expect.objectContaining({
					type: "auto_retry_start",
					attempt: 1,
					maxAttempts: 3,
					errorMessage: REFUSAL_LINE,
				}),
				expect.objectContaining({
					type: "auto_retry_start",
					attempt: 2,
					maxAttempts: 3,
					errorMessage: REFUSAL_LINE,
				}),
				expect.objectContaining({
					type: "auto_retry_start",
					attempt: 3,
					maxAttempts: 3,
					errorMessage: REFUSAL_LINE,
				}),
				expect.objectContaining({ type: "auto_retry_end", success: false, finalError: REFUSAL_LINE }),
			]);
		} finally {
			await harness.cleanup();
		}
	}, 30_000);

	it("reports each refusal and then the success when a retry clears it", async () => {
		const harness = await createHarness(request => (request <= 2 ? refusalResponse() : answerResponse()));
		try {
			await prompt(harness);

			expect(harness.requests()).toBe(3);
			expect(harness.session.getLastAssistantMessage()).toMatchObject({
				stopReason: "stop",
				content: [{ type: "text", text: "Answer" }],
			});
			expect(harness.retryEvents).toEqual([
				expect.objectContaining({ type: "auto_retry_start", attempt: 1, errorMessage: REFUSAL_LINE }),
				expect.objectContaining({ type: "auto_retry_start", attempt: 2, errorMessage: REFUSAL_LINE }),
				expect.objectContaining({ type: "auto_retry_end", success: true }),
			]);
		} finally {
			await harness.cleanup();
		}
	}, 30_000);

	it("surfaces the first refusal when retry.refusalRetries is 0", async () => {
		const harness = await createHarness(() => refusalResponse(), { "retry.refusalRetries": 0 });
		try {
			await prompt(harness);

			expect(harness.requests()).toBe(1);
			expect(harness.session.getLastAssistantMessage()?.errorMessage).toBe(REFUSAL_LINE);
			expect(harness.retryEvents).toEqual([]);
		} finally {
			await harness.cleanup();
		}
	}, 30_000);

	it("exits print mode with the refusal status and the refusal on stderr, one line per attempt", async () => {
		const harness = await createHarness(() => refusalResponse(), { "retry.refusalRetries": 1 });
		const stderr: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const callback = args.at(-1);
			if (typeof callback === "function") (callback as (error?: Error | null) => void)(null);
			return true;
		});
		try {
			const exitCode = await runPrintMode(harness.session, {
				mode: "text",
				initialMessage: "Review this exploit mitigation",
			});

			expect(exitCode).toBe(PRINT_MODE_REFUSAL_EXIT_CODE);
			const lines = stderr.join("").split("\n");
			expect(lines).toContain(`Retrying (1/1): ${REFUSAL_LINE}`);
			expect(lines).toContain(REFUSAL_LINE);
			expect(harness.requests()).toBe(2);
		} finally {
			vi.restoreAllMocks();
			await harness.cleanup();
		}
	}, 30_000);

	// The same exit rule on the second wire shape: the provider refuses inside a 200
	// response, with `stop_reason: "refusal"` on the trailing delta and no error event.
	// One predicate decides both — the turn's `stopDetails.type` — so neither shape is missed.
	it("exits print mode with the refusal status when Anthropic refuses inside a 200 response", async () => {
		const harness = await createHarness(() => anthropicRefusalResponse(), {}, { anthropic: true });
		const stderr: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const callback = args.at(-1);
			if (typeof callback === "function") (callback as (error?: Error | null) => void)(null);
			return true;
		});
		try {
			const exitCode = await runPrintMode(harness.session, {
				mode: "text",
				initialMessage: "Review this exploit mitigation",
			});

			expect(exitCode).toBe(PRINT_MODE_REFUSAL_EXIT_CODE);
			expect(stderr.join("").split("\n")).toContain(ANTHROPIC_REFUSAL_LINE);
			// An Anthropic refusal walks fallback chains only; with no chain it is one request,
			// never a same-model retry — `retry.refusalRetries` is for `cyber_policy` alone.
			expect(harness.requests()).toBe(1);
			expect(harness.session.getLastAssistantMessage()).toMatchObject({
				stopReason: "error",
				stopDetails: { type: "refusal", category: "cyber" },
			});
		} finally {
			vi.restoreAllMocks();
			await harness.cleanup();
		}
	}, 30_000);

	// A refusal retry is not a transient failure: the requests a refusal caused must
	// leave `retry.maxRetries` whole for a 503 that follows them.
	it.each([
		{ name: "three refusals then a 503 at maxRetries 3", maxRetries: 3, steps: ["R", "R", "R", "503", "A"] },
		{ name: "refusal, 503, refusal at maxRetries 1", maxRetries: 1, steps: ["R", "503", "R", "A"] },
	])(
		"keeps the transient budget whole across refusal retries: $name",
		async ({ maxRetries, steps }) => {
			const harness = await createHarness(
				request => {
					const step = steps[request - 1];
					return step === "R" ? refusalResponse() : step === "503" ? transientResponse() : answerResponse();
				},
				{ "retry.maxRetries": maxRetries },
			);
			try {
				await prompt(harness);

				expect(harness.requests()).toBe(steps.length);
				expect(harness.session.getLastAssistantMessage()).toMatchObject({
					stopReason: "stop",
					content: [{ type: "text", text: "Answer" }],
				});
			} finally {
				await harness.cleanup();
			}
		},
		30_000,
	);

	it("keeps the transient budget whole across the refusal walk of a fallback chain", async () => {
		const steps = ["R", "R", "503", "A"];
		const harness = await createHarness(
			request => {
				const step = steps[request - 1];
				return step === "R" ? refusalResponse() : step === "503" ? transientResponse() : answerResponse();
			},
			{ "retry.maxRetries": 1 },
			{ chain: true },
		);
		try {
			await prompt(harness);

			expect(harness.models).toEqual(["primary", "middle", "last", "last"]);
			expect(harness.session.getLastAssistantMessage()?.stopReason).toBe("stop");
		} finally {
			await harness.cleanup();
		}
	}, 30_000);

	// The worst-case request count when every model refuses: the refusal walk visits each
	// of the chain's C models once, then the last one gets `retry.refusalRetries` (k) more:
	// C + k requests. Here C = 3.
	it.each([0, 1, 3, 5])(
		"bounds an all-refusal turn on a three-model chain at 3 + refusalRetries requests (k = %i)",
		async refusalRetries => {
			const harness = await createHarness(
				() => refusalResponse(),
				{ "retry.refusalRetries": refusalRetries },
				{
					chain: true,
				},
			);
			try {
				await prompt(harness);

				expect(harness.models).toEqual(["primary", "middle", "last", ...Array(refusalRetries).fill("last")]);
				expect(harness.session.getLastAssistantMessage()?.errorMessage).toBe(REFUSAL_LINE);
			} finally {
				await harness.cleanup();
			}
		},
		30_000,
	);
});
