/**
 * Composer parity inside the app surface (`composer/surface`): the
 * composer-owned part of every stage. The dock's tail — the attachment band
 * (while the stage shows it) and the composer — must match the viewport's
 * last rows and the cursor; their native nodes must match the dock's
 * `omp.composer.chips` row and `omp.editor` column. The status facts the
 * app slots into the composer are rebuilt from the stage's native tree (the
 * status line owns them); welcome, transcript and queued messages belong to
 * their own screens.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { createRoot, type JSXNode, jsx, type Signal, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import {
	CORPUS_DIR,
	type CorpusCase,
	corpusEnvironment,
	describeTree,
	listCases,
	loadCase,
	stageNative,
} from "@oh-my-pi/pi-tui/testing/corpus";
import { Composer, ComposerChips, type ComposerSlots } from "../../../src/ui/composer";
import { fixtureProvider, key, sendKey, settle, subsetDiff } from "./harness";

const SCREEN = "composer/surface";

interface NativeNode {
	readonly k: string;
	readonly key?: string;
	readonly p?: Record<string, unknown>;
	readonly c?: readonly NativeNode[];
}

/** A node describing to `native` (slot facts the status line owns). */
function build(native: NativeNode): JSXNode {
	return jsx(native.k, { ...native.p, children: (native.c ?? []).map(build) }, native.key);
}

/** The dock column of a stage's native tree. */
function dock(corpusCase: CorpusCase, index: number): readonly NativeNode[] {
	return ((stageNative(corpusCase, index) as NativeNode).c?.[1]?.c ?? []) as readonly NativeNode[];
}

/** The slots a stage's composer shows. */
function slots(composerNative: NativeNode | undefined): ComposerSlots {
	const out: Record<string, JSXNode> = {};
	for (const child of composerNative?.c ?? []) {
		if (child.key === "context") out.context = build(child);
		if (child.key !== "bar") continue;
		for (const fact of child.c ?? []) {
			if (fact.key === "send" || fact.key === "stop" || fact.key === "gap") continue;
			out[fact.key ?? ""] = build(fact);
		}
	}
	return out;
}

describe.skipIf(!fs.existsSync(path.join(CORPUS_DIR, SCREEN)))(SCREEN, async () => {
	for (const file of await listCases(SCREEN)) {
		test(file, async () => {
			const corpusCase = await loadCase(file.replace(/\.json$/, ""));
			const env = corpusEnvironment(corpusCase.theme);
			const inputs = corpusCase.inputs as {
				composer: { composerShape?: string };
				autocompleteProvider?: Parameters<typeof fixtureProvider>[0];
			};
			await createRoot(async dispose => {
				const composer = new Composer({
					shape: inputs.composer.composerShape ?? "band",
					caret: "terminal",
					sendable: false,
					autocomplete: inputs.autocompleteProvider ? fixtureProvider(inputs.autocompleteProvider) : undefined,
				});
				const showChips: Signal<boolean> = signal(false);
				const band = jsx("col", { children: () => (showChips() ? ComposerChips({ composer }) : null) }) as UiNode;
				env.setFocus(composer.field);
				const problems: string[] = [];
				for (let i = 0; i < corpusCase.stages.length; i++) {
					const stage = corpusCase.stages[i]!;
					const label = stage.label;
					const typed = /^type (".*")$/.exec(label);
					if (typed)
						for (const ch of JSON.parse(typed[1]!) as string) sendKey(composer.node, composer.field, key(ch));
					else if (label === "busy") composer.setState({ running: true });
					else if (label === "attachment chips") composer.insertTextAttachment("pasted\nblock\nof text");
					else if (label === "idle again") composer.setState({ running: false });
					else if (label === "cleared") composer.clearDraft();
					else if (label === "slash popup") sendKey(composer.node, composer.field, key("/"));
					showChips.set(label === "attachment chips" || label === "idle again");
					await settle();

					const docked = dock(corpusCase, i);
					const expectedComposer = docked.find(n => String(n.p?.role ?? "").startsWith("omp.editor"));
					composer.setSlots(slots(expectedComposer));
					const native = subsetDiff(expectedComposer, describeTree(composer.node, env), "$");
					if (native) problems.push(`[${i}] ${label}: native ${native}`);
					const expectedChips = docked.find(n => n.p?.role === "omp.composer.chips");
					const chipsNode = band.children()[0];
					if (expectedChips || chipsNode) {
						const diff = subsetDiff(expectedChips, chipsNode && describeTree(chipsNode, env), "$chips");
						if (diff) problems.push(`[${i}] ${label}: native ${diff}`);
					}

					for (const width of corpusCase.widths) {
						const viewport = stage.rows[String(width)] ?? [];
						const bandRows = chipsNode ? paintNode(env, chipsNode, width).rows : [];
						const block = paintNode(env, composer.node, width);
						const rows = [...bandRows, ...block.rows];
						const top = viewport.length - rows.length;
						const diff = firstCellDiff(viewport.slice(Math.max(0, top)), rows);
						if (diff) problems.push(`[${i}] ${label}: w${width} ${diff}`);
						const expected = stage.cursor?.[String(width)] ?? null;
						const actual = block.cursor
							? { row: top + bandRows.length + block.cursor.row, col: block.cursor.col }
							: null;
						if (JSON.stringify(expected) !== JSON.stringify(actual))
							problems.push(
								`[${i}] ${label}: w${width} cursor ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`,
							);
					}
				}
				dispose();
				expect(problems).toEqual([]);
			});
		});
	}
});
