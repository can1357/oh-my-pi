/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal, type UiEvent } from "@oh-my-pi/pi-tui";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import {
	HookSelector,
	type HookSelectorOptionInput,
	type HookSelectorProps,
} from "../../../../src/ui/overlays/pickers/hook-selector";
import { type Driver, pickerSuite } from "./harness";

const DESCRIBED: HookSelectorOptionInput[] = [
	{ label: "1. **Approve** the plan", description: "Run it as written, with `bash` and _edits_." },
	{ label: "2. Revise", description: "  " },
	{
		label: "3. Reject",
		description:
			"A very long description that wraps across many rows at narrow widths and keeps going ünïcödé 日本語 to be sure it wraps.",
	},
	"4. Other",
];
const MANY = Array.from({ length: 30 }, (_, i) => ({
	label: `Option ${i} ${"x".repeat(i % 7)}`,
	description: i % 3 ? `detail ${i}` : undefined,
}));
const SLIDER = {
	caption: "continue with",
	segments: [{ label: "fast", detail: "model-a" }, { label: "balanced" }, { label: "smart", detail: "model-c" }],
	index: 1,
	onChange: () => {},
};

type Variant = [title: string, options: HookSelectorOptionInput[], opts?: Partial<HookSelectorProps>];
const VARIANTS: Record<string, Variant> = {
	plain: ["Pick one", ["SQLite", "Postgres", "MySQL"]],
	"described-radio": [
		"Plan ready\nReview the plan below.\nSecond detail",
		DESCRIBED,
		{ selectionMarker: "radio", markableCount: 3, initialIndex: 1 },
	],
	"checkbox-disabled": [
		"Select tools",
		DESCRIBED,
		{ selectionMarker: "checkbox", checkedIndices: [0, 2, 99], disabledIndices: [1, -1] },
	],
	"outline-many": ["Many options", MANY, { outline: true, maxVisible: 6 }],
	"many-search": ["Many", MANY, { maxVisible: 5, helpText: "custom **help** text" }],
	slider: ["Continue?", ["Yes", "No"], { slider: SLIDER }],
	countdown: ["Timed", ["A", "B"], { timeout: 20_000, initialIndex: 1 }],
	inline: ["Inline card", DESCRIBED, { inline: true, disabledIndices: [0] }],
	empty: ["", []],
	"all-disabled": ["None", ["a", "b"], { disabledIndices: [0, 1] }],
};

/**
 * The old selector heard pointer picks on two keypaths: `picker` (a
 * highlight) and `list` (its card list: highlight and select at once). The
 * new tree's options live at `picker` (sheet) or `list` (card); the steps
 * replay as the equivalent gesture there.
 */
function pickStep(key: "list" | "picker", item: string) {
	return (d: Driver): void => {
		const target = d.find("picker") ? "picker" : "list";
		d.emit({ type: key === "list" ? "activate" : "select", key: target, item });
	};
}
function actionStep(act: string) {
	return (d: Driver): void => {
		const target = d.find("picker") ? "picker" : "";
		d.emit({ type: "action", key: target, act, mods: [] } as UiEvent);
	};
}

pickerSuite({
	dir: "overlays/hook-selector",
	mount(caseName) {
		const [title, options, opts] = VARIANTS[caseName]!;
		const heading = signal(title);
		let clock = CORPUS_NOW;
		const noop = (): void => {};
		return {
			view: () => (
				<HookSelector
					title={heading}
					options={options}
					onSelect={noop}
					onCancel={noop}
					now={() => clock}
					{...opts}
				/>
			),
			focus: d => d.find("picker") ?? d.find("list"),
			steps: {
				"list select": pickStep("list", "2"),
				"picker select": pickStep("picker", "1"),
				"slider tab": d => void d.emit({ type: "select", key: "slider", item: "2" }),
				"slider bad": d => void d.emit({ type: "select", key: "slider", item: "x" }),
				"picker clear": actionStep("clear"),
				"picker confirm": actionStep("confirm"),
				time: () => {
					clock += 3000;
				},
				"set title": () => heading.set("Retitled\nwith break"),
			},
		};
	},
});
