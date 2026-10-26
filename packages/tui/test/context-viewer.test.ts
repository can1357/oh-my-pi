import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import type { TspText } from "@oh-my-pi/pi-wire";
import type {
	ContextThinkingGroup,
	ContextViewCategory,
	ContextViewData,
	ContextViewEntry,
} from "../src/chrome/context-view-model";
import {
	getKeybindings,
	KeybindingsManager,
	type KeybindingsConfig,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "../src/keybindings";
import type { NativeNode } from "../src/native/node";
import { Reconciler } from "../src/native/reconcile";
import { ContextViewer } from "../src/overlays/context-viewer";
import { ensureThemeSync, setThemeInstance, theme, type Theme } from "../src/theme/theme";
import { visibleWidth } from "../src/utils";

const cx = { cols: 100, reduceMotion: false, dark: true, supports: () => false, feature: () => true };
const meterCx = { ...cx, supports: () => true };
const viewers: ContextViewer[] = [];
let previous: Theme;
let previousBindings: KeybindingsManager;
beforeEach(() => {
	ensureThemeSync();
	previous = theme;
	previousBindings = getKeybindings();
});
afterEach(() => {
	for (const viewer of viewers) viewer.dispose();
	viewers.length = 0;
	setThemeInstance(previous);
	setKeybindings(previousBindings);
});

function nodes(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).flatMap(child => ("k" in child ? nodes(child) : []))];
}

function textValue(value: TspText | undefined): string | undefined {
	return typeof value === "string" ? value : value?.map(span => span.t).join("");
}

function usageColumns(item: NativeNode | undefined): string[] | undefined {
	return item?.k === "item" ? textValue(item.p?.value)?.split(" · ") : undefined;
}

/** First line of `text` containing `needle`; fails the test when there is none. */
function lineWith(text: string, needle: string): string {
	const line = text.split("\n").find(candidate => candidate.includes(needle));
	if (line === undefined) throw new Error(`No line contains ${needle}`);
	return line;
}

function fixture(firstOutput?: ContextViewEntry, secondOutput?: ContextViewEntry): ContextViewData {
	const output: ContextViewCategory = {
		id: "tool-output",
		label: "Tool Output",
		tokens: 30000,
		entries: [
			firstOutput ?? {
				id: "result/0",
				label: "read result",
				tokens: 20000,
				timestamp: 0,
				callId: "call-123",
				text:
					Array.from({ length: 100 }, (_, index) => `line ${index}\t${"long ".repeat(30)}`).join("\n") +
					"\ncontext-output-tail",
			},
			secondOutput ?? {
				id: "result/1",
				label: "bash result",
				tokens: 10000,
				text: "short result",
				timestamp: 60_000,
			},
		],
	};
	output.children = [
		{ ...output, key: "tool-output/read", label: "read", entries: output.entries.slice(0, 1), tokens: 20000 },
		{ ...output, key: "tool-output/bash", label: "bash", entries: output.entries.slice(1), tokens: 10000 },
	];
	return {
		breakdown: {
			model: undefined,
			contextWindow: 200000,
			categories: [],
			thresholdTokens: 180000,
			snapcompact: {
				visionCapable: true,
				savedTokens: 6000,
				systemPrompt: {
					applied: true,
					textTokens: 10000,
					imageTokens: 4000,
					frames: 2,
					savedTokens: 6000,
					scope: "all",
				},
			},
			usedTokens: 85000,
			freeTokens: 95000,
			autoCompactBufferTokens: 20000,
		},
		categories: [
			{
				id: "system-prompt",
				label: "System Prompt",
				tokens: 20000,
				entries: [{ id: "system/0", label: "system block", tokens: 20000, text: "entire system source" }],
			},
			{
				id: "skills",
				label: "Skills",
				tokens: 10000,
				entries: [{ id: "skill/0", label: "fixture skill", tokens: 10000, text: "skill hint" }],
			},
			{
				id: "built-in-tools",
				label: "Built-in Tools",
				tokens: 10000,
				entries: [{ id: "tool/0", label: "builtin read", tokens: 10000, text: "schema definition" }],
			},
			{ id: "custom-tools", label: "Custom Tools", tokens: 0, entries: [] },
			{
				id: "user-messages",
				label: "User / Developer Messages",
				tokens: 10000,
				entries: [{ id: "user/0", label: "user", tokens: 10000, text: "question" }],
			},
			output,
		],
	};
}

function harness(data = fixture()) {
	let rows = 24;
	let closed = 0;
	const viewer = new ContextViewer(data, { onClose: () => closed++, requestRender: () => {}, getRows: () => rows });
	viewers.push(viewer);
	const render = (width = 100) => viewer.render(width).map(line => Bun.stripANSI(line));
	return { viewer, render, closed: () => closed, resize: (height: number) => (rows = height) };
}

function select(viewer: ContextViewer, key: string, activate = true): void {
	viewer.handleNativeEvent({ type: activate ? "activate" : "select", key: "categories", item: key });
}

function nativeText(root: NativeNode): string {
	return nodes(root)
		.flatMap(node => (node.k === "text" ? [textValue(node.p?.spans) ?? node.p?.text ?? ""] : []))
		.join("\n");
}

function selected(root: NativeNode): string | null | undefined {
	const all = nodes(root);
	const list = all.find(node => node.k === "list" && node.p?.selected !== undefined);
	return list?.k === "list" ? list.p?.selected : all.find(node => node.p?.mark === "pick")?.key;
}

function scrollToText(viewer: ContextViewer, render: () => readonly string[], value: string): void {
	for (let step = 0; step < 5000; step++) {
		if (render().some(line => line.includes(value))) return;
		viewer.handleInput("\x1b[B");
	}
	throw new Error(`Could not reach ${value} with down navigation`);
}

describe("ContextViewer keybindings", () => {
	const navigationBindings: {
		name: string;
		bindings: KeybindingsConfig;
		up?: string;
		down?: string;
	}[] = [
		{ name: "default arrows", bindings: {}, up: "\x1b[A", down: "\x1b[B" },
		{
			name: "remapped control keys",
			bindings: { "tui.select.up": "ctrl+p", "tui.select.down": "ctrl+n" },
			up: "\x10",
			down: "\x0e",
		},
		{ name: "unbound navigation", bindings: { "tui.select.up": [], "tui.select.down": [] } },
	];
	for (const { name, bindings, up, down } of navigationBindings) {
		it(`captures and navigates only with configured keys: ${name}`, () => {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, bindings));
			const h = harness();
			h.render();
			for (const key of ["\x1b[A", "\x1b[B", "\x10", "\x0e", "k", "j"]) {
				select(h.viewer, "built-in-tools", false);
				expect(h.viewer.capturesInput(key)).toBe(key === up || key === down);
				h.viewer.handleInput(key);
				// Down skips the empty Custom Tools row, which has nothing to open.
				expect(selected(h.viewer.describe(cx))).toBe(
					key === up ? "system-prompt" : key === down ? "user-messages" : "built-in-tools",
				);
			}
		});
	}

	it("remaps opening and returning without retaining Enter or Escape aliases", () => {
		const h = harness();
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.confirm": "o",
				"tui.select.cancel": "b",
			}),
		);
		h.render();
		for (const key of ["\r", "\x1b"]) {
			expect(h.viewer.capturesInput(key)).toBe(false);
			h.viewer.handleInput(key);
		}
		expect(h.closed()).toBe(0);
		expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
		for (const key of ["o", "b"]) expect(h.viewer.capturesInput(key)).toBe(true);
		select(h.viewer, "tool-output", false);
		h.viewer.handleInput("o");
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.viewer.handleInput("o");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-result/0")).toBe(true);
		h.viewer.handleInput("b");
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.viewer.handleInput("b");
		expect(selected(h.viewer.describe(cx))).toBe("tool-output");
		h.viewer.handleInput("b");
		expect(h.closed()).toBe(1);
	});

	it("keeps Native open, Back and Close usable when their keyboard actions are unbound", () => {
		const h = harness();
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.confirm": [],
				"tui.select.cancel": [],
			}),
		);
		h.render();
		for (const key of ["\r", "\x1b", "\x03"]) {
			expect(h.viewer.capturesInput(key)).toBe(false);
			h.viewer.handleInput(key);
		}
		expect(h.closed()).toBe(0);
		expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
		select(h.viewer, "tool-output");
		h.viewer.handleNativeEvent({ type: "action", key: "entries/content/list/result/0", act: "open-entry", mods: [] });
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-result/0")).toBe(true);
		h.viewer.handleNativeEvent({ type: "action", key: "back", act: "back", mods: [] });
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.viewer.handleNativeEvent({ type: "action", key: "back", act: "back", mods: [] });
		expect(selected(h.viewer.describe(cx))).toBe("tool-output");
		h.viewer.handleNativeEvent({ type: "action", key: "close", act: "close", mods: [] });
		expect(h.closed()).toBe(1);
	});
});

describe("ContextViewer navigation", () => {
	it("keeps Skills token totals visible while native and keyboard navigation cannot focus or open them", () => {
		const h = harness();
		expect(
			h
				.render()
				.find(line => /\sSkills\s+\d/.test(line))
				?.match(/\d+K|\d+\.\d%/g),
		).toEqual(["11K", "5.3%"]);
		for (const context of [cx, meterCx]) {
			const root = h.viewer.describe(context);
			const skills = nodes(root).find(node => node.key === "skills");
			expect(usageColumns(skills)).toEqual(["11K", "5.3%"]);
			for (const activate of [false, true]) {
				select(h.viewer, "skills", activate);
				const unchanged = h.viewer.describe(context);
				expect(selected(unchanged)).toBe("system-prompt");
				expect(nodes(unchanged).some(node => node.key === "overview")).toBe(true);
				expect(nodes(unchanged).some(node => node.key === "entry-skill/0")).toBe(false);
			}
		}
		h.viewer.handleInput("\x1b[B");
		expect(selected(h.viewer.describe(cx))).toBe("built-in-tools");
		h.viewer.handleInput("\r");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-tool/0")).toBe(true);
		h.viewer.handleInput("\x1b");
		h.viewer.handleInput("\x1b[A");
		expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
		h.viewer.handleInput("\r");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-system/0")).toBe(true);
	});

	it("opens a single-entry category directly and returns to its overview selection", () => {
		const h = harness();
		select(h.viewer, "system-prompt");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "entry-system/0")).toBe(true);
		expect(h.render().join("\n")).toContain("entire system source");
		h.viewer.handleInput("\x1b");
		expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "overview")).toBe(true);
	});

	it("keeps an empty category closed and unselectable in both renderers", () => {
		const h = harness();
		select(h.viewer, "custom-tools");
		expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
		expect(nodes(h.viewer.describe(cx)).some(node => node.key === "overview")).toBe(true);
		expect(h.render()[0]).not.toContain("Custom Tools");
	});

	it("skips capacity rows at the navigation boundary before and after resizing", () => {
		const h = harness();
		select(h.viewer, "tool-output/bash", false);
		h.render();
		h.viewer.handleInput("\x1b[B");
		expect(selected(h.viewer.describe(cx))).toBe("tool-output/bash");
		h.resize(12);
		h.render(48);
		h.viewer.handleInput("\x1b[B");
		expect(selected(h.viewer.describe({ ...cx, cols: 48 }))).toBe("tool-output/bash");
	});

	it("selects and opens native list items through reconciled events without activating the buffer", () => {
		const h = harness();
		const reconciler = new Reconciler("context-swatches");
		const pending = reconciler
			.reconcile({ main: [h.viewer], dock: [], layer: [] }, meterCx)
			.flatMap(op => (op[0] === "add" ? [op[4]] : []));
		let listPath: string | undefined;
		for (let index = 0; index < pending.length; index++) {
			const wire = pending[index]!;
			if (wire.k === "list") listPath = reconciler.target(wire.id)?.keypath;
			pending.push(...(wire.c ?? []));
		}
		if (!listPath) throw new Error("Missing category list path");
		h.viewer.handleNativeEvent({ type: "select", key: listPath, item: "tool-output/read" });
		expect(selected(h.viewer.describe(meterCx))).toBe("tool-output/read");
		h.viewer.handleNativeEvent({ type: "activate", key: listPath, item: "buffer" });
		expect(selected(h.viewer.describe(meterCx))).toBe("tool-output/read");
		h.viewer.handleNativeEvent({ type: "activate", key: listPath, item: "tool-output/read" });
		expect(JSON.stringify(h.viewer.describe(meterCx))).toContain("context-output-tail");
		h.viewer.handleInput("\x1b");
		expect(selected(h.viewer.describe(meterCx))).toBe("tool-output/read");
		h.viewer.handleInput("\x1b[A");
		expect(selected(h.viewer.describe(meterCx))).toBe("tool-output");
	});
});

describe("ContextViewer preview and scrolling", () => {
	it("reaches saved output tail and restores the initial preview and selection through Back", () => {
		const h = harness();
		h.render();
		select(h.viewer, "tool-output");
		const preview = h.render();
		h.viewer.handleInput("\r");
		scrollToText(h.viewer, () => h.render(), "context-output-tail");
		expect(h.render().join("\n")).toContain("context-output-tail");
		h.viewer.handleInput("\x1b");
		expect(h.render()).toEqual(preview);
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.viewer.handleInput("\x1b");
		h.render();
		expect(selected(h.viewer.describe(cx))).toBe("tool-output");
		expect(h.closed()).toBe(0);
		h.viewer.handleInput("\x1b");
		expect(h.closed()).toBe(1);
	});

	it("emits a new Native scroll request for each repeated down input", () => {
		const h = harness();
		const reconciler = new Reconciler("context-repeated-scroll");
		h.viewer.describe(cx);
		select(h.viewer, "tool-output/read");
		reconciler.reconcile({ main: [h.viewer], dock: [], layer: [] }, cx);
		for (const n of [1, 2]) {
			h.viewer.handleInput("\x1b[B");
			const scroll = nodes(h.viewer.describe(cx)).find(node => node.key === "entry-result/0")?.scroll;
			expect(scroll).toMatchObject({ by: "line-down", n });
			const ops = reconciler.reconcile({ main: [h.viewer], dock: [], layer: [] }, cx);
			expect(ops.filter(op => op[0] === "scroll").map(op => op[2])).toEqual(["line-down"]);
		}
	});

	it("reveals the Native legend's edge rows only when the selection cannot move", () => {
		const h = harness();
		const reconciler = new Reconciler("context-overview-edge");
		const edgeReveals = () =>
			reconciler
				.reconcile({ main: [h.viewer], dock: [], layer: [] }, cx)
				.filter(op => op[0] === "reveal" && op[2] !== "nearest")
				.map(op => op[2]);
		edgeReveals();
		h.viewer.handleInput("\x1b[B");
		expect(selected(h.viewer.describe(cx))).toBe("built-in-tools");
		expect(edgeReveals()).toEqual([]);
		select(h.viewer, "tool-output/bash", false);
		edgeReveals();
		// Each press past the last category brings Buffer and Free Space into view again.
		for (const _ of [1, 2]) {
			h.viewer.handleInput("\x1b[B");
			expect(selected(h.viewer.describe(cx))).toBe("tool-output/bash");
			expect(edgeReveals()).toEqual(["end"]);
		}
		select(h.viewer, "system-prompt", false);
		edgeReveals();
		h.viewer.handleInput("\x1b[A");
		expect(selected(h.viewer.describe(cx))).toBe("system-prompt");
		expect(edgeReveals()).toEqual(["start"]);
	});

	it("pages the full-content view in both renderers and keeps list selection single-step", () => {
		const h = harness();
		const pageDown = "\x1b[6~";
		const pageUp = "\x1b[5~";
		select(h.viewer, "tool-output");
		expect(h.viewer.capturesInput(pageDown)).toBe(false);
		h.viewer.handleInput(pageDown);
		expect(selected(h.viewer.describe(cx))).toBe("result/0");
		h.render();
		h.viewer.handleInput("\r");
		expect(h.viewer.capturesInput(pageDown)).toBe(true);
		const top = h.render().join("\n");
		expect(top).toContain("line 1 ");
		h.viewer.handleInput(pageDown);
		const paged = h.render().join("\n");
		expect(paged).not.toContain("line 1 ");
		expect(paged).toMatch(/line [1-9]\d /);
		h.viewer.handleInput(pageUp);
		expect(h.render().join("\n")).toEqual(top);
		// Native owns its scroll position; the viewer only emits page requests.
		h.viewer.describe(cx);
		h.viewer.handleInput(pageDown);
		expect(nodes(h.viewer.describe(cx)).find(node => node.key === "entry-result/0")?.scroll).toMatchObject({
			by: "page-down",
		});
	});
});

describe("ContextViewer usage and allocation", () => {
	it("conserves Used across top-level allocations and splits only the parent's budget among children", () => {
		const data = fixture();
		const categories = data.categories.filter(category => category.tokens > 0);
		for (const category of categories) category.tokens = 1;
		const output = categories.at(-1)!;
		for (const child of output.children!) child.tokens = 1;
		const h = harness({
			categories,
			breakdown: {
				...data.breakdown,
				usedTokens: 7,
				contextWindow: 100,
				autoCompactBufferTokens: 10,
				freeTokens: 83,
			},
		});
		const value = (key: string) => {
			const item = nodes(h.viewer.describe(cx)).find(node => node.key === key);
			return usageColumns(item);
		};
		expect(categories.map(category => value(category.id))).toEqual([
			["2", "2.0%"],
			["2", "2.0%"],
			["1", "1.0%"],
			["1", "1.0%"],
			["1", "1.0%"],
		]);
		expect(value("tool-output/read")).toEqual(["1", "1.0%"]);
		expect(value("tool-output/bash")).toEqual(["0", "0.0%"]);
		expect(value("buffer")).toEqual(["10", "10.0%"]);
		expect(value("free")).toEqual(["83", "83.0%"]);
		expect(categories.map(category => category.tokens)).toEqual([1, 1, 1, 1, 1]);
	});

	it("assigns leftover tokens by descending remainder before category order", () => {
		const data = fixture();
		const categories = data.categories.slice(0, 3);
		for (const [index, category] of categories.entries()) category.tokens = [1, 2, 4][index]!;
		const h = harness({ categories, breakdown: { ...data.breakdown, usedTokens: 5, contextWindow: 100 } });
		const values = nodes(h.viewer.describe(cx)).filter(
			node => node.k === "item" && categories.some(category => category.id === node.key),
		);
		expect(values.map(node => usageColumns(node))).toEqual([
			["1", "1.0%"],
			["1", "1.0%"],
			["3", "3.0%"],
		]);
	});

	it("keeps original usage without inventing category shares when estimates are unavailable", () => {
		const data = fixture();
		for (const category of data.categories) category.tokens = 0;
		const h = harness(data);
		expect(h.render(160).join("\n")).toContain("85K");
		const items = nodes(h.viewer.describe(cx)).filter(node => node.k === "item");
		expect(usageColumns(items.find(node => node.key === "system-prompt"))).toEqual(["—"]);
	});

	it("omits percentages and the meter when capacity is zero", () => {
		const data = fixture();
		const h = harness({
			...data,
			breakdown: { ...data.breakdown, contextWindow: 0, usedTokens: 0, autoCompactBufferTokens: 0, freeTokens: 0 },
		});
		expect(h.render(160).join("\n")).not.toMatch(/NaN|Infinity/);
		const root = h.viewer.describe(meterCx);
		expect(nodes(root).some(node => node.k === "meter")).toBe(false);
		const top = nodes(root).find(node => node.key === "system-prompt");
		expect(usageColumns(top)).toEqual(["0", "—"]);
	});

	it("shows over-capacity usage without clamping its percentage or category allocation", () => {
		const data = fixture();
		const h = harness({
			...data,
			breakdown: { ...data.breakdown, contextWindow: 10, usedTokens: 15, autoCompactBufferTokens: 0, freeTokens: 0 },
		});
		expect(h.render(160)[1]).toMatch(/15.*10.*150%/);
		const top = nodes(h.viewer.describe(cx)).find(node => node.key === "system-prompt");
		expect(usageColumns(top)).toEqual(["4", "40.0%"]);
	});
});

describe("ContextViewer overview and meter", () => {
	it.each([
		{ name: "without meter support", supportsMeter: false, emptyWeights: false },
		{ name: "without category weights", supportsMeter: true, emptyWeights: true },
	])("shows usage and compaction totals $name", ({ supportsMeter, emptyWeights }) => {
		const data = fixture();
		data.breakdown.thresholdTokens = 160000;
		if (emptyWeights) for (const category of data.categories) category.tokens = 0;
		const h = harness(data);
		const root = h.viewer.describe({ ...cx, supports: () => supportsMeter });
		const lines = nodes(root).flatMap(node => (node.k === "text" ? [textValue(node.p?.spans)] : []));
		expect(lines.some(line => /85K.*200K/.test(line ?? ""))).toBe(true);
		expect(lines.some(line => /75K.*80%/.test(line ?? ""))).toBe(true);
	});

	it("places a stacked meter above selectable categories on meter-capable terminals", () => {
		const data = fixture();
		const { breakdown } = data;
		const h = harness(data);
		for (const cols of [48, 100]) {
			const root = h.viewer.describe({ ...meterCx, cols });
			const all = nodes(root);
			const meter = all.find(node => node.k === "meter");
			if (meter?.k !== "meter") throw new Error("Missing context meter");
			expect(meter.p?.value).toBe(breakdown.usedTokens / breakdown.contextWindow);
			expect(meter.p?.parts?.map(part => part.value)).toEqual([
				21250 / 200000,
				10625 / 200000,
				10625 / 200000,
				10625 / 200000,
				31875 / 200000,
				95000 / 200000,
				20000 / 200000,
			]);
			expect(meter.p?.parts?.at(-1)).toMatchObject({ token: "warning", hatch: true });
			expect(meter.p?.marks?.[0]?.at).toBe(breakdown.thresholdTokens! / breakdown.contextWindow);
			const body = root.c?.findIndex(child => "k" in child && child.key === "overview");
			const bar = root.c?.findIndex(child => "k" in child && child.k === "meter");
			expect(bar).toBeLessThan(body!);
		}
		expect(nodes(h.viewer.describe(cx)).some(node => node.k === "meter")).toBe(false);
	});
});

describe("ContextViewer entry content", () => {
	it("shows a shared replay total once before unknown children and preserves it when opening either child", () => {
		const data = fixture();
		const group: ContextThinkingGroup = {
			id: "thinking-group",
			label: "Assistant thinking · turn 1",
			tokens: 1250,
		};
		const categories: ContextViewCategory[] = [
			{
				id: "assistant-thinking",
				label: "Assistant Thinking",
				tokens: 1275,
				entries: [
					...["first", "second"].map(id => ({
						id,
						label: `${id} block`,
						tokens: 0,
						thinkingGroup: group,
						text: `${id} thinking body`,
					})),
					{ id: "ordinary", label: "ordinary block", tokens: 25, text: "ordinary body" },
				],
			},
		];
		const h = harness({ ...data, categories });
		h.resize(32);
		h.render(160);
		select(h.viewer, "assistant-thinking");
		for (const preview of [h.render(160).join("\n"), nativeText(h.viewer.describe({ ...cx, cols: 160 }))]) {
			// The shared replay total appears once, on the group heading ahead of its members.
			expect(preview.match(/1,250/g)).toHaveLength(1);
			expect(preview.indexOf(group.label)).toBeLessThan(preview.indexOf("[first block]"));
			// Members of a group carry no estimate of their own; ordinary entries do.
			expect(lineWith(preview, "[first block]")).not.toMatch(/\d/);
			expect(lineWith(preview, "[second block]")).not.toMatch(/\d/);
			expect(lineWith(preview, "[ordinary block]")).toContain("25");
			expect(preview).not.toMatch(/\] 0\b/);
		}
		for (const id of ["first", "second"]) {
			h.viewer.handleNativeEvent({ type: "action", key: `entries/content/list/${id}`, act: "open-entry", mods: [] });
			for (const detail of [h.render(160).join("\n"), nativeText(h.viewer.describe({ ...cx, cols: 160 }))]) {
				expect(lineWith(detail, `[${id} block]`)).not.toMatch(/\d/);
				expect(lineWith(detail, group.label)).toContain("1,250");
				expect(detail).toContain(`${id} thinking body`);
			}
			h.viewer.handleInput("\x1b");
		}
	});

	it("renders interrupted single and grouped estimates as unavailable rather than zero tokens", () => {
		const data = fixture();
		const group: ContextThinkingGroup = {
			id: "interrupted-group",
			label: "Interrupted thinking turn",
			tokens: 0,
			interrupted: true,
		};
		data.categories[0]!.entries = [
			{
				id: "interrupted-single",
				label: "interrupted single",
				tokens: 0,
				interrupted: true,
				text: "[interrupted]",
			},
			...["first", "second"].map(id => ({
				id,
				label: `${id} interrupted block`,
				tokens: 0,
				thinkingGroup: group,
				text: "[interrupted]",
			})),
		];
		const h = harness(data);
		h.resize(32);
		h.render(160);
		select(h.viewer, "system-prompt");
		for (const preview of [h.render(160).join("\n"), nativeText(h.viewer.describe({ ...cx, cols: 160 }))]) {
			// Interrupted estimates are unavailable, never a zero count; a lone interrupted entry is
			// not mistaken for a group member, whose estimate lives on its group heading.
			expect(lineWith(preview, "[interrupted single]")).not.toMatch(/\d|—/);
			expect(lineWith(preview, group.label)).not.toMatch(/\d/);
			expect(preview).not.toMatch(/\b0 tokens/);
		}
		for (const [id, heading] of [
			["interrupted-single", "[interrupted single]"],
			["second", group.label],
		] as const) {
			h.viewer.handleNativeEvent({ type: "action", key: `entries/content/list/${id}`, act: "open-entry", mods: [] });
			for (const detail of [h.render(160).join("\n"), nativeText(h.viewer.describe({ ...cx, cols: 160 }))]) {
				expect(lineWith(detail, heading)).not.toMatch(/\d|—/);
				expect(detail).not.toMatch(/\b0 tokens/);
			}
			h.viewer.handleInput("\x1b");
		}
	});

	it("preserves body paths while sanitizing terminal controls in ANSI and native content", () => {
		const data = fixture();
		const path = `${os.homedir()}/context-viewer/source.txt`;
		data.categories[0]!.entries[0] = {
			id: "source",
			label: "source",
			tokens: 1,
			path,
			text: `Source: ${path}\n\tbody\x1b[31m visible\x1b[0m`,
		};
		const h = harness(data);
		h.render();
		select(h.viewer, "system-prompt");
		const ansi = h.render(160).join("\n");
		expect(ansi).toContain(`Source: ${path}`);
		expect(ansi).not.toContain("\t");
		const body = nodes(h.viewer.describe({ ...cx, cols: 160 }))
			.filter(node => node.k === "text")
			.flatMap(node =>
				node.k === "text" ? [node.p?.text ?? "", ...(node.p?.spans?.map(span => span.t) ?? [])] : [],
			)
			.join("\n");
		expect(body).toContain(`Source: ${path}`);
		expect(body).not.toContain("\x1b");
	});

	it("refreshes cached preview and full-content timestamps when the clock format changes at the same width", () => {
		const h = harness();
		const context = { ...cx, cols: 160, hour12: true };
		h.resize(32);
		h.viewer.describe(context);
		select(h.viewer, "tool-output");
		for (const page of ["preview", "full"]) {
			if (page === "full")
				h.viewer.handleNativeEvent({
					type: "action",
					key: "entries/content/list/result/0",
					act: "open-entry",
					mods: [],
				});
			for (const hour12 of [true, false, true]) {
				const expected = new Date(0).toLocaleString([], {
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
					hour12,
				});
				expect(nativeText(h.viewer.describe({ ...context, hour12 }))).toContain(expected);
				expect(h.render(160).join("\n")).toContain(expected);
			}
		}
	});
});

describe("ContextViewer layout", () => {
	it("preserves the footer divider and bottom border at short heights in overview, preview and full content", () => {
		const h = harness();
		for (const page of ["overview", "category", "entry"]) {
			if (page === "category") select(h.viewer, "tool-output");
			if (page === "entry") h.viewer.handleInput("\r");
			for (const height of [18, 6, 4]) {
				h.resize(height);
				const lines = h.render(48);
				expect(lines).toHaveLength(height);
				expect(lines.at(-3)).toMatch(/^├.*┤$/);
				expect(lines.at(-1)).toMatch(/^╰.*╯$/);
				expect(lines.every(line => visibleWidth(line) <= 48)).toBe(true);
			}
			h.resize(24);
			h.render();
		}
	});
});
