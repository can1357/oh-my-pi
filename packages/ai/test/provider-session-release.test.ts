import { describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
	getOpenAICodexTransportDetails,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Message, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { createCodexModel } from "./helpers";

describe("provider routing session release", () => {
	it("closes every Codex credential and Lite socket for one session while preserving another response chain", async () => {
		const requests: Record<string, unknown>[] = [];
		const closed = Promise.withResolvers<void>();
		let opened = 0;
		let closedCount = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return undefined;
				return new Response("WebSocket required", { status: 400 });
			},
			websocket: {
				open() {
					opened++;
				},
				message(socket: ServerWebSocket<unknown>, message) {
					requests.push(JSON.parse(String(message)) as Record<string, unknown>);
					const id = `resp_${requests.length}`;
					const item = {
						type: "message",
						id: `msg_${id}`,
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Answer" }],
					};
					for (const event of [
						{ type: "response.created", response: { id } },
						{ type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
						{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
						{ type: "response.output_text.delta", delta: "Answer" },
						{ type: "response.output_item.done", item },
						{
							type: "response.completed",
							response: {
								id,
								status: "completed",
								usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
							},
						},
					]) {
						socket.send(JSON.stringify(event));
					}
				},
				close() {
					if (++closedCount === 2) closed.resolve();
				},
			},
		});
		const model: Model<"openai-codex-responses"> = {
			...createCodexModel("gpt-5.5"),
			baseUrl: `http://127.0.0.1:${server.port}`,
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = (account: string) =>
			`aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toBase64()}.bbb`;
		const options = { apiKey: token("account-a"), providerSessionState, preferWebsockets: true };
		const messages: Message[] = [{ role: "user", content: "First question", timestamp: 1 }];
		const context = { systemPrompt: ["system prompt"], messages };
		const mainOptions = { ...options, sessionId: "main" };
		const sideSessionId = `side:${"long-session-id".repeat(8)}`;
		const sideOptions = { ...options, sessionId: sideSessionId };
		try {
			const mainReply = await streamOpenAICodexResponses(model, context, mainOptions).result();
			expect(mainReply.stopReason).toBe("stop");
			for (const variant of [sideOptions, { ...sideOptions, apiKey: token("account-b"), responsesLite: true }]) {
				expect((await streamOpenAICodexResponses(model, context, variant).result()).stopReason).toBe("stop");
			}
			expect(opened).toBe(3);
			expect(getOpenAICodexTransportDetails(model, sideOptions).hasSessionState).toBe(true);
			for (const state of providerSessionState.values()) state.releaseSession?.(sideSessionId);
			expect(getOpenAICodexTransportDetails(model, sideOptions)).toMatchObject({
				hasSessionState: false,
				hasTurnState: false,
				websocketConnected: false,
			});
			await closed.promise;
			expect(closedCount).toBe(2);
			expect(getOpenAICodexTransportDetails(model, mainOptions).websocketConnected).toBe(true);
			const followup = await streamOpenAICodexResponses(
				model,
				{ ...context, messages: [...messages, mainReply, { role: "user", content: "Follow-up", timestamp: 2 }] },
				mainOptions,
			).result();
			expect(followup.stopReason).toBe("stop");
			expect(requests[3].previous_response_id).toBe("resp_1");
			expect(opened).toBe(3);
		} finally {
			for (const state of providerSessionState.values()) state.close();
			await server.stop(true);
		}
	});
});
