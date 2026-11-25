/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { createRoot, resolveChildren, signal, type UiEvent } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import {
	HookSelector,
	type HookSelectorOptionInput,
	type HookSelectorProps,
} from "../../../../src/ui/overlays/pickers/hook-selector";
import { type Driver, pickerSuite } from "./harness";

test("ASCII option markers distinguish selection and checked state", () => {
	createRoot(dispose => {
		try {
			const theme = loadThemeSync("dark", { symbolPreset: "ascii" });
			const env = staticEnvironment(theme);
			for (const selectionMarker of ["radio", "checkbox"] as const) {
				const [node] = resolveChildren(
					<HookSelector
						title="Select tools"
						options={["Read", "Search"]}
						selectionMarker={selectionMarker}
						checkedIndices={[0]}
						onSelect={() => {}}
						onCancel={() => {}}
					/>,
				)();
				const rows = paintNode(env, node!, 50).rows.map(stripEscapes);
				expect(rows.find(row => row.includes("Read"))).toContain(selectionMarker === "radio" ? "(o) Read" : "[x] Read");
				expect(rows.find(row => row.includes("Search"))).toContain(selectionMarker === "radio" ? "( ) Search" : "[ ] Search");
			}
		} finally {
			dispose();
		}
	});
});

test("a selected option uses the ASCII cursor", () => {
	createRoot(dispose => {
		try {
			const [node] = resolveChildren(
				<HookSelector title="Choose" options={["Read", "Search"]} onSelect={() => {}} onCancel={() => {}} />,
			)();
			const theme = loadThemeSync("dark", { symbolPreset: "ascii" });
			const rows = paintNode(staticEnvironment(theme), node!, 50).rows.map(stripEscapes);
			expect(rows.find(row => row.includes("Read"))).toContain("> Read");
			expect(rows.find(row => row.includes("Search"))).not.toContain("> Search");
		} finally {
			dispose();
		}
	});
});

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

test("the hook slider uses the ASCII powerline caps and separator", () => {
	createRoot(dispose => {
		try {
			const [node] = resolveChildren(
				<HookSelector
					options={["Yes", "No"]}
					title="Continue?"
					slider={{ ...SLIDER, index: 0 }}
					onSelect={() => {}}
					onCancel={() => {}}
				/>,
			)();
			const theme = loadThemeSync("dark", { symbolPreset: "ascii" });
			const rows = paintNode(staticEnvironment(theme), node!, 70).rows.map(stripEscapes);
			expect(rows.find(row => row.includes("fast"))).toContain("< fast >  balanced > smart");
		} finally {
			dispose();
		}
	});
});

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
