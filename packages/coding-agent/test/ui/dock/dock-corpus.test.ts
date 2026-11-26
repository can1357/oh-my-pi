/**
 * Dock HUD parity against the app-level corpus (`packages/tui/test/corpus/app`):
 * each stage replays its step on the dock models, then the HUD rows the dock
 * paints must equal, cell for cell, the row run right above the composer (and
 * the run under it for widgets below) at every recorded size. The terminal
 * clock follows the capture's: the pinned epoch plus the stage's clock steps.
 * Skips when the local corpus is absent.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRoot, type JSXNode, resolveChildren, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, type StaticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import { CORPUS_DIR, CORPUS_NOW, corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import type { ObservableSession } from "../../../src/task/session-observer-registry";
import type { AgentProgress } from "../../../src/task/task-details";
import type { TodoPhase } from "../../../src/tools/details/todo";
import { subagentEntries } from "../../../src/ui/dock";
import { DockAbove, DockBelow, DockModels } from "./fixture";

interface AppStage {
	readonly label: string;
	readonly rows: Readonly<Record<string, readonly string[]>>;
}

interface AppEvent {
	readonly type: string;
	readonly ms?: number;
	readonly channel?: string;
	readonly payload?: {
		readonly id?: string;
		readonly index?: number;
		readonly agent?: string;
		readonly description?: string;
		readonly status?: string;
		readonly progress?: AgentProgress & { readonly id: string };
	};
	readonly call?: string;
	readonly args?: readonly unknown[];
}

interface AppCase {
	readonly case: string;
	readonly theme: string;
	readonly sizes: readonly string[];
	readonly inputs: {
		readonly stages: readonly {
			readonly label: string;
			readonly events: readonly AppEvent[];
		}[];
	};
	readonly stages: readonly AppStage[];
}

/** What a step sees: the stage's events and the case's subagent sessions so far. */
interface StepContext {
	readonly events: readonly AppEvent[];
	readonly sessions: Map<string, ObservableSession>;
}

type Step = (models: DockModels, cx: StepContext) => void;

const WORKING = {
	label: "Working…",
	startedAt: CORPUS_NOW,
	interruptKey: "escape",
} as const;

function busy(models: DockModels): void {
	models.status.row.set({ kind: "working", spec: WORKING });
}

function idle(models: DockModels): void {
	models.status.row.set(undefined);
}

/** Steps keyed by stage label (stage 0 is the initial state: idle, nothing docked). */
function turnSteps(busyLabels: readonly string[]): (label: string) => Step {
	return label => (busyLabels.includes(label) ? busy : idle);
}

const todoPlan = (statuses: readonly (readonly TodoPhase["tasks"][number]["status"][])[]): TodoPhase[] => [
	{
		name: "Investigate",
		tasks: ["Read greet.ts", "List callers"].map((content, i) => ({
			content,
			status: statuses[0]![i]!,
		})),
	},
	{
		name: "Change",
		tasks: ["Rename the greeting", "Update tests", "Write the changelog"].map((content, i) => ({
			content,
			status: statuses[1]![i]!,
		})),
	},
];

const OPENING = todoPlan([
	["in_progress", "pending"],
	["pending", "pending", "pending"],
]);
const PHASE_TWO = todoPlan([
	["completed", "completed"],
	["in_progress", "pending", "pending"],
]);

/** Subagent bus frames into observer sessions, as the registry keeps them. */
function applyBus(cx: StepContext): void {
	for (const event of cx.events) {
		const payload = event.payload;
		if (event.type !== "bus" || !payload) continue;
		if (event.channel === "task:subagent:lifecycle" && payload.id) {
			if (payload.status === "started") {
				cx.sessions.set(payload.id, {
					id: payload.id,
					kind: "subagent",
					label: payload.id,
					agent: payload.agent,
					description: payload.description,
					status: "active",
					detached: true,
					lastUpdate: CORPUS_NOW,
				});
			} else cx.sessions.delete(payload.id);
		} else if (event.channel === "task:subagent:progress" && payload.progress) {
			const session = cx.sessions.get(payload.progress.id);
			if (session) cx.sessions.set(session.id, { ...session, progress: payload.progress });
		}
	}
}

function subagentStep(livePreview: boolean): Step {
	return (models, cx) => {
		applyBus(cx);
		models.subagents.livePreview.set(livePreview);
		models.subagents.hubKey.set("alt+a");
		models.subagents.entries.set(subagentEntries([...cx.sessions.values()]));
	};
}

function widgetStep(models: DockModels, cx: StepContext): void {
	for (const event of cx.events) {
		if (event.type !== "app" || event.call !== "setHookWidget") continue;
		const [key, content, options] = event.args as [
			string,
			readonly string[] | null,
			{ placement?: "aboveEditor" | "belowEditor" }?,
		];
		models.widgets.set(key, content ?? undefined, options?.placement);
	}
}

const CYCLE = ["smol", "default", "slow"];

const SCRIPTS: Readonly<Record<string, (label: string) => Step>> = {
	"markdown-stream": turnSteps([
		"submitted, waiting for the model",
		"first token at 0.8 s",
		"mid-stream at 2.3 s",
		"code block streaming at 3.5 s",
		"last chunk at 4.1 s",
	]),
	"tool-calls": turnSteps([
		"submitted",
		"bash call streamed, running",
		"bash still running at 2.1 s",
		"bash done",
		"read done",
		"edit applied with diff",
	]),
	"thinking-and-interrupts": turnSteps([
		"thinking streaming",
		"answer streaming after thinking",
		"next reply streaming",
	]),
	"errors-and-retry": label =>
		label === "esc interrupts the tool"
			? m => m.status.row.set({ kind: "retry", retryKey: "f5" })
			: turnSteps(["next turn, tool running", "alt+r retries the tool call", "tool output, model answers"])(label),
	"queued-messages": label => m => {
		const groups: Record<string, { label: string; messages: string[] }[]> = {
			"steering message queued (enter)": [{ label: "Steering", messages: ["also update the README"] }],
			"follow-up queued (ctrl+q)": [
				{ label: "Steering", messages: ["also update the README"] },
				{ label: "After yield", messages: ["then summarize the diff"] },
			],
			"reply ends, steer delivered": [{ label: "After yield", messages: ["then summarize the diff"] }],
		};
		m.queue.groups.set(groups[label] ?? []);
		if (label === "follow-up delivered and answered") idle(m);
		else busy(m);
	},
	"todo-hud": label => m => {
		switch (label) {
			case "todo init (two phases)":
			case "first task started":
				m.todo.phases.set(OPENING);
				busy(m);
				return;
			case "phase one done, next started":
				m.todo.phases.set(PHASE_TWO);
				busy(m);
				return;
			case "turn ends with work open":
				idle(m);
				return;
			case "/todo expand":
				m.todo.expanded.set(true);
				return;
			case "/todo collapse":
				m.todo.expanded.set(false);
				return;
		}
		throw new Error(`todo-hud: no step for ${label}`);
	},
	"subagent-hud": () => subagentStep(false),
	"subagent-hud-full": () => subagentStep(true),
	"model-cycle": label => m => {
		const active: Record<string, number> = {
			"ctrl+p once": 2,
			"ctrl+p twice": 0,
			"ctrl+p wraps around": 1,
		};
		if (label in active) m.cycle.track.set({ segments: CYCLE, active: active[label]! });
	},
	"notices-and-widgets": () => widgetStep,
};

/**
 * Rows of the dock run above the composer per stage (blank rows included),
 * read off the corpus: a HUD that painted nothing would otherwise pass by
 * matching only the rows under it.
 */
const RUN_ROWS: Readonly<Record<string, readonly number[]>> = {
	"errors-and-retry": [1, 1, 2, 2, 2, 2, 1],
	"model-cycle": [1, 3, 3, 3, 3],
	"notices-and-widgets": [1, 1, 1, 1, 1, 3, 3, 3, 1],
	"queued-messages": [1, 2, 6, 8, 6, 2, 1],
	"subagent-hud-full": [1, 5, 7, 5, 1],
	"subagent-hud": [1, 5, 5, 4, 1],
	"todo-hud": [1, 9, 9, 9, 8, 11, 8],
	"markdown-stream": [1, 1, 2, 2, 2, 2, 2, 1],
	"thinking-and-interrupts": [1, 2, 2, 1, 1, 1, 1, 1, 2, 1],
	"tool-calls": [1, 2, 2, 2, 2, 2, 2, 1, 1, 1],
};

/** The composer's first row: the status line over its `╰─` row. */
function composerTop(rows: readonly string[]): number {
	for (let i = rows.length - 1; i > 0; i--) {
		const plain = stripEscapes(rows[i]!);
		if (plain.startsWith("╰─") && !plain.startsWith("╰──")) return i - 1;
	}
	throw new Error("no composer in the stage");
}

function rootOf(node: JSXNode): UiNode {
	const [root] = resolveChildren(node)();
	if (!root) throw new Error("fixture built no node");
	return root;
}

interface StageResult {
	readonly label: string;
	readonly failures: readonly string[];
}

function checkCase(corpusCase: AppCase, script: (label: string) => Step): StageResult[] {
	// The app maps a dark terminal to its default dark theme, titanium (`theme.dark`); light stays `light`.
	const env: StaticEnvironment = corpusEnvironment(corpusCase.theme === "dark" ? "titanium" : corpusCase.theme);
	return createRoot(dispose => {
		try {
			const models = new DockModels();
			const above = rootOf(DockAbove({ models }));
			const below = rootOf(DockBelow({ models }));
			const sessions = new Map<string, ObservableSession>();
			let clock = 0;
			return corpusCase.stages.map((stage, index) => {
				const events = corpusCase.inputs.stages[index]?.events ?? [];
				for (const event of events) if (event.type === "clock") clock += event.ms ?? 0;
				if (index > 0) script(stage.label)(models, { events, sessions });
				env.setNow(CORPUS_NOW + clock);
				const failures: string[] = [];
				for (const size of corpusCase.sizes) {
					const width = Number(size.split("x")[0]);
					const rows = stage.rows[size] ?? [];
					const top = composerTop(rows);
					const painted = paintNode(env, above, width).rows;
					const expectedRows = RUN_ROWS[corpusCase.case]?.[index];
					if (painted.length !== expectedRows)
						failures.push(`above@${size}: painted ${painted.length} rows, the corpus run is ${expectedRows}`);
					const diff = firstCellDiff(rows.slice(top - painted.length, top), painted);
					if (diff) failures.push(`above@${size}: ${diff}`);
					const under = paintNode(env, below, width).rows;
					const diffUnder = firstCellDiff(rows.slice(top + 2, top + 2 + under.length), under);
					if (diffUnder) failures.push(`below@${size}: ${diffUnder}`);
				}
				return { label: stage.label, failures };
			});
		} finally {
			dispose();
		}
	});
}

const APP_DIR = path.join(CORPUS_DIR, "app");
const FILES = ["turn", "dock"].flatMap(area => {
	const dir = path.join(APP_DIR, area);
	return fs.existsSync(dir) ? fs.readdirSync(dir).map(file => path.join(dir, file)) : [];
});

describe.skipIf(FILES.length === 0)("dock HUDs vs app corpus", () => {
	for (const file of FILES.sort()) {
		const corpusCase = JSON.parse(fs.readFileSync(file, "utf8")) as AppCase;
		const script = SCRIPTS[corpusCase.case];
		if (!script) continue;
		const results = checkCase(corpusCase, script);
		for (const result of results) {
			test(`${path.basename(file)} · ${result.label}`, () => {
				expect(result.failures).toEqual([]);
			});
		}
	}
});
