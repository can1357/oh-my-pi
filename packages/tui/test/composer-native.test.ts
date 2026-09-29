import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
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
		expect(nodes(chip).find(n => n.k === "meter")?.p).toMatchObject({ value: 0.75, style: "blocks", steps: 4 });
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

	it("keeps the effort chip at `off` with an empty meter so a click can turn thinking back on", () => {
		const chip = byRole(composer({ running: false, thinking: "off" }).describe(cx), "omp.composer.effort")!;
		expect(chip.p).toMatchObject({ actions: { click: "thinking.cycle" } });
		expect(nodes(chip).find(n => n.k === "meter")?.p).toMatchObject({ value: 0 });
		expect(nodes(chip).find(n => n.k === "text")?.p).toMatchObject({ text: "off" });
	});

	it("omits the effort chip when the model has no thinking", () => {
		expect(byRole(composer({ running: false }).describe(cx), "omp.composer.effort")).toBeUndefined();
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

	it("offers no edit control or hint for sent (locked) steering (#13798)", () => {
		const onEdit = vi.fn();
		const band = new QueuedMessagesBand(
			[
				{ label: "Sent", messages: ["sent"], locked: true },
				{ label: "Steering", messages: ["queued"] },
			],
			"alt+up",
			onEdit,
		);
		const pills = (band.describe().c ?? []).filter(isNode);
		expect(pills.map(pill => byRole(pill, "omp.queue.edit") !== undefined)).toEqual([false, true]);
		expect(band.render(80).some(line => line.includes("to edit"))).toBe(true);

		const sentOnly = new QueuedMessagesBand([{ label: "Sent", messages: ["sent"], locked: true }], "alt+up", onEdit);
		expect(byRole(sentOnly.describe(), "omp.queue.edit")).toBeUndefined();
		expect(sentOnly.render(80).some(line => line.includes("to edit"))).toBe(false);
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
	it("docks no status bar; the composer carries model, effort, context and usage", () => {
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
			expect(dock).toEqual([composer.editor]);
			const described = composer.editor.describe(cx);
			expect(nodes(described).some(n => n.p !== undefined && "role" in n.p && n.p.role === "omp.status")).toBe(
				false,
			);

			// The context hairline leads the composer; the bar closes it.
			const [first] = (described.c ?? []).filter(isNode);
			expect(first).toMatchObject({ k: "meter", p: { role: "omp.composer.context", style: "bar" } });
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
			expect(byRole(bar, "omp.composer.usage")?.p).toMatchObject({ actions: { click: "status.context" } });
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
