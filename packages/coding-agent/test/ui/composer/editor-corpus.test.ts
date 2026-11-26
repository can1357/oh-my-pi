/**
 * Corpus parity of the composer (`composer/editor`): every case replayed
 * stage by stage; native tree, rows (rendered cells) and hardware cursor at
 * every recorded width.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { createRoot } from "@oh-my-pi/pi-tui";
import {
	type CorpusCase,
	CORPUS_DIR,
	corpusEnvironment,
	listCases,
	loadCase,
	stageNative,
} from "@oh-my-pi/pi-tui/testing/corpus";
import settledFile from "./fixtures/settled-file-completion.json";
import { applyStage, compareStage, editorComposer } from "./harness";

const SCREEN = "composer/editor";

// The released capture sent `@日` in one batch, before its `@` lookup settled. With
// a pause at `@`, the released editor draws this additional row and overlay. Keep
// comparing the entire stage, including the original input, cursor and styling.
function settledReference(c: CorpusCase, i: number): CorpusCase {
	const stage = c.stages[i]!;
	if (c.case !== "file autocomplete" || stage.label !== 'type " and @日"') return c;
	const root = stageNative(c, i);
	if (!root || typeof root !== "object" || !("c" in root) || !Array.isArray(root.c))
		throw new Error("Expected a captured editor tree");
	if (root.c.some(node => node.k === "overlay")) return c;
	const row = c.theme === "light" ? settledFile.row.light : settledFile.row.dark;
	const rows = Object.fromEntries(Object.entries(stage.rows).map(([width, lines]) => [width, [...lines, row]]));
	const native = { ...root, c: [...root.c, settledFile.popup] };
	return { ...c, stages: c.stages.with(i, { ...stage, native, rows }) };
}

describe.skipIf(!fs.existsSync(path.join(CORPUS_DIR, SCREEN)))(SCREEN, async () => {
	for (const file of await listCases(SCREEN)) {
		test(file, async () => {
			const corpusCase = await loadCase(file.replace(/\.json$/, ""));
			const env = corpusEnvironment(corpusCase.theme);
			await createRoot(async dispose => {
				const composer = editorComposer(corpusCase, env);
				const problems: string[] = [];
				for (let i = 0; i < corpusCase.stages.length; i++) {
					const stage = corpusCase.stages[i]!;
					if (i > 0) await applyStage(composer, env, stage.label);
					for (const problem of compareStage(settledReference(corpusCase, i), i, composer.node, env))
						problems.push(`[${i}] ${stage.label}: ${problem}`);
				}
				dispose();
				expect(problems).toEqual([]);
			});
		});
	}
});
