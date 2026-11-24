/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, test } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import type { ExtensionAskDialogQuestion } from "../../../../src/modes/view-model/overlays/ask-dialog";
import { AskDialog, AskDialogModel, type AskDialogOptions } from "../../../../src/ui/overlays/panels/ask-dialog";
import { type Driver, panelSuite } from "./harness";

const LONG_Q = `Which **approach** should we take for the \`migration\`? ${"This question is long and keeps going. ".repeat(12)}`;
const questions = (): ExtensionAskDialogQuestion[] => [
	{
		id: "q1",
		header: "Plan\tstep",
		question: LONG_Q,
		recommended: 1,
		options: [
			{ label: "Rewrite `everything`", description: `Start over. ${"Long description words ".repeat(20)}` },
			{
				label: "Patch",
				description: "Minimal patch",
				preview: "```ts\nconst x = 1;\nfunction f() {\n\treturn x;\n}\n```\nAnd **markdown** after.",
			},
			{ label: "Patch (Recommended)" },
			{ label: "Other (type your own)" },
		],
	},
	{
		id: "q2",
		question: "Pick many 🚀 日本語?",
		multi: true,
		options: [{ label: "A" }, { label: "B" }, { label: "C\rD" }, { label: "E" }, { label: "F" }],
	},
	{ id: "q3", question: "Last one?", options: [{ label: "Yes" }, { label: "No" }] },
];
const CASES: Record<string, () => ExtensionAskDialogQuestion[]> = {
	navigate: questions,
	single: () => [
		{ id: "s", question: "Proceed?", options: [{ label: "Yes", description: "Go `now`" }, { label: "No" }] },
	],
	empty: () => [],
	malformed: () => [{ id: 3, question: null, options: [null, { label: 5, description: 1 }] }] as never,
	timeout: questions,
	"image-draft": questions,
	esc: questions,
};

const settle = () => Bun.sleep(1);

panelSuite({
	dir: "overlays/ask-dialog",
	mount(caseName) {
		const skip = signal<string | undefined>(undefined);
		const options: AskDialogOptions = {
			skipNotice: skip,
			terminalRows: () => 30,
			...(caseName === "timeout" ? { timeout: 60_000 } : {}),
		};
		const model = new AskDialogModel(
			CASES[caseName]!(),
			{
				onSubmit() {},
				onCancel() {},
				onPrompt: async prompt => (prompt.title.startsWith("Note") ? "a note\twith tab" : "custom 🚀 answer"),
				...(caseName === "image-draft" ? { onImagePrompt: async () => ({ draft: { text: "kept draft" } }) } : {}),
			},
			options,
		);
		const emit = (event: Parameters<Driver["emit"]>[0]) => async () => {
			model[event.type === "action" ? "action" : "rowEvent"](
				...((event.type === "action"
					? [event.act, event.key]
					: [event.type, event.key, (event as { item: string }).item]) as [never, never, never]),
			);
			await settle();
		};
		const key = (raw: string) => async (d: Driver) => {
			d.press(raw);
			await settle();
		};
		return {
			view: () => <AskDialog model={model} />,
			steps: {
				expand: () => void model.key("ctrl+o", undefined),
				keyHints: () => {},
				"skip on": () => skip.set("Sending your draft skips this ask"),
				"skip off": () => skip.set(undefined),
				note: key("n"),
				other: async d => {
					const downs = caseName === "image-draft" ? 4 : 2;
					for (let i = 0; i < downs; i++) d.press("\x1b[B");
					await key("\n")(d);
				},
				again: key("\n"),
				"native open q2": emit({ type: "action", key: "q1", act: "open:1", mods: [] }),
				"native pick q3": emit({ type: "action", key: "q2/summary", act: "pick:2:1", mods: [] }),
				"native select row": emit({ type: "select", key: "q1", item: "option:2" }),
				"native activate row": emit({ type: "activate", key: "q1", item: "option:0" }),
				"native note menu": emit({ type: "action", key: "q1/option:3", act: "note", mods: [] }),
				"native note bar": emit({ type: "action", key: "actions/note", act: "note", mods: [] }),
				"native stale list": emit({ type: "select", key: "q0", item: "option:0" }),
				"native submit": emit({ type: "action", key: "actions/submit", act: "submit", mods: [] }),
				cancel: emit({ type: "action", key: "actions/cancel", act: "cancel", mods: [] }),
			},
		};
	},
});

describe("Ctrl+O", () => {
	const mountAsk = (asked: ExtensionAskDialogQuestion[]) => {
		const model = new AskDialogModel(
			asked,
			{ onSubmit() {}, onCancel() {}, onPrompt: async () => undefined },
			{
				terminalRows: () => 30,
			},
		);
		const term = createTestTerminal(() => ({ main: [<AskDialog model={model} />] }), { columns: 80, rows: 30 });
		return { model, term };
	};

	test("stays the transcript's when the open question shows in full (#7837)", () => {
		const { model, term } = mountAsk(CASES.single!());
		term.render();
		expect(model.key("ctrl+o", undefined)).toBe(false);
		expect(model.expanded).toBe(false);
		term.dispose();
	});

	test("expands and collapses a cut question", () => {
		const { model, term } = mountAsk(questions());
		term.render();
		expect(model.key("ctrl+o", undefined)).toBe(true);
		expect(model.expanded).toBe(true);
		term.render();
		expect(model.key("ctrl+o", undefined)).toBe(true);
		expect(model.expanded).toBe(false);
		term.dispose();
	});
});
