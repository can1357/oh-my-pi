import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
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

function failedResponse(code: string, message: string): Response {
	const response = { id: "resp_refused", status: "in_progress" };
	const frames = [
		`event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response })}`,
		`event: response.in_progress\ndata: ${JSON.stringify({ type: "response.in_progress", sequence_number: 1, response })}`,
		`event: response.failed\ndata: ${JSON.stringify({
			type: "response.failed",
			sequence_number: 2,
			response: { ...response, status: "failed", error: { code, message } },
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

describe("error envelopes a gateway doubly wrapped", () => {
	// A gateway may wrap the envelope in itself, and the inner object is then the real error.
	it("reads the refusal code out of the inner envelope instead of rotating every credential", async () => {
		const { result, bearers } = await runAgainstPool(() =>
			Response.json({ error: { error: { code: "cyber_policy", message: REFUSAL_MESSAGE } } }, { status: 403 }),
		);

		expect(bearers).toEqual(["Bearer credential-A"]);
		expect(result.stopDetails).toEqual({ type: "refusal", category: "cyber_policy", explanation: REFUSAL_MESSAGE });
	});

	// An `error` field beside a valid outer code is a diagnostic, not the envelope. Taking it
	// loses the outer code: a refusal read that way stops being a refusal and rotates every
	// sibling credential, which is the account walk this pull request exists to prevent.
	it.each([
		{ name: "an empty array", diagnostic: [] as unknown },
		{ name: "an object carrying no code", diagnostic: { trace_id: "abc", detail: "diagnostic only" } },
	])("keeps the outer refusal code when the inner value is $name", async ({ diagnostic }) => {
		const { result, bearers } = await runAgainstPool(() =>
			Response.json(
				{ error: { code: "cyber_policy", message: REFUSAL_MESSAGE, error: diagnostic } },
				{ status: 403 },
			),
		);

		expect(bearers).toEqual(["Bearer credential-A"]);
		expect(result.stopDetails).toEqual({ type: "refusal", category: "cyber_policy", explanation: REFUSAL_MESSAGE });
	});
});

describe("provider content-policy refusals", () => {
	it("attempts a cyber_policy refusal once and surfaces the provider's code and message as a refusal", async () => {
		const { result, bearers } = await runAgainstPool(() => failedResponse("cyber_policy", REFUSAL_MESSAGE));

		expect(bearers).toEqual(["Bearer credential-A"]);
		expect(result.stopReason).toBe("error");
		expect(result.stopDetails).toEqual({ type: "refusal", category: "cyber_policy", explanation: REFUSAL_MESSAGE });
		expect(result.errorMessage).toBe(`Refusal (cyber_policy): ${REFUSAL_MESSAGE}`);
	});

	it.each([
		{
			name: "an account-eligibility denial naming Trusted Access for Cyber",
			respond: () => failedResponse("cyber_policy", TRUSTED_ACCESS_MESSAGE),
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

type RefusalCarrier = "sse" | "http403" | "http400" | "http403-gateway-wrapped";

/** The same `cyber_policy` refusal on the given carrier, in the wire format `api` streams. */
function refusalOn(api: Api, carrier: RefusalCarrier): Response {
	const error = { code: "cyber_policy", message: REFUSAL_MESSAGE };
	// Some gateways wrap the error envelope in itself; the refusal code sits one level deeper.
	if (carrier === "http403-gateway-wrapped") return Response.json({ error: { error } }, { status: 403 });
	if (carrier !== "sse") return Response.json({ error }, { status: carrier === "http403" ? 403 : 400 });
	if (api !== "openai-completions") return failedResponse("cyber_policy", REFUSAL_MESSAGE);
	// Chat Completions streams a failure as an in-band `error` chunk.
	return new Response(
		`data: ${JSON.stringify({ error: { ...error, type: "invalid_request_error" } })}\n\ndata: [DONE]\n\n`,
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

describe("content-policy refusals on every OpenAI-wire API and carrier", () => {
	const apis = ["openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses"] as const;
	const carriers: RefusalCarrier[] = ["sse", "http403", "http400", "http403-gateway-wrapped"];
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
			expect(result.stopDetails).toEqual({
				type: "refusal",
				category: "cyber_policy",
				explanation: REFUSAL_MESSAGE,
			});
			expect(result.errorMessage).toBe(`Refusal (cyber_policy): ${REFUSAL_MESSAGE}`);
		},
	);
});
