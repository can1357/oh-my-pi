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

type Harness = {
	session: AgentSession;
	requests: () => number;
	retryEvents: Extract<AgentSessionEvent, { type: "auto_retry_start" | "auto_retry_end" }>[];
	cleanup: () => Promise<void>;
};

/** A real AgentSession on the real Responses provider; `respond` answers request N (1-based). */
async function createHarness(respond: (request: number) => Response, settingsOverrides = {}): Promise<Harness> {
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		fetch: async request => {
			await request.text();
			requests++;
			return respond(requests);
		},
	});
	const tempDir = TempDir.createSync("@pi-content-refusal-");
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.keys.setRuntime("openai", "refusal-test-key");
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const settings = Settings.isolated({ "retry.baseDelayMs": 1, ...settingsOverrides });
	const agent = new Agent({
		getApiKey: () => "refusal-test-key",
		initialState: {
			model: responsesModel(server.url.toString().replace(/\/$/, "")),
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		streamFn: streamSimple,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings }),
	});
	const retryEvents: Harness["retryEvents"] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start" || event.type === "auto_retry_end") retryEvents.push(event);
	});
	return {
		session,
		requests: () => requests,
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
});
