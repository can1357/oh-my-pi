/**
 * The status line's facts in the native composer, against the `composer/surface`
 * corpus (default preset over the capture's session): the context meter, the
 * extras bar, the usage text and the model chip's label, wherever a stage shows them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { createRoot, isUiNode, type JSXNode, signal } from "@oh-my-pi/pi-tui";
import {
	CORPUS_DIR,
	type CorpusCase,
	corpusEnvironment,
	describeTree,
	stageNative,
} from "@oh-my-pi/pi-tui/testing/corpus";
import type { StatusLineSegmentOptions } from "../../../src/modes/view-model/status-line/types";
import { composerFacts } from "../../../src/ui/status/composer-facts";
import type { StatusFacts } from "../../../src/ui/status/facts";
import { corpusStatusFacts } from "./fixture";

const SCREEN = "composer/surface";

interface NativeNode {
	readonly k: string;
	readonly key?: string;
	readonly p?: Record<string, unknown>;
	readonly c?: readonly NativeNode[];
}

function find(node: NativeNode, match: (node: NativeNode) => boolean): NativeNode | undefined {
	if (match(node)) return node;
	for (const child of node.c ?? []) {
		const found = find(child, match);
		if (found) return found;
	}
	return undefined;
}

test("the native composer cache fact describes the next message only when cache status is known", () => {
	const env = corpusEnvironment("dark");
	createRoot(dispose => {
		try {
			const base = corpusStatusFacts();
			const facts = signal<StatusFacts>(base);
			const { extras } = composerFacts({
				settings: () => ({ preset: "custom", leftSegments: ["cache"], rightSegments: [] }),
				facts,
				click: action => ({ click: action }),
			});
			if (!isUiNode(extras)) throw new Error("Expected the composer extras node");
			const native = () => describeTree(extras, env);
			expect(native()).not.toHaveProperty("c");

			const entry = { inferred: true, touchedAt: base.now, cachedTokens: 42, nextTokens: 60 };
			facts.set({ ...base, promptCache: { ...entry, state: "warm", tier: "short" } });
			expect(native()).toMatchObject({
				c: [
					{
						k: "seg",
						key: "cache",
						p: {
							role: "omp.composer.cache",
							side: "right",
							aria: "Likely cached, no expiry",
							actions: { click: "status.cache" },
							hovercard: {
								k: "col",
								p: { role: "omp.composer.cache.card" },
								c: [
									{ k: "text", p: { text: "Likely cached, no expiry" } },
									{ k: "text", p: { spans: [{ t: "Next message reads ~42 from cache", s: "muted" }] } },
								],
							},
						},
					},
				],
			});

			facts.set({
				...base,
				promptCache: { ...entry, state: "cold", tier: "short", reason: { kind: "expired", at: base.now } },
			});
			expect(native()).toMatchObject({
				c: [
					{
						k: "seg",
						key: "cache",
						p: {
							title: "Not cached — expired\nNext message re-sends ~60",
							hovercard: {
								k: "col",
								p: { role: "omp.composer.cache.card" },
								c: [
									{ k: "text", p: { spans: [{ t: "Not cached — expired", s: "warning" }] } },
									{ k: "text", p: { spans: [{ t: "Next message re-sends ~60", s: "muted" }] } },
								],
							},
						},
					},
				],
			});
			facts.set(base);
			expect(native()).not.toHaveProperty("c");
		} finally {
			dispose();
		}
	});
});

test("the composer model chip keeps the user's model display options", () => {
	createRoot(dispose => {
		try {
			const facts = signal<StatusFacts>({
				...corpusStatusFacts(),
				model: { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", thinking: true },
			});
			const label = (model: StatusLineSegmentOptions["model"]) =>
				composerFacts({
					settings: () => ({ preset: "default", segmentOptions: { model } }),
					facts,
					click: action => ({ click: action }),
				})
					.model()
					.map(span => span.t)
					.join("");
			expect(label({ showProvider: true })).toBe("anthropic/Opus 4.8");
			expect(label({ showProvider: true, display: "id" })).toBe("anthropic/claude-opus-4-8");
			expect(label({})).toBe("Opus 4.8");
		} finally {
			dispose();
		}
	});
});

const dir = path.join(CORPUS_DIR, SCREEN);
const files = fs.existsSync(dir)
	? fs
			.readdirSync(dir)
			.filter(file => file.endsWith(".json"))
			.sort()
	: [];

describe.skipIf(files.length === 0)(`${SCREEN} status facts`, () => {
	for (const file of files) {
		test(file, () => {
			const corpusCase = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as CorpusCase;
			const env = corpusEnvironment(corpusCase.theme);
			const failures: string[] = [];
			let compared = 0;
			createRoot(dispose => {
				const slots = composerFacts({
					settings: () => ({ preset: "default" }),
					facts: signal(corpusStatusFacts()),
					click: action => ({ click: action }),
				});
				const describeNode = (node: JSXNode) => (isUiNode(node) ? describeTree(node, env) : undefined);
				corpusCase.stages.forEach((stage, index) => {
					const native = stageNative(corpusCase, index) as NativeNode | null;
					if (!native) return;
					const expected: [string, NativeNode | undefined, unknown][] = [
						["context", find(native, n => n.k === "meter" && n.key === "context"), describeNode(slots.context)],
						["extras", find(native, n => n.k === "status" && n.key === "extras"), describeNode(slots.extras)],
						["usage", find(native, n => n.k === "text" && n.key === "usage"), describeNode(slots.usage)],
					];
					const model = find(native, n => n.k === "row" && n.key === "model");
					const name = model && find(model, n => n.k === "text" && n.key === "name");
					for (const [slot, want, got] of expected) {
						if (!want) continue;
						compared++;
						if (!Bun.deepEquals(want, got)) {
							failures.push(`${stage.label} ${slot}: ${JSON.stringify(want)} vs ${JSON.stringify(got)}`);
						}
					}
					if (name) {
						compared++;
						const want = name.p?.spans;
						if (!Bun.deepEquals(want, slots.model()))
							failures.push(`${stage.label} model: ${JSON.stringify(want)}`);
					}
				});
				dispose();
			});
			expect(failures).toEqual([]);
			expect(compared).toBeGreaterThan(0);
		});
	}
});
