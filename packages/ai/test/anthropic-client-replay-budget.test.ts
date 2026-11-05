/**
 * `StreamOptions.replayBudgetMs` against the resends `AnthropicHttpClient`
 * makes on its own — the wire retries that live below every rung the provider
 * module owns, and that no send gate can see, because a gate only checks a
 * replay something else already armed.
 *
 * The budget is wired here the way `buildAnthropicClientOptions` wires it: the
 * client's `fetch` is the gated one and the client carries the budget. Each
 * refusal case has its allowing twin, so a count of one is the deadline and not
 * a disabled retry.
 */
import { scheduler } from "node:timers/promises";
import { expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AnthropicMessagesClient, type AnthropicClientOptions } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { MessageCreateParamsStreaming } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ReplayBudget } from "@oh-my-pi/pi-ai/utils/replay-budget";

const params: MessageCreateParamsStreaming = {
	model: "claude-sonnet-4-5",
	messages: [{ role: "user", content: "hi" }],
	max_tokens: 64,
	stream: true,
};

/** A 429 stating a 1 ms wait, then a 200. The count is the count of wire requests. */
function overloadedThenOk(): { requests: () => number; fetch: FetchImpl } {
	let requests = 0;
	const fetchImpl: FetchImpl = (async () => {
		requests += 1;
		return requests === 1
			? new Response("overloaded", { status: 429, headers: { "retry-after-ms": "1" } })
			: new Response("{}", { status: 200 });
	}) as FetchImpl;
	return { requests: () => requests, fetch: fetchImpl };
}

/** A client wired as the provider wires one: gated fetch, budget, and a retry-wait hook that really sleeps. */
function clientUnder(budget: ReplayBudget | undefined, base: FetchImpl): AnthropicMessagesClient {
	const options: AnthropicClientOptions = {
		apiKey: "sk-test",
		maxRetries: 2,
		replayBudget: budget,
		fetch: budget ? budget.gateFetch(base) : base,
		retryPolicy: { providerRetryWait: async (_delayMs, signal) => await scheduler.wait(20, { signal }) },
	};
	return new AnthropicMessagesClient(options);
}

function settle(client: AnthropicMessagesClient): Promise<{ status?: number; error?: unknown }> {
	return client.messages
		.create(params)
		.asResponse()
		.then(
			response => ({ status: response.status }),
			(error: unknown) => ({ error }),
		);
}

it("refuses the client's own 429 resend once the replay budget is spent", async () => {
	const route = overloadedThenOk();

	const outcome = await settle(clientUnder(new ReplayBudget(1), route.fetch));

	expect(route.requests()).toBe(1);
	// The refusal answers with the failure the replay would have replaced.
	expect(AIError.status(outcome.error)).toBe(429);
});

it("sends the client's own 429 resend while the replay budget admits the wait", async () => {
	const route = overloadedThenOk();

	const outcome = await settle(clientUnder(new ReplayBudget(60_000), route.fetch));

	expect(route.requests()).toBe(2);
	expect(outcome.status).toBe(200);
});

it("sends the client's own 429 resend when no budget governs the call", async () => {
	const route = overloadedThenOk();

	const outcome = await settle(clientUnder(undefined, route.fetch));

	expect(route.requests()).toBe(2);
	expect(outcome.status).toBe(200);
});

it("refuses the client's own resend of a connection failure once the budget is spent", async () => {
	// The transport-error rung of the same loop resent without consulting the
	// budget too, and spent two further attempts doing it.
	let requests = 0;
	const fetchImpl: FetchImpl = (async () => {
		requests += 1;
		throw new TypeError("fetch failed");
	}) as FetchImpl;

	const outcome = await settle(clientUnder(new ReplayBudget(1), fetchImpl));

	expect(requests).toBe(1);
	expect(outcome.error).toBeInstanceOf(AIError.AnthropicConnectionError);
});

it("sends the client's own resend of a connection failure while the budget admits the wait", async () => {
	let requests = 0;
	const fetchImpl: FetchImpl = (async () => {
		requests += 1;
		if (requests === 1) throw new TypeError("fetch failed");
		return new Response("{}", { status: 200 });
	}) as FetchImpl;

	const outcome = await settle(clientUnder(new ReplayBudget(60_000), fetchImpl));

	expect(requests).toBe(2);
	expect(outcome.status).toBe(200);
});
