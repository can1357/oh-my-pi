/**
 * Corpus checks for `transcript/tool/<id>`: one {@link ToolCall} driven
 * through the recorded lifecycle (args streaming, start, partial and final
 * results, expand/fold, seal, error, cancel, viewport allocations, hidden
 * activity, extension presentations, images), its {@link ToolBlock} described
 * against each stage's native tree and painted against its rows.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, setSystemTime } from "bun:test";
import { capturing, type StageResult, stageTest } from "../deviations";
import { createRoot, isUiNode, type Signal, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, type StaticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
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
import "../../../src/ui/styles/tools";
import "../../../src/ui/tools";
import type { ToolPresenter } from "../../../src/ui/tools/contract";
import { defaultPresenter } from "../../../src/ui/tools/default";
import type { ExtensionRows } from "../../../src/extensibility/extensions/render-types";
import { type LegacyToolRenderer, legacyPresenter } from "../../../src/ui/tools/legacy";
import { ToolBlock, ToolCall, type ToolCallResult, type ToolPresentation } from "../../../src/ui/transcript/tool-block";

/** What a transcript tool case records about its flow. */
export interface FlowInputs {
	readonly toolName: string;
	readonly useBuiltInRenderer?: boolean | null;
	readonly tool?: {
		readonly name?: string;
		readonly label?: string;
		readonly mode?: string;
		readonly mergeCallAndResult?: boolean;
		readonly renderCall?: string;
		readonly renderResult?: string;
	} | null;
	readonly streamingArgs?: unknown;
	readonly args: unknown;
	readonly partial?: ToolCallResult;
	readonly result: ToolCallResult;
	readonly errorResult?: ToolCallResult;
	readonly preview?: unknown;
	readonly presenterAnswer?: unknown;
}

/** Row hooks of flows whose tool drew its own rows (the corpus recorded them as functions). */
export type FlowHooks = (flow: FlowInputs) => LegacyToolRenderer | undefined;

const GENERIC_ERROR: ToolCallResult = {
	content: [{ type: "text", text: "Error: tool failed\nsecond line of the failure" }],
	isError: true,
};

const SKIPPED: ToolCallResult = {
	content: [
		{
			type: "text",
			text: "Skipped: steering input arrived before this call ran",
		},
	],
	details: { source: "interrupt_skipped", __synthetic: true },
};

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Plain text components (an extension's `Text`/`Box`). */
export function textComponent(text: string): ExtensionRows {
	return {
		render: width => (text === "" ? [] : text.split("\n").map(line => line.slice(0, width))),
	};
}

/** The presenter a flow's block uses: the tool's row hooks, else the built-in one, else the generic card. */
function flowPresenter(flow: FlowInputs, hooks: FlowHooks | undefined): ToolPresenter | undefined {
	const legacy = hooks?.(flow);
	if (legacy) return legacyPresenter(legacy, defaultPresenter);
	// A tool without its own renderer gets the generic card; one with it (MCP, task) its registered presenter.
	if (flow.useBuiltInRenderer === false && !flow.tool?.renderCall) return defaultPresenter;
	return undefined;
}

interface Driver {
	readonly call: ToolCall;
	readonly tree: UiNode;
	/** The application clock. */
	appNow: number;
	/** Spinner frame the stage shows. */
	frame: number;
	/** Rows the transcript allocates (undefined: unlimited). */
	allocation: number | undefined;
}

function presentation(answer: unknown): ToolPresentation {
	if (answer === "compact" || answer === "hidden" || answer === "full") return answer;
	if (answer && typeof answer === "object" && "compact" in answer) return answer as ToolPresentation;
	return "full";
}

/** Apply one recorded step. */
function step(driver: Driver, label: string, flow: FlowInputs): void {
	const { call } = driver;
	const frame = /^spinner frame (\d+)$/.exec(label);
	if (frame) {
		driver.frame = Number(frame[1]);
		return;
	}
	const allocation = /^allocation (\d+) rows?$/.exec(label);
	if (allocation) {
		driver.allocation = Number(allocation[1]);
		return;
	}
	switch (label) {
		case "initial":
			return;
		case "args streamed in":
			call.updateArgs(structuredClone(flow.args));
			return;
		case "stream preview":
			call.updateStreamPreview(structuredClone(flow.preview));
			return;
		case "args complete":
			call.setArgsComplete();
			return;
		case "execution started":
			call.setExecutionStarted();
			return;
		case "elapsed 4.2s":
			driver.appNow = CORPUS_NOW + 4200;
			return;
		case "partial result":
			call.updateResult(structuredClone(flow.partial!), true);
			return;
		case "result":
			call.updateResult(structuredClone(flow.result), false);
			return;
		case "error result":
			call.updateResult(structuredClone(flow.errorResult ?? GENERIC_ERROR), false);
			return;
		case "expanded":
			call.setExpanded(true);
			return;
		case "collapsed":
			call.setExpanded(false);
			return;
		case "native fold":
			call.toggle(true);
			return;
		case "native unfold":
			call.toggle(false);
			return;
		case "sealed":
			call.seal();
			return;
		case "allocation full":
			driver.allocation = undefined;
			return;
		case "activity hidden":
			call.setActivityVisible(false);
			return;
		case "activity shown":
			call.setActivityVisible(true);
			return;
		case "skipped":
			call.updateResult(structuredClone(SKIPPED), false);
			return;
		case "image result":
			call.updateResult(
				{
					content: [
						{ type: "text", text: "rendered chart" },
						{ type: "image", data: PNG_1X1, mimeType: "image/png" },
					],
				},
				false,
			);
			return;
		case "images hidden":
			call.setShowImages(false);
			return;
		case "presenter full":
			call.setPresentation("full");
			return;
		case "presenter again":
			call.setPresentation(presentation(flow.presenterAnswer));
			return;
		default:
			throw new Error(`tool flows: unknown step ${JSON.stringify(label)}`);
	}
}

/** Paint clock showing `frame` at (or just after) `now`. */
function paintClock(env: StaticEnvironment, now: number, frame: number): number {
	const frames = env.theme().symbols.spinnerFrames.length;
	const at = Math.floor(now / SPINNER_INTERVAL_MS) % frames;
	const ahead = (((frame - at) % frames) + frames) % frames;
	return (Math.floor(now / SPINNER_INTERVAL_MS) + ahead) * SPINNER_INTERVAL_MS;
}

/** Outcome of one stage: null fields matched. */
/** Outcome of one flow stage: null fields matched. */
export type FlowStageResult = StageResult;

/** Drive a case and compare every stage. */
export function checkFlowCase(corpusCase: CorpusCase, hooks?: FlowHooks): FlowStageResult[] {
	const flow = corpusCase.inputs as FlowInputs;
	const env = corpusEnvironment(corpusCase.theme);
	return createRoot(dispose => {
		try {
			const driver = {
				appNow: CORPUS_NOW,
				frame: 0,
				allocation: undefined as number | undefined,
			} as Driver;
			const call = new ToolCall({
				id: "call1",
				name: flow.toolName,
				label: flow.tool?.label ?? undefined,
				// Only the lifecycle case starts while args still stream.
				args: structuredClone(
					corpusCase.case === "success lifecycle" ? (flow.streamingArgs ?? flow.args) : flow.args,
				),
				presenter: flowPresenter(flow, hooks),
				now: () => driver.appNow,
			});
			if (flow.tool?.mode) call.setRenderContext({ editMode: flow.tool.mode });
			if (flow.presenterAnswer !== undefined) call.setPresentation(presentation(flow.presenterAnswer));
			const tree = ToolBlock({ call });
			if (!isUiNode(tree)) throw new Error("tool flows: ToolBlock must build one node");
			Object.assign(driver, { call, tree });
			const out: FlowStageResult[] = [];
			corpusCase.stages.forEach((stage, index) => {
				setSystemTime(new Date(driver.appNow));
				step(driver, stage.label, flow);
				setSystemTime(new Date(driver.appNow));
				env.setNow(paintClock(env, driver.appNow, driver.frame));
				(env.reduceMotion as Signal<boolean>).set(false);
				const described = describeTree(tree, env);
				const native = firstDiff(stageNative(corpusCase, index), described);
				const rows: Record<string, string | null> = {};
				const painted: Record<string, readonly string[]> = {};
				for (const width of corpusCase.widths) {
					const expected = stage.rows[String(width)] ?? [];
					const actual = paintNode(env, tree, width, driver.allocation).rows;
					if (capturing) painted[String(width)] = actual;
					rows[String(width)] = firstCellDiff(expected, actual);
				}
				out.push(
					capturing
						? { label: stage.label, index, native, rows, painted, described }
						: { label: stage.label, index, native, rows },
				);
			});
			setSystemTime();
			return out;
		} finally {
			dispose();
		}
	});
}

/** Case files of `transcript/tool/<id>`. */
export function flowCaseFiles(id: string): string[] {
	const dir = path.join(CORPUS_DIR, "transcript/tool", id);
	return fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter(file => file.endsWith(".json"))
				.sort()
		: [];
}

/** Load one case. */
export function loadFlowCase(id: string, file: string): CorpusCase {
	return JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, "transcript/tool", id, file), "utf8")) as CorpusCase;
}

/** A test per stage of every case of `transcript/tool/<id>`; skips when the corpus is absent. */
export function flowSuite(id: string, hooks?: FlowHooks): void {
	if (Bun.env.PI_UI_SCREEN_RUNNER) return;
	const files = flowCaseFiles(id);
	describe.skipIf(files.length === 0)(`transcript/tool/${id} corpus`, () => {
		for (const file of files) {
			const results = checkFlowCase(loadFlowCase(id, file), hooks);
			for (const result of results) stageTest(`transcript/tool/${id}`, file, result);
		}
	});
}
