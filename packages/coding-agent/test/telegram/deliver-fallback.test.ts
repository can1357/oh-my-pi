import { describe, expect, it } from "bun:test";
import { richMarkdown } from "../../src/telegram/rich";
import { MARKUP, bench, limited, longText, missing, refused } from "./deliver-fixtures";

describe("delivery ladder", () => {
	it("carries the same markdown from rich to HTML, then to plain text", async () => {
		const html = bench({ sendRichMessage: refused("sendRichMessage") });
		await html.delivery.send({ chatId: 1, threadId: 7, markdown: "# Result\n\ntext", replyMarkup: MARKUP });
		expect(html.of("sendRichMessage").length).toBe(1);
		expect(html.of("sendMessage").map(call => call.fields.parseMode)).toEqual(["HTML"]);
		expect(html.of("sendMessage")[0].fields.replyMarkup).toBe(MARKUP);

		const plain = bench({
			sendRichMessage: refused("sendRichMessage"),
			sendMessage: (fields: { parseMode?: unknown }) => {
				if (fields.parseMode === "HTML") throw refused("sendMessage");
				return { message_id: 300 };
			},
		});
		const ids = await plain.delivery.send({ chatId: 1, threadId: 7, markdown: "# Result\n\ntext" });
		expect(plain.of("sendMessage").at(-1)?.fields.text).toBe("Result\ntext");
		expect(plain.of("sendMessage").at(-1)?.fields.parseMode).toBeUndefined();
		expect(ids).toEqual([300]);
	});

	it("disables rich for good when Telegram does not know the method", async () => {
		const gone = bench({ sendRichMessage: missing("sendRichMessage") });
		await gone.delivery.send({ chatId: 1, threadId: 7, markdown: "one" });
		await gone.delivery.send({ chatId: 1, threadId: 7, markdown: "two" });
		expect(gone.of("sendRichMessage").length).toBe(1);
		expect(gone.of("sendMessage").length).toBe(2);

		const absent = bench({ withoutRich: true });
		await absent.delivery.send({ chatId: 1, threadId: 7, markdown: "one" });
		expect(absent.of("sendRichMessage")).toEqual([]);
		expect(absent.of("sendMessage").length).toBe(1);
	});

	it("rolls back only the message Telegram refused, not the next one", async () => {
		let first = true;
		const b = bench({
			sendRichMessage: () => {
				if (!first) return { message_id: 900 };
				first = false;
				throw refused("sendRichMessage");
			},
		});
		await b.delivery.send({ chatId: 1, threadId: 7, markdown: "one" });
		await b.delivery.send({ chatId: 1, threadId: 7, markdown: "two" });
		expect(b.of("sendRichMessage").length).toBe(2);
		expect(b.of("sendMessage").length).toBe(1);
	});

	it("keeps the rich flag per delivery", async () => {
		const gone = bench({ sendRichMessage: missing("sendRichMessage") });
		const alive = bench();
		await gone.delivery.send({ chatId: 1, threadId: 7, markdown: "one" });
		await gone.delivery.send({ chatId: 1, threadId: 7, markdown: "two" });
		await alive.delivery.send({ chatId: 1, threadId: 7, markdown: "one" });
		expect(gone.of("sendRichMessage").length).toBe(1);
		expect(alive.of("sendRichMessage").length).toBe(1);
		expect(alive.of("sendMessage")).toEqual([]);
	});

	it("stops on a 429 of the second chunk, returning the first id without duplicating it", async () => {
		const b = bench({
			sendRichMessage: (
				(calls = 0) =>
				() => {
					calls += 1;
					if (calls === 2) throw limited("sendRichMessage");
					return { message_id: 500 + calls };
				}
			)(),
		});
		const ids = await b.delivery.send({ chatId: 1, threadId: 7, markdown: longText() });
		expect(ids).toEqual([501]);
		expect(b.of("sendRichMessage").length).toBe(2);
		expect(b.of("sendMessage")).toEqual([]);
	});

	it("survives a 429 on every rung without throwing", async () => {
		const b = bench({
			sendRichMessage: limited("sendRichMessage"),
			sendMessage: limited("sendMessage"),
			editMessageText: limited("editMessageText"),
			sendRichMessageDraft: limited("sendRichMessageDraft"),
		});
		expect(await b.delivery.send({ chatId: 1, threadId: 7, markdown: longText() })).toEqual([]);
		expect(await b.delivery.send({ chatId: 1, threadId: 7, markdown: "one" })).toEqual([]);
		expect(await b.delivery.edit({ chatId: 1, messageId: 5, markdown: "one" })).toBe(false);
		expect(await b.delivery.draft({ chatId: 1, threadId: 7, draftId: 1, markdown: "one" })).toBe(false);
	});

	it("carries only the unsent tail into the next rung", async () => {
		const b = bench({
			sendRichMessage: (
				(calls = 0) =>
				() => {
					calls += 1;
					if (calls === 2) throw refused("sendRichMessage");
					return { message_id: 600 + calls };
				}
			)(),
		});
		const markdown = longText();
		const rich = richMarkdown(markdown);
		expect(rich.length).toBeGreaterThanOrEqual(2);
		const marker = /line \d+ x/u.exec(rich[1]);
		expect(marker).not.toBeNull();
		const tailMarker = marker?.[0] ?? "";
		const ids = await b.delivery.send({ chatId: 1, threadId: 7, markdown });
		expect(b.of("sendRichMessage").length).toBe(2);
		const html = b
			.of("sendMessage")
			.map(call => call.fields.text)
			.join("\n");
		expect(html.includes("line 0 ")).toBe(false);
		expect(html.includes(tailMarker)).toBe(true);
		expect(ids.slice(0, 1)).toEqual([601]);
	});

	it("continues an edit's overflow as new messages in the thread, losing nothing", async () => {
		const b = bench({
			editMessageText: (fields: { richMessage?: unknown; messageId: number }) => {
				if (fields.richMessage !== undefined) throw refused("editMessageText");
				return { message_id: fields.messageId };
			},
		});
		const markdown = "z".repeat(10000);
		expect(await b.delivery.edit({ chatId: 1, threadId: 7, messageId: 5, markdown })).toBe(true);
		const edits = b.of("editMessageText");
		expect(edits.length).toBe(2);
		expect(edits.at(-1)?.fields.parseMode).toBe("HTML");
		const sent = b.of("sendMessage");
		expect(sent.length).toBeGreaterThanOrEqual(1);
		for (const call of sent) expect(call.fields.parseMode).toBe("HTML");
		const all = [edits.at(-1)?.fields.text, ...sent.map(call => call.fields.text)].join("");
		expect((all.match(/z/gu) ?? []).length).toBe(10000);
	});
});
