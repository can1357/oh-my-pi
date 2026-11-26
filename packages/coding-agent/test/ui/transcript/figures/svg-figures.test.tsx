/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { createRoot, signal } from "@oh-my-pi/pi-tui";
import {
	DEFAULT_FIGURE_CELL,
	type Embed,
	EmbedFigure,
	FenceFigure,
	figureWorkSettled,
	SvgFigure,
	SvgRaster,
	TableChart,
} from "../../../../src/ui/transcript/figures";
import { single } from "../messages/harness";
import { figureSuite } from "./harness";

/** The cell size every figure capture pinned. */
const cell = DEFAULT_FIGURE_CELL;

figureSuite("svg-figure", corpusCase => {
	const inputs = corpusCase.inputs as {
		codeFallback: boolean;
		maxRows: number | null;
		stages: { source: string; final: boolean }[];
	};
	const raster = new SvgRaster({ cell, maxRows: inputs.maxRows ?? undefined });
	return {
		node: single(
			<col>
				<SvgFigure raster={raster} codeFallback={inputs.codeFallback} />
			</col>,
		),
		async apply(label) {
			if (label === "partial") raster.update(inputs.stages[0]!.source, false);
			else if (label === "final settled") {
				raster.update(inputs.stages[1]!.source, true);
				await figureWorkSettled();
			} else throw new Error(`unknown stage ${label}`);
		},
	};
});

test("a room change redraws an SVG only when one of the rooms cuts it", async () => {
	const room = signal<number | undefined>(40);
	let raster!: SvgRaster;
	const dispose = createRoot(dispose => {
		raster = new SvgRaster({ cell, maxRows: room });
		return dispose;
	});
	const drawn = () => {
		const state = raster.state();
		if (state.status !== "ready") throw new Error(`raster ${state.status}`);
		return state.raster;
	};
	try {
		// Four rows tall at its natural size.
		raster.update(`<svg width="80" height="${4 * cell.h}"><rect width="80" height="${4 * cell.h}"/></svg>`, true);
		await figureWorkSettled();
		const natural = drawn();
		expect(natural.h).toBe(4 * cell.h);

		room.set(20);
		await figureWorkSettled();
		expect(drawn()).toBe(natural);

		room.set(2);
		await figureWorkSettled();
		expect(drawn().h).toBeLessThanOrEqual(2 * cell.h);

		room.set(20);
		await figureWorkSettled();
		expect(drawn().h).toBe(natural.h);
	} finally {
		dispose();
	}
});

figureSuite("fence-figure", corpusCase => {
	const inputs = corpusCase.inputs as {
		lang: string;
		source?: string;
		closed?: boolean;
		stages?: { source: string; closed: boolean }[];
	};
	const source = signal("");
	const closed = signal(false);
	const stage = (next: { source: string; closed: boolean }): void => {
		source.set(next.source);
		closed.set(next.closed);
	};
	return {
		node: single(
			<col>
				<FenceFigure lang={inputs.lang} source={source} closed={closed} cell={cell} />
			</col>,
		),
		async apply(label, index) {
			if (label === "open fence") stage({ source: inputs.source!, closed: inputs.closed! });
			else if (label === "final settled") {
				stage(inputs.stages![1]!);
				await figureWorkSettled();
			} else stage(inputs.stages![index - 1]!);
		},
	};
});

figureSuite("table-chart", corpusCase => {
	const inputs = corpusCase.inputs as { maxRows: number | null; stages: string[] };
	const markdown = signal("");
	return {
		node: single(
			<col>
				<TableChart markdown={markdown} cell={cell} maxRows={inputs.maxRows ?? undefined} />
			</col>,
		),
		async apply(label) {
			if (label === "numeric table settled") markdown.set(inputs.stages[0]!);
			else if (label === "text-only table") markdown.set(inputs.stages[1]!);
			else throw new Error(`unknown stage ${label}`);
			await figureWorkSettled();
		},
	};
});

figureSuite("embed-figure", corpusCase => {
	const inputs = corpusCase.inputs as { embed: Embed; showImages: boolean; embedHost: { cwd: string } };
	const embed = signal<Embed | undefined>(undefined);
	const host = { cwd: () => inputs.embedHost.cwd, capturePage: () => Promise.reject(new Error("no browser")) };
	return {
		node: single(
			<col>
				<EmbedFigure embed={embed} showImages={inputs.showImages} host={host} cell={cell} />
			</col>,
		),
		async apply(label) {
			if (label !== "loaded") throw new Error(`unknown stage ${label}`);
			embed.set(inputs.embed);
			await figureWorkSettled();
		},
	};
});
