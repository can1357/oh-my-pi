import { describe, expect, it } from "bun:test";
import { TelegramApiError, TelegramBotApi, botIdOf, redactToken } from "../../src/telegram/api";

const TOKEN = "123456:TEST";
const BASE = "https://tg.test";

interface RecordedCall {
	url: string;
	init: { body?: unknown; method?: string; signal?: AbortSignal | null };
}

function bench(answers: Array<Response | Error | (() => Response | Error)>, options: { attempts?: number } = {}) {
	const calls: RecordedCall[] = [];
	const slept: number[] = [];
	const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(input), init: init ?? {} });
		const entry = answers[Math.min(calls.length - 1, answers.length - 1)];
		const answer = typeof entry === "function" ? entry() : entry;
		if (answer instanceof Error) throw answer;
		return answer;
	};
	const api = new TelegramBotApi({
		token: TOKEN,
		fetch: fetchImpl as unknown as typeof fetch,
		baseUrl: BASE,
		sleep: async (ms: number) => {
			slept.push(ms);
		},
		...options,
	});
	return { calls, slept, api };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
	new Response(JSON.stringify(body), { status: 200, ...init });
const wire = (call: RecordedCall): unknown => JSON.parse(String(call.init.body ?? "null"));
const capture = async (promise: Promise<unknown>): Promise<unknown> =>
	promise.then(
		() => {
			throw new Error("expected the call to fail");
		},
		(error: unknown) => error,
	);

describe("TelegramBotApi", () => {
	it("converts camelCase parameters to the wire's snake_case, nested objects included", async () => {
		const b = bench([json({ ok: true, result: { message_id: 10 } })]);
		const result = await b.api.sendMessage({
			chatId: -100500,
			threadId: 12,
			text: "hello",
			parseMode: "HTML",
			replyTo: 9,
			replyMarkup: { inlineKeyboard: [[{ text: "ok", callbackData: "ui:1" }]] },
		});
		expect(result.message_id).toBe(10);
		expect(b.calls[0].url).toBe(`${BASE}/bot${TOKEN}/sendMessage`);
		expect(b.calls[0].init.method).toBe("POST");
		expect(wire(b.calls[0])).toEqual({
			chat_id: -100500,
			message_thread_id: 12,
			text: "hello",
			parse_mode: "HTML",
			reply_to_message_id: 9,
			reply_markup: { inline_keyboard: [[{ text: "ok", callback_data: "ui:1" }]] },
		});
	});

	it("drops undefined parameters and sends offset, timeout and allowed updates", async () => {
		const b = bench([json({ ok: true, result: [] })]);
		const controller = new AbortController();
		expect(
			await b.api.getUpdates({ offset: 5, timeout: 30, allowedUpdates: ["message"] }, controller.signal),
		).toEqual([]);
		expect(wire(b.calls[0])).toEqual({ offset: 5, timeout: 30, allowed_updates: ["message"] });
		expect(b.calls[0].url.endsWith("/getUpdates")).toBe(true);
	});

	it("forwards the caller's cancellation into the in-flight request", async () => {
		let requestSignal: AbortSignal | null | undefined;
		const fetchImpl = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestSignal = init?.signal;
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			return promise;
		};
		const api = new TelegramBotApi({ token: TOKEN, fetch: fetchImpl as unknown as typeof fetch, baseUrl: BASE });
		const stop = new AbortController();
		const pending = capture(api.getUpdates({ offset: 0, timeout: 30 }, stop.signal));
		stop.abort();
		expect(((await pending) as Error).name).toBe("AbortError");
		expect(requestSignal?.aborted).toBe(true);
	});

	it("turns a Telegram refusal into TelegramApiError without leaking the token", async () => {
		const b = bench([json({ ok: false, error_code: 401, description: `Unauthorized: token ${TOKEN} revoked` })]);
		const error = (await capture(b.api.getMe())) as TelegramApiError;
		expect(error).toBeInstanceOf(TelegramApiError);
		expect(error.method).toBe("getMe");
		expect(error.code).toBe(401);
		expect(error.retryAfter).toBeNull();
		expect(error.message).not.toContain(TOKEN);
		expect(error.message).toContain("***");
	});

	it("retries a 429 after the retry_after it states", async () => {
		const b = bench([
			json(
				{ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 2 } },
				{ status: 429 },
			),
			json({ ok: true, result: { message_id: 11 } }),
		]);
		expect((await b.api.sendMessage({ chatId: 1, text: "x" })).message_id).toBe(11);
		expect(b.slept).toEqual([2000]);
		expect(b.calls.length).toBe(2);
	});

	it("gives up past the attempt budget, reporting retry_after", async () => {
		const b = bench(
			[
				() =>
					json(
						{ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 5 } },
						{ status: 429 },
					),
			],
			{ attempts: 2 },
		);
		const error = (await capture(b.api.getMe())) as TelegramApiError;
		expect(error.code).toBe(429);
		expect(error.retryAfter).toBe(5);
		expect(b.calls.length).toBe(2);
		expect(b.slept).toEqual([5000]);
	});

	it("reads Retry-After from the header when the body states nothing", async () => {
		const b = bench([json({}, { status: 429, headers: { "retry-after": "3" } }), json({ ok: true, result: true })]);
		expect(await b.api.setMyCommands([])).toBe(true);
		expect(b.slept).toEqual([3000]);
	});

	it("downloads a file through getFile and the file endpoint", async () => {
		const b = bench([
			json({ ok: true, result: { file_path: "voice/1.oga" } }),
			new Response(new Uint8Array([1, 2, 3])),
		]);
		const result = await b.api.downloadFile("file-1");
		expect([...result]).toEqual([1, 2, 3]);
		expect(wire(b.calls[0])).toEqual({ file_id: "file-1" });
		expect(b.calls[1].url).toBe(`${BASE}/file/bot${TOKEN}/voice/1.oga`);
	});

	it("refuses a download Telegram did not name, and a refused download", async () => {
		const withoutPath = (await capture(
			bench([json({ ok: true, result: {} })]).api.downloadFile("file-1"),
		)) as TelegramApiError;
		expect(withoutPath).toBeInstanceOf(TelegramApiError);
		expect(withoutPath.message).not.toContain(TOKEN);

		const refused = (await capture(
			bench([
				json({ ok: true, result: { file_path: "voice/1.oga" } }),
				new Response("gone", { status: 404 }),
			]).api.downloadFile("file-1"),
		)) as TelegramApiError;
		expect(refused.code).toBe(404);
		expect(refused.method).toBe("downloadFile");
	});

	it("names a network failure and a non-JSON answer without the token", async () => {
		const network = (await capture(
			bench([new Error(`connect to ${BASE}/bot${TOKEN}/getMe failed`)]).api.getMe(),
		)) as TelegramApiError;
		expect(network.message).not.toContain(TOKEN);
		expect(network.message).toContain("***");

		const broken = (await capture(bench([new Response("<html>", { status: 502 })]).api.getMe())) as TelegramApiError;
		expect(broken.code).toBe(502);
		expect(broken.method).toBe("getMe");
	});

	it("lets an AbortError through untouched", async () => {
		const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
		const error = (await capture(bench([aborted]).api.getMe(new AbortController().signal))) as Error;
		expect(error.name).toBe("AbortError");
	});

	it("calls every method Telegram expects with the fields it reads", async () => {
		const surface: Array<[string, (api: TelegramBotApi) => Promise<unknown>, string, unknown]> = [
			["getMe", api => api.getMe(), "getMe", {}],
			["getChat", api => api.getChat({ chatId: 1 }), "getChat", { chat_id: 1 }],
			[
				"editMessageText",
				api => api.editMessageText({ chatId: 1, messageId: 4, text: "x" }),
				"editMessageText",
				{ chat_id: 1, message_id: 4, text: "x" },
			],
			[
				"editMessageReplyMarkup",
				api => api.editMessageReplyMarkup({ chatId: 1, messageId: 4, replyMarkup: { inlineKeyboard: [] } }),
				"editMessageReplyMarkup",
				{ chat_id: 1, message_id: 4, reply_markup: { inline_keyboard: [] } },
			],
			[
				"sendRichMessage",
				api =>
					api.sendRichMessage({
						chatId: 1,
						threadId: 2,
						richMessage: { markdown: "# Result" },
						replyMarkup: { inlineKeyboard: [[{ text: "⏹ Stop", callbackData: "turn:stop" }]] },
					}),
				"sendRichMessage",
				{
					chat_id: 1,
					message_thread_id: 2,
					rich_message: { markdown: "# Result" },
					reply_markup: { inline_keyboard: [[{ text: "⏹ Stop", callback_data: "turn:stop" }]] },
				},
			],
			[
				"sendRichMessageDraft",
				api =>
					api.sendRichMessageDraft({
						chatId: 1,
						threadId: 2,
						draftId: 3,
						richMessage: { markdown: "…" },
						canStop: true,
					}),
				"sendRichMessageDraft",
				{ chat_id: 1, message_thread_id: 2, draft_id: 3, rich_message: { markdown: "…" }, can_stop: true },
			],
			[
				"setMessageReaction",
				api => api.setMessageReaction({ chatId: 1, messageId: 5, reaction: [{ type: "emoji", emoji: "👀" }] }),
				"setMessageReaction",
				{ chat_id: 1, message_id: 5, reaction: [{ type: "emoji", emoji: "👀" }] },
			],
			["getForumTopicIconStickers", api => api.getForumTopicIconStickers(), "getForumTopicIconStickers", {}],
			[
				"editForumTopic without a name",
				api => api.editForumTopic({ chatId: 1, threadId: 2, iconCustomEmojiId: "" }),
				"editForumTopic",
				{ chat_id: 1, message_thread_id: 2, icon_custom_emoji_id: "" },
			],
			[
				"createForumTopic",
				api => api.createForumTopic({ chatId: 1, name: "LFS-1" }),
				"createForumTopic",
				{ chat_id: 1, name: "LFS-1" },
			],
			[
				"editForumTopic",
				api => api.editForumTopic({ chatId: 1, threadId: 2, name: "LFS-2" }),
				"editForumTopic",
				{ chat_id: 1, message_thread_id: 2, name: "LFS-2" },
			],
			[
				"closeForumTopic",
				api => api.closeForumTopic({ chatId: 1, threadId: 2 }),
				"closeForumTopic",
				{ chat_id: 1, message_thread_id: 2 },
			],
			[
				"reopenForumTopic",
				api => api.reopenForumTopic({ chatId: 1, threadId: 2 }),
				"reopenForumTopic",
				{ chat_id: 1, message_thread_id: 2 },
			],
			[
				"answerCallbackQuery",
				api => api.answerCallbackQuery({ id: "cb-1", text: "ok" }),
				"answerCallbackQuery",
				{ callback_query_id: "cb-1", text: "ok" },
			],
			[
				"sendChatAction",
				api => api.sendChatAction({ chatId: 1, threadId: 2, action: "typing" }),
				"sendChatAction",
				{ chat_id: 1, message_thread_id: 2, action: "typing" },
			],
			[
				"setMyCommands",
				api => api.setMyCommands([{ command: "new", description: "new session" }]),
				"setMyCommands",
				{ commands: [{ command: "new", description: "new session" }] },
			],
		];
		for (const [name, run, method, expected] of surface) {
			const b = bench([json({ ok: true, result: true })]);
			await run(b.api);
			expect(b.calls[0].url, name).toBe(`${BASE}/bot${TOKEN}/${method}`);
			expect(wire(b.calls[0]), name).toEqual(expected);
			expect(b.calls.length, name).toBe(1);
		}
	});
});

describe("redactToken", () => {
	it("hides the token raw and percent-encoded, and leaves other text alone", () => {
		expect(redactToken(`x ${TOKEN} y`, TOKEN)).toBe("x *** y");
		expect(redactToken(encodeURIComponent(TOKEN), TOKEN)).toBe("***");
		expect(redactToken("nothing to hide", "")).toBe("nothing to hide");
	});
});

describe("botIdOf", () => {
	it("reads the numeric prefix of a token and refuses tokens without one", () => {
		expect(botIdOf("123456:ABC-DEF")).toBe("123456");
		expect(botIdOf("not-a-token")).toBeNull();
		expect(botIdOf("")).toBeNull();
	});
});
