/**
 * Corpus checks for `tools/<name>` screens painted by the `omp.tool.*` looks.
 *
 * A case records one renderer hook (call or result) driven through display
 * steps. Each stage is replayed as a {@link ToolViewState}; the presenter's
 * view is described as the corpus `toolview` node, and the `tool` node the
 * transcript block builds for it ({@link toolNodeProps}) is painted with the
 * tool's look (no transcript margins) and compared cell by cell.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, setSystemTime } from "bun:test";
import { capturing, type StageResult, stageTest } from "../deviations";
import { createRoot, isUiNode, type JSXNode, jsx, resolveChildren, type UiNode } from "@oh-my-pi/pi-tui";
import {
	DEFAULT_SPINNER_INTERVAL_MS,
	defineRolePainter,
	type PaintEnvironment,
	paintNode,
	type StaticEnvironment,
} from "@oh-my-pi/pi-tui/term/paint";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import {
	CORPUS_DIR,
	CORPUS_NOW,
	type CorpusCase,
	corpusEnvironment,
	describeTree,
	firstDiff,
	stageNative,
} from "@oh-my-pi/pi-tui/testing/corpus";
import type { TspCardStatus } from "@oh-my-pi/pi-wire";
import { paintToolLook } from "../../../src/ui/styles/tools/block";
import "../../../src/ui/styles/tools";
import type { ToolPresenter, ToolResult, ToolView, ToolViewState } from "../../../src/ui/tools/contract";
import { ToolBlock, type ToolCall, toolNodeProps } from "../../../src/ui/transcript/tool-block";

/** The visible rows of a real transcript block, without ANSI styling or right padding. */
export function plainToolRows(call: ToolCall, env: PaintEnvironment, width = 100): string[] {
	return createRoot(dispose => {
		try {
			const node = ToolBlock({ call });
			if (!isUiNode(node)) throw new Error("Expected a transcript tool node");
			return paintNode(env, node, width).rows.map(row => Bun.stripANSI(row).trimEnd());
		} finally {
			dispose();
		}
	});
}

/** What a `tools/<name>` case records about the renderer call. */
export interface ToolCaseInputs {
	readonly hook: "renderCall" | "renderResult";
	readonly args?: unknown;
	readonly result?: ToolResult;
	readonly initialOptions: {
		readonly expanded: boolean;
		readonly isPartial: boolean;
		readonly spinnerFrame?: number;
		readonly argsComplete?: boolean;
		readonly executionStarted?: boolean;
		readonly elapsedMs?: number;
		readonly renderContext?: Record<string, unknown>;
	};
}

/** How a screen's recorded inputs reach the presenter (most pass through). */
export interface ToolScreenAdapter {
	/** The presenter's args (and the call's args the block threads into `term.args`). */
	args?(inputs: ToolCaseInputs): unknown;
	/** The result the presenter sees. */
	result?(inputs: ToolCaseInputs): ToolResult | undefined;
	/** Extra render context. */
	renderContext?(inputs: ToolCaseInputs): Record<string, unknown> | undefined;
}

export interface ToolScreen {
	/** `tools/<dir>`. */
	readonly dir: string;
	/** The tool name the block is created with. */
	readonly name: string;
	readonly presenter: ToolPresenter;
	readonly adapter?: ToolScreenAdapter;
	/** Steps beyond the shared ones, by stage label. */
	readonly steps?: Readonly<Record<string, (state: ToolViewState) => ToolViewState>>;
	/** Stage labels that set the old renderer's spinner frame (undefined: stopped, reduced motion). */
	readonly frames?: Readonly<Record<string, number | undefined>>;
}

/** One stage's replayed state. */
export interface ToolStage {
	readonly state: ToolViewState;
	readonly spinnerFrame?: number;
	/** Application clock of the stage. */
	readonly now: number;
	/** The wall clock the capture pinned (`Date.now()` while presenting): moved only by the start and elapsed steps. */
	readonly wall: number;
}

/** The application clock a stage's state was captured at (the corpus pinned clock plus the stage's elapsed time). */
function stageNow(state: ToolViewState): number {
	return CORPUS_NOW + (state.executionStarted ? (state.elapsedMs ?? 0) : 0);
}

/** Replay the display states of every stage. */
export function replayStages(screen: ToolScreen, corpusCase: CorpusCase): ToolStage[] {
	const inputs = corpusCase.inputs as ToolCaseInputs;
	const o = inputs.initialOptions;
	const extraContext = screen.adapter?.renderContext?.(inputs);
	const renderContext = o.renderContext || extraContext ? { ...o.renderContext, ...extraContext } : undefined;
	let state: ToolViewState = {
		expanded: o.expanded,
		isPartial: o.isPartial,
		argsComplete: o.argsComplete ?? false,
		executionStarted: o.executionStarted ?? false,
		...(o.elapsedMs !== undefined ? { elapsedMs: o.elapsedMs } : {}),
		...(renderContext ? { renderContext } : {}),
	};
	let spinnerFrame = o.spinnerFrame;
	let wall = CORPUS_NOW;
	const out: ToolStage[] = [];
	for (const stage of corpusCase.stages) {
		switch (stage.label) {
			case "initial":
				break;
			case "spinner 4":
				spinnerFrame = 4;
				break;
			case "args complete":
				state = { ...state, argsComplete: true };
				break;
			case "execution started":
				state = { ...state, executionStarted: true, elapsedMs: 2500 };
				wall = CORPUS_NOW + 2500;
				break;
			case "expanded": {
				const ctx = state.renderContext;
				state = {
					...state,
					expanded: true,
					...(ctx
						? {
								renderContext: "expanded" in ctx ? { ...ctx, expanded: true } : ctx,
							}
						: {}),
				};
				break;
			}
			case "spinner stopped":
				spinnerFrame = undefined;
				break;
			case "elapsed 4.2s":
				state = { ...state, elapsedMs: 4200 };
				wall = CORPUS_NOW + 4200;
				break;
			default: {
				if (screen.frames && stage.label in screen.frames) {
					spinnerFrame = screen.frames[stage.label];
					break;
				}
				const step = screen.steps?.[stage.label];
				if (!step) throw new Error(`tool screens: unknown stage label ${JSON.stringify(stage.label)}`);
				state = step(state);
			}
		}
		out.push({ state, spinnerFrame, now: stageNow(state), wall });
	}
	return out;
}

/**
 * Move `env` to a stage: the clock at the stage time, advanced to the
 * recorded spinner frame; still spinners and reduced motion once the spinner stopped.
 */
export function applyStage(env: StaticEnvironment, stage: ToolStage): void {
	const frames = env.theme().symbols.spinnerFrames.length;
	let now = stage.now;
	if (stage.spinnerFrame !== undefined && frames > 0) {
		const at = Math.floor(now / DEFAULT_SPINNER_INTERVAL_MS) % frames;
		const ahead = (((stage.spinnerFrame - at) % frames) + frames) % frames;
		now = (Math.floor(now / DEFAULT_SPINNER_INTERVAL_MS) + ahead) * DEFAULT_SPINNER_INTERVAL_MS;
	}
	env.setNow(now);
	const still = stage.spinnerFrame === undefined;
	env.setReduceMotion(still);
	env.setSpinnerInterval(still ? 0 : DEFAULT_SPINNER_INTERVAL_MS);
}

function caseArgs(screen: ToolScreen, inputs: ToolCaseInputs): unknown {
	const args = structuredClone(inputs.args ?? {});
	return screen.adapter?.args ? screen.adapter.args({ ...inputs, args }) : args;
}

function caseResult(screen: ToolScreen, inputs: ToolCaseInputs): ToolResult | undefined {
	const result = screen.adapter?.result ? screen.adapter.result(inputs) : inputs.result;
	return result === undefined ? undefined : structuredClone(result);
}

/** The presenter's view of a stage. */
export function presentStage(screen: ToolScreen, corpusCase: CorpusCase, stage: ToolStage): ToolView | undefined {
	const inputs = corpusCase.inputs as ToolCaseInputs;
	const args = caseArgs(screen, inputs);
	if (inputs.hook === "renderResult") return screen.presenter.result?.(caseResult(screen, inputs)!, stage.state, args);
	return screen.presenter.call?.(args, stage.state);
}

function clean(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(clean);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const v = (value as Record<string, unknown>)[key];
			if (v === undefined || typeof v === "function") continue;
			out[key] = clean(v);
		}
		return out;
	}
	return value;
}

/** The `toolview` description of a view, as the corpus recorded it. */
export function describeToolview(
	screen: ToolScreen,
	corpusCase: CorpusCase,
	stage: ToolStage,
	view: ToolView | undefined,
	body: readonly UiNode[],
	env: StaticEnvironment,
): unknown {
	const inputs = corpusCase.inputs as ToolCaseInputs;
	const presenter = screen.presenter;
	const args = caseArgs(screen, inputs);
	const { head, label, body: _body, term: _term, inline, ...rest } = view ?? {};
	const p = {
		...rest,
		tool: head,
		head: label,
		describeHooks: true,
		viewReturned: view !== undefined,
		mergeCallAndResult: presenter.merge,
		// The corpus recorded the old renderer-level flag: a presenter's default wins over a view's frame.
		inline: presenter.inline ?? inline,
		activity: presenter.activity?.(args, stage.state),
		figure: presenter.figure?.(args, caseResult(screen, inputs), stage.state),
	};
	const out: Record<string, unknown> = { k: "toolview", p: clean(p) };
	if (body.length > 0) out.c = body.map(node => describeTree(node, env));
	return out;
}

/** The status the block gives a stage. */
function stageStatus(inputs: ToolCaseInputs, stage: ToolStage): TspCardStatus {
	if (inputs.hook === "renderCall" || stage.state.isPartial)
		return stage.state.executionStarted ? "running" : "pending";
	return inputs.result?.isError ? "error" : "done";
}

/** Role whose painter paints a node's look without margins. */
const LOOK_ROLE = "omp.test.tool-look";
defineRolePainter("tool", LOOK_ROLE, paintToolLook);

/** The tool node the block builds for a stage's view, painted as its look alone. */
export function stageToolNode(
	screen: ToolScreen,
	corpusCase: CorpusCase,
	stage: ToolStage,
	view: ToolView | undefined,
	body: readonly UiNode[],
): UiNode {
	const inputs = corpusCase.inputs as ToolCaseInputs;
	const { state } = stage;
	const presenterInline = screen.presenter.inline;
	const props = toolNodeProps({
		name: screen.name,
		label: screen.name,
		view: view && presenterInline && view.inline === undefined ? { ...view, inline: presenterInline } : view,
		status: stageStatus(inputs, stage),
		expanded: state.expanded,
		...(state.elapsedMs !== undefined ? { elapsedMs: state.elapsedMs } : {}),
		...(state.executionStarted ? { startedAt: stage.now - (state.elapsedMs ?? 0) } : {}),
		hasBody: body.length > 0,
		streamsBody: screen.presenter.streamsBody,
		args: caseArgs(screen, inputs),
	});
	const node = jsx("tool", { ...props, role: LOOK_ROLE, children: [...body] });
	if (!isUiNode(node)) throw new Error("tool screens: tool node expected");
	return node;
}

export type { StageResult } from "../deviations";

function bodyNodes(body: JSXNode | undefined): readonly UiNode[] {
	return body === undefined ? [] : resolveChildren(body)();
}

/** Check every stage of a case. */
export function checkToolScreenCase(screen: ToolScreen, corpusCase: CorpusCase): StageResult[] {
	const env = corpusEnvironment(corpusCase.theme);
	return replayStages(screen, corpusCase).map((stage, index) =>
		createRoot(dispose => {
			try {
				applyStage(env, stage);
				setSystemTime(new Date(stage.wall));
				const view = presentStage(screen, corpusCase, stage);
				const body = bodyNodes(view?.body);
				const described = describeToolview(screen, corpusCase, stage, view, body, env);
				const native = firstDiff(stageNative(corpusCase, index), described);
				const node = stageToolNode(screen, corpusCase, stage, view, body);
				const rows: Record<string, string | null> = {};
				const painted: Record<string, readonly string[]> = {};
				for (const width of corpusCase.widths) {
					const expected = corpusCase.stages[index]!.rows[String(width)] ?? [];
					const actual = paintNode(env, node, width).rows;
					if (capturing) painted[String(width)] = actual;
					rows[String(width)] = firstCellDiff(expected, actual);
				}
				const label = corpusCase.stages[index]!.label;
				return capturing ? { label, index, native, rows, painted, described } : { label, index, native, rows };
			} finally {
				setSystemTime();
				dispose();
			}
		}),
	);
}

/** Case files of a screen. */
export function screenCaseFiles(dir: string): string[] {
	const full = path.join(CORPUS_DIR, dir);
	return fs.existsSync(full)
		? fs
				.readdirSync(full)
				.filter(file => file.endsWith(".json"))
				.sort()
		: [];
}

/** Load a case file of a screen. */
export function loadScreenCase(dir: string, file: string): CorpusCase {
	return JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, dir, file), "utf8")) as CorpusCase;
}

/** A test per stage of every case of the screen; skips when the local corpus is absent. */
export function toolScreenSuite(screen: ToolScreen): void {
	// The stage runner (`bun test/ui/tools/run-screen.ts`) loads suites only for their screen definitions.
	if (Bun.env.PI_UI_SCREEN_RUNNER) return;
	const files = screenCaseFiles(screen.dir);
	describe.skipIf(files.length === 0)(`${screen.dir} corpus`, () => {
		for (const file of files) {
			const results = checkToolScreenCase(screen, loadScreenCase(screen.dir, file));
			for (const result of results) stageTest(screen.dir, file, result);
		}
	});
}
