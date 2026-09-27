/**
 * Contract: the ask flow behind `askDialog`. It walks the questions in order,
 * toggles a multi-select question until Done, accepts a free-text "Other"
 * answer for the current question, and reports the finished answers in the
 * order (and with the ids) the ask tool requires.
 */
import { describe, expect, it } from "bun:test";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAskFlow, type AskFlow } from "@oh-my-pi/pi-coding-agent/telegram/ask-desk";
import { ASK_DONE_INDEX, ASK_OTHER_INDEX, CANCEL_INDEX } from "@oh-my-pi/pi-coding-agent/telegram/dialog-keys";

const question = (id: string, extra: Partial<ExtensionAskDialogQuestion> = {}): ExtensionAskDialogQuestion => ({
	id,
	question: `Question ${id}`,
	options: [{ label: "JWT" }, { label: "OAuth2" }],
	...extra,
});

const summary = (flow: AskFlow) => ({
	at: flow.at(),
	total: flow.total(),
	question: flow.question()?.id ?? null,
	selected: [...flow.selected()],
	awaiting: flow.awaitingText(),
});

describe("ask flow", () => {
	it("answers a single-select question on the first option pressed", () => {
		const flow = createAskFlow([question("q1")]);
		expect(summary(flow)).toEqual({ at: 1, total: 1, question: "q1", selected: [], awaiting: false });
		const outcome = flow.press(1);
		expect(outcome).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Question q1",
					options: ["JWT", "OAuth2"],
					multi: false,
					selectedOptions: ["OAuth2"],
				},
			],
		});
		expect(flow.question()).toBeNull();
		expect(flow.press(0)).toEqual({ kind: "stale" });
	});

	it("toggles a multi-select question and submits the checked labels", () => {
		const flow = createAskFlow([question("q1", { multi: true })]);
		expect(flow.multi()).toBe(true);
		expect(flow.press(0)).toEqual({ kind: "render" });
		expect(summary(flow).selected).toEqual(["JWT"]);
		expect(flow.press(1)).toEqual({ kind: "render" });
		expect(summary(flow).selected).toEqual(["JWT", "OAuth2"]);
		expect(flow.press(0)).toEqual({ kind: "render" });
		expect(summary(flow).selected).toEqual(["OAuth2"]);
		const outcome = flow.press(ASK_DONE_INDEX);
		expect(outcome).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Question q1",
					options: ["JWT", "OAuth2"],
					multi: true,
					selectedOptions: ["OAuth2"],
				},
			],
		});
	});

	it("accepts an empty multi-select submission as selecting none", () => {
		const flow = createAskFlow([question("q1", { multi: true })]);
		expect(flow.press(ASK_DONE_INDEX)).toEqual({
			kind: "submit",
			results: [{ id: "q1", question: "Question q1", options: ["JWT", "OAuth2"], multi: true, selectedOptions: [] }],
		});
	});

	it("carries a free-text Other answer instead of a selection", () => {
		const flow = createAskFlow([question("q1")]);
		expect(flow.press(ASK_OTHER_INDEX)).toEqual({ kind: "render" });
		expect(flow.awaitingText()).toBe(true);
		expect(flow.reply("a bespoke answer")).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Question q1",
					options: ["JWT", "OAuth2"],
					multi: false,
					selectedOptions: [],
					customInput: "a bespoke answer",
				},
			],
		});
	});

	it("only accepts free text while a question waits for it", () => {
		const flow = createAskFlow([question("q1")]);
		expect(flow.reply("early")).toEqual({ kind: "stale" });
		flow.press(ASK_OTHER_INDEX);
		flow.reply("late");
		expect(flow.reply("after")).toEqual({ kind: "stale" });
	});

	it("cancels the whole dialog on the cancel button", () => {
		const flow = createAskFlow([question("q1"), question("q2")]);
		expect(flow.press(CANCEL_INDEX)).toEqual({ kind: "cancel" });
	});

	it("refuses Done on a single-select question and foreign indices", () => {
		const flow = createAskFlow([question("q1")]);
		expect(flow.press(ASK_DONE_INDEX)).toEqual({ kind: "stale" });
		expect(flow.press(99)).toEqual({ kind: "stale" });
		expect(flow.press(-9)).toEqual({ kind: "stale" });
		expect(flow.question()?.id).toBe("q1");
	});

	it("walks several questions in order and returns their answers with the requested ids", () => {
		const flow = createAskFlow([question("q1"), question("q2", { multi: true })]);
		expect(flow.press(0)).toEqual({ kind: "render" });
		expect(summary(flow)).toEqual({ at: 2, total: 2, question: "q2", selected: [], awaiting: false });
		expect(flow.results()).toEqual([
			{ id: "q1", question: "Question q1", options: ["JWT", "OAuth2"], multi: false, selectedOptions: ["JWT"] },
		]);
		expect(flow.press(1)).toEqual({ kind: "render" });
		const outcome = flow.press(ASK_DONE_INDEX);
		expect(outcome).toEqual({
			kind: "submit",
			results: [
				{ id: "q1", question: "Question q1", options: ["JWT", "OAuth2"], multi: false, selectedOptions: ["JWT"] },
				{ id: "q2", question: "Question q2", options: ["JWT", "OAuth2"], multi: true, selectedOptions: ["OAuth2"] },
			],
		});
		expect(flow.at()).toBe(3);
	});
});
