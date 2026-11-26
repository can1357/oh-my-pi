/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Corpus parity of `primitives/image` (an `image` node in a terminal without
 * an image protocol) and `primitives/sparkline` (the sparkline helpers the
 * `chart` painter draws with).
 *
 * Deviations:
 * - image `fallback-text` and `fallback-no-filename` @20: the label (34 and
 *   24 cells) is cut to the 20 cells the block got; today's row overflows
 *   the width.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRoot, isUiNode, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import { fitSparkValues, peakBuckets, sparkline } from "@oh-my-pi/pi-tui/term/painters/chart";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import {
	CORPUS_DIR,
	type CorpusCase,
	corpusEnvironment,
	describeTree,
	firstDiff,
} from "@oh-my-pi/pi-tui/testing/corpus";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

const theme = loadThemeSync("dark");

function cases(screen: string): CorpusCase[] {
	const dir = path.join(CORPUS_DIR, "primitives", screen);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter(file => file.endsWith(".dark.json"))
		.sort()
		.map(file => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as CorpusCase);
}

const IMAGE_DEVIATIONS: Record<string, string> = {
	"fallback text@20": "label cut to the 20-cell width (today's row overflows it)",
	"fallback no filename@20": "label cut to the 20-cell width (today's row overflows it)",
};

const imageCases = cases("image");
describe.skipIf(imageCases.length === 0)("primitives/image", () => {
	for (const corpusCase of imageCases) {
		test(corpusCase.case, () => {
			const inputs = corpusCase.inputs as {
				base64: string;
				mimeType: string;
				options: { filename?: string; maxWidthCells?: number; maxHeightCells?: number };
			};
			const env = corpusEnvironment(corpusCase.theme);
			const blob = registerBlob(Buffer.from(inputs.base64, "base64"), inputs.mimeType);
			const name = inputs.options.filename ? `${inputs.options.filename} ` : "";
			const alt = `[Image: ${name}[${inputs.mimeType}] 1x1]`;
			const maxW = signal(inputs.options.maxWidthCells);
			const maxH = signal(inputs.options.maxHeightCells);
			const failures: string[] = [];
			createRoot(dispose => {
				const node = (
					<image
						blob={blob}
						w={1}
						h={1}
						alt={alt}
						max={() => {
							const w = maxW();
							const h = maxH();
							if (w === undefined && h === undefined) return undefined;
							return {
								...(w === undefined ? {} : { w: `${w}ch` as const }),
								...(h === undefined ? {} : { h: `${h}lines` as const }),
							};
						}}
					/>
				) as UiNode;
				corpusCase.stages.forEach((stage, index) => {
					if (stage.label === "max width 8") maxW.set(8);
					else if (stage.label === "max height 2") maxH.set(2);
					else if (index > 0) throw new Error(`unknown stage ${stage.label}`);
					const native = firstDiff(stage.native === "same" ? undefined : stage.native, describeTree(node, env));
					if (stage.native !== "same" && native) failures.push(`${stage.label} native: ${native}`);
					for (const width of corpusCase.widths) {
						const diff = firstCellDiff(stage.rows[String(width)] ?? [], paintNode(env, node, width).rows);
						const why = IMAGE_DEVIATIONS[`${corpusCase.case}@${width}`];
						if (diff && !why) failures.push(`${stage.label} @${width}: ${diff}`);
						if (!diff && why) failures.push(`${stage.label} @${width}: listed deviation now matches`);
					}
				});
				dispose();
			});
			expect(failures).toEqual([]);
		});
	}
});

const SPARK_STYLES = {
	"fraction-color": (glyph: string, _value: number, fraction: number) =>
		theme.fg(fraction < 0.5 ? "success" : fraction < 0.8 ? "warning" : "error", glyph),
};

const sparkCases = cases("sparkline");
describe.skipIf(sparkCases.length === 0)("primitives/sparkline", () => {
	for (const corpusCase of sparkCases) {
		test(corpusCase.case, () => {
			const inputs = corpusCase.inputs as {
				values?: (number | "NaN" | null)[];
				options?: { min?: number; max?: number; gap?: string; style?: keyof typeof SPARK_STYLES };
				points?: { at: number; value: number }[];
				sinceMs?: number;
				nowMs?: number;
				host: string;
			};
			const stage = corpusCase.stages[0]!;
			for (const width of corpusCase.widths) {
				let row: string;
				if (inputs.points) {
					row = sparkline(peakBuckets(inputs.points, inputs.sinceMs!, inputs.nowMs!, width), { gap: "·" });
				} else {
					const values = inputs.values!.map(v => (v === "NaN" ? Number.NaN : (v ?? undefined)));
					const options = inputs.options ?? {};
					const fit = inputs.host.includes("fitSparkValues") && values.every(v => v !== undefined);
					row = sparkline(fit ? fitSparkValues(values as number[], width) : values, {
						...options,
						style: options.style ? SPARK_STYLES[options.style] : undefined,
					});
				}
				expect(firstCellDiff(stage.rows[String(width)] ?? [], [row])).toBeNull();
			}
		});
	}

	test("the chart painter draws a spark series the same way, toned per value", () => {
		createRoot(dispose => {
			const env = corpusEnvironment("dark");
			const node = (
				<chart kind="spark" series={[{ value: 0 }, { value: 5, tone: "error" }, { value: 10 }]} token="accent" />
			) as UiNode;
			if (!isUiNode(node)) throw new Error("expected a node");
			expect(paintNode(env, node, 20).rows).toEqual([
				theme.fg("accent", "▁") + theme.fg("error", "▅") + theme.fg("accent", "█"),
			]);
			dispose();
		});
	});
});
