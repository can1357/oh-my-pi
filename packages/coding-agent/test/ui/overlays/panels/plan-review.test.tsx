/** @jsxImportSource @oh-my-pi/pi-tui */
import type { UiEvent } from "@oh-my-pi/pi-tui";
import { corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import { PlanReview } from "../../../../src/ui/overlays/panels/plan-review";
import {
	type PlanReviewOptions,
	PlanReviewModel,
	type PlanReviewOverlayChoice,
} from "../../../../src/ui/overlays/panels/plan-review-model";
import { type Driver, panelSuite } from "./harness";

const PLAN = `# Refactor the thing

Intro paragraph with **bold** and \`code\` and a [link](http://x).

## Goals

- First goal that is fairly long and will wrap at narrow widths for sure, yes
- Second goal 中文 wide chars

### Sub goal

Detail of the sub goal.

\`\`\`ts
# not a heading
const x = 1;
\`\`\`

## Steps

1. Do this
2. Then that

## Risks

> quoted risk

## Rollout

Ship it.
`;
const CHOICES: PlanReviewOverlayChoice[] = [
	{ id: "exec", label: "Approve and execute", meta: "120k", detail: "Runs now" },
	{ id: "compact", label: "Approve and compact", disabled: "Too full" },
	{ id: "keep", label: "Approve and keep context" },
];
const SLIDER = {
	caption: "Model",
	index: 1,
	segments: [{ label: "fast", detail: "Haiku" }, { label: "smart" }, { label: "max", detail: "Opus" }],
};
const ENTER = "\r";
const TAB = "\t";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const CANCEL = "\x07";

interface CaseSetup {
	promptTitle?: string;
	slider?: boolean;
	save?: boolean;
	plan?: string;
	refine?: boolean;
	helpText?: string;
}

const SETUPS: Record<string, CaseSetup> = {
	interactive: { promptTitle: "Plan mode - next step" },
	"native-modes": { save: false, helpText: "custom help" },
	"approve-cancel": { slider: false, refine: false },
	"cancel-key": { plan: "just text, no headings" },
	empty: { plan: "", slider: false },
};

const press =
	(...keys: string[]) =>
	(d: Driver) => {
		for (const key of keys) d.press(key);
	};
const emit = (event: Record<string, unknown>) => (d: Driver) =>
	void d.emit({ mods: [], ...event } as unknown as UiEvent);
const mouse = (b: number, x: number, y: number, up = false) => `\x1b[<${b};${x};${y}${up ? "m" : "M"}`;

panelSuite({
	dir: "overlays/plan-review",
	mount(caseName, corpusCase) {
		const setup = SETUPS[caseName] ?? {};
		const env = corpusEnvironment(corpusCase.theme);
		const options: PlanReviewOptions = {
			options: CHOICES,
			refine: setup.refine === false ? undefined : { id: "refine", label: "Refine the plan" },
			promptTitle: setup.promptTitle,
			helpText: setup.helpText,
			initialIndex: 1,
			slider: setup.slider === false ? undefined : SLIDER,
			externalEditorLabel: "ctrl+e",
			cancelKey: "ctrl+g",
		};
		const noop = () => {};
		const model = new PlanReviewModel(
			setup.plan ?? PLAN,
			options,
			{
				onPick: noop,
				onCancel: noop,
				onSave: setup.save === false ? undefined : noop,
				onCopyPlan: noop,
				onExternalEditor: noop,
				onAnnotationExternalEditor: (draft, commit) => commit(`${draft}+ext`),
			},
			{ theme: env.theme, size: () => ({ columns: corpusCase.widths.at(-1)!, rows: 30 }) },
		);
		const host =
			(dock: boolean, doc = true) =>
			() =>
				model.setNativeHost({ dock, doc });
		return {
			view: () => <PlanReview model={model} />,
			height: 30,
			steps: {
				"actions nav": press(DOWN, UP, UP, "j", "k"),
				slider: press(LEFT, RIGHT, RIGHT, RIGHT, "h"),
				"up into body": press(UP, UP, UP),
				"body scroll": press("j", "j", "\x1b[1;2B", "\x1b[6~", "G", "g"),
				"body annotate": press("j", "j", "a", ..."why this", ENTER),
				"body annotate 2": press("a", ..."multi\nline", ENTER),
				"edit chooser": press("e"),
				"chooser nav": press(DOWN, "k", "j"),
				"chooser pick": press(ENTER, ..." edited"),
				"ext annot": press("\x05"),
				commit: press(ENTER),
				"chooser cancel": press("e", CANCEL),
				"to toc": press(TAB, TAB),
				"toc nav": press("j", "j", "k"),
				"toc annotate": press("a", ..."section note", ENTER),
				"toc edit": press("e", "!", ENTER),
				"toc delete": press("j", "d"),
				undo: press("u"),
				"delete again": press("d"),
				"toc to body": press(ENTER, "h", RIGHT),
				copy: press("c", "\x05"),
				"mouse wheel": press(mouse(65, 30, 5), mouse(64, 30, 5)),
				"mouse motion": press(...Array.from({ length: 40 }, (_, y) => mouse(35, 10, y + 1))),
				"mouse toc click": press(mouse(0, 3, 3), mouse(0, 3, 3, true)),
				"mouse body click": press(mouse(0, 50, 4)),
				"set choices": () =>
					model.setChoices([CHOICES[2]!, CHOICES[1]!, { id: "new", label: "New one", disabled: "nope" }]),
				"set slider": () => model.setSliderIndex(0),
				"help text tab": press(TAB, "\x1b[Z"),
				"annot esc": press(TAB, "a", "x", CANCEL),
				"set content": () => model.setPlanContent(`${PLAN}\n## Extra\n\nmore\n`),
				"native toc select": emit({ type: "select", key: "split/sidebar/toc", item: "h3" }),
				"native toc activate": emit({ type: "activate", key: "split/sidebar/toc", item: "h5" }),
				"native options select": emit({ type: "select", key: "options", item: "o1" }),
				"native tabs": emit({ type: "select", key: "slider/tabs", item: "t2" }),
				"native comment": emit({
					type: "comment",
					key: "split/body/doc",
					quote: "Do this",
					at: 160,
					note: "native note",
				}),
				"native commentNote": emit({ type: "commentNote", key: "split/body/doc", comment: "c1", note: "renamed" }),
				"native uncomment": emit({ type: "uncomment", key: "split/body/doc", comment: "c2" }),
				"native docChange": emit({
					type: "docChange",
					key: "split/body/doc",
					text: "Intro changed.\n\n## Goals\n\n- one\n\n## Steps\n\n1. Do this\n",
				}),
				"native action model": emit({ type: "action", key: "dock/model", act: "tier:1" }),
				"native action save": emit({ type: "action", key: "dock/save", act: "save" }),
				"native action refine": emit({ type: "action", key: "dock/approve/main", act: "refine" }),
				// native modes
				comment: emit({ type: "comment", key: "split/body/doc", quote: "Ship it.", at: 300, note: "n" }),
				chooser: press(TAB, "e"),
				"chooser native select": emit({ type: "select", key: "chooser", item: "c0" }),
				"chooser native activate": emit({ type: "activate", key: "chooser", item: "c0" }),
				type: press("z"),
				"blocked action": emit({ type: "action", key: "dock/save", act: "save" }),
				submit: press(ENTER),
				more: emit({ type: "action", key: "dock/approve/more", act: "compact" }),
				"more ok": emit({ type: "action", key: "dock/approve/more", act: "keep" }),
				"after commit": press(ENTER),
				// native dock / bar keys: the host draws the dock natively
				"native on + dock": host(true),
				"dock keys": press(LEFT, RIGHT, DOWN, DOWN, UP, "d", "u"),
				"dock no-doc": d => {
					model.setNativeHost({ dock: true, doc: false });
					press("a", ..."note", ENTER, "e")(d);
					model.setNativeHost({ dock: true, doc: true });
				},
				"dock chooser": press(ENTER, "!", ENTER),
				"dock enter": press(ENTER),
				"native off": host(false),
				"native on bar": host(true),
				"bar keys": press("\x1b[1;2D", "\x1b[1;2C", LEFT, RIGHT, "l", "h", DOWN, UP, TAB, TAB, ENTER),
				approve: emit({ type: "action", key: "dock/approve/main", act: "approve" }),
				"select bad": () => void model.selectOption("compact"),
				"click option": press(mouse(0, 10, 35)),
				"select ok": () => void model.selectOption("refine"),
			},
		};
	},
});
