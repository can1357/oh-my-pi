import { describe, expect, it } from "bun:test";
import { TelegramApiError } from "../../src/telegram/api";
import { renderAssistantText } from "../../src/telegram/markdown";
import { RICH_TEXT_LIMIT } from "../../src/telegram/rich";
import { MARKUP, bench, longText, refused } from "./deliver-fixtures";

describe("createDelivery.send", () => {
	it("sends rich messages and puts the keyboard on the last chunk", async () => {
		const b = bench();
		const ids = await b.delivery.send({ chatId: 1, threadId: 7, markdown: longText(), replyMarkup: MARKUP });
		const rich = b.of("sendRichMessage");
		expect(rich.length).toBeGreaterThanOrEqual(2);
		expect(ids).toEqual(rich.map((_call, index) => 101 + index));
		expect(rich[0].fields.replyMarkup).toBeUndefined();
		expect(rich.at(-1)?.fields.replyMarkup).toBe(MARKUP);
		expect(rich[0].fields.message_thread_id).toBeUndefined();
		expect(rich[0].fields.threadId).toBe(7);
		expect(b.of("sendMessage").length).toBe(0);
		for (const call of rich) expect(typeof (call.fields.richMessage as { markdown: string }).markdown).toBe("string");
	});

	it("sends nothing for an empty answer", async () => {
		const b = bench();
		expect(await b.delivery.send({ chatId: 1, threadId: 7, markdown: "  \n" })).toEqual([]);
		expect(b.calls).toEqual([]);
	});
});

describe("createDelivery.edit", () => {
	it("edits in place, clipping a text too long for one rich message", async () => {
		const b = bench();
		expect(await b.delivery.edit({ chatId: 1, messageId: 5, markdown: "# Card", replyMarkup: MARKUP })).toBe(true);
		expect(b.of("editMessageText")[0].fields).toEqual({
			chatId: 1,
			messageId: 5,
			richMessage: { markdown: "# Card" },
			replyMarkup: MARKUP,
		});
		await b.delivery.edit({ chatId: 1, messageId: 5, markdown: "z".repeat(RICH_TEXT_LIMIT + 500) });
		const clipped = (b.of("editMessageText").at(-1)!.fields.richMessage as { markdown: string }).markdown;
		expect(clipped.length).toBe(RICH_TEXT_LIMIT);
		expect(clipped.endsWith("…")).toBe(true);
	});

	it("falls back to HTML when the rich edit is refused", async () => {
		const fallback = bench({
			editMessageText: (fields: { richMessage?: unknown; messageId: number }) => {
				if (fields.richMessage !== undefined) throw refused("editMessageText");
				return { message_id: fields.messageId };
			},
		});
		expect(await fallback.delivery.edit({ chatId: 1, messageId: 5, markdown: "# Card" })).toBe(true);
		expect(fallback.of("editMessageText").at(-1)?.fields.parseMode).toBe("HTML");
	});

	it("treats `message is not modified` as success instead of falling back", async () => {
		const b = bench({
			editMessageText: new TelegramApiError("editMessageText", {
				code: 400,
				description: "Bad Request: message is not modified",
			}),
		});
		expect(await b.delivery.edit({ chatId: 1, messageId: 5, markdown: "text" })).toBe(true);
		expect(b.of("editMessageText").length).toBe(1);
	});

	it("clips without a topic instead of continuing as new messages", async () => {
		const b = bench();
		await b.delivery.edit({ chatId: 1, messageId: 5, markdown: "z".repeat(RICH_TEXT_LIMIT + 100) });
		const edited = (b.of("editMessageText").at(-1)!.fields.richMessage as { markdown: string }).markdown;
		expect(edited.length).toBe(RICH_TEXT_LIMIT);
		expect(edited.endsWith("…")).toBe(true);
		expect(b.of("sendMessage")).toEqual([]);
	});
});

describe("createDelivery continuation maintenance", () => {
	it("posts each continuation of a growing answer once and edits it in place afterwards", async () => {
		const b = bench({ withoutRich: true });
		// The stream's group-chat path: a send places the head, later ticks grow the answer.
		const sent = await b.delivery.send({ chatId: 1, threadId: 7, markdown: "z".repeat(9000) });
		expect(b.of("sendMessage").length).toBe(renderAssistantText("z".repeat(9000)).length);
		for (const length of [9500, 12000, 12000]) {
			const edited = await b.delivery.edit({
				chatId: 1,
				threadId: 7,
				messageId: sent[0]!,
				markdown: "z".repeat(length),
			});
			expect(edited).toBe(true);
		}
		const chunks = renderAssistantText("z".repeat(12000));
		const posted = b.of("sendMessage");
		expect(posted.length).toBe(chunks.length);
		const tail = posted.slice(1).map(call => call.messageId);
		const lastEdit = b.of("editMessageText").slice(-chunks.length);
		expect(lastEdit.map(call => call.fields.messageId)).toEqual([sent[0], ...tail]);
		expect(lastEdit.map(call => String(call.fields.text)).join("")).toBe("z".repeat(12000));
	});

	it("blanks continuations the answer no longer reaches and refills them when it grows again", async () => {
		const b = bench({ withoutRich: true });
		const full = "z".repeat(12000);
		const sent = await b.delivery.send({ chatId: 1, threadId: 7, markdown: full });
		const chunks = renderAssistantText(full);
		const tail = b
			.of("sendMessage")
			.slice(1)
			.map(call => call.messageId);
		expect(tail).toHaveLength(chunks.length - 1);

		await b.delivery.edit({ chatId: 1, threadId: 7, messageId: sent[0]!, markdown: "z".repeat(5000) });
		// The chunks the shorter answer no longer reaches are blanked, never left showing the old revision.
		const blanked = b.of("editMessageText").filter(call => call.fields.text === "…");
		expect(blanked.map(call => call.fields.messageId)).toEqual(tail.slice(1));
		expect(b.of("sendMessage").length).toBe(chunks.length);

		await b.delivery.edit({ chatId: 1, threadId: 7, messageId: sent[0]!, markdown: full });
		expect(b.of("sendMessage").length).toBe(chunks.length);
		const refilled = b.of("editMessageText").slice(-chunks.length);
		expect(refilled.map(call => call.fields.messageId)).toEqual([sent[0], ...tail]);
		expect(refilled.map(call => String(call.fields.text)).join("")).toBe(full);
	});

	it("keys continuations by chat as well as message id", async () => {
		const b = bench({ withoutRich: true });
		const sent = await b.delivery.send({ chatId: 1, threadId: 7, markdown: "z".repeat(12000) });
		const posted = b.of("sendMessage").length;
		// Message ids are per chat: the same id in another chat is a different message with its own overflow.
		await b.delivery.edit({ chatId: 2, threadId: 8, messageId: sent[0]!, markdown: "z".repeat(12000) });
		expect(b.of("sendMessage").length).toBe(posted + renderAssistantText("z".repeat(12000)).length - 1);
		expect(b.of("editMessageText").map(call => call.fields.messageId)).toEqual([sent[0]]);
	});
});

describe("createDelivery.draft", () => {
	it("refuses drafts in a group chat and when rich is unavailable", async () => {
		const b = bench();
		expect(
			await b.delivery.draft({ chatId: -555, threadId: 7, draftId: 1, markdown: "text", thinking: "thinking" }),
		).toBe(false);
		expect(b.calls).toEqual([]);

		const absent = bench({ withoutRich: true });
		expect(await absent.delivery.draft({ chatId: 1, threadId: 7, draftId: 1, markdown: "text" })).toBe(false);
		expect(absent.calls).toEqual([]);
	});

	it("sends a private-chat draft with the thinking block and the stop button", async () => {
		const b = bench();
		expect(
			await b.delivery.draft({
				chatId: 1,
				threadId: 7,
				draftId: 4,
				markdown: "# Result",
				thinking: "thinking",
				canStop: true,
			}),
		).toBe(true);
		const [sent] = b.of("sendRichMessageDraft");
		expect(sent.fields.richMessage).toEqual({ markdown: "<tg-thinking>thinking</tg-thinking>\n# Result" });
		expect(sent.fields.canStop).toBe(true);
		expect(sent.fields.draftId).toBe(4);
		expect(sent.fields.threadId).toBe(7);
	});

	it("finds the accepted draft shape and remembers it", async () => {
		let refusedMarkdown = true;
		const b = bench({
			sendRichMessageDraft: (fields: { richMessage: Record<string, unknown> }) => {
				if (refusedMarkdown && fields.richMessage.markdown !== undefined) {
					refusedMarkdown = false;
					throw refused("sendRichMessageDraft");
				}
				return true;
			},
		});
		expect(
			await b.delivery.draft({ chatId: 1, threadId: 7, draftId: 1, markdown: "text", thinking: "thinking" }),
		).toBe(true);
		const shapes = b
			.of("sendRichMessageDraft")
			.map(call => Object.keys(call.fields.richMessage as Record<string, unknown>)[0]);
		expect(shapes).toEqual(["markdown", "html"]);
		await b.delivery.draft({ chatId: 1, threadId: 7, draftId: 2, markdown: "text", thinking: "thinking" });
		expect((b.of("sendRichMessageDraft").at(-1)!.fields.richMessage as { html: string }).html).toBe(
			"<tg-thinking>thinking</tg-thinking>text",
		);
	});
});
