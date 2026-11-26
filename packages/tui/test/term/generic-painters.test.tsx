/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, test } from "bun:test";
import { createRoot, isUiNode, type JSXNode, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import "@oh-my-pi/pi-tui/term/painters/index";
import { formatDuration } from "@oh-my-pi/pi-tui/term/painters/elapsed";
import { SPINNER_INTERVAL_MS } from "@oh-my-pi/pi-tui/term/painters/spinner";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

const theme = loadThemeSync("dark");

function paint(jsx: JSXNode, width: number, now = 0, reduceMotion = false): string[] {
	return createRoot(dispose => {
		try {
			if (!isUiNode(jsx)) throw new Error("expected one node");
			const env = staticEnvironment(theme, { now, reduceMotion });
			return [...paintNode(env, jsx as UiNode, width).rows].map(stripEscapes);
		} finally {
			dispose();
		}
	});
}

const KINDS: Record<string, () => JSXNode> = {
	badge: () => <badge text="truncated" tone="warning" />,
	icon: () => <icon name="folder" />,
	kbd: () => <kbd keys={["ctrl", "o"]} />,
	kv: () => (
		<kv
			items={[
				{ k: "model", v: "a very long value that has to wrap across rows" },
				{ k: "cost", v: "$0.01" },
			]}
		/>
	),
	list: () => (
		<list selected="a" max={2}>
			<item key="a" label="alpha" detail="first" value="1" />
			<item key="b" label="beta" />
			<item key="c" label="gamma" />
		</list>
	),
	table: () => (
		<table
			cols={[
				{ id: "name", head: "Name", grow: 1 },
				{ id: "size", head: "Size", align: "end", priority: -1 },
			]}
			rows={[
				{ id: "1", cells: { name: "packages/tui/src/term/painters/table.ts", size: "4K" } },
				{ id: "2", cells: { name: "a", size: "12K" } },
			]}
		/>
	),
	tree: () => (
		<tree
			nodes={[
				{ id: "src", label: "src", open: true, children: [{ id: "a", label: "a.ts" }] },
				{ id: "test", label: "test", children: [{ id: "b", label: "b.ts" }] },
			]}
		/>
	),
	json: () => <json value={{ libraries: [{ id: "/facebook/react", stars: 230000 }], ok: true }} open={1} />,
	progress: () => <progress value={0.42} label="indexing" />,
	meter: () => <meter value={0.74} label="74%" total="200K" thresholds={{ warn: 0.7 }} />,
	rate: () => <rate value={42.34} unit="tok" />,
	elapsed: () => <elapsed age={4200} />,
	spinner: () => <spinner label="working" />,
	shimmer: () => <shimmer text="thinking" />,
};

describe("generic painters", () => {
	for (const kind in KINDS) {
		test(`${kind} fits every width`, () => {
			for (const width of [1, 8, 20, 80]) {
				for (const row of paint(KINDS[kind]!(), width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		});
	}

	test("list marks the selection and clamps to max", () => {
		expect(paint(KINDS.list!(), 30)).toEqual(["❯ alpha  first               1", "… 2 more"]);
	});

	test("tree folds closed nodes", () => {
		expect(paint(KINDS.tree!(), 30)).toEqual(["├─ ▾ src", "│  └─ a.ts", "└─ ▸ test"]);
	});

	test("json lists the root entries and opens one level", () => {
		expect(paint(KINDS.json!(), 60)).toEqual([
			"├ • libraries [1]",
			'    └─ 0: {id: "/facebook/react", stars: 230000}',
			"└ • ok: true",
		]);
	});

	test("spinner frames follow the clock; reduced motion holds the first", () => {
		const frames = theme.symbols.spinnerFrames;
		expect(paint(<spinner />, 10, SPINNER_INTERVAL_MS * 3)).toEqual([frames[3]!]);
		expect(paint(<spinner />, 10, SPINNER_INTERVAL_MS * 3, true)).toEqual([frames[0]!]);
	});

	test("elapsed counts on from the age it first painted", () => {
		expect(paint(<elapsed age={4200} />, 10, 1000)).toEqual(["4.2s"]);
		expect(paint(<elapsed age={0} stopped={65_000} format="clock" />, 10)).toEqual(["1:05"]);
		expect(formatDuration(3_725_000)).toBe("1h 2m");
	});
});
