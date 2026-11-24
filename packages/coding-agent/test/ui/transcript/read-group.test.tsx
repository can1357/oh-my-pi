/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Corpus checks for grouped reads (`transcript/read-group`): a {@link ReadGroup}
 * driven through the recorded steps (args, results, usage, toggles, renames,
 * presenters), its block described against each stage's native tree and
 * painted against its rows.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRoot, isUiNode, type JSXNode, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import {
	CORPUS_DIR,
	type CorpusCase,
	corpusEnvironment,
	describeTree,
	firstDiff,
	stageNative,
} from "@oh-my-pi/pi-tui/testing/corpus";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import "../../../src/ui/styles/tools";
import "../../../src/ui/styles/transcript/read-group";
import { ReadGroup, ReadGroupBlock, type ReadPresenter, type ReadResult } from "../../../src/ui/transcript/read-group";
import { nativeShell } from "../../helpers/native-shell";

// This file publishes corpus themes as the active theme; put the previous one back for later files.
const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const SCREEN = "transcript/read-group";
const CODE = Array.from({ length: 30 }, (_, i) => `const v${i} = "ünï 日本 ${i}";`).join("\n");
const USAGE = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 };

function result(text: string, details?: unknown, isError = false): ReadResult {
	return { content: [{ type: "text", text }], details, isError };
}

/** The recorded presenter: read `a` compact with a label and rows, read `c` hidden, others full. */
const PRESENTER: ReadPresenter = block =>
	block.id === "a"
		? { compact: { label: "A compact", rows: ["row 1", "row 2"] } }
		: block.id === "c"
			? "hidden"
			: undefined;

function step(group: ReadGroup, label: string): void {
	switch (label) {
		case "initial":
			return;
		case "read a args":
			group.updateArgs({ path: "src/a.ts:1-20" }, "a");
			return;
		case "read a result":
			group.updateResult(result(CODE, { displayContent: { text: CODE, startLine: 1 } }), false, "a");
			return;
		case "read b args":
			group.updateArgs({ path: "/abs/README.md" }, "b");
			return;
		case "read c args":
			group.updateArgs({ path: "src/a.ts:40-50" }, "c");
			return;
		case "usage attached":
			if (group.entries().some(entry => entry.id === "x")) group.attachUsage(["x"], USAGE, 100);
			else group.attachUsage(["a", "c"], USAGE, 1200, 300, 0, 5000);
			return;
		case "read b markdown result":
			group.updateResult(result("# Title\n\nbody text", { contentType: "text/markdown" }), false, "b");
			return;
		case "read c error":
			group.updateResult(result("Error: ENOENT no such file", undefined, true), false, "c");
			return;
		case "expanded":
			group.setExpanded(true);
			return;
		case "native toggle full":
			group.toggle("full", true);
			return;
		case "native toggle preview a":
			group.toggle("pa", false);
			return;
		case "native fold root":
			group.toggle("", true);
			return;
		case "entry b renamed":
			group.renameEntry("b", "b2");
			return;
		case "activity hidden":
			group.setActivityVisible(false);
			return;
		case "activity shown":
			group.setActivityVisible(true);
			return;
		case "sealed":
			group.seal();
			return;
		case "entry a removed":
			group.removeEntry("a");
			return;
		case "read args":
			group.updateArgs({ path: "lib/x.py?q=foo" }, "x");
			return;
		case "result with suffix resolution and conflicts":
			group.updateResult(
				result("ok", {
					suffixResolution: { from: "lib/y.py", to: "lib/x.py" },
					conflictCount: 2,
				}),
				false,
				"x",
			);
			return;
		case "presentation refreshed":
			group.refreshPresentation();
			return;
		case "presenters removed":
			group.setPresenter(undefined);
			return;
		case "presenters restored":
			group.setPresenter(PRESENTER);
			return;
		case "native open compact a":
			group.toggle("ca", false);
			return;
		default:
			throw new Error(`read group: unknown step ${JSON.stringify(label)}`);
	}
}

export interface GroupStageResult {
	readonly label: string;
	readonly native: string | null;
	readonly rows: Readonly<Record<string, string | null>>;
}

/** Drive a case and compare every stage. */
export function checkReadGroupCase(corpusCase: CorpusCase): GroupStageResult[] {
	const env = corpusEnvironment(corpusCase.theme);
	setCurrentTheme(loadThemeSync(corpusCase.theme));
	const inputs = corpusCase.inputs as {
		readonly component: string;
		readonly presenter?: string;
	};
	const group = new ReadGroup({
		showContentPreview: /showContentPreview: true/.test(inputs.component),
	});
	if (inputs.presenter) group.setPresenter(PRESENTER);
	const holder = createRoot(() => (<col>{ReadGroupBlock({ group }) as unknown as JSXNode}</col>) as unknown) as UiNode;
	const out: GroupStageResult[] = [];
	for (let index = 0; index < corpusCase.stages.length; index++) {
		const stage = corpusCase.stages[index]!;
		step(group, stage.label);
		const block = holder.children()[0];
		if (!isUiNode(block)) throw new Error("read group: block must be one node");
		const native = firstDiff(stageNative(corpusCase, index), describeTree(block, env));
		const rows: Record<string, string | null> = {};
		for (const width of corpusCase.widths)
			rows[String(width)] = firstCellDiff(stage.rows[String(width)] ?? [], paintNode(env, block, width).rows);
		out.push({ label: stage.label, native, rows });
	}
	return out;
}

export function readGroupCaseFiles(): string[] {
	const dir = path.join(CORPUS_DIR, SCREEN);
	return fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter(file => file.endsWith(".json"))
				.sort()
		: [];
}

export function loadReadGroupCase(file: string): CorpusCase {
	return JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, SCREEN, file), "utf8")) as CorpusCase;
}

if (!Bun.env.PI_UI_SCREEN_RUNNER) {
	test("opening a grouped Markdown preview leaves the other read folded", async () => {
		const group = new ReadGroup({ showContentPreview: true });
		for (const id of ["a", "b"]) {
			group.updateArgs({ path: `${id}.md` }, id);
			group.updateResult(result(`# ${id}\n\nContents`, { contentType: "text/markdown" }), false, id);
		}
		group.seal();
		await using ui = await nativeShell();
		const block = ui.shell.transcript.append(() => ReadGroupBlock({ group }));
		ui.shell.transcript.settle(block);
		const second = ui.node("card", "mb");
		ui.send({ ev: "toggle", sf: ui.sf, id: second.id, collapsed: false });
		expect(ui.node("card", "mb").p.collapsed).toBe(false);
		expect(ui.node("card", "ma").p.collapsed).toBe(true);
	});

	const files = readGroupCaseFiles();
	describe.skipIf(files.length === 0)(`${SCREEN} corpus`, () => {
		for (const file of files) {
			test(file, () => {
				const failures: string[] = [];
				for (const stage of checkReadGroupCase(loadReadGroupCase(file))) {
					if (stage.native) failures.push(`${stage.label} native: ${stage.native}`);
					for (const width in stage.rows) {
						const diff = stage.rows[width];
						if (diff) failures.push(`${stage.label} rows@${width}: ${diff}`);
					}
				}
				expect(failures).toEqual([]);
			});
		}
	});
}
