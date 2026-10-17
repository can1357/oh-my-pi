import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, FetchImpl, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import * as piUtils from "@oh-my-pi/pi-utils";
import { createCodexModel } from "./helpers";
const originalWebSocket = global.WebSocket;

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(() => {
	vi.restoreAllMocks();
	global.WebSocket = originalWebSocket;
});

function createCodexTestToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

const context: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

const COMPLETED_SSE = `${[
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	},
]
	.map(event => `data: ${JSON.stringify(event)}`)
	.join("\n\n")}\n\n`;

const NOT_ENABLED_BODY = JSON.stringify({
	error: {
		message: "The requested Cyber access program is not authorized for this workspace.",
		type: "invalid_request_error",
		param: "access_programs.cyber",
		code: "access_program_not_enabled",
	},
});

function decodeBody(body: RequestInit["body"]): Record<string, unknown> {
	const text =
		typeof body === "string"
			? body
			: body instanceof Uint8Array
				? new TextDecoder().decode(Bun.zstdDecompressSync(body))
				: undefined;
	if (text === undefined) throw new Error("expected a string or binary Codex request body");
	return JSON.parse(text) as Record<string, unknown>;
}

/** Fetch mock answering each `/responses` call with the next status and recording the sent `access_programs`. */
function createFetchMock(statuses: number[], sent: unknown[], errorBody = NOT_ENABLED_BODY): FetchImpl {
	return (async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (!url.endsWith("/responses")) return new Response("not found", { status: 404 });
		sent.push(decodeBody(init?.body).access_programs);
		const status = statuses[sent.length - 1] ?? 200;
		return status === 200
			? new Response(COMPLETED_SSE, { status, headers: { "content-type": "text/event-stream" } })
			: new Response(errorBody, { status, headers: { "content-type": "application/json" } });
	}) as FetchImpl;
}

describe("openai-codex cyber access programs", () => {
	const model = createCodexModel("gpt-6-sol", {
		baseUrl: "https://chatgpt.com/backend-api",
		preferWebsockets: true,
		accountAccess: {
			"acct-daybreak": { cyberPrograms: ["standard", "daybreak_blue"] },
			"acct-standard": { cyberPrograms: ["standard"] },
		},
	});

	it("requests Daybreak Blue only for eligible accounts and drops it for good after a rejection", async () => {
		const sent: unknown[] = [];
		const hookAccessPrograms: unknown[] = [];
		let hookCalls = 0;
		class FailingWebSocket {
			static readonly CONNECTING = 0;
			static readonly OPEN = 1;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;
			static failedAcquisitionCount = 0;
			static sendCount = 0;
			readyState = FailingWebSocket.CONNECTING;
			binaryType: "blob" | "arraybuffer" | "nodebuffer" = "blob";
			onopen: ((event: Event) => void) | null = null;
			onmessage: ((event: MessageEvent) => void) | null = null;
			onerror: ((event: Event) => void) | null = null;
			onclose: ((event: CloseEvent) => void) | null = null;

			constructor(
				readonly url: string,
				readonly options?: { headers?: Record<string, string>; proxy?: string },
			) {
				queueMicrotask(() => {
					FailingWebSocket.failedAcquisitionCount += 1;
					this.readyState = FailingWebSocket.CLOSED;
					this.onerror?.(new Event("error"));
					this.onclose?.({ code: 1006 } as CloseEvent);
				});
			}

			send(_data: string): void {
				FailingWebSocket.sendCount += 1;
			}

			close(): void {
				this.readyState = FailingWebSocket.CLOSED;
			}
		}

		global.WebSocket = FailingWebSocket as unknown as typeof WebSocket;
		const hook = async (payload: unknown) => {
			const request = payload as Record<string, unknown>;
			hookCalls += 1;
			hookAccessPrograms.push(request.access_programs);
			return request;
		};
		let runNumber = 0;
		const run = (accountId: string, statuses: number[], withHook = false) => {
			const providerSessionState = new Map<string, ProviderSessionState>();
			const sessionId = `access-programs-${accountId}-${runNumber++}`;
			return streamOpenAICodexResponses(model, context, {
				apiKey: createCodexTestToken(accountId),
				fetch: createFetchMock(statuses, sent),
				sessionId,
				providerSessionState,
				...(withHook ? { onPayload: hook } : {}),
			}).result();
		};

		expect((await run("acct-standard", [200])).stopReason).toBe("stop");
		expect(sent).toEqual([undefined]);
		expect(FailingWebSocket.failedAcquisitionCount).toBe(1);
		expect(FailingWebSocket.sendCount).toBe(0);

		sent.length = 0;
		const failuresBeforeDaybreak = FailingWebSocket.failedAcquisitionCount;
		const replayed = await run("acct-daybreak", [403, 200], true);
		expect(replayed.stopReason).toBe("stop");
		expect(sent).toEqual([{ cyber: "daybreak_blue" }, undefined]);
		expect(FailingWebSocket.failedAcquisitionCount - failuresBeforeDaybreak).toBe(1);
		expect(FailingWebSocket.sendCount).toBe(0);
		expect(hookCalls).toBe(2);
		expect(hookAccessPrograms).toEqual([{ cyber: "daybreak_blue" }, undefined]);

		sent.length = 0;
		expect((await run("acct-daybreak", [200], true)).stopReason).toBe("stop");
		expect(sent).toEqual([undefined]);
		expect(hookCalls).toBe(3);
		expect(hookAccessPrograms).toEqual([{ cyber: "daybreak_blue" }, undefined, undefined]);
	});

	it.each([
		["rejection", "The requested Cyber access program is not authorized for this workspace.", true],
		["unrelated error", "The requested input is not valid for this model.", false],
	] as const)("uses the message for a type-only invalid_request_error: %s", async (name, message, rejectsProgram) => {
		const accountId = `acct-daybreak-generic-${name}`;
		const genericModel = createCodexModel(`gpt-6-sol-generic-${name}`, {
			preferWebsockets: false,
			accountAccess: { [accountId]: { cyberPrograms: ["standard", "daybreak_blue"] } },
		});
		const sent: unknown[] = [];
		const options = {
			apiKey: createCodexTestToken(accountId),
			fetch: createFetchMock(
				[403, 200],
				sent,
				JSON.stringify({ error: { type: "invalid_request_error", message } }),
			),
		};

		const result = await streamOpenAICodexResponses(genericModel, context, options).result();
		expect(result.stopReason).toBe(rejectsProgram ? "stop" : "error");
		if (!rejectsProgram) expect(result.errorMessage).toContain(message);
		expect(sent).toEqual(rejectsProgram ? [{ cyber: "daybreak_blue" }, undefined] : [{ cyber: "daybreak_blue" }]);

		sent.length = 0;
		expect(
			(
				await streamOpenAICodexResponses(genericModel, context, {
					...options,
					fetch: createFetchMock([200], sent),
				}).result()
			).stopReason,
		).toBe("stop");
		expect(sent).toEqual([rejectsProgram ? undefined : { cyber: "daybreak_blue" }]);
	});

	it.each(["SSE", "HTTP"])("surfaces %s cyber policy errors without replaying or disabling Daybreak", async path => {
		const accountId = `acct-daybreak-cyber-policy-${path}`;
		const policyModel = createCodexModel(`gpt-6-sol-cyber-policy-${path}`, {
			preferWebsockets: false,
			accountAccess: { [accountId]: { cyberPrograms: ["standard", "daybreak_blue"] } },
		});
		const message =
			"This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. Otherwise, confirm that the access_programs.cyber parameter is set to the appropriate tier, and note that some cybersecurity requests are still limited, even when Daybreak is on.";
		const errorSse = `data: ${JSON.stringify({ type: "error", code: "cyber_policy", message })}\n\n`;
		const sent: unknown[] = [];
		const fetch = (async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (!url.endsWith("/responses")) return new Response("not found", { status: 404 });
			sent.push(decodeBody(init?.body).access_programs);
			return new Response(sent.length === 1 ? errorSse : COMPLETED_SSE, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as FetchImpl;
		const options = {
			apiKey: createCodexTestToken(accountId),
			fetch:
				path === "HTTP"
					? createFetchMock(
							[403, 200],
							sent,
							JSON.stringify({ error: { type: "invalid_request_error", code: "cyber_policy", message } }),
						)
					: fetch,
		};

		const failed = await streamOpenAICodexResponses(policyModel, context, options).result();
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toContain(message);
		expect(sent).toEqual([{ cyber: "daybreak_blue" }]);

		expect((await streamOpenAICodexResponses(policyModel, context, options).result()).stopReason).toBe("stop");
		expect(sent).toEqual([{ cyber: "daybreak_blue" }, { cyber: "daybreak_blue" }]);
	});
});
