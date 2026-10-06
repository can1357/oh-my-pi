/**
 * Contract: the ⚡ topic icon. It is resolved from Telegram's topic-icon
 * stickers once, applies to private chats only, and the first refusal disables
 * the icon permanently so a chat without rights never pays a failing call per
 * turn.
 */
import { describe, expect, it } from "bun:test";
import { createTurnIcon } from "@oh-my-pi/pi-coding-agent/telegram/turn-icon";
import type { TelegramSticker } from "@oh-my-pi/pi-coding-agent/telegram/types";
import { fakeApi } from "./slice-d-fakes";

const LIST: TelegramSticker[] = [
	{ file_id: "f1", emoji: "🙂", custom_emoji_id: "icon-smile" },
	{ file_id: "f2", emoji: "⚡️", custom_emoji_id: "icon-bolt" },
];

function iconApi(options: { list?: TelegramSticker[]; fail?: boolean } = {}) {
	const api = fakeApi();
	const list = options.list ?? LIST;
	api.getForumTopicIconStickers = async () => {
		api.calls.push({ method: "getForumTopicIconStickers", fields: {} });
		return list;
	};
	if (options.fail === true) {
		api.editForumTopic = async fields => {
			api.calls.push({ method: "editForumTopic", fields: fields as unknown as Record<string, unknown> });
			throw new Error("Bad Request: not enough rights");
		};
	}
	const setIds = () => api.of("editForumTopic").map(call => call.fields.iconCustomEmojiId);
	return { api, setIds };
}

describe("turn icon", () => {
	it("sets the ⚡ sticker and clears it with an empty id", async () => {
		const { api, setIds } = iconApi();
		const icon = createTurnIcon({ api, chatId: 555 });
		expect(await icon.set(7, true)).toBe(true);
		expect(await icon.set(7, false)).toBe(true);
		expect(setIds()).toEqual(["icon-bolt", ""]);
	});

	it("caches the sticker id instead of the list", async () => {
		const { api, setIds } = iconApi();
		const icon = createTurnIcon({ api, chatId: 555 });
		await icon.set(7, true);
		await icon.set(7, false);
		await icon.set(7, true);
		await icon.set(7, false);
		expect(setIds()).toEqual(["icon-bolt", "", "icon-bolt", ""]);
		expect(api.of("getForumTopicIconStickers")).toHaveLength(1);
	});

	it("finds ⚡ even when the sticker carries the variation selector", async () => {
		const { api, setIds } = iconApi();
		const icon = createTurnIcon({ api, chatId: 555 });
		expect(await icon.set(7, true)).toBe(true);
		expect(setIds()).toEqual(["icon-bolt"]);
	});

	it("leaves a group topic alone", async () => {
		const { api } = iconApi();
		const icon = createTurnIcon({ api, chatId: -100_500 });
		expect(await icon.set(7, true)).toBe(false);
		expect(api.of("editForumTopic")).toHaveLength(0);
	});

	it("disables itself after the first refusal", async () => {
		const { api } = iconApi({ fail: true });
		const icon = createTurnIcon({ api, chatId: 555 });
		expect(await icon.set(7, true)).toBe(false);
		expect(await icon.set(7, false)).toBe(false);
		expect(api.of("editForumTopic")).toHaveLength(1);
	});

	it("does not touch the topic when the ⚡ sticker is missing", async () => {
		const { api } = iconApi({ list: [{ file_id: "f1", emoji: "🙂", custom_emoji_id: "icon-smile" }] });
		const icon = createTurnIcon({ api, chatId: 555 });
		expect(await icon.set(7, true)).toBe(false);
		expect(api.of("editForumTopic")).toHaveLength(0);
	});

	it("keeps each chat's cache separate", async () => {
		const first = iconApi();
		const second = iconApi();
		const one = createTurnIcon({ api: first.api, chatId: 555 });
		const two = createTurnIcon({ api: second.api, chatId: 777 });
		await one.set(7, true);
		await two.set(8, true);
		expect(first.api.of("getForumTopicIconStickers")).toHaveLength(1);
		expect(second.api.of("getForumTopicIconStickers")).toHaveLength(1);
	});
});
