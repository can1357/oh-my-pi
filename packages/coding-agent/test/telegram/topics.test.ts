import { describe, expect, it } from "bun:test";
import { TelegramApiError } from "../../src/telegram/api";
import { closedTitle, isForumChat, withoutClosedMark } from "../../src/telegram/topics";
import { topicsBench } from "./topics-fixtures";

describe("closed topic names", () => {
	it("marks a closed topic in English, within Telegram's topic-name limit", () => {
		expect(closedTitle("topic")).toBe("topic · closed");
		const name = "n".repeat(200);
		const closed = closedTitle(name);
		expect(closed.length).toBe(128);
		expect(closed.endsWith(" · closed")).toBe(true);
	});

	it("strips the closed mark only from names that carry it", () => {
		expect(withoutClosedMark("topic · closed")).toBe("topic");
		expect(withoutClosedMark("topic")).toBeNull();
	});

	it("treats only negative chat ids as forums", () => {
		expect(isForumChat(-100123)).toBe(true);
		expect(isForumChat(555)).toBe(false);
	});
});

describe("createTopics.notify", () => {
	it("posts markdown through the delivery into the topic", async () => {
		const b = topicsBench(555);
		expect(await b.topics.notify(7, "## Hi\n\n- one")).toBe(true);
		expect(b.sent).toEqual([{ chatId: 555, threadId: 7, markdown: "## Hi\n\n- one" }]);
	});

	it("posts into the general thread and reports nothing sent as false", async () => {
		const b = topicsBench(555, { sent: [] });
		expect(await b.topics.notify(null, "general")).toBe(false);
		expect(b.sent).toEqual([{ chatId: 555, markdown: "general" }]);
	});
});

describe("createTopics.create", () => {
	it("resolves the thread id Telegram assigned", async () => {
		const b = topicsBench(555, { threadId: 42 });
		expect(await b.topics.create("session")).toBe(42);
		expect(b.of("createForumTopic")[0].fields).toEqual({ chatId: 555, name: "session" });
	});

	it("resolves null when Telegram named no thread, and throws on a refusal", async () => {
		const empty = topicsBench(555, { createForumTopic: () => ({}) });
		expect(await empty.topics.create("session")).toBeNull();

		const refused = topicsBench(555, {
			createForumTopic: new TelegramApiError("createForumTopic", { code: 400, description: "Bad Request" }),
		});
		await expect(refused.topics.create("session")).rejects.toBeInstanceOf(TelegramApiError);
	});
});

describe("createTopics.close", () => {
	it("closes a forum topic with the forum call and does not rename it", async () => {
		const b = topicsBench(-100);
		expect(await b.topics.close(7, "topic")).toBe(true);
		expect(b.of("closeForumTopic")[0].fields).toEqual({ chatId: -100, threadId: 7 });
		expect(b.of("editForumTopic")).toEqual([]);
	});

	it("falls back to the closed title when the forum close is refused", async () => {
		const b = topicsBench(-100, {
			closeForumTopic: new TelegramApiError("closeForumTopic", { code: 400, description: "Bad Request" }),
		});
		expect(await b.topics.close(7, "topic")).toBe(true);
		expect(b.of("editForumTopic")[0].fields).toEqual({ chatId: -100, threadId: 7, name: "topic · closed" });
	});

	it("renames a private chat's topic to the closed title and reports a refused rename", async () => {
		const b = topicsBench(555);
		expect(await b.topics.close(7, "topic")).toBe(true);
		expect(b.of("closeForumTopic")).toEqual([]);
		expect(b.of("editForumTopic")[0].fields).toEqual({ chatId: 555, threadId: 7, name: "topic · closed" });

		const refused = topicsBench(555, {
			editForumTopic: new TelegramApiError("editForumTopic", { code: 400, description: "Bad Request" }),
		});
		expect(await refused.topics.close(7, "topic")).toBe(false);
	});
});

describe("createTopics.reopen", () => {
	it("reopens a forum topic and restores its name", async () => {
		const b = topicsBench(-100);
		expect(await b.topics.reopen(7, "topic")).toBe(true);
		expect(b.of("reopenForumTopic")[0].fields).toEqual({ chatId: -100, threadId: 7 });
		expect(b.of("editForumTopic")[0].fields).toEqual({ chatId: -100, threadId: 7, name: "topic" });
	});

	it("only restores the name in a private chat", async () => {
		const b = topicsBench(555);
		expect(await b.topics.reopen(7, "topic")).toBe(true);
		expect(b.of("reopenForumTopic")).toEqual([]);
		expect(b.of("editForumTopic")[0].fields).toEqual({ chatId: 555, threadId: 7, name: "topic" });
	});
});

describe("createTopics.rename", () => {
	it("renames the topic and reports a refusal to the caller", async () => {
		const b = topicsBench(555);
		await b.topics.rename(7, "new name");
		expect(b.of("editForumTopic")[0].fields).toEqual({ chatId: 555, threadId: 7, name: "new name" });

		const refused = topicsBench(555, {
			editForumTopic: new TelegramApiError("editForumTopic", { code: 400, description: "Bad Request" }),
		});
		await expect(refused.topics.rename(7, "new name")).rejects.toBeInstanceOf(TelegramApiError);
	});
});
