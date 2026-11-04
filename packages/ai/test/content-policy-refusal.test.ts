import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
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
