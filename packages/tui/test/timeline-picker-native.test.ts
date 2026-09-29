import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TspKind, TspPickerProps, TspProps } from "@oh-my-pi/pi-wire";
import type { SessionMessageEntryLike } from "../src/chat/transcript-entry";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import type { TUI } from "../src/index";
import { CopySelectorComponent } from "../src/overlays/copy-selector";
import { RewindSelectorComponent } from "../src/overlays/rewind-selector";
import { TreeSelectorComponent, type TreeSelectorNode } from "../src/overlays/tree-selector";
import { initTheme } from "../src/theme";

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const genericCx: DescribeContext = { ...pickerCx, supports: (kind: TspKind) => kind !== "picker" };
const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

beforeAll(async () => {
	await initTheme(false);
});

function entry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntryLike {
	return { type: "message", id, parentId, timestamp: "2026-09-28T09:05:00", message } as SessionMessageEntryLike;
}

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 }) as AgentMessage;

function assistant(content: unknown[]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "demo",
		model: "demo",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 2,
	} as unknown as AgentMessage;
}

const toolResult = (callId: string, text: string) =>
	({
		role: "toolResult",
		toolCallId: callId,
		toolName: "grep",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	}) as unknown as AgentMessage;

/** u1 → a1 (grep call) → t1 → a2 (prose with a code block) → u2. */
function transcript(): SessionMessageEntryLike[] {
	return [
		entry("u1", null, user("find the ack")),
		entry("a1", "u1", assistant([{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "ack" } }])),
		entry("t1", "a1", toolResult("c1", "src/frame.rs:12: ack")),
		entry("a2", "t1", assistant([{ type: "text", text: "Found it:\n\n```rust\nfn ack() {}\n```" }])),
		entry("u2", "a2", user("thanks")),
	];
}

function props(root: NativeNode): TspPickerProps {
	if (root.k !== "picker" || !root.p) throw new Error(`expected a picker root, got ${root.k}`);
	return root.p;
}

const typeText = (component: { handleInput(data: string): void }, text: string) => {
	for (const ch of text) component.handleInput(ch);
};

describe("rewind picker", () => {
	function rewind(selected: string[] = [], cancelled: { count: number } = { count: 0 }) {
		return new RewindSelectorComponent(transcript(), {
			ui,
			cwd: "/tmp",
			requestRender: () => {},
			onSelect: id => selected.push(id),
			onCancel: () => cancelled.count++,
		});
	}

	test("describes a timeline picker of turns when supported, the card otherwise", () => {
		const selector = rewind();
		expect(selector.nativeSheet(genericCx)).toBe(false);
		expect(selector.describe(genericCx).k).toBe("card");

		expect(selector.nativeSheet(pickerCx)).toBe(true);
		const p = props(selector.describe(pickerCx));
		expect([p.layout, p.size, p.icon, p.query]).toEqual(["timeline", "lg", "rewind", null]);
		expect(p.items?.map(item => [item.id, item.node, item.role, item.label])).toEqual([
			["u1", "user", undefined, "find the ack"],
			["a1", "tool", "omp.tool.grep", "grep ack"],
			["a2", "assistant", undefined, "Found it:"],
			["u2", "user", undefined, "thanks"],
		]);
		expect(p.items?.[0]?.facts).toEqual({ at: "09:05" });
		expect(p.selected).toBe("u2");
		expect(p.actions?.map(action => action.id)).toEqual(["rewind", "lateral", "filter", "close"]);
	});

	test("the preview is the turn's own transcript components under the drop warning", () => {
		const selector = rewind();
		selector.handleNativeEvent({ type: "select", key: "", item: "u1" });
		const root = selector.describe(pickerCx);
		const [caption, ...turn] = root.c ?? [];
		expect(JSON.stringify((caption as NativeNode).p)).toContain("everything below is dropped");
		expect(JSON.stringify((caption as NativeNode).p)).toContain("4 turns");
		expect(turn.length).toBeGreaterThan(0);
		expect(turn.every((child: NativeChild) => !("k" in child))).toBe(true);
	});

	test("a row click outlines without rewinding; activate and the primary action rewind like Enter", () => {
		const selected: string[] = [];
		const selector = rewind(selected);
		selector.handleNativeEvent({ type: "select", key: "", item: "a1" });
		expect(props(selector.describe(pickerCx)).selected).toBe("a1");
		expect(selected).toEqual([]);

		selector.handleNativeEvent({ type: "action", key: "", act: "rewind", mods: [] });
		// The tool result folds into its call's turn: rewinding there keeps the output.
		expect(selected).toEqual(["t1"]);
		selector.handleNativeEvent({ type: "activate", key: "", item: "u1" });
		expect(selected).toEqual(["t1", "u1"]);
	});

	test("filtering shows the query, narrows only `order`, and Close leaves the filter first", () => {
		const cancelled = { count: 0 };
		const selector = rewind([], cancelled);
		const items = props(selector.describe(pickerCx)).items;

		selector.handleInput("f");
		// Under TSP the filter matches turn text, not rendered rows.
		setNativeRendering(true);
		try {
			typeText(selector, "ack");
			const filtered = props(selector.describe(pickerCx));
			expect(filtered.query).toBe("ack");
			expect(filtered.items).toBe(items);
			expect(filtered.order).toEqual(["u1", "a1", "a2"]);
		} finally {
			setNativeRendering(false);
		}

		selector.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
		expect(props(selector.describe(pickerCx)).query).toBeNull();
		expect(cancelled.count).toBe(0);
		selector.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
		expect(cancelled.count).toBe(1);
	});
});

describe("copy picker", () => {
	function copy(picks: string[]) {
		return new CopySelectorComponent(transcript(), {
			ui,
			cwd: "/tmp",
			requestRender: () => {},
			onPick: (content, label) => picks.push(`${label}:${content}`),
			onCancel: () => {},
		});
	}

	test("the preview stacks the whole message and its blocks; Blocks focuses the first", () => {
		const selector = copy([]);
		selector.handleNativeEvent({ type: "select", key: "", item: "a2" });
		let root = selector.describe(pickerCx);
		expect(props(root).focus).toBe("list");
		const sections = () => (root.c ?? []) as NativeNode[];
		expect(
			sections().map(section => [section.key, (section.p as TspProps<"section">).head, section.p?.role]),
		).toEqual([
			["whole", "Whole message", "omp.picker.block"],
			["b0", expect.stringContaining("rust"), "omp.picker.block"],
		]);
		expect(sections()[1]?.p?.actions?.click).toBe("copy");

		selector.handleNativeEvent({ type: "action", key: "", act: "blocks", mods: [] });
		root = selector.describe(pickerCx);
		expect(props(root).focus).toBe("preview");
		expect(sections()[1]?.p?.role).toBe("omp.picker.block.focused");
		expect(props(root).actions?.find(action => action.id === "close")?.label).toBe("Back");
	});

	test("the Copy action picks the focused block, activate picks a whole turn", () => {
		const picks: string[] = [];
		const selector = copy(picks);
		selector.handleNativeEvent({ type: "select", key: "", item: "a2" });
		selector.handleInput("\x1b[C");
		selector.handleNativeEvent({ type: "action", key: "", act: "pick", mods: [] });
		expect(picks).toEqual(["rust code:fn ack() {}"]);

		selector.handleNativeEvent({ type: "activate", key: "", item: "u1" });
		expect(picks.at(-1)).toBe("user message:find the ack");
		expect(props(selector.describe(pickerCx)).focus).toBe("list");
	});
});

describe("session tree picker", () => {
	/** u1 → a1 → {u2 → a3 (active leaf), u3 (labeled "idea")}. */
	function tree(): TreeSelectorNode[] {
		const node = (e: SessionMessageEntryLike, children: TreeSelectorNode[] = [], label?: string) =>
			({ entry: e, children, label }) as TreeSelectorNode;
		return [
			node(entry("u1", null, user("find the ack")), [
				node(entry("a1", "u1", assistant([{ type: "text", text: "Found it." }])), [
					node(entry("u2", "a1", user("rewrite it")), [
						node(entry("a3", "u2", assistant([{ type: "text", text: "done" }]))),
					]),
					node(entry("u3", "a1", user("explain it")), [], "idea"),
				]),
			]),
		];
	}

	function treeSelector(switched: string[] = [], cancelled: { count: number } = { count: 0 }) {
		return new TreeSelectorComponent(
			tree(),
			"a3",
			40,
			(id, options) => switched.push(`${id}${options.summarize ? "+summary" : ""}`),
			() => cancelled.count++,
			undefined,
			"default",
			"Frame acks",
		);
	}

	function treeProps(selector: TreeSelectorComponent): TspPickerProps {
		const root = selector.describe(pickerCx);
		const sheet = root.c?.[0] as NativeNode | undefined;
		if (root.k !== "col" || sheet?.key !== "picker") throw new Error("expected a column holding the picker");
		return props(sheet);
	}

	test("describes the tree picker when supported: depth, active path, label badge, current leaf", () => {
		const selector = treeSelector();
		expect(selector.describe(genericCx).k).toBe("card");
		const p = treeProps(selector);
		expect([p.layout, p.icon, p.subtitle, p.tab]).toEqual(["tree", "git-branch", "Frame acks", "default"]);
		expect(p.current).toEqual(["a3"]);
		const byId = new Map(p.items?.map(item => [item.id, item]));
		expect(byId.get("a1")?.open).toBe(true);
		expect(byId.get("u2")?.dot).toBe("accent");
		expect(byId.get("u3")?.dot).toBeUndefined();
		expect(byId.get("u3")?.badges).toEqual([{ text: "idea", tone: "warning" }]);
		expect((byId.get("u2")?.depth ?? 0) > (byId.get("a1")?.depth ?? 0)).toBe(true);
		expect(p.selected).toBe("a3");
	});

	test("typing and filter tabs change the order, never the catalogue", () => {
		const selector = treeSelector();
		const { items } = treeProps(selector);
		typeText(selector, "explain");
		const searched = treeProps(selector);
		expect(searched.items).toBe(items);
		expect(searched.query).toBe("explain");
		expect(searched.order).toEqual(["u3"]);

		selector.handleInput("\x1b");
		selector.handleNativeEvent({ type: "action", key: "^picker", act: "tab", value: "user-only", mods: [] });
		const users = treeProps(selector);
		expect(users.tab).toBe("user-only");
		expect(users.order).toEqual(["u1", "u2", "u3"]);
		expect(users.items).toBe(items);
	});

	test("pointer events take the keys' paths: select, Summarize & switch, Close", () => {
		const switched: string[] = [];
		const cancelled = { count: 0 };
		const selector = treeSelector(switched, cancelled);
		selector.handleNativeEvent({ type: "select", key: "^picker", item: "u3" });
		expect(treeProps(selector).selected).toBe("u3");
		expect(switched).toEqual([]);

		selector.handleNativeEvent({ type: "action", key: "^picker", act: "summarize", mods: [] });
		expect(switched).toEqual(["u3+summary"]);
		selector.handleNativeEvent({ type: "activate", key: "^picker", item: "u1" });
		expect(switched).toEqual(["u3+summary", "u1"]);
		selector.handleNativeEvent({ type: "action", key: "^picker", act: "close", mods: [] });
		expect(cancelled.count).toBe(1);
	});

	test("the Label action edits in the preview and the saved label becomes a badge", () => {
		const labels: string[] = [];
		const selector = new TreeSelectorComponent(
			tree(),
			"a3",
			40,
			() => {},
			() => {},
			(id, label) => labels.push(`${id}=${label}`),
		);
		selector.handleNativeEvent({ type: "action", key: "^picker", act: "label", mods: [] });
		expect(treeProps(selector).focus).toBe("preview");
		typeText(selector, "ship");
		selector.handleNativeEvent({ type: "action", key: "^picker", act: "label-save", mods: [] });
		expect(labels).toEqual(["a3=ship"]);
		const p = treeProps(selector);
		expect(p.focus).toBe("list");
		expect(p.items?.find(item => item.id === "a3")?.badges).toEqual([{ text: "ship", tone: "warning" }]);
	});
});
