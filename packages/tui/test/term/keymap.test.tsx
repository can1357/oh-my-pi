/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The widget keymap: lists, menus and settings answer to the keys a program
 * binds with `setWidgetKeymap`, and to their native keys by default.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { JSXNode, UiEvent, UiNode } from "../../src";
import { setWidgetKeymap, widgetKeys } from "../../src/term/keymap";
import { createTestTerminal } from "../../src/testing/terminal";

afterEach(() => setWidgetKeymap());

function firstOfKind(node: UiNode, kind: string): UiNode | null {
	if (node.kind === kind) return node;
	for (const child of node.children()) {
		const found = firstOfKind(child, kind);
		if (found) return found;
	}
	return null;
}

/** A widget of `kind` mounted alone and focused; its events in order. */
function mount(view: (events: UiEvent[]) => JSXNode, kind: string) {
	const events: UiEvent[] = [];
	const term = createTestTerminal(() => ({ layer: view(events) }), { columns: 60, rows: 20 });
	term.render();
	const layer = term.surface.layer()[0];
	term.focus(layer ? firstOfKind(layer, kind) : null);
	return { term, events };
}

const ITEMS = [
	{ id: "a", label: "Alpha" },
	{ id: "b", label: "Beta" },
	{ id: "c", label: "Gamma" },
];

function picker() {
	return mount(
		events => (
			<picker
				items={ITEMS}
				selected="a"
				actions={[{ id: "close", label: "Close", keys: ["esc"], end: true }]}
				onEvent={event => void events.push(event)}
			/>
		),
		"picker",
	);
}

describe("picker", () => {
	test("native keys by default", () => {
		const { term, events } = picker();
		term.press("down");
		term.press("enter");
		term.press("escape");
		term.press("ctrl+c");
		expect(events.map(event => event.type)).toEqual(["select", "activate", "action"]);
	});

	test("remapped navigation, confirm and cancel", () => {
		setWidgetKeymap({
			"select.down": ["ctrl+n"],
			"select.confirm": ["ctrl+y"],
			"select.cancel": ["escape", "ctrl+g"],
		});
		const { term, events } = picker();
		term.press("down");
		term.press("enter");
		expect(events).toEqual([]);
		term.press("ctrl+n");
		term.press("ctrl+y");
		// An action keyed Escape runs on every cancel key.
		term.press("ctrl+g");
		expect(events.map(event => ("item" in event ? `${event.type}:${event.item}` : event.type))).toEqual([
			"select:b",
			"activate:a",
			"action",
		]);
	});
});

describe("menu", () => {
	test("remapped keys open, move and close it", () => {
		setWidgetKeymap({ "select.down": ["j"], "select.cancel": ["q"] });
		const { term, events } = mount(
			events => (
				<menu
					text="Pick"
					open={true}
					items={ITEMS.map(item => ({ id: item.id, label: item.label }))}
					onEvent={event => void events.push(event)}
				/>
			),
			"menu",
		);
		term.press("down");
		term.press("j");
		term.press("escape");
		term.press("q");
		expect(events.map(event => event.type)).toEqual(["select", "toggle"]);
	});
});

describe("keymap", () => {
	test("an action left out keeps its default; an empty list unbinds it", () => {
		setWidgetKeymap({ "select.up": [] });
		expect(widgetKeys("select.up")).toEqual([]);
		expect(widgetKeys("select.down")).toEqual(["down"]);
		setWidgetKeymap();
		expect(widgetKeys("select.up")).toEqual(["up"]);
	});
});
