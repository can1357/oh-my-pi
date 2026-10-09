import { afterEach, describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { clearGrokbotTokenCache, runWithGrokbotAuthSourceAsync } from "@oh-my-pi/pi-catalog/discovery/grokbot-auth";
import { frameConnectPayload, isRecord } from "@oh-my-pi/pi-utils";
import { grokbotChatPrompt } from "../src/providers/grokbot-chat";
import { streamSimple } from "../src/stream";
import type { Context, FetchImpl } from "../src/types";

afterEach(() => clearGrokbotTokenCache());
const model = buildModel(seedModels<"grokbot-chat">("grokbot-chat")[0]!);
const context: Context = { messages: [{ role: "user", content: "fixture request", timestamp: 0 }] };

interface FixtureOptions {
	foreignRows?: boolean;
	refuse?: boolean;
	mismatchReadback?: boolean;
	deniedWatch?: boolean;
	abortAfterSend?: AbortController;
	denyCleanup?: boolean;
}
function fixture(options: FixtureOptions = {}) {
	const calls: Array<{ method: string; body: Record<string, unknown>; bearer: string | null }> = [];
	let newAgent: Record<string, unknown> | undefined;
	let transcript: Array<Record<string, unknown>> = [];
	let watchController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let watchCancelled = false;
	const original = {
		id: "original-server",
		agentId: "original-agent",
		name: "real agent",
		viewerIsOwner: true,
		viewerCanManage: true,
	};
	const encode = (body: unknown) => frameConnectPayload(Buffer.from(JSON.stringify(body)));
	const fetch: FetchImpl = async (input, init) => {
		const method = String(input).split("/").at(-1)!;
		const bytes = init?.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.from(String(init?.body ?? "{}"));
		const body: unknown = JSON.parse((method === "WatchGrokBotTranscripts" ? bytes.subarray(5) : bytes).toString());
		if (!isRecord(body)) throw new Error("Invalid fixture request");
		calls.push({ method, body, bearer: new Headers(init?.headers).get("authorization") });
		switch (method) {
			case "inference-credential":
				return Response.json({
					accessToken: "fixture-session",
					grokBotToken: "must-not-use-inference",
					expiresAtMs: Date.now() + 300_000,
				});
			case "ListGrokBotAgents":
				return Response.json({ agents: newAgent ? [original, newAgent] : [original] });
			case "CreateGrokBotAgent":
				newAgent = { ...body, id: "new-server", viewerIsOwner: true, viewerCanManage: true };
				return Response.json({ agent: newAgent });
			case "ListGrokBotTranscriptEntries":
				return Response.json({
					generation: 1,
					entries: options.mismatchReadback && transcript.length ? [] : [...transcript].reverse(),
				});
			case "WatchGrokBotTranscripts": {
				if (options.deniedWatch)
					return new Response(
						frameConnectPayload(
							Buffer.from(
								JSON.stringify({ error: { code: "permission_denied", message: "DO_NOT_ECHO_SECRET" } }),
							),
							2,
						),
						{ headers: { "content-type": "application/connect+json" } },
					);
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						watchController = controller;
						controller.enqueue(encode({ connected: {} }));
						init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
					},
					cancel() {
						watchCancelled = true;
					},
				});
				return new Response(stream, { headers: { "content-type": "application/connect+json" } });
			}
			case "SendGrokBotUserMessage": {
				if (options.abortAfterSend) {
					options.abortAfterSend.abort();
					return Response.json({ delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL", dispatched: true });
				}
				if (options.refuse) return Response.json({ delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED" });
				transcript = [
					{
						seq: "9007199254740993",
						entryId: "user-entry",
						body: Buffer.from(
							JSON.stringify({ kind: "message", role: "user", clientNonce: body.messageId, content: body.text }),
						).toString("base64"),
					},
					{
						seq: "9007199254740994",
						entryId: "reply-entry",
						body: Buffer.from(
							JSON.stringify({
								kind: "send-message",
								message: { type: "text", content: "verified fixture reply" },
							}),
						).toString("base64"),
					},
				];
				watchController?.enqueue(
					encode({
						rows: { agentId: options.foreignRows ? "original-agent" : body.agentId, entries: transcript },
					}),
				);
				return Response.json({ delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL", dispatched: true });
			}
			case "DeleteGrokBotAgent":
				if (options.denyCleanup) return Response.json({ code: "permission_denied" }, { status: 403 });
				if (body.id !== "new-server") throw new Error("Attempt to delete original agent");
				newAgent = undefined;
				return Response.json({});
			default:
				throw new Error(`Unexpected fixture RPC ${method}`);
		}
	};
	return {
		fetch,
		calls,
		get watchCancelled() {
			return watchCancelled;
		},
		get newAgentExists() {
			return !!newAgent;
		},
	};
}

async function run(f: ReturnFixture, ctx = context, signal?: AbortSignal, onPayload?: (payload: unknown) => unknown) {
	return runWithGrokbotAuthSourceAsync(
		{
			secretsPath: "/not-present/grokbot.env",
			env: { GROKBOT_RENEWAL_CREDENTIAL: "fixture-renewal", GROKBOT_MACHINE_ID: "fixture-machine" },
		},
		async () => {
			const stream = streamSimple(model, ctx, { apiKey: "fixture-renewal", fetch: f.fetch, signal, onPayload });
			for await (const _event of stream) {
				/* Consume normal public stream events. */
			}
			return stream.result();
		},
	);
}
interface ReturnFixture {
	fetch: FetchImpl;
	calls: Array<{ method: string; body: Record<string, unknown>; bearer: string | null }>;
	readonly watchCancelled: boolean;
	readonly newAgentExists: boolean;
}

describe("host-managed GrokBotService adapter", () => {
	test("accepts the CLI's pass-through hook but prevents a hook from claiming model selection", async () => {
		const passThrough = fixture();
		const accepted = await run(passThrough, context, undefined, payload =>
			isRecord(payload) ? { ...payload } : payload,
		);
		expect(accepted.stopReason).toBe("stop");
		const override = fixture();
		const refused = await run(override, context, undefined, payload =>
			isRecord(payload) ? { ...payload, requestedModel: { modelId: "claude-opus-5-5" } } : payload,
		);
		expect(refused.stopReason).toBe("error");
		expect(override.calls.filter(call => call.method === "SendGrokBotUserMessage")).toHaveLength(0);
		expect(override.newAgentExists).toBe(false);
	});
	test("caller abort still cleans up through an independent signal without repeating delivery", async () => {
		const controller = new AbortController();
		const f = fixture({ abortAfterSend: controller });
		const result = await run(f, context, controller.signal);
		expect(result.stopReason).toBe("aborted");
		expect(f.calls.filter(call => call.method === "SendGrokBotUserMessage")).toHaveLength(1);
		expect(f.newAgentExists).toBe(false);
	});

	test("cleanup failure remains visible even when the caller aborted", async () => {
		const controller = new AbortController();
		const f = fixture({ abortAfterSend: controller, denyCleanup: true });
		const result = await run(f, context, controller.signal);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("could not verify cleanup");
		expect(result.errorMessage).toContain("omp-chat-");
		expect(f.newAgentExists).toBe(true);
	});
	test("requires its own nonce and readback, uses session auth, and deletes only its temporary agent", async () => {
		const f = fixture();
		const result = await run(f);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "verified fixture reply" }]);
		expect(result.model).toBe("host-managed");
		expect(result.upstreamModel).toBeUndefined();
		const send = f.calls.filter(call => call.method === "SendGrokBotUserMessage");
		expect(send).toHaveLength(1);
		expect(send[0]?.body).not.toHaveProperty("modelId");
		expect(send[0]?.body).not.toHaveProperty("requestedModel");
		expect(
			f.calls
				.filter(call => call.method !== "inference-credential")
				.every(call => call.bearer === "Bearer fixture-session"),
		).toBe(true);
		expect(f.calls.filter(call => call.method === "DeleteGrokBotAgent").map(call => call.body.id)).toEqual([
			"new-server",
		]);
		expect(f.newAgentExists).toBe(false);
		expect(f.watchCancelled).toBe(true);
	});

	test("rejects another agent's rows and still cleans up its own conversation", async () => {
		const f = fixture({ foreignRows: true });
		const result = await run(f);
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([]);
		expect(f.newAgentExists).toBe(false);
	});

	test("does not claim completion when independent readback lacks the reply", async () => {
		const f = fixture({ mismatchReadback: true });
		const result = await run(f);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("reply failed independent transcript readback");
		expect(result.content).toEqual([]);
		expect(f.newAgentExists).toBe(false);
	});

	test("does not expose unexpected hook or transport exception text", async () => {
		const f = fixture();
		const result = await run(f, context, undefined, () => {
			throw new Error("DO_NOT_ECHO_SECRET");
		});
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).not.toContain("DO_NOT_ECHO_SECRET");
		expect(f.newAgentExists).toBe(false);
	});

	test("an uncertain/refused delivery is not resubmitted, and the watch is cancelled", async () => {
		const f = fixture({ refuse: true });
		const result = await run(f);
		expect(result.stopReason).toBe("error");
		expect(f.calls.filter(call => call.method === "SendGrokBotUserMessage")).toHaveLength(1);
		expect(f.newAgentExists).toBe(false);
	});

	test("HTTP 200 permission-denied trailers remain errors and never echo their body", async () => {
		const f = fixture({ deniedWatch: true });
		const result = await run(f);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(403);
		expect(result.errorMessage).not.toContain("DO_NOT_ECHO_SECRET");
		expect(f.newAgentExists).toBe(false);
	});

	test("rejects tools before any upstream write instead of silently stripping them", async () => {
		const f = fixture();
		const result = await run(f, {
			...context,
			tools: [{ name: "bash", description: "shell", parameters: { type: "object", properties: {} } }],
		});
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("--no-tools");
		expect(f.calls).toHaveLength(0);
	});

	test("history preserves prior text, not signed thinking or image placeholders", () => {
		const text = grokbotChatPrompt({
			systemPrompt: ["system instructions"],
			messages: [
				{
					role: "assistant",
					api: "grokbot-sand",
					provider: "grokbot",
					model: "claude-opus-5-5",
					content: [
						{ type: "thinking", thinking: "private thought", thinkingSignature: "signed" },
						{ type: "text", text: "prior answer" },
					],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
			],
		});
		expect(text).toContain("prior answer");
		expect(text).not.toContain("private thought");
		expect(text).not.toContain("signed");
		expect(() =>
			grokbotChatPrompt({
				messages: [{ role: "user", timestamp: 0, content: [{ type: "image", data: "x", mimeType: "image/png" }] }],
			}),
		).toThrow("text only");
	});
});
