/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Dock HUD looks and behaviour the app corpus does not reach: overflowing
 * lists, click targets, maintenance rows, the folded todo, widget limits,
 * the editor gap, progress rows and the deferred preview.
 */
import { describe, expect, test } from "bun:test";
import { createRoot, type JSXNode, resolveChildren, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { type Block, paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { DownloadActivity } from "../../../src/downloads/activity";
import type { ObservableSession } from "../../../src/task/session-observer-registry";
import {
	BackgroundCompactionModel,
	DeferredCommand,
	DeferredCommandModel,
	EditorGap,
	HookWidgets,
	HookWidgetsModel,
	ProgressHud,
	ProgressHudModel,
	QueuedMessages,
	QueueModel,
	StatusHud,
	StatusHudModel,
	type SubagentEntry,
	SubagentHud,
	SubagentHudModel,
	subagentEntries,
	TodoHudModel,
	WorkingRow,
	workingMessage,
} from "../../../src/ui/dock";

const NOW = 1_700_000_000_000;
const env = staticEnvironment(loadThemeSync("dark"), { now: NOW });

/** Paint what `factory` builds at `width`; plain rows (trailing blanks trimmed) and the block. */
function paint(factory: () => JSXNode, width = 80): { rows: string[]; block: Block } {
	return createRoot(dispose => {
		try {
			const nodes = resolveChildren(factory())();
			const root: UiNode | undefined = nodes[0];
			const block = root ? paintNode(env, root, width) : { rows: [] };
			return { rows: block.rows.map(row => stripEscapes(row).trimEnd()), block };
		} finally {
			dispose();
		}
	});
}

describe("subagents HUD", () => {
	const entry = (id: string, extra: Partial<SubagentEntry> = {}): SubagentEntry => ({
		id,
		displayId: id,
		description: `Work on ${id}`,
		...extra,
	});

	test("collapsed list: three agents, an expander, click targets", () => {
		const model = new SubagentHudModel();
		model.entries.set(["a", "b", "c", "d"].map(id => entry(id)));
		const { rows, block } = paint(() => <SubagentHud model={model} />);
		expect(rows).toEqual([
			"",
			" Subagents · 4 running",
			"  ├─ ⟳ a: Work on a",
			"  ├─ ⟳ b: Work on b",
			"  └─ ⟳ c: Work on c",
			"  … 1 more — expand",
		]);
		expect(block.hits?.map(hit => [hit.row, hit.height, hit.act])).toEqual([
			[2, 1, "subagents.focus=a"],
			[3, 1, "subagents.focus=b"],
			[4, 1, "subagents.focus=c"],
			[5, 1, "subagents.toggle"],
		]);
		model.expanded.set(true);
		expect(paint(() => <SubagentHud model={model} />).rows.slice(-2)).toEqual([
			"  └─ ⟳ d: Work on d",
			"  … show less",
		]);
	});

	test("an agent that only waits on its own agents gets a muted mark, one at work an accent one", () => {
		const session = (id: string, currentTool: string): ObservableSession => ({
			id,
			kind: "subagent",
			label: id,
			description: `Work on ${id}`,
			status: "active",
			lastUpdate: NOW,
			progress: {
				index: 0,
				id,
				agent: "task",
				agentSource: "bundled",
				status: "running",
				task: id,
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				requests: 1,
				tokens: 0,
				cost: 0,
				durationMs: 1000,
				currentTool,
			},
		});
		const entries = subagentEntries([session("w", "wait"), session("b", "bash")]);
		expect(entries.map(e => [e.id, e.waiting])).toEqual([
			["w", true],
			["b", undefined],
		]);
		const model = new SubagentHudModel();
		model.entries.set(entries);
		const { block } = paint(() => <SubagentHud model={model} />);
		const theme = loadThemeSync("dark");
		const mark = theme.symbols.symbol("status.running");
		expect(block.rows[2]).toContain(theme.fg("muted", mark));
		expect(block.rows[3]).toContain(theme.fg("accent", mark));
	});

	test("live preview: badge, assignment preview, finished call, elapsed marker", () => {
		const model = new SubagentHudModel();
		model.livePreview.set(true);
		model.entries.set([
			entry("a", { agent: "explore", call: { tool: "read", detail: "src/a.ts", live: false, error: true } }),
			{
				id: "b",
				displayId: "b",
				preview: "Fix the parser",
				call: { tool: "bash", detail: "bun test", live: true, startedAt: NOW - 6200 },
			},
		]);
		const { rows, block } = paint(() => <SubagentHud model={model} />);
		expect(rows.slice(2)).toEqual([
			"  ├─ ⟳ a ⟦explore⟧: Work on a",
			"  │  └ ✘ read: src/a.ts",
			"  └─ ⟳ b Fix the parser",
			"     └ bash: bun test · 6.2s",
		]);
		expect(block.hits?.map(hit => [hit.row, hit.height])).toEqual([
			[2, 2],
			[4, 2],
		]);
	});
});

describe("status row", () => {
	test("maintenance rows: spinner, muted line, cancel hint; retry counts down", () => {
		const compaction = paint(() => (
			<WorkingRow
				spec={{
					label: "Compacting context…",
					startedAt: NOW,
					variant: { kind: "compaction" },
					interruptKey: "escape",
				}}
			/>
		)).rows;
		expect(compaction[0]).toBe("");
		expect(compaction[1]).toMatch(/^ \S Compacting context… \(⎋ to cancel\)$/);
		const spec = {
			label: "",
			startedAt: NOW,
			variant: { kind: "retry", attempt: 1, max: 3, delayMs: 4000, reason: "529 Overloaded" },
			interruptKey: "escape",
		} as const;
		expect(workingMessage(spec, NOW + 2000, key => (key === "escape" ? "⎋" : key))).toBe(
			"Retrying (1/3) in 2.0s · 529 Overloaded (⎋ to cancel)",
		);
	});

	test("a trailer docks right; a live label is re-read", () => {
		let n = 0;
		const rows = paint(() => (
			<WorkingRow
				spec={{
					label: () => `Step ${++n}\nsecond line`,
					startedAt: NOW,
					interruptKey: "escape",
					shimmer: "disabled",
					trailer: () => "⚡ 41.2 tok/s",
				}}
			/>
		)).rows;
		expect(rows[1]).toMatch(/^ {2}⎋ Step \d+ +⚡ 41\.2 tok\/s$/);
		expect(visibleWidth(rows[1]!)).toBe(80);
	});

	test("short terminals fold the todo into the status row", () => {
		const todo = new TodoHudModel();
		todo.compact.set(true);
		todo.phases.set([{ name: "Plan", tasks: [{ content: "Write it", status: "in_progress" }] }]);
		const status = new StatusHudModel(todo);
		const idle = paint(() => <StatusHud model={status} />).rows;
		expect(idle).toEqual(["", `${" ".repeat(80 - 22)}TODO 0/1 · ☐ Write it`]);
		status.row.set({ kind: "retry", retryKey: "f5" });
		const busy = paint(() => <StatusHud model={status} />).rows;
		expect(busy[1]).toMatch(/^ {2}F5 to retry +TODO 0\/1 · ☐ Write it$/);
	});

	test("the idle trailer keeps the styling it arrives with (the band title's faint italics)", () => {
		const status = new StatusHudModel();
		const title = "\x1b[2;3mParity session\x1b[23;22m";
		status.idleTrailer.set(title);
		expect(paint(() => <StatusHud model={status} />).block.rows).toEqual(["", `${" ".repeat(66)}${title}`]);
	});

	test("idle trailer and background compaction stand in for the working row", () => {
		const status = new StatusHudModel();
		status.idleTrailer.set("⚡ 12.0 tok/s");
		expect(paint(() => <StatusHud model={status} />).rows).toEqual(["", `${" ".repeat(67)}⚡ 12.0 tok/s`]);
		status.background.run.set({
			label: "Compacting context in the background",
			startedAt: NOW,
			interruptKey: "escape",
		});
		expect(paint(() => <StatusHud model={status} />).rows[1]).toMatch(
			/Compacting context in the background… \(⎋ to cancel\)$/,
		);
		status.background.inView.set(false);
		expect(paint(() => <StatusHud model={status} />).rows[1]).toContain("tok/s");
	});
});

describe("widgets and the editor gap", () => {
	test("line widgets stop at ten lines; rows and nodes draw as given", () => {
		const widgets = new HookWidgetsModel();
		widgets.set(
			"long",
			Array.from({ length: 12 }, (_, i) => `line ${i + 1}`),
		);
		widgets.set("rows", { render: width => [`rows at ${width}`] });
		widgets.set("node", () => <text text="a node" />, "belowEditor");
		const above = paint(() => <HookWidgets model={widgets} placement="aboveEditor" />).rows;
		expect(above).toEqual([
			...Array.from({ length: 10 }, (_, i) => ` line ${i + 1}`),
			" ... (widget truncated)",
			"rows at 80",
		]);
		expect(paint(() => <HookWidgets model={widgets} placement="belowEditor" />).rows).toEqual(["a node"]);
		widgets.set("long", ["replaced"]);
		expect(paint(() => <HookWidgets model={widgets} placement="aboveEditor" />).rows).toEqual([
			" replaced",
			"rows at 80",
		]);
	});

	test("the gap closes under a drawn status row in a band composer, never over widgets", () => {
		const widgets = new HookWidgetsModel();
		const occupied = signal(false);
		const band = signal(true);
		const gap = () => <EditorGap widgets={widgets} statusOccupied={occupied} band={band} />;
		expect(paint(gap).rows).toEqual([""]);
		occupied.set(true);
		expect(paint(gap).rows).toEqual([]);
		band.set(false);
		expect(paint(gap).rows).toEqual([""]);
		band.set(true);
		widgets.set("w", ["x"]);
		expect(paint(gap).rows).toEqual([""]);
	});
});

test("queued messages keep one line each", () => {
	const queue = new QueueModel();
	queue.groups.set([{ label: "Steering", messages: ["first\nsecond"] }]);
	expect(paint(() => <QueuedMessages model={queue} />, 30).rows).toEqual([
		"",
		" Steering · 1",
		"   1. first ↵ second",
		"   └ ⌥↑ to edit",
	]);
});

test("progress rows dock right with a bar", () => {
	const model = new ProgressHudModel(new BackgroundCompactionModel(), () => false);
	model.judgments.update({
		id: "b",
		intent: "Grade answers",
		done: 3,
		total: 10,
		failed: 1,
		cost: 0.0312,
		running: true,
	});
	const [row] = paint(() => <ProgressHud model={model} />, 60).rows;
	expect(row).toBe(`${" ".repeat(3)}Grade answers ━━━━━───────────── 3/10 · $0.031 · 1 failed`);
});

describe("download rows", () => {
	const activity = (overrides: Partial<DownloadActivity>): DownloadActivity => ({
		id: 1,
		label: "SmolLM2-135M",
		state: "running",
		...overrides,
	});
	const rows = (model: ProgressHudModel, width = 100): string =>
		paint(() => <ProgressHud model={model} />, width).rows.join("\n");
	const hud = (): ProgressHudModel => new ProgressHudModel(new BackgroundCompactionModel(), () => false);

	test("a download that finishes inside the reveal window never shows", () => {
		const model = hud();
		model.downloads.update(activity({ loaded: 0, total: 100 }), NOW);
		model.downloads.update(activity({ state: "done" }), NOW + 50);
		expect(rows(model)).toBe("");
		model.downloads.dispose();
	});

	test("one that outlasts the window shows byte progress", () => {
		const model = hud();
		model.downloads.update(activity({ loaded: 0, total: 271_165_812, detail: "model.safetensors" }), NOW);
		expect(rows(model)).toBe("");
		model.downloads.update(
			activity({ loaded: 135_582_906, total: 271_165_812, detail: "model.safetensors" }),
			NOW + 200,
		);
		const row = rows(model);
		expect(row).toContain("SmolLM2-135M · model.safetensors");
		expect(row).toMatch(/129\.\d+MB \/ 258\.\d+MB$/);
		model.downloads.dispose();
	});

	test("a failure stays with its reason", () => {
		const model = hud();
		model.downloads.update(activity({ label: "Chromium", total: 150_000_000, loaded: 1 }), NOW);
		model.downloads.update(
			activity({ label: "Chromium", state: "failed", error: "GET https://storage.googleapis.com: 403" }),
			NOW + 200,
		);
		expect(rows(model, 120)).toContain("Chromium failed: GET https://storage.googleapis.com: 403");
		model.downloads.dispose();
	});

	test("step progress shows counts, not byte sizes", () => {
		const model = hud();
		model.downloads.update(activity({ label: "Optimizing skills", unit: "steps", loaded: 0, total: 12 }), NOW);
		model.downloads.update(activity({ label: "Optimizing skills", unit: "steps", loaded: 3, total: 12 }), NOW + 200);
		const row = rows(model);
		expect(row).toContain("Optimizing skills");
		expect(row).toMatch(/ 3\/12$/);
		model.downloads.dispose();
	});

	test("a lone step shows under its label without calling it a download", () => {
		const model = hud();
		model.downloads.update(activity({ label: "Optimizing MCP: github", unit: "steps" }), NOW);
		model.downloads.update(activity({ label: "Optimizing MCP: github", unit: "steps" }), NOW + 200);
		const row = rows(model);
		expect(row).toContain("Optimizing MCP: github");
		expect(row).not.toContain("downloading");
		model.downloads.dispose();
	});
});

test("deferred preview cuts long output", () => {
	const model = new DeferredCommandModel();
	model.maxRows.set(6);
	model.commands.set(1);
	model.panels.set([
		() => (
			<col>
				{Array.from({ length: 9 }, (_, i) => (
					<text text={`usage ${i}`} />
				))}
			</col>
		),
	]);
	expect(paint(() => <DeferredCommand model={model} />).rows).toEqual([
		"",
		"usage 0",
		"usage 1",
		"usage 2",
		"usage 3",
		"usage 4",
		"… 4 more rows — 1 command output shown in full when the agent pauses · ⎋ to hide",
	]);
});
