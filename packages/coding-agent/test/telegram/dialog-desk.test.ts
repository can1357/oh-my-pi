/**
 * Contract: the dialog desk. It presents an owned topic session's
 * `ExtensionUIContext` entirely over Telegram (buttons, text replies, ask
 * dialogs, timeouts, stale presses, topic drops), and hands the attached TUI
 * session a `RemoteDialogHost` that answers the same requests — returning
 * `unavailable` when it loses the race rather than pretending to be a cancel.
 */
import { describe, expect, it } from "bun:test";
import type {
	ExtensionAskDialogQuestion,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createDialogDesk } from "@oh-my-pi/pi-coding-agent/telegram/dialog-desk";
import type { TelegramInlineKeyboardMarkup } from "@oh-my-pi/pi-coding-agent/telegram/types";
import { callbackQuery, drain, fakeApi, fakeClock, fakeDelivery } from "./slice-d-fakes";

const TOPIC = 7;

function setup() {
	const api = fakeApi();
	const delivery = fakeDelivery();
	const clock = fakeClock();
	const desk = createDialogDesk({ api, delivery, chatId: -1000, clock });
	// Type test: a topic session gets a full `ExtensionUIContext`, not a subset.
	const ui: ExtensionUIContext = desk.uiContextFor(TOPIC);
	const sent = () => delivery.of("send").at(-1)?.fields ?? {};
	const lastEdit = () => delivery.of("edit").at(-1)?.fields ?? {};
	const answerTextOf = () => api.of("answerCallbackQuery").at(-1)?.fields.text;
	return { api, delivery, clock, desk, ui, sent, lastEdit, answerTextOf };
}

const flat = (markup: unknown) => ((markup as TelegramInlineKeyboardMarkup | null)?.inlineKeyboard ?? []).flat();
const dataOf = (markup: unknown, text: string) => flat(markup).find(button => button.text === text)?.callbackData ?? "";
const texts = (markup: unknown) => flat(markup).map(button => button.text);

const QUESTION: ExtensionAskDialogQuestion = {
	id: "q1",
	question: "Which sign in method",
	options: [{ label: "JWT" }, { label: "OAuth2" }],
};

describe("uiContextFor", () => {
	it("answers a select with the pressed option's label and closes the message", async () => {
		const { desk, ui, sent, lastEdit, answerTextOf, delivery } = setup();
		const answer = ui.select("Model", ["Fast", { label: "Precise", description: "slow" }]);
		await drain();
		expect(sent().threadId).toBe(TOPIC);
		expect(texts(sent().replyMarkup)).toEqual(["Fast", "Precise — slow", "Cancel"]);
		expect(await desk.handleCallback(callbackQuery(dataOf(sent().replyMarkup, "Fast")))).toBe(true);
		expect(await answer).toBe("Fast");
		expect(answerTextOf()).toBe("Accepted");
		expect(String(lastEdit().markdown)).toContain("**✅ Answer:** Fast");
		expect(lastEdit().replyMarkup).toEqual({ inlineKeyboard: [] });
		expect(lastEdit().threadId).toBe(TOPIC);
		expect(delivery.of("send")).toHaveLength(1);
	});

	it("answers a confirm with a boolean and the cancel button with undefined", async () => {
		const yes = setup();
		const yesAnswer = yes.ui.confirm("Continue?", "Sure?");
		await drain();
		await yes.desk.handleCallback(callbackQuery(dataOf(yes.sent().replyMarkup, "Yes")));
		expect(await yesAnswer).toBe(true);

		const no = setup();
		const noAnswer = no.ui.confirm("Continue?", "Sure?");
		await drain();
		await no.desk.handleCallback(callbackQuery(dataOf(no.sent().replyMarkup, "No")));
		expect(await noAnswer).toBe(false);
		expect(String(no.lastEdit().markdown)).toContain("**✅ Answer:** No");

		const cancelled = setup();
		const cancelAnswer = cancelled.ui.select("Model", ["Fast"]);
		await drain();
		await cancelled.desk.handleCallback(callbackQuery(dataOf(cancelled.sent().replyMarkup, "Cancel")));
		expect(await cancelAnswer).toBeUndefined();
		expect(String(cancelled.lastEdit().markdown)).toContain("**✅ Answer:** Cancelled");
	});

	it("takes a topic reply as an input answer, and only while one is pending", async () => {
		const { desk, ui, lastEdit, delivery } = setup();
		expect(await desk.answerText(TOPIC, "too early")).toBe(false);
		const answer = ui.input("Branch name", "feature/x");
		await drain();
		expect(await desk.answerText(TOPIC, "feature/y")).toBe(true);
		expect(await answer).toBe("feature/y");
		expect(String(lastEdit().markdown)).toContain("**✅ Answer:** feature/y");
		// A trailing reply after the answer is a prompt again, not a dialog answer.
		expect(await desk.answerText(TOPIC, "unrelated")).toBe(false);
		expect(delivery.of("send")).toHaveLength(1);
	});

	it("answers the most recent pending text dialog of the topic", async () => {
		const { desk, ui } = setup();
		const first = ui.input("First question");
		await drain();
		const second = ui.editor("Second question", "prefill");
		await drain();
		expect(await desk.answerText(TOPIC, "newest")).toBe(true);
		expect(await second).toBe("newest");
		expect(await desk.answerText(TOPIC, "older")).toBe(true);
		expect(await first).toBe("older");
		expect(await desk.answerText(TOPIC, "nothing left")).toBe(false);
	});

	it("shows the editor prefill and answers it with a topic reply", async () => {
		const { desk, ui, sent } = setup();
		const answer = ui.editor("Edit the note", "line one\nline two");
		await drain();
		expect(String(sent().markdown)).toContain("> line one\n> line two");
		await desk.answerText(TOPIC, "line one edited");
		expect(await answer).toBe("line one edited");
	});

	it("resolves a timed-out dialog as unanswered and strikes the keyboard", async () => {
		const { desk, ui, lastEdit } = setup();
		const answer = ui.select("Model", ["Fast"], { timeout: 20 });
		await drain();
		expect(await answer).toBeUndefined();
		await drain();
		expect(lastEdit().replyMarkup).toEqual({ inlineKeyboard: [] });
		expect(await desk.answerText(TOPIC, "late")).toBe(false);
	});

	it("refuses a press that arrives after the dialog was answered", async () => {
		const { desk, ui, sent, answerTextOf } = setup();
		const answer = ui.select("Model", ["Fast"]);
		await drain();
		const data = dataOf(sent().replyMarkup, "Fast");
		await desk.handleCallback(callbackQuery(data));
		expect(await answer).toBe("Fast");
		await desk.handleCallback(callbackQuery(data));
		expect(answerTextOf()).toBe("This question is already closed");
	});

	it("refuses a button minted by a previous desk instance as stale", async () => {
		const previous = setup();
		const orphan = previous.ui.select("Model", ["Fast"]);
		await drain();
		const staleData = dataOf(previous.sent().replyMarkup, "Fast");

		const current = setup();
		const mine = current.ui.select("Model", ["Fast"]);
		await drain();
		expect(await current.desk.handleCallback(callbackQuery(staleData))).toBe(true);
		expect(current.answerTextOf()).toBe("This question is already closed");
		// The stale press must not consume the live dialog it never named.
		await current.desk.handleCallback(callbackQuery(dataOf(current.sent().replyMarkup, "Fast")));
		expect(await mine).toBe("Fast");
		previous.desk.shutdown();
		expect(await orphan).toBeUndefined();
	});

	it("ignores callbacks that belong to another owner", async () => {
		const { desk, api } = setup();
		expect(await desk.handleCallback(callbackQuery("turn:stop"))).toBe(false);
		expect(await desk.handleCallback(callbackQuery("question:1"))).toBe(false);
		expect(api.of("answerCallbackQuery")).toHaveLength(0);
	});

	it("cancels the topic's pending dialogs when the topic is dropped", async () => {
		const { desk, ui, lastEdit } = setup();
		const answer = ui.input("Branch name");
		await drain();
		desk.dropTopic(TOPIC);
		expect(await answer).toBeUndefined();
		await drain();
		expect(lastEdit().replyMarkup).toEqual({ inlineKeyboard: [] });
		expect(await desk.answerText(TOPIC, "after the drop")).toBe(false);
	});

	it("cancels every pending dialog on shutdown, across topics", async () => {
		const { desk, ui } = setup();
		const first = ui.input("First");
		const second = desk.uiContextFor(8).input("Second");
		await drain();
		desk.shutdown();
		expect(await first).toBeUndefined();
		expect(await second).toBeUndefined();
	});

	it("keeps each topic's dialogs separate", async () => {
		const { desk, ui } = setup();
		const other = desk.uiContextFor(8).input("Second topic");
		const mine = ui.input("My topic");
		await drain();
		expect(await desk.answerText(8, "for topic 8")).toBe(true);
		expect(await other).toBe("for topic 8");
		expect(await desk.answerText(TOPIC, "for topic 7")).toBe(true);
		expect(await mine).toBe("for topic 7");
	});
});

describe("askDialog", () => {
	it("answers a single-select question over its buttons", async () => {
		const { desk, ui, sent, lastEdit } = setup();
		const answer = ui.askDialog!([QUESTION]);
		await drain();
		expect(texts(sent().replyMarkup)).toEqual(["JWT", "OAuth2", "Other (type your own)", "Cancel"]);
		await desk.handleCallback(callbackQuery(dataOf(sent().replyMarkup, "JWT")));
		expect(await answer).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Which sign in method",
					options: ["JWT", "OAuth2"],
					multi: false,
					selectedOptions: ["JWT"],
				},
			],
		});
		expect(String(lastEdit().markdown)).toContain("**✅ Answer:** Selected: JWT");
	});

	it("toggles a multi-select question and submits on Done", async () => {
		const { desk, ui, sent, lastEdit } = setup();
		const multi: ExtensionAskDialogQuestion = { ...QUESTION, multi: true };
		const answer = ui.askDialog!([multi]);
		await drain();
		await desk.handleCallback(callbackQuery(dataOf(sent().replyMarkup, "JWT")));
		const toggled = lastEdit().replyMarkup as TelegramInlineKeyboardMarkup;
		expect(texts(toggled)).toEqual(["☑ JWT", "OAuth2", "Done", "Other (type your own)", "Cancel"]);
		await desk.handleCallback(callbackQuery(dataOf(toggled, "OAuth2")));
		const both = lastEdit().replyMarkup as TelegramInlineKeyboardMarkup;
		expect(texts(both)).toEqual(["☑ JWT", "☑ OAuth2", "Done", "Other (type your own)", "Cancel"]);
		await desk.handleCallback(callbackQuery(dataOf(both, "Done")));
		expect(await answer).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Which sign in method",
					options: ["JWT", "OAuth2"],
					multi: true,
					selectedOptions: ["JWT", "OAuth2"],
				},
			],
		});
	});

	it("takes an Other answer as free text", async () => {
		const { desk, ui, sent, lastEdit } = setup();
		const answer = ui.askDialog!([QUESTION]);
		await drain();
		await desk.handleCallback(callbackQuery(dataOf(sent().replyMarkup, "Other (type your own)")));
		expect(String(lastEdit().markdown)).toContain("Write your answer as a message in this topic.");
		expect(await desk.answerText(TOPIC, "through the gate")).toBe(true);
		expect(await answer).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Which sign in method",
					options: ["JWT", "OAuth2"],
					multi: false,
					selectedOptions: [],
					customInput: "through the gate",
				},
			],
		});
	});

	it("cancels the whole ask dialog", async () => {
		const { desk, ui, sent, lastEdit } = setup();
		const answer = ui.askDialog!([QUESTION]);
		await drain();
		await desk.handleCallback(callbackQuery(dataOf(sent().replyMarkup, "Cancel")));
		expect(await answer).toBeUndefined();
		expect(String(lastEdit().markdown)).toContain("**✅ Answer:** Cancelled");
	});

	it("posts one message per question and returns the answers in order", async () => {
		const { desk, ui, delivery } = setup();
		const second: ExtensionAskDialogQuestion = {
			id: "q2",
			question: "Which store",
			options: [{ label: "SQLite" }, { label: "Postgres" }],
		};
		const answer = ui.askDialog!([QUESTION, second]);
		await drain();
		expect(delivery.of("send")).toHaveLength(1);
		await desk.handleCallback(callbackQuery(dataOf(delivery.of("send")[0].fields.replyMarkup, "JWT")));
		await drain();
		expect(delivery.of("send")).toHaveLength(2);
		expect(String(delivery.of("edit")[0].fields.markdown)).toContain("**✅ Answer:** Selected: JWT");
		const secondSend = delivery.of("send")[1].fields;
		expect(String(secondSend.markdown)).toContain("Which store");
		await desk.handleCallback(callbackQuery(dataOf(secondSend.replyMarkup, "Postgres")));
		expect(await answer).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Which sign in method",
					options: ["JWT", "OAuth2"],
					multi: false,
					selectedOptions: ["JWT"],
				},
				{
					id: "q2",
					question: "Which store",
					options: ["SQLite", "Postgres"],
					multi: false,
					selectedOptions: ["Postgres"],
				},
			],
		});
	});
});

describe("remoteDialogHostFor", () => {
	it("takes no request while the session has no topic", async () => {
		const { desk } = setup();
		const host = desk.remoteDialogHostFor(() => null);
		expect(host.requestGuestUi({ kind: "select", title: "Model", options: ["Fast"] })).toBeNull();
	});

	it("answers a marked select and reports a cancel as an answered undefined", async () => {
		const { desk, sent } = setup();
		const host = desk.remoteDialogHostFor(() => TOPIC);
		const pending = host.requestGuestUi({
			kind: "select",
			title: "Pick a target",
			options: [{ label: "Fast", description: "flash" }, { label: "Careful" }],
			selectionMarker: "radio",
			checkedIndices: [1],
			helpText: "↑↓ navigate",
		});
		await drain();
		// The TUI's key hints must not leak into the chat.
		expect(String(sent().markdown)).not.toContain("navigate");
		expect(texts(sent().replyMarkup)).toEqual(["○ Fast — flash", "◉ Careful", "Cancel"]);
		await desk.handleCallback(callbackQuery(dataOf(sent().replyMarkup, "◉ Careful")));
		expect(await pending).toEqual({ kind: "answered", value: "Careful" });

		const cancelling = host.requestGuestUi({ kind: "select", title: "Again", options: ["Fast"] });
		await drain();
		await desk.handleCallback(callbackQuery(dataOf(sent().replyMarkup, "Cancel")));
		expect(await cancelling).toEqual({ kind: "answered", value: undefined });
	});

	it("marks a checkbox request from its checked indices", async () => {
		const { desk, sent } = setup();
		const host = desk.remoteDialogHostFor(() => TOPIC);
		void host.requestGuestUi({
			kind: "select",
			title: "What to enable",
			options: ["JWT", "OAuth2", "Chat about this"],
			selectionMarker: "checkbox",
			checkedIndices: [0],
			markableCount: 2,
		});
		await drain();
		expect(texts(sent().replyMarkup)).toEqual(["☑ JWT", "☐ OAuth2", "Chat about this", "Cancel"]);
	});

	it("reports unavailable and strikes the keyboard when the local UI wins", async () => {
		const { desk, sent, lastEdit } = setup();
		const host = desk.remoteDialogHostFor(() => TOPIC);
		const controller = new AbortController();
		const pending = host.requestGuestUi({ kind: "select", title: "Model", options: ["Fast"] }, controller.signal);
		await drain();
		expect(dataOf(sent().replyMarkup, "Fast")).not.toBe("");
		controller.abort();
		expect(await pending).toEqual({ kind: "unavailable" });
		await drain();
		expect(lastEdit().replyMarkup).toEqual({ inlineKeyboard: [] });
		expect(String(lastEdit().markdown)).toContain("_Closed._");
	});

	it("takes an editor answer from a topic reply", async () => {
		const { desk, sent } = setup();
		const host = desk.remoteDialogHostFor(() => TOPIC);
		const pending = host.requestGuestUi({ kind: "editor", title: "Edit the note", prefill: "draft" });
		await drain();
		expect(String(sent().markdown)).toContain("> draft");
		expect(await desk.answerText(TOPIC, "final text")).toBe(true);
		expect(await pending).toEqual({ kind: "answered", value: "final text" });
	});
});
