import { expect, it } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = getBundledModel<"openai-responses">("openai", "gpt-5-mini");

it("recovers a session when the new credential cannot replay old encrypted reasoning", async () => {
	const requests: unknown[] = [];
	let responseCount = 0;
	const fetch: FetchImpl = async (_url, init) => {
		const body: { input: Array<{ type?: string; encrypted_content?: string; call_id?: string }> } = JSON.parse(
			String(init?.body),
		);
		requests.push(body.input);
		const oldCredential = new Headers(init?.headers).get("Authorization") === "Bearer old-account-key";
		if (
			!oldCredential &&
			body.input.some(item => item.type === "reasoning" && item.encrypted_content === "previous-account-payload")
		) {
			return new Response(
				JSON.stringify({
					error: {
						message: "reasoning `encrypted_content` was not issued to this caller",
						type: "invalid_request_error",
					},
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		}
		if (
			!oldCredential &&
			body.input.some(item => item.type === "function_call" && item.call_id === "call_new") &&
			!body.input.some(item => item.type === "reasoning" && item.encrypted_content === "replacement-account-payload")
		) {
			return new Response(
				JSON.stringify({
					error: { message: "tool call missing its reasoning item", type: "invalid_request_error" },
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		}
		responseCount++;
		const id = `resp_${responseCount}`;
		const text = responseCount === 1 ? "Previous answer" : "Continued answer";
		const toolArguments = '{"path":"note.txt"}';
		const events = [
			{ type: "response.created", response: { id, status: "in_progress" } },
			...(responseCount < 3
				? [
						{
							type: "response.output_item.done",
							output_index: 0,
							item: {
								type: "reasoning",
								id: responseCount === 1 ? "rs_previous" : "rs_replacement",
								summary: [],
								encrypted_content:
									responseCount === 1 ? "previous-account-payload" : "replacement-account-payload",
							},
						},
					]
				: []),
			...(responseCount === 2
				? [
						{
							type: "response.output_item.added",
							output_index: 1,
							item: {
								type: "function_call",
								id: "fc_new",
								call_id: "call_new",
								name: "read",
								arguments: "",
								status: "in_progress",
							},
						},
						{
							type: "response.function_call_arguments.delta",
							output_index: 1,
							item_id: "fc_new",
							delta: toolArguments,
						},
						{
							type: "response.function_call_arguments.done",
							output_index: 1,
							item_id: "fc_new",
							arguments: toolArguments,
						},
						{
							type: "response.output_item.done",
							output_index: 1,
							item: {
								type: "function_call",
								id: "fc_new",
								call_id: "call_new",
								name: "read",
								arguments: toolArguments,
								status: "completed",
							},
						},
					]
				: [
						{
							type: "response.output_item.done",
							output_index: oldCredential ? 1 : 0,
							item: {
								type: "message",
								id: `msg_${id}`,
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text }],
							},
						},
					]),
			{ type: "response.completed", response: { id, status: "completed" } },
		];
		return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const providerSessionState = new Map<string, ProviderSessionState>();
	const options = { apiKey: "new-account-key", fetch, providerSessionState, statefulResponses: false };
	const firstUser = { role: "user" as const, content: "First question", timestamp: 1 };
	const assistant = await streamOpenAIResponses(
		model,
		{ messages: [firstUser] },
		{ ...options, apiKey: "old-account-key" },
	).result();
	const firstContext: Context = {
		messages: [firstUser, assistant, { role: "user", content: "Next question", timestamp: 3 }],
	};
	const recovered = await streamOpenAIResponses(model, firstContext, options).result();
	const continued = await streamOpenAIResponses(
		model,
		{
			messages: [
				...firstContext.messages,
				recovered,
				{
					role: "toolResult",
					toolCallId: "call_new|fc_new",
					toolName: "read",
					content: [{ type: "text", text: "note contents" }],
					isError: false,
					timestamp: 4,
				},
			],
		},
		options,
	).result();

	expect(assistant.stopReason).toBe("stop");
	expect(recovered.stopReason).toBe("toolUse");
	expect(recovered.content.find(block => block.type === "toolCall")).toMatchObject({
		id: "call_new|fc_new",
		name: "read",
		arguments: { path: "note.txt" },
	});
	expect(continued.stopReason).toBe("stop");
	expect(continued.content.filter(block => block.type === "text").map(block => block.text)).toContain(
		"Continued answer",
	);
	expect(requests).toHaveLength(4);
	expect(JSON.stringify(requests[1])).toContain("previous-account-payload");
	expect(JSON.stringify(requests[2])).toContain("Previous answer");
	expect(JSON.stringify(requests.slice(2))).not.toContain("previous-account-payload");
	expect(JSON.stringify(requests[3])).toContain("replacement-account-payload");
});

it("does not retry unrelated invalid requests", async () => {
	let requests = 0;
	const fetch: FetchImpl = async () => {
		requests++;
		return new Response(JSON.stringify({ error: { message: "Invalid input", type: "invalid_request_error" } }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	};
	const result = await streamOpenAIResponses(
		model,
		{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
		{ apiKey: "test-key", fetch },
	).result();

	expect(result.stopReason).toBe("error");
	expect(result.errorStatus).toBe(400);
	expect(requests).toBe(1);
});
