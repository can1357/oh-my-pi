/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, test } from "bun:test";
import { type KeyEvent, type Signal, signal, type UiEvent, type UiNode } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { widgetFor, widgetState, type WidgetContext } from "@oh-my-pi/pi-tui/term/widgets";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";

const env = staticEnvironment(PLAIN_THEME);

function rows(node: unknown, width: number, height?: number): readonly string[] {
	return renderBlock(node as UiNode, width, { env, height }).rows;
}

function press(id: string, text?: string): KeyEvent {
	return { id, kind: "press", raw: "", ...(text === undefined ? {} : { text }) };
}

/** Feed `key` to `node`'s widget; returns the events it sent. */
function keyOf(node: UiNode, key: KeyEvent): UiEvent[] {
	const sent: UiEvent[] = [];
	const cx: WidgetContext = {
		emit: event => void sent.push(event),
		state: <T,>(name: string, init: () => T): Signal<T> => {
			const map = widgetState(node);
			let value = map.get(name) as Signal<T> | undefined;
			if (!value) {
				value = signal(init());
				map.set(name, value as Signal<unknown>);
			}
			return value;
		},
		keypath: "",
		focus: () => {},
		pageRows: 10,
	};
	widgetFor(node)?.key?.(node, key, cx);
	return sent;
}

function fits(lines: readonly string[], width: number): boolean {
	return lines.every(line => visibleWidth(line) <= width);
}

describe("chrome kinds", () => {
	test("every row fits its width", () => {
		const nodes = [
			<tabs
				items={[
					{ id: "a", label: "Alpha" },
					{ id: "b", label: "Beta" },
					{ id: "c", label: "Gamma" },
				]}
				active="b"
			/>,
			<button text="Save" keys={["ctrl", "s"]} variant="primary" />,
			<buttons>
				<button text="Approve" keys={["enter"]} />
				<button text="Cancel" />
			</buttons>,
			<menu
				text="More"
				caret
				open
				active="b"
				items={[
					"Section",
					{ id: "a", label: "First", keys: ["ctrl", "a"] },
					"-",
					{ id: "b", label: "Second", detail: "why" },
				]}
			/>,
			<overlay head="Sheet">
				<text>Body text that wraps across the sheet</text>
			</overlay>,
			<toast text="Copied to clipboard" sub="3 files" action="undo" />,
		];
		for (const node of nodes)
			for (let width = 1; width <= 120; width++)
				expect({ kind: (node as UiNode).kind, width, fits: fits(rows(node, width), width) }).toEqual({
					kind: (node as UiNode).kind,
					width,
					fits: true,
				});
	});

	test("tabs shrink far tabs to their short form, then wrap", () => {
		const node = (
			<tabs
				items={[
					{ id: "a", label: "Alpha" },
					{ id: "b", label: "Beta" },
				]}
				active="a"
			/>
		);
		expect(rows(node, 40)).toEqual([" Alpha    Beta "]);
		expect(rows(node, 10)).toEqual([" Alpha   ", " Beta "]);
	});

	test("tabs keys step to the neighbouring tab", () => {
		const node = (
			<tabs
				items={[
					{ id: "a", label: "A" },
					{ id: "b", label: "B" },
				]}
				active="a"
			/>
		) as UiNode;
		expect(keyOf(node, press("right"))).toEqual([{ type: "select", key: "", item: "b" }]);
		expect(keyOf(node, press("left"))).toEqual([{ type: "select", key: "", item: "b" }]);
	});

	test("button and buttons run click actions", () => {
		const button = (<button text="Go" actions={{ click: "go" }} />) as UiNode;
		expect(rows(button, 20)).toEqual(["[ Go ]"]);
		expect(keyOf(button, press("enter"))).toEqual([{ type: "action", key: "", act: "go", mods: [] }]);
		const group = (
			<buttons>
				<button text="One" actions={{ click: "one" }} />
				<button text="Two" actions={{ click: "two" }} />
			</buttons>
		) as UiNode;
		expect(rows(group, 40)).toEqual(["[ One ] [ Two ]"]);
		expect(keyOf(group, press("right"))).toEqual([]);
		expect(keyOf(group, press("enter"))).toEqual([{ type: "action", key: "", act: "two", mods: [] }]);
	});

	test("menu opens, moves and chooses", () => {
		const closed = (
			<menu
				text="More"
				items={[
					{ id: "a", label: "A" },
					{ id: "b", label: "B", checked: false },
				]}
			/>
		) as UiNode;
		expect(rows(closed, 30)).toEqual(["[ More ]"]);
		expect(keyOf(closed, press("enter"))).toEqual([{ type: "toggle", key: "", collapsed: false }]);
		const open = (
			<menu
				text="More"
				open
				active="a"
				items={[
					{ id: "a", label: "A" },
					{ id: "b", label: "B", checked: false },
				]}
			/>
		) as UiNode;
		expect(rows(open, 12).length).toBe(5);
		expect(keyOf(open, press("down"))).toEqual([{ type: "select", key: "", item: "b" }]);
		expect(keyOf(open, press("escape"))).toEqual([{ type: "toggle", key: "", collapsed: true }]);
		const onB = (<menu open active="b" items={[{ id: "b", label: "B", checked: false }]} />) as UiNode;
		expect(keyOf(onB, press("enter"))).toEqual([{ type: "action", key: "", act: "b", mods: [], checked: true }]);
	});

	test("overlay frames its head and children; full overlays fill their height", () => {
		const node = (
			<overlay head="Title">
				<text>Hi</text>
			</overlay>
		);
		expect(rows(node, 12)).toEqual(["╭─ Title ──╮", "│ Hi       │", "╰──────────╯"]);
		expect(rows(node, 12, 6).length).toBe(6);
	});

	test("toast puts its action button at the end", () => {
		const block = renderBlock((<toast text="Saved" action="undo" />) as UiNode, 30, { env });
		expect(block.rows).toEqual(["Saved  [ Undo ]"]);
		expect(block.hits?.[0]?.act).toBe("undo");
	});
});
