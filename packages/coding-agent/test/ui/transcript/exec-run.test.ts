/**
 * Corpus checks for user-run commands and cells (`transcript/bash-exec`,
 * `transcript/eval-exec`): an {@link ExecRun} driven through the recorded
 * steps (output chunks, expand/fold, completion), its block described
 * against each stage's native tree and painted against its rows.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { createRoot, isUiNode } from "@oh-my-pi/pi-tui";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
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
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import "../../../src/ui/styles/transcript/exec-run";
import { type ExecCompletion, ExecRun, ExecRunBlock } from "../../../src/ui/transcript/exec-run";

// This file publishes corpus themes as the active theme; put the previous one back for later files.
const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const LONG = Array.from({ length: 45 }, (_, i) => `line ${i} ünïcødé 日本語 ${"x".repeat(i)}`).join("\n");
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PTY_CHUNK =
	"\x1b[1;32mCPU\x1b[0m [|||||     25%]\r\n\x1b[1;34mMem\x1b[0m [||||||||  60%]\r\nprogress 10%\rprogress 90%\r\n";

/** How each recorded completion ended the run. */
function completion(label: string): [exitCode: number | undefined, cancelled: boolean, extra?: ExecCompletion] {
	if (label.startsWith("completed exit 2"))
		return [
			2,
			false,
			{
				output: `final\n${LONG}`,
				truncation: { truncated: true, totalLines: 900, outputLines: 100 } as never,
				artifactError: { message: "disk full" },
				minimized: { filter: "git", inputBytes: 9000, outputBytes: 100, artifactId: "a1" } as never,
			},
		];
	if (label.startsWith("cancelled")) return [undefined, true];
	if (label === "completed with an inline PNG image")
		return [0, false, { output: "img", images: [{ data: PNG_1X1, mimeType: "image/png" }] }];
	if (label.startsWith("completed with an image, images hidden"))
		return [0, false, { images: [{ data: PNG_1X1, mimeType: "image/png" }], showImages: false }];
	return [0, false];
}

interface ExecInputs {
	readonly component: string;
	readonly command?: string;
	readonly code?: string;
	readonly completion: string;
}

/** The run a case starts from, parsed from its recorded constructor call. */
function startRun(corpusCase: CorpusCase): ExecRun {
	const inputs = corpusCase.inputs as ExecInputs;
	const excluded = /excludeFromContext true/.test(inputs.component);
	if (corpusCase.screen === "transcript/eval-exec") {
		const language = /'js'\)/.test(inputs.component) ? "js" : "python";
		return new ExecRun({ kind: "eval", source: inputs.code ?? "", excluded, language, now: () => CORPUS_NOW });
	}
	const command = /BashExecutionComponent\('(.*?)'/.exec(inputs.component)?.[1] ?? inputs.command ?? "";
	return new ExecRun({ kind: "bash", source: command, excluded, now: () => CORPUS_NOW });
}

async function step(run: ExecRun, label: string, inputs: ExecInputs): Promise<void> {
	switch (label) {
		case "initial":
			return;
		case "first chunk":
			run.appendOutput("hello\nwor");
			return;
		case "second chunk long":
			run.appendOutput(`ld\n${LONG}`);
			return;
		case "expanded":
			run.setExpanded(true);
			return;
		case "collapsed":
			run.setExpanded(false);
			return;
		case "native fold":
			run.toggle(true);
			return;
		case "native unfold":
			run.toggle(false);
			return;
		case "pty chunk":
			await run.appendPtyChunk(PTY_CHUNK);
			return;
		case "complete":
			run.setComplete(...completion(inputs.completion));
			return;
		default:
			throw new Error(`exec runs: unknown step ${JSON.stringify(label)}`);
	}
}

export interface ExecStageResult {
	readonly label: string;
	readonly native: string | null;
	readonly rows: Readonly<Record<string, string | null>>;
}

/** Drive a case and compare every stage. */
export async function checkExecCase(corpusCase: CorpusCase): Promise<ExecStageResult[]> {
	const env = corpusEnvironment(corpusCase.theme);
	setCurrentTheme(loadThemeSync(corpusCase.theme));
	const run = startRun(corpusCase);
	const tree = createRoot(() => ExecRunBlock({ run }));
	if (!isUiNode(tree)) throw new Error("exec runs: block must be one node");
	const out: ExecStageResult[] = [];
	for (let index = 0; index < corpusCase.stages.length; index++) {
		const stage = corpusCase.stages[index]!;
		await step(run, stage.label, corpusCase.inputs as ExecInputs);
		const native = firstDiff(stageNative(corpusCase, index), describeTree(tree, env));
		const rows: Record<string, string | null> = {};
		for (const width of corpusCase.widths)
			rows[String(width)] = firstCellDiff(stage.rows[String(width)] ?? [], paintNode(env, tree, width).rows);
		out.push({ label: stage.label, native, rows });
	}
	return out;
}

/** Case files of a screen. */
export function execCaseFiles(screen: string): string[] {
	const dir = path.join(CORPUS_DIR, screen);
	return fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter(file => file.endsWith(".json"))
				.sort()
		: [];
}

export function loadExecCase(screen: string, file: string): CorpusCase {
	return JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, screen, file), "utf8")) as CorpusCase;
}

if (!Bun.env.PI_UI_SCREEN_RUNNER) {
	for (const screen of ["transcript/bash-exec", "transcript/eval-exec"]) {
		const files = execCaseFiles(screen);
		describe.skipIf(files.length === 0)(`${screen} corpus`, () => {
			for (const file of files) {
				test(file, async () => {
					const failures: string[] = [];
					for (const result of await checkExecCase(loadExecCase(screen, file))) {
						if (result.native) failures.push(`${result.label} native: ${result.native}`);
						for (const width in result.rows) {
							const diff = result.rows[width];
							if (diff) failures.push(`${result.label} rows@${width}: ${diff}`);
						}
					}
					expect(failures).toEqual([]);
				});
			}
		});
	}
}
