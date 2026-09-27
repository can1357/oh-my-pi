/**
 * Pairing: the code binds one chat and one user to the bot, a wrong code is
 * ignored, a chat that cannot host topics is refused with the fix, and the
 * poll times out or cancels. lifeos had no pairing flow; this is new behaviour.
 */
import { describe, expect, it } from "bun:test";
import { classifyPairingUpdate, startTelegramPairing } from "@oh-my-pi/pi-coding-agent/telegram/pairing";
import type { TelegramApi, TelegramChat, TelegramUpdate, TelegramUser } from "@oh-my-pi/pi-coding-agent/telegram/types";

const CODE = "a1b2c3d4";
const BOT: TelegramUser = { id: 1, first_name: "bridge", username: "omp_bridge", has_topics_enabled: true };

function chat(overrides: Partial<TelegramChat> = {}): TelegramChat {
	return { id: -100500, type: "supergroup", title: "Team", is_forum: true, ...overrides };
}

function message(
	updateId: number,
	text: string,
	chatOverrides: Partial<TelegramChat> = {},
	from?: TelegramUser,
): TelegramUpdate {
	return {
		update_id: updateId,
		message: {
			message_id: updateId,
			date: 1_700_000_000,
			chat: chat(chatOverrides),
			from: from ?? { id: 7, first_name: "Dev", username: "dev" },
			text,
		},
	};
}

function api(overrides: Partial<TelegramApi> = {}): TelegramApi {
	return {
		getMe: async () => BOT,
		getUpdates: async () => [],
		...overrides,
	} as unknown as TelegramApi;
}

describe("pairing decision", () => {
	it("binds the chat and sender of a matching /pair message", () => {
		expect(classifyPairingUpdate(message(1, `/pair ${CODE}`), CODE, BOT)).toEqual({
			kind: "paired",
			chatId: -100500,
			userId: 7,
			chatTitle: "Team",
		});
	});

	it("accepts the /start deep-link form and a command addressed to the bot", () => {
		expect(classifyPairingUpdate(message(1, `/start ${CODE}`), CODE, BOT)).not.toBeNull();
		expect(classifyPairingUpdate(message(2, `/pair@omp_bridge ${CODE}`), CODE, BOT)).not.toBeNull();
	});

	it("ignores a wrong code, other commands, and bots", () => {
		expect(classifyPairingUpdate(message(1, "/pair deadbeef"), CODE, BOT)).toBeNull();
		expect(classifyPairingUpdate(message(2, CODE), CODE, BOT)).toBeNull();
		expect(
			classifyPairingUpdate(message(3, `/pair ${CODE}`, {}, { id: 9, first_name: "Bot", is_bot: true }), CODE, BOT),
		).toBeNull();
		expect(classifyPairingUpdate({ update_id: 4 }, CODE, BOT)).toBeNull();
	});

	it("refuses a private chat without Threaded Mode and a non-forum group", () => {
		const noTopics = classifyPairingUpdate(
			message(1, `/pair ${CODE}`, { type: "private", is_forum: undefined }),
			CODE,
			{
				...BOT,
				has_topics_enabled: false,
			},
		);
		expect(noTopics?.kind).toBe("refused");
		if (noTopics?.kind === "refused") expect(noTopics.message).toContain("Threaded Mode");

		const notForum = classifyPairingUpdate(
			message(2, `/pair ${CODE}`, { type: "supergroup", is_forum: false }),
			CODE,
			BOT,
		);
		expect(notForum?.kind).toBe("refused");
		if (notForum?.kind === "refused") expect(notForum.message).toContain("Topics");

		const channel = classifyPairingUpdate(
			message(3, `/pair ${CODE}`, { type: "channel", is_forum: undefined }),
			CODE,
			BOT,
		);
		expect(channel?.kind).toBe("refused");
	});

	it("accepts a private chat whose bot has topics enabled", () => {
		expect(
			classifyPairingUpdate(message(1, `/pair ${CODE}`, { type: "private", is_forum: undefined }), CODE, BOT),
		).toEqual({ kind: "paired", chatId: -100500, userId: 7, chatTitle: "Team" });
	});
});

describe("pairing poll", () => {
	it("reports the bot identity and pairs on the first matching message", async () => {
		const ready: (string | null)[] = [];
		const run = startTelegramPairing({
			api: api({ getUpdates: async () => [message(1, `/pair ${CODE}`)] }),
			code: CODE,
			onReady: info => ready.push(info.botUsername),
		});
		expect(await run.outcome).toEqual({ kind: "paired", chatId: -100500, userId: 7, chatTitle: "Team" });
		expect(ready).toEqual(["omp_bridge"]);
	});

	it("skips a wrong code and pairs on the next update", async () => {
		const batches = [[message(1, "/pair deadbeef")], [message(2, `/pair ${CODE}`)]];
		const run = startTelegramPairing({
			api: api({ getUpdates: async () => batches.shift() ?? [] }),
			code: CODE,
		});
		expect((await run.outcome).kind).toBe("paired");
	});

	it("confirms the pairing message so the bridge's poller never receives it again", async () => {
		// Telegram keeps an update until a later getUpdates passes an offset beyond it.
		let pending = [message(5, `/pair ${CODE}`)];
		const server = api({
			getUpdates: async params => {
				const offset = params.offset ?? 0;
				pending = pending.filter(update => update.update_id >= offset);
				return pending;
			},
		});
		const run = startTelegramPairing({ api: server, code: CODE });
		expect((await run.outcome).kind).toBe("paired");
		expect(await server.getUpdates({})).toEqual([]);
	});

	it("times out without a matching message", async () => {
		const run = startTelegramPairing({ api: api(), code: CODE, timeoutMs: 0 });
		expect(await run.outcome).toEqual({ kind: "timeout" });
	});

	it("cancels an in-flight poll", async () => {
		const run = startTelegramPairing({ api: api(), code: CODE });
		run.cancel();
		expect(await run.outcome).toEqual({ kind: "cancelled" });
	});

	it("refuses when Telegram cannot be reached", async () => {
		const run = startTelegramPairing({
			api: api({
				getMe: async () => {
					throw new Error("401 Unauthorized");
				},
			}),
			code: CODE,
		});
		const outcome = await run.outcome;
		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused") expect(outcome.message).toContain("401");
	});
});
