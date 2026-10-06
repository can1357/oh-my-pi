import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import type { TspKind } from "@oh-my-pi/pi-wire";
import { describeWorkingRow } from "@oh-my-pi/pi-tui/components/loader";
import { SelectList } from "@oh-my-pi/pi-tui/components/select-list";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { type ComposerNativeState, CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { QueuedMessagesBand } from "@oh-my-pi/pi-tui/prompt/queued-messages";
import { createStartupStatusLine } from "@oh-my-pi/pi-tui/status-line/startup";
import { getEditorTheme, getSelectListTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

const context = (kinds: readonly TspKind[] | "all"): DescribeContext => ({
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports: kind => kinds === "all" || kinds.includes(kind),
	feature: () => true,
});
const cx = context("all");

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child;
}

/** A dock child that is a component rather than a described node. */
function isComponent(child: NativeChild): child is Component {
	return typeof (child as Component).render === "function";
}

/** Every described node under `root` (component children are not expanded). */
function nodes(root: NativeNode): NativeNode[] {
	const out: NativeNode[] = [root];
	for (const child of root.c ?? []) if (isNode(child)) out.push(...nodes(child));
	return out;
}

function byRole(root: NativeNode, role: string): NativeNode | undefined {
	return nodes(root).find(n => n.p !== undefined && "role" in n.p && n.p.role === role);
}

function composer(state: ComposerNativeState): CustomEditor {
	const editor = new CustomEditor(getEditorTheme());
	editor.composerState = () => state;
	return editor;
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setNativeRendering(false);
});

describe("native composer", () => {
	it("tints the composer by shell mode and marks `!!` as not sent to the model", () => {
		const bash = composer({ running: false, shell: { kind: "bash", excluded: true } }).describe(cx);
		expect(bash.p).toMatchObject({ role: "omp.editor.bash" });
		const mode = byRole(bash, "omp.composer.mode")!;
		expect(nodes(mode).map(n => n.k)).toEqual(["row", "icon", "text"]);
		expect(nodes(mode)[1]!.p).toMatchObject({ name: "eye-off" });

		const python = composer({ running: false, shell: { kind: "python", excluded: false } }).describe(cx);
		expect(python.p).toMatchObject({ role: "omp.editor.python" });
		expect(nodes(byRole(python, "omp.composer.mode")!).some(n => n.k === "icon")).toBe(false);

		const prompt = composer({ running: false }).describe(cx);
		expect(prompt.p).toMatchObject({ role: "omp.editor" });
		expect(byRole(prompt, "omp.composer.mode")).toBeUndefined();
	});

	it("draws a shell-mode draft as code in its language, the sigil hidden behind the mode chip", () => {
		const input = (editor: CustomEditor) => nodes(editor.describe(cx)).find(n => n.k === "editor")!;
		const python = composer({ running: false, shell: { kind: "python", excluded: true } });
		python.setText("  $$ df.describe()");
		expect(input(python).p).toMatchObject({ lang: "python", decor: [{ from: 0, to: 5, s: "hide" }] });

		// No blank after the sigil: only the sigil hides; prose decorations stay off in code.
		const bash = composer({ running: false, shell: { kind: "bash", excluded: false } });
		bash.setText("!ultrathink ls");
		expect(input(bash).p).toMatchObject({ lang: "bash", decor: [{ from: 0, to: 1, s: "hide" }] });

		const prompt = composer({ running: false });
		prompt.setText("$ ultrathink");
		const props = input(prompt).p;
		expect(props).not.toMatchObject({ lang: expect.anything() });
		expect(props).not.toMatchObject({ decor: expect.arrayContaining([expect.objectContaining({ s: "hide" })]) });
	});

	it("swaps the send keycap for Stop while a turn runs, and routes clicks to the key handlers", () => {
		let running = false;
		const editor = new CustomEditor(getEditorTheme());
		editor.composerState = () => ({ running, thinking: "high" });
		editor.onCycleThinkingLevel = vi.fn();
		editor.onEscape = vi.fn();
		const idle = editor.describe(cx);
		expect(idle.p).not.toHaveProperty("tone");
		expect(byRole(idle, "omp.composer.send")?.p).toMatchObject({ keys: ["enter"], actions: { click: "submit" } });
		expect(byRole(idle, "omp.composer.stop")).toBeUndefined();
		const chip = byRole(idle, "omp.composer.effort")!;
		expect(chip.p).toMatchObject({ actions: { click: "thinking.cycle" } });
		expect(nodes(chip).find(n => n.k === "effort")?.p).toEqual({ level: "high" });
		expect(nodes(chip).find(n => n.k === "text")?.p).toMatchObject({ text: "high" });

		running = true;
		const busy = editor.describe(cx);
		expect(busy.p).toMatchObject({ tone: "pending" });
		expect(byRole(busy, "omp.composer.send")).toBeUndefined();
		expect(byRole(busy, "omp.composer.stop")?.p).toMatchObject({ actions: { click: "interrupt" }, tone: "error" });

		editor.handleNativeEvent({ type: "action", key: "bar/effort", act: "thinking.cycle", mods: [] });
		editor.handleNativeEvent({ type: "action", key: "bar/stop", act: "interrupt", mods: [] });
		expect(editor.onCycleThinkingLevel).toHaveBeenCalledTimes(1);
		expect(editor.onEscape).toHaveBeenCalledTimes(1);
	});

	it("names the viewed subagent over the draft and routes its links to the focus handler", () => {
		expect(byRole(composer({ running: false }).describe(cx), "omp.composer.focus")).toBeUndefined();

		const editor = composer({ running: false, viewing: ["AckAudit", "Scout"] });
		const focused: string[] = [];
		editor.onFocusAgent = id => focused.push(id);
		const root = editor.describe(cx);
		const header = byRole(root, "omp.composer.focus")!;
		const lead = (root.c ?? []).filter(isNode);
		expect(lead.indexOf(header)).toBeLessThan(lead.indexOf(byRole(root, "omp.composer.line")!));
		expect(byRole(header, "omp.composer.agent")?.p).toMatchObject({ text: "Scout" });
		expect(nodes(root).find(n => n.k === "editor")?.p).toMatchObject({ placeholder: "Message Scout" });
		expect(byRole(header, "omp.composer.crumb")?.p).toMatchObject({
			text: "AckAudit",
			actions: { click: "focus:AckAudit" },
		});
		expect(byRole(header, "omp.composer.exit")?.p).toMatchObject({ actions: { click: "focus:Main" } });

		for (const act of ["focus:AckAudit", "focus:Main"]) {
			editor.handleNativeEvent({ type: "action", key: "focus", act, mods: [] });
		}
		expect(focused).toEqual(["AckAudit", "Main"]);
	});

	it("memoizes send readiness separately from editability during bootstrap", () => {
		const editor = composer({ running: false });
		editor.disableSubmit = true;
		editor.setText("editable draft");
		const bootstrap = editor.describe(cx);
		expect(nodes(bootstrap).find(n => n.k === "editor")?.p).toMatchObject({
			text: "editable draft",
			sendable: false,
		});
		editor.onSubmit = vi.fn();
		expect(editor.describe(cx)).toBe(bootstrap);

		editor.disableSubmit = false;
		const ready = editor.describe(cx);
		expect(ready).not.toBe(bootstrap);
		expect(nodes(ready).find(n => n.k === "editor")?.p).toMatchObject({
			text: "editable draft",
			sendable: true,
		});
		expect(editor.describe(cx)).toBe(ready);

		editor.onSubmit = undefined;
		expect(nodes(editor.describe(cx)).find(n => n.k === "editor")?.p).toMatchObject({
			text: "editable draft",
			sendable: false,
		});
	});

	it("submits the draft on a send click like Enter", () => {
		const editor = composer({ running: false });
		const submitted: string[] = [];
		editor.onSubmit = text => {
			submitted.push(text);
		};
		editor.setText("hello");
		editor.handleNativeEvent({ type: "action", key: "bar/send", act: "submit", mods: [] });
		expect(submitted).toEqual(["hello"]);
	});

	it("keeps the effort chip at `off` with an empty glyph so a click can turn thinking back on", () => {
		const chip = byRole(composer({ running: false, thinking: "off" }).describe(cx), "omp.composer.effort")!;
		expect(chip.p).toMatchObject({ actions: { click: "thinking.cycle" } });
		expect(nodes(chip).find(n => n.k === "effort")?.p).toEqual({ level: "off" });
		expect(nodes(chip).find(n => n.k === "text")?.p).toMatchObject({ text: "off" });
	});

	it("sends an unresolved `auto` level through to the effort glyph", () => {
		const chip = byRole(composer({ running: false, thinking: "auto" }).describe(cx), "omp.composer.effort")!;
		expect(nodes(chip).map(n => n.k)).toEqual(["row", "effort", "text"]);
		expect(nodes(chip)[1]!.p).toEqual({ level: "auto" });
	});

	it("falls back to a four-step blocks meter where the terminal lacks the effort kind", () => {
		const legacy = context(["row", "text", "icon", "meter", "editor", "kbd"]);
		const chipFor = (thinking: string) =>
			byRole(composer({ running: false, thinking }).describe(legacy), "omp.composer.effort")!;
		expect(nodes(chipFor("high")).some(n => n.k === "effort")).toBe(false);
		expect(nodes(chipFor("high")).find(n => n.k === "meter")?.p).toMatchObject({
			value: 0.75,
			style: "blocks",
			steps: 4,
		});
		expect(nodes(chipFor("off")).find(n => n.k === "meter")?.p).toMatchObject({ value: 0 });
		expect(nodes(chipFor("auto")).find(n => n.k === "meter")?.p).toMatchObject({ value: null });
	});

	it("rebuilds the effort chip when the effort capability changes", () => {
		const editor = composer({ running: false, thinking: "max" });
		const kinds = (root: NativeNode) => nodes(byRole(root, "omp.composer.effort")!).map(n => n.k);
		expect(kinds(editor.describe(context(["row", "text", "meter"])))).toContain("meter");
		expect(kinds(editor.describe(cx))).toContain("effort");
	});

	it("omits the effort chip when the model has no thinking", () => {
		expect(byRole(composer({ running: false }).describe(cx), "omp.composer.effort")).toBeUndefined();
	});

	it("docks the tok/s readout right after the effort chip, only while there is a reading", () => {
		let rate: number | undefined = 31.8;
		const editor = new CustomEditor(getEditorTheme());
		editor.composerState = () => ({ running: false, thinking: "xhigh", rate });
		const bar = () => byRole(editor.describe(cx), "omp.composer.bar")!;
		const slots = (root: NativeNode) =>
			(root.c ?? []).filter(isNode).map(n => (n.p !== undefined && "role" in n.p ? n.p.role : n.key));

		const reading = bar();
		expect(slots(reading)).toEqual(["omp.composer.effort", "omp.composer.rate", "gap", "omp.composer.send"]);
		expect(byRole(reading, "omp.composer.rate")?.p).toEqual({
			value: 31.8,
			unit: "tok/s",
			role: "omp.composer.rate",
			title: "Generation rate",
		});

		// A rate tick re-describes the readout alone: the chips beside it keep their nodes.
		rate = 32.4;
		const ticked = bar();
		expect(byRole(ticked, "omp.composer.rate")?.p).toMatchObject({ value: 32.4 });
		expect(byRole(ticked, "omp.composer.effort")).toBe(byRole(reading, "omp.composer.effort"));

		rate = undefined;
		expect(slots(bar())).toEqual(["omp.composer.effort", "gap", "omp.composer.send"]);
	});
});

describe("native composer thinking level in the model chip", () => {
	function withFacts(state: ComposerNativeState): CustomEditor {
		const editor = composer(state);
		editor.composerFacts = createStartupStatusLine({
			settings: { preset: "custom", leftSegments: [], rightSegments: [] },
			gitEnabled: false,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});
		return editor;
	}

	it("draws the level as the model chip's icon, cycling on click, and drops the effort chip", () => {
		const root = withFacts({ running: false, thinking: "xhigh", thinkingInModel: true }).describe(cx);
		expect(byRole(root, "omp.composer.effort")).toBeUndefined();
		const model = byRole(root, "omp.composer.model")!;
		expect((model.c ?? []).filter(isNode).map(n => n.k)).toEqual(["effort", "text", "icon"]);
		expect(byRole(model, "omp.composer.model.effort")?.p).toMatchObject({
			level: "xhigh",
			// The level, then the cycle key as the effort chip's tooltip names it.
			title: expect.stringMatching(/^Thinking effort: xhigh {2}\S/),
			actions: { click: "thinking.cycle" },
		});
	});

	it("keeps the model icon and the effort chip where the terminal lacks the effort kind", () => {
		const legacy = context(["row", "text", "icon", "meter", "editor", "kbd"]);
		const root = withFacts({ running: false, thinking: "xhigh", thinkingInModel: true }).describe(legacy);
		expect(byRole(root, "omp.composer.model.effort")).toBeUndefined();
		expect((byRole(root, "omp.composer.model")!.c ?? []).filter(isNode)[0]?.p).toMatchObject({ name: "model" });
		expect(byRole(root, "omp.composer.effort")).toBeDefined();
	});
});

describe("native working row", () => {
	it("counts a retry down in a ring and offers Cancel; without meter support it spins", () => {
		const spec = {
			label: "Retrying · attempt 1 of 3",
			startedAt: 1_000,
			variant: { kind: "retry", attempt: 1, max: 3, delayMs: 4_000 } as const,
			interruptKey: "escape",
		};
		const row = describeWorkingRow(spec, cx, 2_000);
		const first = row.c![0] as NativeNode;
		expect(first.k).toBe("meter");
		expect(first.p).toMatchObject({ value: 0.75, style: "ring" });
		const stop = byRole(row, "omp.working.stop")!;
		expect(stop.p).toMatchObject({ title: "Cancel  esc", actions: { click: "interrupt" } });

		const plain = describeWorkingRow(spec, context([]), 2_000);
		expect((plain.c![0] as NativeNode).k).toBe("spinner");
	});

	it("leads with the spinner and the elapsed time, then the divider and the intent, without a tok/s readout", () => {
		const row = describeWorkingRow({ label: "Diagnosing", startedAt: 0, interruptKey: "escape" }, cx, 10);
		expect((row.c ?? []).filter(isNode).map(n => n.key)).toEqual([
			"spinner",
			"elapsed",
			"sep",
			"label",
			"fill",
			"stop",
		]);
	});

	it("shows indeterminate progress while compacting and no stop control when Esc would not cancel", () => {
		const row = describeWorkingRow(
			{ label: "Compacting context…", startedAt: 0, variant: { kind: "compaction" } },
			cx,
			10,
		);
		expect(nodes(row).find(n => n.k === "progress")?.p).toEqual({ value: null });
		expect(byRole(row, "omp.working.stop")).toBeUndefined();
	});
});

describe("native queued messages", () => {
	it("counts the queue in the first pill only and edits through the dequeue path", () => {
		const onEdit = vi.fn();
		const band = new QueuedMessagesBand(
			[
				{ label: "Steering", messages: ["one", "two"] },
				{ label: "After yield", messages: ["three"] },
			],
			"alt+up",
			onEdit,
		);
		const pills = (band.describe().c ?? []).filter(isNode);
		expect(pills).toHaveLength(3);
		const counts = pills.map(pill => byRole(pill, "omp.queue.count")?.p);
		expect(counts).toEqual([{ text: "3", role: "omp.queue.count" }, undefined, undefined]);
		band.handleNativeEvent({ type: "action", key: "x/edit", act: "queue.edit", mods: [] });
		expect(onEdit).toHaveBeenCalledTimes(1);

		const single = new QueuedMessagesBand([{ label: "Steering", messages: ["only"] }], "alt+up", onEdit);
		expect(byRole(single.describe(), "omp.queue.count")).toBeUndefined();
	});
});

describe("native autocomplete list", () => {
	it("marks the typed prefix, names the icon and shows live state as the value", () => {
		const list = new SelectList(
			[
				{
					value: "model",
					label: "model",
					icon: "\uec19",
					iconName: "model",
					description: "Model: demo/demo",
					nativeDetail: "Select model",
					state: "demo/demo",
				},
				{ value: "move", label: "move", description: "Move the session" },
			],
			8,
			getSelectListTheme(),
		);
		list.setNativeMark("mo");
		const described = list.describe(cx);
		const listNode = nodes(described).find(n => n.k === "list")!;
		expect(listNode.p).toMatchObject({ selected: "model" });
		expect(listNode.p !== undefined && "filter" in listNode.p ? listNode.p.filter : undefined).toBeUndefined();
		const [model, move] = (listNode.c ?? []).filter(isNode);
		expect(model!.p).toMatchObject({
			icon: "model",
			label: [{ t: "mo", s: "mark" }, { t: "del" }],
			detail: [{ t: "Select model", s: "muted" }],
			value: [{ t: "demo/demo", s: "muted" }],
		});
		expect(move!.p).toMatchObject({ label: [{ t: "mo", s: "mark" }, { t: "ve" }] });
	});
});

describe("native composer without a status strip", () => {
	it("docks an empty status block; the composer carries model, effort, context and usage", () => {
		setNativeRendering(true);
		const composer = new Composer({
			terminal: new VirtualTerminal(80, 24),
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
			status: {
				statusLine: {
					settings: {
						preset: "custom",
						leftSegments: ["model", "path", "git", "hostname"],
						rightSegments: ["context_pct", "cost"],
					},
					gitEnabled: false,
					autoThinking: false,
					fastMode: false,
					usingSubscription: false,
					autoCompactEnabled: false,
					compactionBoundaries: null,
				},
			},
		});
		composer.start();
		try {
			composer.editor.composerState = () => ({ running: false, thinking: "high" });
			const { dock } = composer.describeSurface();
			// The status host trails the dock, as it trails the ANSI roots, so a
			// renderer has somewhere to paint on this surface too.
			expect(dock[0]).toBe(composer.editor);
			expect(dock).toHaveLength(2);
			// With no renderer installed it describes nothing, so the dock still
			// shows no status bar — which is the point of the arrangement.
			const host = dock[1]!;
			expect(isComponent(host) ? host.describe?.(cx) : undefined).toEqual({ k: "col", c: [] });
			const described = composer.editor.describe(cx);
			expect(nodes(described).some(n => n.p !== undefined && "role" in n.p && n.p.role === "omp.status")).toBe(
				false,
			);

			// The context hairline leads the composer; the bar closes it.
			const [first] = (described.c ?? []).filter(isNode);
			expect(first).toMatchObject({
				k: "meter",
				p: { role: "omp.composer.context", style: "bar", actions: { click: "status.context" } },
			});
			const bar = byRole(described, "omp.composer.bar")!;
			expect(
				(bar.c ?? []).filter(isNode).map(n => (n.p !== undefined && "role" in n.p ? n.p.role : undefined)),
			).toEqual([
				"omp.composer.model",
				"omp.composer.effort",
				"omp.composer.extras",
				"omp.composer.usage",
				"omp.composer.send",
			]);
			const model = byRole(bar, "omp.composer.model")!;
			expect(model.p).toMatchObject({ actions: { click: "status.model" } });
			expect(nodes(model).map(n => n.k)).toEqual(["row", "icon", "text", "icon"]);
			// Path and branch belong to Tern's pane header; the rest stays as a fact.
			const extras = byRole(bar, "omp.composer.extras")!;
			expect((extras.c ?? []).filter(isNode).map(n => n.key)).toEqual(["hostname"]);
			expect(byRole(bar, "omp.composer.usage")?.p).toMatchObject({ actions: { click: "status.cost" } });
		} finally {
			composer.stop();
		}
	});

	it("sends the model chip's click to the status line's model action", () => {
		const line = createStartupStatusLine({
			settings: { preset: "custom", leftSegments: [], rightSegments: [] },
			gitEnabled: false,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});
		const actions: string[] = [];
		line.onNativeAction = action => actions.push(action);
		const editor = composer({ running: false });
		editor.composerFacts = line;
		editor.handleNativeEvent({ type: "action", key: "bar/model", act: "status.model", mods: [] });
		expect(actions).toEqual(["status.model"]);
	});
});
