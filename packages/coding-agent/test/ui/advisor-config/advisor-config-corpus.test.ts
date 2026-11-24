/**
 * Corpus parity of the advisor-config overlay (`overlays/advisor-config`):
 * every case, both themes, replayed through keys, pointer reports, pastes,
 * native page events and the editor sheet's picker events.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { batch, type UiNode } from "@oh-my-pi/pi-tui";
import { bubbleEvent, bubblePaste, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import { type CorpusCase, corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { fullscreenMenuView } from "../../../src/modes/controllers/selector-views";
import { nativeShell } from "../../helpers/native-shell";
import { nodeAtKeypath } from "../overlays/panels/harness";
import { caseFiles, checkStage, type Driven, hasCorpus, sendInput } from "../settings/harness";
import { buildAdvisorConfig, STEPS } from "./fixture";

const SCREEN = "advisor-config";
const HEIGHT = 40;
const FIT_WIDTHS = [1, 8, 12, 20, 33, 60, 100, 160, 240];

/** The case name of a corpus file (`roster.dark.json` → `roster`). */
function caseName(file: string): string {
	return path.basename(file).split(".")[0]!;
}

async function replay(file: string): Promise<{ passed: number; total: number; failures: string[] }> {
	const corpus = (await Bun.file(file).json()) as CorpusCase;
	const env = corpusEnvironment(corpus.theme);
	const name = caseName(file);
	const fixture = buildAdvisorConfig(name, corpus.theme);
	const driven: Driven = { root: fixture.root, height: HEIGHT };
	const steps = STEPS[name]!;
	// The capture snapshots after the builder's promise settles (the usage reports are in by then).
	await Bun.sleep(1);
	const geometry = corpus.widths[corpus.widths.length - 1]!;
	const failures: string[] = [];
	let passed = 0;
	for (let i = 0; i < corpus.stages.length; i++) {
		const label = corpus.stages[i]!.label;
		if (i > 0) {
			const step = label.startsWith("key ") ? { keys: [JSON.parse(label.slice(4)) as string] } : steps[label];
			if (!step) throw new Error(`${name}: no step for ${label}`);
			if ("keys" in step) for (const raw of step.keys) sendInput(env, driven, raw, geometry);
			else if ("event" in step) {
				const target = nodeAtKeypath(fixture.root, step.event.key);
				if (target) batch(() => bubbleEvent(pathTo([fixture.root], target), step.event));
			} else if ("picker" in step) {
				const sheet = fixture.root.children().find((child: UiNode) => child.kind === "picker");
				if (sheet) batch(() => bubbleEvent(pathTo([fixture.root], sheet), step.picker));
			} else if ("paste" in step) batch(() => bubblePaste([fixture.root], { text: step.paste }));
			else if ("tick" in step) fixture.statTokens.update(n => n + 1000);
			else if ("flush" in step) await Bun.sleep(1);
			// The capture awaited each step: promises the step settled have run their continuations.
			await undefined;
		}
		const stageFailures = checkStage(corpus, i, env, driven);
		// Widths the capture builder listed beyond the recorded ones: every row must fit.
		for (const width of FIT_WIDTHS) {
			const rows = paintNode(env, fixture.root, width, HEIGHT).rows;
			const wide = rows.findIndex(row => visibleWidth(row) > width);
			if (wide >= 0) stageFailures.push(`w${width}: row ${wide} is ${visibleWidth(rows[wide]!)} cells`);
		}
		if (stageFailures.length === 0) passed++;
		else failures.push(`[${i}] ${label}: ${stageFailures.join("\n      ")}`);
	}
	return { passed, total: corpus.stages.length, failures };
}

test("prefs actions under the advisor sheet open, edit and save shared instructions", async () => {
	await using ui = await nativeShell();
	let saved: string | undefined;
	const overlay = ui.shell.overlays.show(() => {
		const { root } = buildAdvisorConfig("native-prefs", "dark", {
			save: async (_scope, doc) => {
				saved = doc.instructions;
			},
			close: () => ui.shell.overlays.closeAll(),
		});
		return fullscreenMenuView("advisor-config", root);
	});
	const sf = ui.sf;
	const id = ui.node("prefs").id;
	ui.send({ ev: "action", sf, id, act: "page", value: "shared" });
	const editor = ui.node("editor");
	const len = String(editor.p.text).length;
	ui.send({ ev: "edit", sf, id: editor.id, len, from: 0, to: len, text: "New policy", cursor: 10 });
	ui.send({ ev: "action", sf, id: ui.node("button", "submit").id, act: "submit" });
	ui.send({ ev: "action", sf, id, act: "save" });
	await Promise.resolve();
	expect(saved).toBe("New policy");
	ui.send({ ev: "action", sf, id, act: "close" });
	expect(overlay.closed).toBe(true);
});

describe.skipIf(!hasCorpus(SCREEN))("overlays/advisor-config corpus", () => {
	const files = hasCorpus(SCREEN) ? caseFiles(SCREEN) : [];
	for (const file of files) {
		test(path.basename(file, ".json"), async () => {
			const result = await replay(file);
			if (result.failures.length > 0)
				console.log(
					`${path.basename(file)} ${result.passed}/${result.total}\n  ${result.failures.slice(0, 4).join("\n  ")}`,
				);
			expect(result.failures).toEqual([]);
		});
	}
});
