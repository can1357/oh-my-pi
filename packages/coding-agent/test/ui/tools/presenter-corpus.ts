/**
 * Corpus checks for tool presenters (`tools/<name>` screens).
 *
 * A `tools/<name>` case records one renderer hook (call or result) driven
 * through display-state steps. This replays the steps as {@link ToolViewState}s,
 * runs the presenter, and compares
 * - the view's description (`toolview`: head → `tool`, label → `head`, body →
 *   children) with the stage's native tree;
 * - the terminal rows of the view, painted as the transcript's tool block
 *   paints it, with the stage's rows at every width.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { JSXNode, UiNode } from "@oh-my-pi/pi-tui";
import { createRoot, isUiNode, jsx, resolveChildren, type Signal } from "@oh-my-pi/pi-tui";
import {
	defineRolePainter,
	type PaintEnvironment,
	paintNode,
	type StaticEnvironment,
} from "@oh-my-pi/pi-tui/term/paint";
import { SPINNER_INTERVAL_MS } from "@oh-my-pi/pi-tui/term/painters/spinner";
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
import type { TspText } from "@oh-my-pi/pi-wire";
import { paintToolLook } from "../../../src/ui/styles/tools/block";
import type { ToolPresenter, ToolResult, ToolView, ToolViewState } from "../../../src/ui/tools/contract";
import { captureStage, capturing, skipsAt } from "../deviations";

/** The renderer inputs a `tools/<name>` case records. */
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

/** One stage's replayed display state. */
export interface ToolStage {
	readonly state: ToolViewState;
	/** The old renderer's spinner frame index (undefined once stopped). */
	readonly spinnerFrame?: number;
	/** Terminal clock of the stage, before aligning it to {@link spinnerFrame}. */
	readonly now: number;
}

/**
 * Set `env` to a stage: the clock moved to the stage's time and then on to
 * the old spinner frame (`SPINNER_INTERVAL_MS` per frame), reduced motion
 * once the old spinner stopped (painters draw their still frame).
 */
export function applyStage(env: StaticEnvironment, stage: ToolStage): void {
	const frames = env.theme().symbols.spinnerFrames.length;
	let now = stage.now;
	if (stage.spinnerFrame !== undefined && frames > 0) {
		const at = Math.floor(now / SPINNER_INTERVAL_MS) % frames;
		now += ((((stage.spinnerFrame - at) % frames) + frames) % frames) * SPINNER_INTERVAL_MS;
	}
	env.setNow(now);
	(env.reduceMotion as Signal<boolean>).set(stage.spinnerFrame === undefined);
}

/** The display state of every stage of a case, replaying the harness steps by label. */
export function toolStages(corpusCase: CorpusCase): ToolStage[] {
	const inputs = corpusCase.inputs as ToolCaseInputs;
	const o = inputs.initialOptions;
	let state: ToolViewState = {
		expanded: o.expanded,
		isPartial: o.isPartial,
		argsComplete: o.argsComplete ?? false,
		executionStarted: o.executionStarted ?? false,
		elapsedMs: o.elapsedMs,
		renderContext: o.renderContext,
	};
	let spinnerFrame = o.spinnerFrame;
	let now = CORPUS_NOW;
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
				now = CORPUS_NOW + 2500;
				break;
			case "expanded": {
				const ctx = state.renderContext;
				state = {
					...state,
					expanded: true,
					renderContext: ctx && "expanded" in ctx ? { ...ctx, expanded: true } : ctx,
				};
				break;
			}
			case "spinner stopped":
				spinnerFrame = undefined;
				break;
			case "elapsed 4.2s":
				state = { ...state, elapsedMs: 4200 };
				now = CORPUS_NOW + 4200;
				break;
			default:
				throw new Error(`presenter-corpus: unknown stage label ${JSON.stringify(stage.label)}`);
		}
		out.push({ state, spinnerFrame, now });
	}
	return out;
}

/** The presenter's view of a stage (`call` or `result` per the case's hook). */
export function presentStage(presenter: ToolPresenter, corpusCase: CorpusCase, stage: ToolStage): ToolView | undefined {
	const inputs = corpusCase.inputs as ToolCaseInputs;
	const args = structuredClone(inputs.args ?? {});
	if (inputs.hook === "renderResult")
		return presenter.result?.(structuredClone(inputs.result!), stage.state, args as never);
	return presenter.call?.(args as never, stage.state);
}

/** Body nodes of a view, built under a root the caller disposes. */
export function bodyNodes(body: JSXNode | undefined): readonly UiNode[] {
	return body === undefined ? [] : resolveChildren(body)();
}

/** How a screen's corpus differs from its presenter. */
export interface ToolScreenOptions {
	/**
	 * The old renderer was flagged `inline` (its terminal look had no outer
	 * box) without its views being frameless: the corpus `toolview` records
	 * `inline: true` while the transcript frames the tool as a card.
	 */
	readonly legacyInline?: boolean;
}

/** The `toolview` description of a view, as the corpus harness recorded it. */
export function describeView(
	presenter: ToolPresenter,
	corpusCase: CorpusCase,
	stage: ToolStage,
	view: ToolView | undefined,
	body: readonly UiNode[],
	env: PaintEnvironment,
	options?: ToolScreenOptions,
): unknown {
	const inputs = corpusCase.inputs as ToolCaseInputs;
	const args = structuredClone(inputs.args ?? {});
	const { head, label, body: _body, term: _term, inline, ...rest } = view ?? {};
	const activity = presenter.activity?.(args as never, stage.state);
	const figure = presenter.figure?.(
		args as never,
		inputs.hook === "renderResult" ? structuredClone(inputs.result) : undefined,
		stage.state,
	);
	const p: Record<string, unknown> = {
		...rest,
		tool: head,
		head: label as TspText | undefined,
		describeHooks: true,
		viewReturned: view !== undefined,
		mergeCallAndResult: presenter.merge,
		inline: inline ?? presenter.inline ?? options?.legacyInline,
		activity,
		figure,
	};
	const description = {
		k: "toolview",
		p: clean(p),
		c: body.map(node => describeTree(node, env)),
	};
	if (description.c.length === 0) delete (description as { c?: unknown }).c;
	return description;
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

/**
 * Paints a view as the transcript's tool block does (without the block's
 * margins): the rows a `tools/<name>` stage records.
 */
export type ViewPainter = (
	view: ToolView | undefined,
	body: readonly UiNode[],
	stage: ToolStage,
	env: StaticEnvironment,
	width: number,
) => readonly string[];

/** The status a stage's tool node carries. */
export function stageStatus(corpusCase: CorpusCase, stage: ToolStage): "pending" | "running" | "done" | "error" {
	const inputs = corpusCase.inputs as ToolCaseInputs;
	if (inputs.hook === "renderCall") return stage.state.executionStarted ? "running" : "pending";
	if (stage.state.isPartial) return "running";
	return inputs.result?.isError ? "error" : "done";
}

/**
 * The `tool` node the transcript's tool block builds for a view (head facts
 * as props, `label` as the title, body as children, `term` passed through).
 */
export function toolNode(
	name: string,
	view: ToolView | undefined,
	body: readonly UiNode[],
	status: "pending" | "running" | "done" | "error",
	state: ToolViewState,
	inline?: boolean,
): UiNode {
	const head = view?.head;
	const collapsed = view?.open ? false : view?.folded ? true : !state.expanded;
	const node = jsx("tool", {
		name,
		role: LOOK_ONLY_ROLE,
		title: head?.title ?? view?.label ?? name,
		target: head?.target,
		targetKind: head?.targetKind,
		lang: head?.lang,
		command: head?.command,
		href: head?.href,
		meta: head?.meta,
		badges: head?.badges,
		note: head?.note,
		exit: head?.exit,
		status,
		age: status === "running" ? state.elapsedMs : undefined,
		took: status === "done" || status === "error" ? state.elapsedMs : undefined,
		frame: (view?.inline ?? inline) ? "inline" : "card",
		collapsible: true,
		collapsed,
		preview: view?.preview,
		tone: view?.tone,
		term: view?.term,
		children: [...body],
	});
	if (!isUiNode(node)) throw new Error("presenter-corpus: tool node expected");
	return node;
}

/** Role of harness tool nodes: painted by the tool's look alone, without the block's margins (what a `tools/<name>` stage records). */
const LOOK_ONLY_ROLE = "omp.test.tool-look";
defineRolePainter("tool", LOOK_ONLY_ROLE, paintToolLook);

/** Paints a view with its tool look. */
export function paintToolBlock(name: string, presenter: ToolPresenter, corpusCase: CorpusCase): ViewPainter {
	return (view, body, stage, env, width) =>
		paintNode(env, toolNode(name, view, body, stageStatus(corpusCase, stage), stage.state, presenter.inline), width)
			.rows;
}

/** Per-stage outcome: null fields matched. */
export interface StageResult {
	readonly label: string;
	readonly native: string | null;
	readonly rows: Readonly<Record<string, string | null>>;
	/** Painted rows by width and the described tree, kept only while the deviation report captures. */
	readonly painted?: Readonly<Record<string, readonly string[]>>;
	readonly described?: unknown;
}

/** Check every stage of a case: native always, rows when a painter is given. */
export function checkToolCase(
	presenter: ToolPresenter,
	corpusCase: CorpusCase,
	paint?: ViewPainter,
	options?: ToolScreenOptions,
): StageResult[] {
	const env = corpusEnvironment(corpusCase.theme);
	const stages = toolStages(corpusCase);
	return stages.map((stage, index) =>
		createRoot(dispose => {
			try {
				applyStage(env, stage);
				const view = presentStage(presenter, corpusCase, stage);
				const body = bodyNodes(view?.body);
				const described = describeView(presenter, corpusCase, stage, view, body, env, options);
				const native = firstDiff(stageNative(corpusCase, index), described);
				const rows: Record<string, string | null> = {};
				const painted: Record<string, readonly string[]> = {};
				if (paint) {
					for (const width of corpusCase.widths) {
						const expected = corpusCase.stages[index]!.rows[String(width)] ?? [];
						const actual = paint(view, body, stage, env, width);
						if (capturing) painted[String(width)] = actual;
						rows[String(width)] = firstCellDiff(expected, actual);
					}
				}
				const label = corpusCase.stages[index]!.label;
				return capturing ? { label, native, rows, painted, described } : { label, native, rows };
			} finally {
				dispose();
			}
		}),
	);
}

/**
 * A `describe` block per case of `tools/<screen>`, one test per stage
 * (native tree and rows at every width; the native tree is skipped where a
 * deviation lists it). Skips when the local corpus is absent.
 */
export function toolScreenSuite(
	screen: string,
	name: string,
	presenter: ToolPresenter,
	options?: ToolScreenOptions,
): void {
	const dir = path.join(CORPUS_DIR, "tools", screen);
	const files = fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter(file => file.endsWith(".json"))
				.sort()
		: [];
	describe.skipIf(files.length === 0)(`tools/${screen} corpus`, () => {
		for (const file of files) {
			const corpusCase = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as CorpusCase;
			const results = checkToolCase(presenter, corpusCase, paintToolBlock(name, presenter, corpusCase), options);
			for (const [index, result] of results.entries()) {
				if (result.painted)
					captureStage({
						screen: `tools/${screen}`,
						file,
						index,
						label: result.label,
						rows: result.painted,
						native: result.described,
					});
				// A listed native deviation (`../deviations.ts`) leaves the native tree out of the comparison.
				const nativeSkipped = skipsAt(
					{ screen: `tools/${screen}`, case: file, index, label: result.label },
					"native",
				);
				test(`${file} · ${result.label}`, () => {
					const failures: string[] = [];
					if (result.native && !nativeSkipped) failures.push(`native: ${result.native}`);
					for (const width in result.rows) {
						const diff = result.rows[width];
						if (diff) failures.push(`rows@${width}: ${diff}`);
					}
					expect(failures).toEqual([]);
				});
			}
		}
	});
}
