/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { createTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import {
	buildBrowserItems,
	resolveRoleAssignments,
	sortModelItems,
} from "../../../../src/modes/view-model/overlays/model-browser";
import { ModelBrowser } from "../../../../src/ui/overlays/pickers/model-browser";
import { type ModelBrowserOptions, ModelBrowserState } from "../../../../src/ui/overlays/pickers/model-browser-state";
import { type Driver, pickerSuite } from "./harness";
import { MODELS, model, source } from "./model-fixtures";

const settings = source({ default: "demo/demo", smol: "openai/gpt-5.6-mini" }, ["demo/demo", "openai/gpt-5.6"]);
const roles = resolveRoleAssignments(settings, MODELS, MODELS);
const items = buildBrowserItems(MODELS);
sortModelItems(items, { roles, mruOrder: settings.mruOrder });
const fewer = items.slice(2, 5);
const extra = buildBrowserItems([...MODELS, model("zeta", "z-1", { contextWindow: 100 })]);

/** A pointer event at a row of the browser (the capture's column 4). */
const pointer =
	(row: number, button: "left" | "wheel-down" | "none", action: "press" | "move") =>
	(d: Driver): void =>
		d.mouse(row, 4, { button, action });

const CASES: Readonly<Record<string, { options: ModelBrowserOptions; hydrate: boolean }>> = {
	"hydrated-over-context-marking": {
		options: { currentContextTokens: 150_000, markOverContext: true },
		hydrate: true,
	},
	"plain-list": { options: {}, hydrate: true },
	"empty-with-host-text": { options: { emptyText: () => "  Discovering providers…" }, hydrate: false },
	"empty-default-text": { options: { showProvider: false }, hydrate: false },
};

pickerSuite({
	dir: "overlays/model-browser",
	mount(caseName) {
		const spec = CASES[caseName]!;
		const browser = new ModelBrowserState(settings, spec.options);
		if (spec.hydrate) {
			browser.setRoles(roles);
			browser.setMruOrder(settings.mruOrder);
			browser.setPerfStats(settings.modelPerf);
			browser.setItems(items);
			browser.setCurrentSelector("demo/demo");
			browser.setMaxVisible(5);
		}
		return {
			view: () => <ModelBrowser browser={browser} />,
			focus: d => d.root,
			steps: {
				"wheel down": pointer(3, "wheel-down", "press"),
				"wheel down again": pointer(4, "wheel-down", "press"),
				hover: pointer(3, "none", "move"),
				"click other": pointer(4, "left", "press"),
				"click selected": pointer(4, "left", "press"),
				"clear hover": () => browser.clearHover(),
				"maxVisible 3": () => browser.setMaxVisible(3),
				"hide provider": () => browser.setShowProvider(false),
				"current gpt": () => browser.setCurrentSelector("openai/gpt-5.6"),
				unfocus: () => browser.setFocused(false),
				"select tiny": () => void browser.selectSelector("local/tiny"),
				"mark over context off": () => browser.setMarkOverContext(false),
				"mark over context on": () => browser.setMarkOverContext(true),
				"query gpt": () => browser.setQuery("gpt"),
				"query provider-scoped": () => browser.setQuery("openai/mini"),
				"query no match": () => browser.setQuery("zzzz"),
				"query clear": () => browser.setQuery(""),
				"native select": d => void d.emit({ type: "select", key: "list", item: "openai/gpt-5.6-mini" }),
				"native activate": d => void d.emit({ type: "activate", key: "list", item: "anthropic/claude-opus-5" }),
				"native other key": d => void d.emit({ type: "select", key: "detail", item: "demo/demo" }),
				"route picker item": () => void browser.routePickerItem("local/tiny", false),
				"move wrap": () => browser.moveSelection(-20),
				"move clamp": () => browser.moveSelection(20, { wrap: false }),
				"perf cleared": () => browser.setPerfStats(new Map()),
				"roles cleared": () => browser.setRoles({}),
				"fewer items": () => browser.setItems(fewer),
				"more items": () => browser.setItems(extra),
				"preserve order + query": () => {
					browser.setPreserveQueryOrder(true);
					browser.setQuery("d");
				},
				refocus: () => browser.setFocused(true),
				"no items": () => browser.setItems([]),
				cancel: () => browser.handleCancel(),
				items: () => browser.setItems(items),
				empty: () => browser.setItems([]),
			},
		};
	},
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeText(node: unknown): string {
	if (typeof node === "string") return node;
	if (Array.isArray(node)) return node.map(nativeText).join("");
	if (!isRecord(node)) return "";
	let text = typeof node.t === "string" ? node.t : "";
	const props = node.p;
	if (isRecord(props)) {
		const spans = props.spans;
		if (Array.isArray(spans)) text += nativeText(spans);
		text += nativeText(props.value);
		text += nativeText(props.label);
	}
	const children = node.c;
	return text + nativeText(children);
}

test("native model browser resolves glyphs from the active theme", () => {
	const previous = currentTheme();
	const custom = createTheme({
		...previous.json,
		symbols: {
			...previous.json.symbols,
			overrides: {
				...previous.json.symbols?.overrides,
				"status.enabled": "@ENABLED",
				"icon.context": "@CONTEXT",
				"icon.intelligence": "@INTELLIGENCE",
			},
		},
	});
	setCurrentTheme(custom);
	try {
		const browser = new ModelBrowserState(settings, {});
		browser.setRoles(roles);
		browser.setMruOrder(settings.mruOrder);
		browser.setPerfStats(settings.modelPerf);
		browser.setItems(items);
		browser.setCurrentSelector("demo/demo");
		browser.setMaxVisible(5);
		const term = createTestTerminal(() => ({ main: <ModelBrowser browser={browser} /> }), {
			columns: 100,
			rows: 40,
			theme: custom,
		});
		try {
			const root = term.surface.main()[0];
			expect(root).toBeDefined();
			const text = nativeText(describeTree(root!, staticEnvironment(custom), 100));
			expect(text).toContain("@ENABLED");
			expect(text).toContain("@CONTEXT");
			expect(text).toContain("@INTELLIGENCE");
			expect(text).not.toContain(previous.symbols.symbol("status.enabled"));
			expect(text).not.toContain(previous.symbols.symbol("icon.context"));
			expect(text).not.toContain(previous.symbols.symbol("icon.intelligence"));
		} finally {
			term.dispose();
		}
	} finally {
		setCurrentTheme(previous);
	}
});
