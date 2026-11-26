/**
 * App-level parity against the app corpus (`packages/tui/test/corpus/app`): each
 * case is replayed on the real interactive mode (`replay.ts`, in a process of its
 * own) at every recorded size, and every stage's viewport rows, scrollback rows
 * and cursor must equal the capture cell for cell, except where
 * `../deviations.ts` lists a deliberate difference. Skips when the corpus is absent.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import { CORPUS_DIR } from "@oh-my-pi/pi-tui/testing/corpus";
import { captureStage, skipsAt } from "../deviations";
import type { ReplayedStage } from "./replay";

const APP_DIR = path.join(CORPUS_DIR, "app");
const REPLAY = path.join(import.meta.dir, "replay.ts");

interface CaseStage {
	readonly label: string;
	readonly rows: Record<string, readonly string[]>;
	readonly scrollback: Record<string, readonly string[] | "same">;
	readonly cursor: Record<string, { row: number; col: number; visible: boolean }>;
}

interface CaseFile {
	readonly screen: string;
	readonly case: string;
	readonly sizes: readonly string[];
	readonly stages: readonly CaseStage[];
}

function caseFiles(): string[] {
	if (!fs.existsSync(APP_DIR)) return [];
	return fs
		.readdirSync(APP_DIR, { recursive: true, encoding: "utf8" })
		.filter(file => file.endsWith(".json"))
		.sort();
}

async function replay(file: string, size: string): Promise<ReplayedStage[]> {
	const child = Bun.spawn(["bun", REPLAY, file, size], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	await child.exited;
	let result: { stages?: ReplayedStage[]; error?: string };
	try {
		result = JSON.parse(stdout);
	} catch {
		throw new Error(`replay printed no result:\n${stderr.slice(-4000)}`);
	}
	if (result.error) throw new Error(result.error);
	return result.stages!;
}

/** What differs at one stage (empty when it matches). */
function stageDiffs(expected: CaseFile, index: number, size: string, actual: ReplayedStage): string[] {
	const stage = expected.stages[index]!;
	const width = Number(size.split("x")[0]);
	const diffs: string[] = [];
	const ref = { screen: expected.screen, case: expected.case, index, label: stage.label };
	if (!skipsAt(ref, "rows", width)) {
		const rows = firstCellDiff(stage.rows[size]!, actual.viewport);
		if (rows) diffs.push(`viewport: ${rows}`);
		let history = stage.scrollback[size]!;
		for (let back = index - 1; history === "same" && back >= 0; back--)
			history = expected.stages[back]!.scrollback[size]!;
		const scrollback = firstCellDiff(history === "same" ? [] : history, actual.scrollback);
		if (scrollback) diffs.push(`scrollback: ${scrollback}`);
		// A hidden cursor's position is not shown anywhere: only its hiding is compared.
		const cursor = stage.cursor[size]!;
		const same = cursor.visible ? JSON.stringify(cursor) === JSON.stringify(actual.cursor) : !actual.cursor.visible;
		if (!same) diffs.push(`cursor: expected ${JSON.stringify(cursor)}, got ${JSON.stringify(actual.cursor)}`);
	}
	return diffs;
}

const files = caseFiles();

describe.skipIf(files.length === 0)("app corpus", () => {
	for (const file of files) {
		const expected = JSON.parse(fs.readFileSync(path.join(APP_DIR, file), "utf8")) as CaseFile;
		for (const size of expected.sizes) {
			test(`${file} @ ${size}`, async () => {
				const stages = await replay(path.join(APP_DIR, file), size);
				const failures: string[] = [];
				stages.forEach((actual, index) => {
					// History then screen, as the deviation report lays out a recorded app stage.
					captureStage({
						screen: expected.screen,
						file: path.basename(file),
						index,
						label: expected.stages[index]!.label,
						rows: { [size]: [...actual.scrollback, ...actual.viewport] },
					});
					for (const diff of stageDiffs(expected, index, size, actual))
						failures.push(`stage ${index} (${expected.stages[index]!.label}) ${diff}`);
				});
				expect(failures).toEqual([]);
			}, 120_000);
		}
	}
});
