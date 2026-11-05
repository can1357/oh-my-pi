import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// The refusal exactly as an OpenAI Responses route sends it: HTTP 200, then
// `response.failed` carrying `cyber_policy`, then `[DONE]`.
const REFUSAL_MESSAGE =
	"This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. Some cybersecurity requests are still limited, even when Daybreak is on.";
const TRUSTED_ACCESS_MESSAGE =
	"This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber to continue.";

const context: Context = {
	systemPrompt: ["Test"],
	messages: [{ role: "user", content: "Review this exploit mitigation", timestamp: Date.now() }],
};

const model: Model<"openai-responses"> = buildModel({
	api: "openai-responses",
	name: "Refusal Test",
	id: "refusal-test",
	provider: "openai",
	baseUrl: "http://127.0.0.1:9/v1",
	contextWindow: 200_000,
	maxTokens: 8192,
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies ModelSpec<"openai-responses">);

function failedResponse(error: Record<string, unknown>, inStatusDetails = false): Response {
	const response = { id: "resp_refused", status: "in_progress" };
	const frames = [
		`event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response })}`,
		`event: response.in_progress\ndata: ${JSON.stringify({ type: "response.in_progress", sequence_number: 1, response })}`,
		`event: response.failed\ndata: ${JSON.stringify({
			type: "response.failed",
			sequence_number: 2,
			response: inStatusDetails
				? { ...response, status: "failed", status_details: { error } }
				: { ...response, status: "failed", error },
		})}`,
		"data: [DONE]",
	];
	return new Response(`${frames.join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const POOL = ["credential-A", "credential-B", "credential-C"];

/** Run one request through the real Responses provider with a three-credential rotating resolver. */
async function runAgainstPool(respond: () => Response) {
	const bearers: string[] = [];
	const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		bearers.push(new Headers(init?.headers).get("authorization") ?? "");
		return respond();
	}) as FetchImpl;
	let sibling = 0;
	const stream = streamSimple(model, context, {
		fetch,
		apiKey: async ctx => (ctx.error === undefined ? POOL[0] : POOL[++sibling]),
	});
	return { result: await stream.result(), bearers };
}

const quotaModel: Model<"openai-completions"> = buildModel({
	api: "openai-completions",
	name: "Quota Test",
	id: "quota-test",
	provider: "probe",
	baseUrl: "http://127.0.0.1:9/v1",
	contextWindow: 128_000,
	maxTokens: 1024,
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies ModelSpec<"openai-completions">);

/**
 * One in-band Chat Completions error frame: HTTP 200, the error inside the stream. That route
 * has no raw-body fallback, so a parser that descends into the wrong object has nothing left to
 * report — the code, the classification and the explanation all go with it.
 */
async function runInBandError(error: Record<string, unknown>): Promise<AssistantMessage> {
	const fetch = (async () =>
		new Response(`data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		})) as FetchImpl;
	return await streamSimple(quotaModel, context, { fetch, apiKey: "test" }).result();
}

describe("error envelopes a gateway doubly wrapped", () => {
	// A gateway may wrap the envelope in itself, and the inner object is then the real error.
	it("reads the refusal code out of the inner envelope instead of rotating every credential", async () => {
		const { result, bearers } = await runAgainstPool(() =>
			Response.json({ error: { error: { code: "cyber_policy", message: REFUSAL_MESSAGE } } }, { status: 403 }),
		);

		expect(bearers).toEqual(["Bearer credential-A"]);
		expect(result.stopDetails).toEqual({ type: "refusal", category: "cyber_policy", explanation: REFUSAL_MESSAGE });
	});
});

describe("an `error` field beside a code of its own", () => {
	// It is a diagnostic, not the envelope, and reading it as one throws away the outer code and
	// message. A refusal survives that by a second route (its code is also read off the plain
	// provider error), so a refusal cannot witness the precedence; a spent quota can. Read the
	// wrong way it stops classifying as a usage limit and is retried as an unexplained transient.
	it.each([
		{ name: "an empty array", diagnostic: [] as unknown },
		{ name: "an object carrying no code", diagnostic: { trace_id: "abc", detail: "diagnostic only" } },
	])("keeps the quota code and its explanation when the field is $name", async ({ diagnostic }) => {
		const result = await runInBandError({
			code: "429",
			type: "TOO_MANY_REQUESTS",
			message: "Your account quota is exhausted",
			error: diagnostic,
		});

		expect(result.errorMessage).toBe("429 Your account quota is exhausted");
		expect(AIError.isUsageLimit(result)).toBe(true);
	});
});

describe("provider content-policy refusals", () => {
	it("attempts a cyber_policy refusal once and surfaces the provider's code and message as a refusal", async () => {
		const { result, bearers } = await runAgainstPool(() =>
			failedResponse({ code: "cyber_policy", message: REFUSAL_MESSAGE }),
		);

		expect(bearers).toEqual(["Bearer credential-A"]);
		expect(result.stopReason).toBe("error");
		expect(result.stopDetails).toEqual({ type: "refusal", category: "cyber_policy", explanation: REFUSAL_MESSAGE });
		expect(result.errorMessage).toBe(`Refusal (cyber_policy): ${REFUSAL_MESSAGE}`);
	});

	it("does not retry an in-band refusal whose own message reads like a throttle", async () => {
		// In band there is no status field to contradict the text, so a refusal that asks the
		// caller to try again reads as throttle wording unless the refusal guard runs first.
		// It is still a refusal, and it is still one request.
		const worded = "This content was flagged for possible cybersecurity risk. Please retry in a moment.";
		const { result, bearers } = await runAgainstPool(() => failedResponse({ code: "cyber_policy", message: worded }));

		expect(bearers).toEqual(["Bearer credential-A"]);
		expect(result.stopDetails).toEqual({ type: "refusal", category: "cyber_policy", explanation: worded });
		expect(result.errorMessage).toBe(`Refusal (cyber_policy): ${worded}`);
	});

	it.each([
		{
			name: "an account-eligibility denial naming Trusted Access for Cyber",
			respond: () => failedResponse({ code: "cyber_policy", message: TRUSTED_ACCESS_MESSAGE }),
		},
		{
			name: "an HTTP 403 access denial",
			respond: () => Response.json({ error: { message: "Access denied for this account" } }, { status: 403 }),
		},
	])("still rotates every sibling credential on $name", async ({ respond }) => {
		const { result, bearers } = await runAgainstPool(respond);

		expect(bearers).toEqual(POOL.map(key => `Bearer ${key}`));
		expect(result.stopReason).toBe("error");
		expect(result.stopDetails?.type).not.toBe("refusal");
	});
});

type RefusalCarrier =
	| "sse"
	| "http403"
	| "http400"
	| "http403-gateway-wrapped"
	| "sse-gateway-wrapped"
	| "sse-diagnostic-beside-the-code"
	| "sse-code-carried-as-type"
	| "http403-numeric-code-beside-the-type"
	| "sse-numeric-code-beside-the-type"
	| "sse-wrapped-three-deep"
	| "http403-wrapped-three-deep"
	| "http403-flat-root"
	| "sse-in-status-details"
	| "http403-root-code-beside-a-diagnostic"
	| "sse-flat-root-chunk"
	| "http403-in-response-error"
	| "http403-in-status-details"
	| "http403-root-discriminator-with-inner-envelope"
	| "sse-root-discriminator-with-inner-envelope"
	| "sse-root-code-beside-a-diagnostic"
	| "http403-type-code-beside-a-diagnostic"
	| "http403-status-string-code-over-an-envelope";

/** A transient cause a gateway may attach beside a refusal; it must never replace it. */
const INNER_DIAGNOSTIC = { code: "server_error", message: "upstream diagnostic", status: 503 };

/**
 * A refusal whose own message reads like a throttle. In band there is no status field to
 * contradict the text, so this is what makes a mis-read code retryable rather than merely wrong.
 */
const RETRY_WORDED_REFUSAL = "This content was flagged for possible cybersecurity risk. Please retry in a moment.";

/**
 * The message the carrier sends, which is also the explanation it must surface.
 *
 * Throttle wording is not decoration on these two rows: in band there is no status field to
 * contradict the text, so it is what makes the shared in-band probe's choice of envelope
 * observable. If the probe looks in a position the provider's reporter does not, or stops looking
 * where the reporter keeps going, the frame is claimed as a transient failure and the refusal is
 * gone before any reporter runs.
 */
function refusalMessageOn(carrier: RefusalCarrier): string {
	return carrier === "sse-numeric-code-beside-the-type" ? RETRY_WORDED_REFUSAL : REFUSAL_MESSAGE;
}

/** The same `cyber_policy` refusal on the given carrier, in the wire format `api` streams. */
function refusalOn(api: Api, carrier: RefusalCarrier): Response {
	const message = refusalMessageOn(carrier);
	const error = { code: "cyber_policy", message };
	// Some gateways wrap the error envelope in itself; the refusal code sits one level deeper.
	if (carrier === "http403-gateway-wrapped") return Response.json({ error: { error } }, { status: 403 });
	// A compat host answers with the envelope AT THE ROOT, no `error` member at all. The shared
	// in-band probe has always accepted that shape; three readers of a non-2xx body discarded it,
	// so the same refusal read correctly in band and spent every credential over HTTP.
	if (carrier === "http403-flat-root") return Response.json(error, { status: 403 });
	// The wire writes a DISCRIMINATOR at the root of a Responses failure body, exactly as this
	// file's own `failedResponse` helper does. A reader that treats a root `type` as a code reads
	// `"response.failed"` and never reaches the envelope beneath it.
	if (carrier === "http403-in-response-error") {
		return Response.json({ type: "response.failed", response: { status: "failed", error } }, { status: 403 });
	}
	if (carrier === "http403-in-status-details") {
		return Response.json(
			{ type: "response.failed", response: { status: "failed", status_details: { error } } },
			{ status: 403 },
		);
	}
	// The same discriminator with the envelope sitting directly beside it. Ranking a root `type`
	// above the inner envelope read the code as `"error"` and spent every stored credential.
	// The refusal code written in the root's `type` with a diagnostic object beside it. This is
	// structurally identical to the discriminator carrier above — `{ type, error: {...} }` — and
	// only the vocabulary separates them: "cyber_policy" is a code this system knows, "error" is
	// a frame name it does not.
	// A root `code` holding a three-digit STATUS, with a root message beside it, over a real
	// envelope. Treating "403" as the body's machine code hides the refusal underneath it. The
	// status here is deliberately NOT retryable: a refusal delivered on a 429 or 503 is resent by
	// the transport before any reader sees the body, which is a separate limitation this pull
	// request names and does not fix, and mixing the two would make this row prove neither.
	if (carrier === "http403-status-string-code-over-an-envelope") {
		return Response.json(
			{ code: "403", message: "Forbidden", error: { code: "cyber_policy", message: REFUSAL_MESSAGE } },
			{ status: 403 },
		);
	}
	if (carrier === "http403-type-code-beside-a-diagnostic") {
		return Response.json(
			{ type: "cyber_policy", message: REFUSAL_MESSAGE, error: INNER_DIAGNOSTIC },
			{ status: 403 },
		);
	}
	if (carrier === "http403-root-discriminator-with-inner-envelope") {
		return Response.json({ type: "error", error }, { status: 403 });
	}
	// And the same root envelope with a DIAGNOSTIC object beside it. The rule one level down —
	// an `error` field beside a code of its own is a diagnostic — governs the root too; reading
	// the diagnostic instead discarded the refusal and spent every credential.
	if (carrier === "http403-root-code-beside-a-diagnostic") {
		return Response.json(
			{ ...error, error: { code: "invalid_api_key", message: "diagnostic account error" } },
			{ status: 403 },
		);
	}
	// A gateway fronting a gateway: the middle level carries nothing of its own, so a reader that
	// refuses to walk through it never reaches the code at the bottom.
	if (carrier === "http403-wrapped-three-deep") {
		return Response.json({ error: { error: { error } } }, { status: 403 });
	}
	// The provider's own envelope may carry the code as `type` with a NUMBER in `code` — a status
	// wearing the field's name. A reader that takes `code` first gets "400" and the only code the
	// body carried is gone.
	if (carrier === "http403-numeric-code-beside-the-type") {
		return Response.json({ error: { code: 400, type: "cyber_policy", message } }, { status: 403 });
	}
	if (!carrier.startsWith("sse")) return Response.json({ error }, { status: carrier === "http403" ? 403 : 400 });
	// In band: an HTTP 200 whose stream carries the failure. Each API reads that frame with its own
	// code, and a refusal arriving this way can lose its code — to the wrapper, to a diagnostic
	// beside it, to being written as `type` rather than `code`, to a number in `code` masking that
	// `type`, or to an intermediate wrapper level carrying nothing of its own. Chat Completions
	// carries the provider's `type` beside the code; a gateway that wraps the envelope wraps that
	// whole object rather than adding a sibling type of its own.
	const inner = api === "openai-completions" ? { ...error, type: "invalid_request_error" } : error;
	const streamed =
		carrier === "sse-gateway-wrapped"
			? { error: inner }
			: carrier === "sse-wrapped-three-deep"
				? { error: { error: inner } }
				: carrier === "sse-diagnostic-beside-the-code"
					? { ...inner, error: INNER_DIAGNOSTIC }
					: carrier === "sse-code-carried-as-type"
						? { type: "cyber_policy", message }
						: carrier === "sse-numeric-code-beside-the-type"
							? { code: 400, type: "cyber_policy", message }
							: inner;
	// `sse-in-status-details` puts the same envelope in `response.status_details.error`, the
	// position one Responses-family reader consulted and the Codex one did not. Chat Completions
	// has no such field, so for that API the carrier is the ordinary in-band chunk.
	// The root-code-with-a-diagnostic shape on the Responses family is an `error` EVENT whose own
	// root carries the code, with the diagnostic beside it — the frame an arm drove when three of
	// the four wires reported the diagnostic and exited 1 while Chat Completions reported the
	// refusal and exited 4 on identical bytes.
	if (carrier === "sse-root-code-beside-a-diagnostic" && api !== "openai-completions") {
		const frame = JSON.stringify({ type: "error", ...error, error: INNER_DIAGNOSTIC });
		return new Response(`event: error\ndata: ${frame}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	if (api !== "openai-completions") return failedResponse(streamed, carrier === "sse-in-status-details");
	// `sse-flat-root-chunk` puts the code at the ROOT of the chunk with no `error` object at all,
	// which is what cost this wire its code: its reporter returned a generic error before ever
	// asking whether the frame was a refusal.
	// The same discriminator in band, on the wire that writes a bare `error` chunk:
	// `{ type: "error", error: { code, message } }`. On the Responses family this carrier is the
	// ordinary in-band failure, whose own frame already carries `type: "response.failed"` at its
	// root, so every API here answers the question with the shape that API actually writes.
	if (carrier === "sse-root-discriminator-with-inner-envelope") {
		return new Response(`data: ${JSON.stringify({ type: "error", error: inner })}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	// The refusal at the chunk root with a transient diagnostic beside it. A probe that selects
	// the diagnostic reads `server_error` with its 503 and claims the frame as retryable, and the
	// refusal is gone before the provider's reporter ever sees it.
	if (carrier === "sse-root-code-beside-a-diagnostic") {
		return new Response(
			`data: ${JSON.stringify({ type: "error", ...error, error: INNER_DIAGNOSTIC })}\n\ndata: [DONE]\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	}
	if (carrier === "sse-flat-root-chunk") {
		return new Response(`data: ${JSON.stringify({ type: "error", ...error })}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	// Chat Completions streams a failure as an in-band `error` chunk.
	return new Response(`data: ${JSON.stringify({ error: streamed })}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("content-policy refusals on every OpenAI-wire API and carrier", () => {
	const apis = ["openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses"] as const;
	const carriers: RefusalCarrier[] = [
		"sse",
		"http403",
		"http400",
		"http403-gateway-wrapped",
		"sse-gateway-wrapped",
		"sse-diagnostic-beside-the-code",
		"sse-code-carried-as-type",
		"http403-numeric-code-beside-the-type",
		"sse-numeric-code-beside-the-type",
		"sse-wrapped-three-deep",
		"http403-wrapped-three-deep",
		"http403-flat-root",
		"sse-in-status-details",
		"http403-root-code-beside-a-diagnostic",
		"sse-flat-root-chunk",
		"http403-in-response-error",
		"http403-in-status-details",
		"http403-root-discriminator-with-inner-envelope",
		"sse-root-discriminator-with-inner-envelope",
		"sse-root-code-beside-a-diagnostic",
		"http403-type-code-beside-a-diagnostic",
		"http403-status-string-code-over-an-envelope",
	];
	it.each(apis.flatMap(api => carriers.map(carrier => ({ api, carrier }))))(
		"$api $carrier: one attempt, no rotation, the refusal's stopDetails kept",
		async ({ api, carrier }) => {
			const credentials: string[] = [];
			using server = Bun.serve({
				port: 0,
				fetch: async request => {
					await request.text();
					credentials.push(request.headers.get("authorization") ?? request.headers.get("api-key") ?? "");
					return refusalOn(api, carrier);
				},
			});
			const routeModel = buildModel({
				api,
				name: "Refusal Route",
				id: "refusal-route",
				provider: "refusal-proxy",
				baseUrl: server.url.toString().replace(/\/$/, ""),
				preferWebsockets: false,
				contextWindow: 200_000,
				maxTokens: 8192,
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} satisfies ModelSpec<Api>) as Model<Api>;
			let sibling = 0;
			const result = await streamSimple(routeModel, context, {
				apiKey: async ctx => (ctx.error === undefined ? POOL[0] : POOL[++sibling]),
			}).result();

			expect(credentials).toHaveLength(1);
			expect(credentials[0]).toContain(POOL[0]);
			expect(result.stopReason).toBe("error");
			const message = refusalMessageOn(carrier);
			expect(result.stopDetails).toEqual({
				type: "refusal",
				category: "cyber_policy",
				explanation: message,
			});
			expect(result.errorMessage).toBe(`Refusal (cyber_policy): ${message}`);
		},
	);
});
