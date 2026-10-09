import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, FetchImpl, Message, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

function response(id: string): Response {
	const events = [
		{ type: "response.created", response: { id } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Answer" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${id}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Answer" }],
			},
		},
		{
			type: "response.completed",
			response: { id, status: "completed", usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } },
		},
	];
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

interface ResponsesState extends ProviderSessionState {
	chains: Map<string, unknown>;
}

describe("one-shot side request state", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	function createSession(sideStreamFn: StreamFn): AgentSession {
		const session = new AgentSession({
			agent: new Agent({
				promptCacheKey: "main-cache",
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [{ role: "user", content: "Main question", timestamp: 1 }],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {
				resolver: () => async () => "test-key",
				authStorage: { usage: { ingestHeaders() {} }, oauth: { identity() {} } },
				hasLazyRuntimeMetadata: () => false,
			} as never,
			sideStreamFn,
		});
		sessions.push(session);
		return session;
	}

	it("releases completed one-shot histories while preserving main and reusable side response chains", async () => {
		const requests: Record<string, unknown>[] = [];
		const fetch: FetchImpl = async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return response(`resp_${requests.length}`);
		};
		const session = createSession((_model, context, options) =>
			streamOpenAIResponses(model, context, { ...options, apiKey: "test-key", statefulResponses: true, fetch }),
		);
		const mainContext: Context = { systemPrompt: ["main system"], messages: session.messages as Message[] };
		const mainOptions = {
			apiKey: "test-key",
			sessionId: session.sessionId,
			providerSessionState: session.providerSessionState,
			statefulResponses: true,
			fetch,
		};
		const mainReply = await streamOpenAIResponses(model, mainContext, mainOptions).result();
		const sideReply = await session.runEphemeralTurn({ promptText: "Side question", conversationKey: "topic" });
		const state = session.providerSessionState.get("openai-responses:openai") as ResponsesState;
		expect(state.chains.size).toBe(2);
		expect((await session.runEphemeralTurn({ promptText: "One-shot question" })).replyText).toBe("Answer");
		expect(state.chains.size).toBe(2);
		await session.runEphemeralTurn({
			promptText: "Side follow-up",
			conversationKey: "topic",
			history: [
				{ role: "user", content: "Side question", attribution: "agent", timestamp: 2 },
				sideReply.assistantMessage,
			],
		});
		await streamOpenAIResponses(
			model,
			{
				...mainContext,
				messages: [...mainContext.messages, mainReply, { role: "user", content: "Main follow-up", timestamp: 3 }],
			},
			mainOptions,
		).result();
		expect(requests[2].previous_response_id).toBeUndefined();
		expect(requests[2].prompt_cache_key).toBe("main-cache");
		expect(requests[3].previous_response_id).toBe("resp_2");
		expect(requests[4].previous_response_id).toBe("resp_1");
	});

	it("keeps an overlapping one-shot request alive when another finishes", async () => {
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let requests = 0;
		const session = createSession((_model, context, options) =>
			streamOpenAIResponses(model, context, {
				...options,
				apiKey: "test-key",
				statefulResponses: true,
				fetch: async () => {
					const id = ++requests;
					if (id === 1) {
						entered.resolve();
						await finish.promise;
					}
					return response(`resp_${id}`);
				},
			}),
		);
		const pending = session.runEphemeralTurn({ promptText: "Pending question" });
		try {
			await entered.promise;
			expect((await session.runEphemeralTurn({ promptText: "Fast question" })).replyText).toBe("Answer");
			const state = session.providerSessionState.get("openai-responses:openai") as ResponsesState;
			expect(state.chains.size).toBe(1);
			finish.resolve();
			expect((await pending).replyText).toBe("Answer");
			expect(state.chains.size).toBe(0);
		} finally {
			finish.resolve();
			await pending.catch(() => {});
		}
	});

	it("preserves learned strict-tool fallback across completed one-shot requests", async () => {
		const strictFlags: Array<boolean | undefined> = [];
		const session = createSession((_model, context, options) =>
			streamOpenAIResponses(model, context, {
				...options,
				apiKey: "test-key",
				statefulResponses: true,
				fetch: async (_url, init) => {
					const body = JSON.parse(String(init?.body)) as { tools: Array<{ strict?: boolean }> };
					strictFlags.push(body.tools[0]?.strict);
					if (strictFlags.length === 1) {
						return new Response(
							JSON.stringify({
								error: {
									type: "invalid_request_error",
									message:
										"The compiled grammar is too large. Simplify your tool schemas or reduce the number of strict tools.",
								},
							}),
							{ status: 400, headers: { "content-type": "application/json" } },
						);
					}
					return response(`resp_${strictFlags.length}`);
				},
			}),
		);
		session.agent.setTools([
			{
				name: "lookup",
				label: "Lookup",
				description: "Look up a value",
				parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
				execute: async () => ({ content: [], details: {} }),
			},
		]);
		for (const promptText of ["First question", "Second question"]) {
			expect((await session.runEphemeralTurn({ promptText })).replyText).toBe("Answer");
		}
		expect(strictFlags).toEqual([true, undefined, undefined]);
		const state = session.providerSessionState.get("openai-responses:openai") as ResponsesState;
		expect(state.chains.size).toBe(0);
	});

	it.each(["transport error", "abort", "delivery error"])("releases one-shot history after %s", async failure => {
		const entered = Promise.withResolvers<void>();
		const abort = new AbortController();
		const session = createSession((_model, context, options) =>
			streamOpenAIResponses(model, context, {
				...options,
				apiKey: "test-key",
				statefulResponses: true,
				fetch: async () => {
					if (failure === "transport error") {
						return new Response(JSON.stringify({ error: { message: "Invalid side request" } }), { status: 400 });
					}
					if (failure === "abort") {
						options?.signal?.throwIfAborted();
						const pending = Promise.withResolvers<Response>();
						options?.signal?.addEventListener("abort", () => pending.reject(options.signal?.reason), {
							once: true,
						});
						entered.resolve();
						return pending.promise;
					}
					return response("resp_delivery");
				},
			}),
		);
		const turn = session.runEphemeralTurn({
			promptText: "One-shot question",
			signal: abort.signal,
			onTextDelta: () => {
				if (failure === "delivery error") throw new Error("Delivery failed");
			},
		});
		if (failure === "abort") {
			await entered.promise;
			abort.abort();
		}
		await expect(turn).rejects.toThrow(
			failure === "transport error" ? "Invalid side request" : failure === "abort" ? /abort/i : "Delivery failed",
		);
		const state = session.providerSessionState.get("openai-responses:openai") as ResponsesState;
		expect(state.chains.size).toBe(0);
	});

	it("cleans up a rejected stream factory without masking its error when another provider cleanup throws", async () => {
		const retained = new Set<string>();
		const session = createSession(async (_model, _context, options) => {
			const sessionId = options?.sessionId;
			if (!sessionId) throw new Error("Missing side session id");
			retained.add(sessionId);
			throw new Error("Factory failed");
		});
		session.providerSessionState.set("throwing", {
			close() {},
			releaseSession() {
				throw new Error("Cleanup failed");
			},
		});
		session.providerSessionState.set("retaining", {
			close() {},
			releaseSession: sessionId => retained.delete(sessionId),
		});
		await expect(session.runEphemeralTurn({ promptText: "Question" })).rejects.toThrow("Factory failed");
		expect(retained.size).toBe(0);
	});
});
