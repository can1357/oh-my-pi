/**
 * Contract: how a dialog looks and how its answers are encoded. A prompt is
 * escaped markdown plus a keyboard whose callback data carries only a minted
 * token and an index (Telegram caps callbacks at 64 UTF-8 bytes); an ask
 * question lists its options with descriptions and a ⭐ on the recommended one.
 */
import { describe, expect, it } from "bun:test";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	ASK_DONE_INDEX,
	ASK_OTHER_INDEX,
	CANCEL_INDEX,
	MIN_INDEX,
	parseUiCallback,
	uiCallbackData,
} from "@oh-my-pi/pi-coding-agent/telegram/dialog-keys";
import {
	askOptionLines,
	askQuestionKeyboard,
	askQuestionText,
	askReplyText,
	OTHER_LABEL,
	type UiPrompt,
	selectLabels,
	uiPrompt,
} from "@oh-my-pi/pi-coding-agent/telegram/dialogs";
import type { TelegramInlineKeyboardMarkup } from "@oh-my-pi/pi-coding-agent/telegram/types";

const flat = (markup: TelegramInlineKeyboardMarkup | null | undefined) => markup?.inlineKeyboard.flat() ?? [];
const labels = (markup: TelegramInlineKeyboardMarkup | null | undefined) => flat(markup).map(button => button.text);
const dataOf = (markup: TelegramInlineKeyboardMarkup | null | undefined, text: string) =>
	flat(markup).find(button => button.text === text)?.callbackData;
const promptLabels = (prompt: UiPrompt) => labels(prompt.replyMarkup);

const QUESTION: ExtensionAskDialogQuestion = {
	id: "q1",
	question: "Which sign in method",
	header: "security",
	options: [
		{ label: "JWT", description: "stateless tokens" },
		{ label: "OAuth2", description: "external provider" },
	],
	recommended: 0,
};

describe("uiPrompt", () => {
	it("offers a select as labelled buttons plus a cancel", () => {
		const prompt = uiPrompt(
			{
				method: "select",
				title: "Model",
				message: "Which one?",
				options: ["Fast", { label: "Precise", description: "slow" }],
			},
			"ab12",
		);
		expect(prompt.text).toBe("## ❓ Model\nWhich one?");
		expect(prompt.expectsReply).toBe(false);
		expect(prompt.replyMarkup?.inlineKeyboard).toEqual([
			[{ text: "Fast", callbackData: "u:ab12:0" }],
			[{ text: "Precise — slow", callbackData: "u:ab12:1" }],
			[{ text: "Cancel", callbackData: "u:ab12:-1" }],
		]);
		expect(selectLabels(["Fast", { label: "Precise", description: "slow" }])).toEqual(["Fast", "Precise"]);
	});

	it("offers a confirm as Yes and No", () => {
		const prompt = uiPrompt({ method: "confirm", title: "Continue?", message: "Sure?" }, "ab12");
		expect(prompt.text).toBe("## ❓ Continue?\nSure?");
		expect(prompt.replyMarkup?.inlineKeyboard).toEqual([
			[
				{ text: "Yes", callbackData: "u:ab12:1" },
				{ text: "No", callbackData: "u:ab12:0" },
			],
		]);
		expect(prompt.expectsReply).toBe(false);
	});

	it("asks for input and editor answers as topic replies, with a way out", () => {
		const asked = uiPrompt({ method: "input", title: "Branch name", placeholder: "feature/…" }, "ab12");
		expect(asked.expectsReply).toBe(true);
		expect(asked.text).toBe("## ❓ Branch name\n_feature/…_\n\nWrite your answer as a message in this topic.");
		expect(promptLabels(asked)).toEqual(["Cancel"]);
		expect(dataOf(asked.replyMarkup, "Cancel")).toBe(uiCallbackData("ab12", CANCEL_INDEX));
		const edited = uiPrompt({ method: "editor", title: "Edit the note", prefill: "line one\nline two" }, "ab12");
		expect(edited.expectsReply).toBe(true);
		expect(edited.text).toBe(
			"## ❓ Edit the note\n> line one\n> line two\n\nWrite your answer as a message in this topic.",
		);
	});

	it("posts a notification without a keyboard", () => {
		const note = uiPrompt({ method: "notify", message: "All done" }, "ab12");
		expect(note).toEqual({ text: "All done", replyMarkup: null, expectsReply: false });
	});

	it("escapes untrusted titles, messages and options instead of breaking the markup", () => {
		const prompt = uiPrompt(
			{ method: "select", title: "Use *this* <b>?", message: "over _there_ and $5", options: ["a|b"] },
			"ab12",
		);
		expect(prompt.text.startsWith("## ❓ ")).toBe(true);
		expect(prompt.text).toContain("\\*this\\*");
		expect(prompt.text).toContain("&lt;b");
		expect(prompt.text).not.toContain("<b>");
		expect(prompt.text).toContain("\\_there\\_");
		expect(prompt.text).toContain("\\$5");
		// Button labels are plain Telegram text, not markdown, so they stay raw.
		expect(promptLabels(prompt)).toEqual(["a|b", "Cancel"]);
	});
});

describe("ask rendering", () => {
	it("lists the options with descriptions, marks the recommended one, and shows progress", () => {
		const text = askQuestionText(QUESTION, 1, 2, false);
		expect(text).toContain("## ❓ Which sign in method");
		expect(text).toContain("_security_");
		expect(text).toContain("_Question 1 of 2_");
		expect(text).toContain("1. **JWT** — stateless tokens ⭐");
		expect(text).toContain("2. **OAuth2** — external provider");
		expect(text).not.toContain("Select any number");
	});

	it("adds the multi-select hint and hides options beyond the twentieth", () => {
		const many: ExtensionAskDialogQuestion = {
			id: "q2",
			question: "What to enable",
			multi: true,
			options: Array.from({ length: 25 }, (_unused, index) => ({ label: `option ${index}` })),
		};
		const text = askQuestionText(many, 1, 1, true);
		expect(text).toContain("_Select any number of options, then press Done._");
		expect(text).toContain("20. **option 19**");
		expect(text).not.toContain("option 20");
		expect(text).toContain("_…and 5 more_");
		expect(askOptionLines(many.options, 3)[3]).toBe("4. **option 3** ⭐");
	});

	it("renders the keyboard: checked options, Done for multi, Other and Cancel", () => {
		const keyboard = askQuestionKeyboard(QUESTION, "ab12", new Set(["JWT"]), true);
		expect(labels(keyboard)).toEqual(["☑ JWT ⭐", "OAuth2", "Done", OTHER_LABEL, "Cancel"]);
		expect(flat(keyboard).map(button => button.callbackData)).toEqual([
			"u:ab12:0",
			"u:ab12:1",
			"u:ab12:-2",
			"u:ab12:-3",
			"u:ab12:-1",
		]);
		const single = askQuestionKeyboard(QUESTION, "ab12", new Set(), false);
		expect(labels(single)).toEqual(["JWT ⭐", "OAuth2", OTHER_LABEL, "Cancel"]);
		expect(dataOf(single, OTHER_LABEL)).toBe(uiCallbackData("ab12", ASK_OTHER_INDEX));
	});

	it("asks for the free-text answer in the topic", () => {
		const text = askReplyText(QUESTION, 1, 1);
		expect(text).toContain("Which sign in method");
		expect(text).toContain("Write your answer as a message in this topic.");
	});
});

describe("dialog callback data", () => {
	it("round-trips every reserved index inside Telegram's 64-byte budget", () => {
		expect(uiCallbackData("ab12", CANCEL_INDEX)).toBe("u:ab12:-1");
		for (const index of [MIN_INDEX, ASK_OTHER_INDEX, ASK_DONE_INDEX, CANCEL_INDEX, 0, 9999]) {
			const data = uiCallbackData("x1234567890abcd", index);
			expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
			expect(parseUiCallback(data)).toEqual({ token: "x1234567890abcd", index });
		}
	});

	it("refuses foreign or malformed callbacks and out-of-range indices", () => {
		expect(parseUiCallback("question:1")).toBeNull();
		expect(parseUiCallback("turn:stop")).toBeNull();
		expect(parseUiCallback("u:ab12:first")).toBeNull();
		expect(parseUiCallback("u:ab12")).toBeNull();
		expect(parseUiCallback(undefined)).toBeNull();
		expect(parseUiCallback(`u:${"я".repeat(30)}:1`)).toBeNull();
		expect(() => uiCallbackData("я".repeat(20), 1)).toThrow(RangeError);
		expect(() => uiCallbackData("ab12", 10000)).toThrow(RangeError);
		expect(() => uiCallbackData("ab12", MIN_INDEX - 1)).toThrow(RangeError);
		expect(() => uiCallbackData("ab12", 1.5)).toThrow(RangeError);
	});
});
