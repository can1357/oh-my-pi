/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A finished reply stays out of terminal scrollback until its figure's
 * raster lands: settling a transcript block whose SVG still rasterizes
 * leaves it live (a terminal keeps painting it), and the block settles
 * once the raster lands, or once the source fails to draw.
 */
import { describe, expect, test } from "bun:test";
import { isSettled, signal } from "@oh-my-pi/pi-tui";
import { Transcript } from "../../../../src/ui/shell/transcript";
import {
	DEFAULT_FIGURE_CELL,
	FenceFigure,
	FigureMarkdown,
	figureWorkSettled,
} from "../../../../src/ui/transcript/figures";

const FIGURE = "<svg viewBox='0 0 80 20'><rect width='80' height='20' fill='var(--accent)'/></svg>";

function figureBlock(transcript: Transcript, source: string) {
	return transcript.append(() => (
		<col>
			<text text="Before" />
			<FenceFigure lang="svg" source={source} closed={true} cell={DEFAULT_FIGURE_CELL} />
		</col>
	));
}

describe("svg figure settle hold", () => {
	test("a settled block waits for its figure's raster", async () => {
		const transcript = new Transcript();
		const block = figureBlock(transcript, FIGURE);
		transcript.settle(block);
		expect(isSettled(block.node)).toBe(false);
		await figureWorkSettled();
		expect(isSettled(block.node)).toBe(true);
		expect(
			JSON.stringify(
				block.node
					.children()[0]!
					.children()
					.map(child => child.kind),
			),
		).toContain("image");
	});

	test("a reply settled as it stops streaming waits for the figure its final text builds", async () => {
		const transcript = new Transcript();
		const streaming = signal(true);
		const block = transcript.append(() => (
			<FigureMarkdown
				text={`Before\n\n\`\`\`svg\n${FIGURE}\n\`\`\`\n\nAfter`}
				streaming={streaming}
				charts={false}
				showImages={true}
				cell={DEFAULT_FIGURE_CELL}
			/>
		));
		// No frame painted the reply between the end of its stream and its settling.
		streaming.set(false);
		transcript.settle(block);
		expect(isSettled(block.node)).toBe(false);
		await figureWorkSettled();
		expect(isSettled(block.node)).toBe(true);
	});

	test("a source that never draws releases the block once it fails", async () => {
		const transcript = new Transcript();
		const block = figureBlock(transcript, "<svg><rect width='x' </svg>");
		transcript.settle(block);
		await figureWorkSettled();
		expect(isSettled(block.node)).toBe(true);
	});

	test("a block without figures settles at once; a raster that already landed holds nothing", async () => {
		const transcript = new Transcript();
		const plain = transcript.append(() => <text text="plain" />);
		transcript.settle(plain);
		expect(isSettled(plain.node)).toBe(true);

		const drawn = figureBlock(transcript, FIGURE);
		await figureWorkSettled();
		transcript.settle(drawn);
		expect(isSettled(drawn.node)).toBe(true);
	});
});
