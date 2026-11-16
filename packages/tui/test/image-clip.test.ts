import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ImageBudget } from "@oh-my-pi/pi-natives";
import { Image } from "@oh-my-pi/pi-tui/components/image";
import { type CellDimensions, getCellDimensions, setCellDimensions } from "@oh-my-pi/pi-tui/inline-image";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { type HistoryBatch, TUI } from "@oh-my-pi/pi-tui/tui";
import { forceImageProtocol } from "./helpers/image-protocol";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

type MutableTerminalInfo = { id: string; imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

// Direct-placement contract: a straddling image block must be re-anchored at
// its first visible row with the source rectangle clipped to the visible
// slice, and a placement id whose cells reached native scrollback must never
// be re-used (Kitty replace semantics strip the old placement everywhere,
// scrollback included — the permanently cropped images on WezTerm).

let restoreProtocol: () => void;
const originalTerminalId = terminal.id;
const originalGraphics = TERMINAL.kittyUnicodePlaceholders;
let originalCellDims: CellDimensions;

beforeEach(() => {
	originalCellDims = getCellDimensions();
	setCellDimensions({ widthPx: 10, heightPx: 10 });
	restoreProtocol = forceImageProtocol(ImageProtocol.Kitty);
	terminal.id = "wezterm";
	TERMINAL.kittyUnicodePlaceholders = false;
});

afterEach(() => {
	setCellDimensions(originalCellDims);
	restoreProtocol();
	terminal.id = originalTerminalId;
	TERMINAL.kittyUnicodePlaceholders = originalGraphics;
});

describe("kitty direct-placement wire format", () => {
	it("renders a direct placement as the exact last line the terminal engine parses", () => {
		const budget = new ImageBudget(8);
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 6, budget, imageKey: "roundtrip" },
			{ widthPx: 40, heightPx: 60 },
		);
		const imageId = budget.acquireId("roundtrip");
		budget.beginPass();
		const lines = image.render(40);
		budget.endPass();
		expect(lines.length).toBe(6);
		// The native frame writer recognizes exactly this shape (cursor save, CUU(rows-1), the `a=p`
		// command with image id, placement id, columns and rows, cursor restore) and rebuilds it for
		// the row it is written at; any other shape is written verbatim, unclipped.
		expect(lines[lines.length - 1]).toBe(
			`\x1b7\x1b[5A\x1b_Ga=p,q=2,C=1,i=${imageId},p=${imageId},c=4,r=6\x1b\\\x1b8`,
		);
	});
});

/** A multi-row graphic for exercising viewport ownership against the terminal engine. */
function image(budget: ImageBudget): Image {
	return new Image(
		BASE64_ONE_PIXEL_PNG,
		"image/png",
		{ fallbackColor: text => text },
		{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "placement" },
		{ widthPx: 40, heightPx: 40 },
	);
}

describe("direct placement lifecycle", () => {
	for (const fullscreen of [false, true]) {
		it(`removes moved and hidden images from the ${fullscreen ? "alternate" : "normal"} viewport`, async () => {
			const term = new VirtualTerminal(40, 12);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const graphic = image(tui.imageBudget);
			let top = 1;
			let visible = true;
			const render = (width: number) => [
				...Array.from({ length: top }, (_, index) => `prose ${index}`),
				...(visible ? graphic.render(width) : ["replacement prose"]),
			];
			tui.setFrameProvider({ renderFrame: size => ({ viewport: render(size.columns) }), acknowledgeHistory() {} });
			if (fullscreen) tui.showOverlay({ render, invalidate() {} }, { fullscreen: true, anchor: "top-left" });
			try {
				tui.start();
				await scheduler.settle(term);
				expect(term.graphicsPlacements().map(placement => placement.row)).toEqual([1]);

				top = 2;
				tui.requestRender();
				await scheduler.settle(term);
				expect(term.graphicsPlacements().map(placement => placement.row)).toEqual([2]);

				visible = false;
				tui.requestRender();
				await scheduler.settle(term);
				expect(term.graphicsPlacements()).toEqual([]);
				expect(term.getViewport()[2]?.trimEnd()).toBe("replacement prose");
			} finally {
				tui.stop();
			}
		});
	}

	it("deletes a live copy without deleting the same image already committed to scrollback", async () => {
		const term = new VirtualTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const graphic = image(tui.imageBudget);
		let append = false;
		let acknowledged = false;
		let visible = true;
		tui.setFrameProvider({
			renderFrame: size => {
				const rows = graphic.render(size.columns);
				const history: HistoryBatch | undefined =
					append && !acknowledged
						? { id: 1, rows: [...rows, ...Array.from({ length: 16 }, (_, index) => `history ${index}`)] }
						: undefined;
				return { history, viewport: visible ? rows : ["replacement prose"] };
			},
			acknowledgeHistory() {
				acknowledged = true;
			},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			append = true;
			visible = false;
			tui.requestRender();
			await scheduler.settle(term);
			const archived = term.graphicsPlacements();
			expect(archived).toHaveLength(1);

			visible = true;
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.graphicsPlacements()).toHaveLength(2);

			visible = false;
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.graphicsPlacements()).toEqual(archived);
		} finally {
			tui.stop();
		}
	});

	it("preserves replay history split into the viewport after the next live repaint", async () => {
		const term = new VirtualTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const graphic = image(tui.imageBudget);
		let acknowledged = false;
		tui.setFrameProvider({
			renderFrame: size => ({
				history: acknowledged ? undefined : { id: 1, kind: "replay", rows: graphic.render(size.columns) },
				viewport: ["live prose"],
			}),
			acknowledgeHistory() {
				acknowledged = true;
			},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			const archived = term.graphicsPlacements();
			expect(archived).toHaveLength(1);

			tui.requestRender();
			await scheduler.settle(term);
			expect(term.graphicsPlacements()).toEqual(archived);
		} finally {
			tui.stop();
		}
	});
});

describe("uncroppable image blocks", () => {
	for (const protocol of [ImageProtocol.Iterm2, ImageProtocol.Kitty]) {
		it(`does not draw a top-clipped ${protocol === ImageProtocol.Kitty ? "Kitty transmit-and-display" : "iTerm2"} image over following text`, async () => {
			forceImageProtocol(protocol);
			const term = new VirtualTerminal(40, 8);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const graphic = new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: text => text },
				{ maxWidthCells: 4, maxHeightCells: 4 },
				{ widthPx: 40, heightPx: 40 },
			);
			const settled = ["table row", "table border"];
			let retired = false;
			let accepted = false;
			tui.setFrameProvider({
				renderFrame: size => {
					const block = graphic.render(size.columns);
					if (!retired) return { viewport: [...settled, ...block, "following text"] };
					return {
						history: accepted ? undefined : { id: 1, rows: settled },
						viewport: [...block.slice(2), "following text"],
					};
				},
				acknowledgeHistory() {
					accepted = true;
				},
			});
			const writes: string[] = [];
			const write = term.receive.bind(term);
			term.receive = data => {
				writes.push(data);
				write(data);
			};
			try {
				tui.start();
				await scheduler.settle(term);
				expect(writes.join("")).toContain(protocol);
				writes.length = 0;
				retired = true;
				tui.requestRender();
				await scheduler.settle(term);
				const output = writes.join("");
				expect(output).not.toContain(protocol);
				expect(
					term
						.getViewport()
						.map(row => row.trimEnd())
						.slice(0, 2),
				).toEqual(settled);
				expect(term.getViewport()[4]?.trimEnd()).toBe("following text");
			} finally {
				tui.stop();
			}
		});
	}
});
