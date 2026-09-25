import { expect, it } from "bun:test";
import { withAuth } from "../src/auth-retry";
import { classifyGatewayError } from "../src/error/gateway";
import { AnthropicMessagesClient } from "../src/providers/anthropic-client";
import { enforceStrictSchema } from "../src/utils/schema/normalize";

it("keeps a circular strict schema terminal instead of retrying a provider", () => {
	const schema: Record<string, unknown> = { type: "object" };
	schema.properties = { recursive: schema };
	let caught: unknown;
	try {
		enforceStrictSchema(schema);
	} catch (error) {
		caught = error;
	}
	expect(classifyGatewayError(caught)).toMatchObject({ owner: "request", disposition: "request_terminal" });
});

it("attributes a missing credential to credential rotation rather than provider outage", async () => {
	let caught: unknown;
	try {
		await withAuth(undefined, async () => "unreachable", { missingKeyMessage: "No configured credential" });
	} catch (error) {
		caught = error;
	}
	expect(classifyGatewayError(caught)).toMatchObject({ owner: "credential", disposition: "credential_transient" });
});

it("keeps an exhausted Anthropic conflict retryable", async () => {
	const client = new AnthropicMessagesClient({
		apiKey: "test",
		maxRetries: 0,
		fetch: async () => new Response("Conflict", { status: 409 }),
	});
	let caught: unknown;
	try {
		await client.messages
			.create({ model: "test", messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: true })
			.asResponse();
	} catch (error) {
		caught = error;
	}
	expect(classifyGatewayError(caught)).toMatchObject({
		status: 409,
		owner: "provider",
		disposition: "provider_transient",
	});
});
