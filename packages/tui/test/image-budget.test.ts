import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { Image, ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import {
	encodeKittyVirtualPlacement,
	getKittyGraphics,
	KITTY_PLACEHOLDER,
	setKittyGraphics,
} from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	encodeKitty,
	encodeKittyDeleteImage,
	encodeKittyPlacement,
	encodeKittyTransmit,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	TERMINAL,
	wrapTmuxPassthrough,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

import { VirtualTerminal } from "./virtual-terminal";

type MutableTerminalInfo = { id: string; imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

const ORIGINAL_TMUX = Bun.env.TMUX;
const ORIGINAL_HERDR_ENV = Bun.env.HERDR_ENV;

beforeEach(() => {
	delete Bun.env.TMUX;
	delete Bun.env.HERDR_ENV;
});

afterEach(() => {
	if (ORIGINAL_TMUX === undefined) delete Bun.env.TMUX;
	else Bun.env.TMUX = ORIGINAL_TMUX;
	if (ORIGINAL_HERDR_ENV === undefined) delete Bun.env.HERDR_ENV;
	else Bun.env.HERDR_ENV = ORIGINAL_HERDR_ENV;
});

/** Drive one render pass against the budget with `count` images (ids 1..count, stable across passes). */
function pass(budget: ImageBudget, count: number): { suppressed: boolean[]; reset: boolean; purge: readonly number[] } {
	budget.beginPass();
	const suppressed: boolean[] = [];
	for (let i = 0; i < count; i++) suppressed.push(budget.observe(i + 1));
	const reset = budget.endPass();
	const purge = [...budget.takePurgeIds()];
	return { suppressed, reset, purge };
}

describe("ImageBudget", () => {
	it("keeps every image live while at or under the cap", () => {
		const budget = new ImageBudget(3, () => {});
		const first = pass(budget, 2);
		expect(first.suppressed).toEqual([false, false]);
		expect(first.reset).toBe(false);

		const second = pass(budget, 3);
		expect(second.suppressed).toEqual([false, false, false]);
		expect(second.reset).toBe(false);
		expect(second.purge).toEqual([]);
	});

	it("demotes the oldest image on the frame after the cap is exceeded, purging its graphics id", () => {
		let renders = 0;
		const budget = new ImageBudget(2, () => {
			renders += 1;
		});

		// At cap: nothing demoted.
		expect(pass(budget, 2).suppressed).toEqual([false, false]);

		// Over cap: the new image still shows this frame; a follow-up render is scheduled.
		const overflow = pass(budget, 3);
		expect(overflow.suppressed).toEqual([false, false, false]);
		expect(overflow.reset).toBe(false);
		expect(renders).toBe(1);

		// The scheduled frame demotes the oldest image and purges its id (1) with a full redraw.
		const demote = pass(budget, 3);
		expect(demote.suppressed).toEqual([true, false, false]);
		expect(demote.reset).toBe(true);
		expect(demote.purge).toEqual([1]);

		// Steady state: no further resets while the count is unchanged.
		const steady = pass(budget, 3);
		expect(steady.suppressed).toEqual([true, false, false]);
		expect(steady.reset).toBe(false);
		expect(steady.purge).toEqual([]);
	});

	it("keeps exactly `cap` images live as more arrive", () => {
		const budget = new ImageBudget(2, () => {});
		// Walk up to 5 images; each addition settles into a demotion frame.
		for (let count = 3; count <= 5; count++) {
			pass(budget, count); // overflow frame (schedules reset)
			pass(budget, count); // reset frame (applies demotion)
		}
		const settled = pass(budget, 5);
		// Newest 2 live, oldest 3 demoted.
		expect(settled.suppressed).toEqual([true, true, true, false, false]);
	});

	it("treats cap <= 0 as unlimited: never demotes, never schedules a redraw", () => {
		let renders = 0;
		const budget = new ImageBudget(0, () => {
			renders += 1;
		});
		expect(budget.enabled).toBe(false);
		const result = pass(budget, 6);
		expect(result.suppressed).toEqual([false, false, false, false, false, false]);
		expect(result.reset).toBe(false);
		expect(result.purge).toEqual([]);
		expect(renders).toBe(0);
	});

	it("restores demoted images once the count settles back within the cap", () => {
		const budget = new ImageBudget(2, () => {});
		pass(budget, 3); // overflow
		pass(budget, 3); // demote oldest
		expect(pass(budget, 3).suppressed).toEqual([true, false, false]);

		// Drop back to 2 images; after the threshold settles nothing is demoted.
		pass(budget, 2);
		const restored = pass(budget, 2);
		expect(restored.suppressed).toEqual([false, false]);
		expect(restored.reset).toBe(false);
		expect(restored.purge).toEqual([]);
	});

	it("hands back a stable graphics id per key and fresh ids without one", () => {
		const budget = new ImageBudget(3, () => {});
		const a1 = budget.acquireId("tool:0");
		const a2 = budget.acquireId("tool:0");
		const b = budget.acquireId("tool:1");
		expect(a1).toBe(a2);
		expect(b).not.toBe(a1);
		expect(budget.acquireId()).not.toBe(budget.acquireId());
	});

	it("initializes separate budgets with different starting IDs", () => {
		const budget1 = new ImageBudget();
		const budget2 = new ImageBudget();
		expect(budget1.acquireId()).not.toBe(budget2.acquireId());
	});
	it("evicts demoted IDs from the key map so a returned key gets a fresh ID", () => {
		const budget = new ImageBudget(2, () => {});
		const id1 = budget.acquireId("keyA");
		const id2 = budget.acquireId("keyB");
		const id3 = budget.acquireId("keyC");

		// At cap: only 2 images.
		budget.beginPass();
		budget.observe(id1);
		budget.observe(id2);
		budget.endPass();

		// acquireId should return the same IDs.
		expect(budget.acquireId("keyA")).toBe(id1);
		expect(budget.acquireId("keyB")).toBe(id2);

		// Overflow: observe 3 images.
		budget.beginPass();
		budget.observe(id1);
		budget.observe(id2);
		budget.observe(id3);
		budget.endPass(); // schedules demotion of id1

		// The key map should STILL hold id1 because it's not purged until the demotion frame.
		expect(budget.acquireId("keyA")).toBe(id1);

		// Demotion frame: applies the purge of id1.
		budget.beginPass();
		budget.observe(id1);
		budget.observe(id2);
		budget.observe(id3);
		const reset = budget.endPass();
		expect(reset).toBe(true);

		// id1 was purged. Acquiring "keyA" now yields a fresh ID.
		const id1Fresh = budget.acquireId("keyA");
		expect(id1Fresh).not.toBe(id1);

		// The other keys are still intact.
		expect(budget.acquireId("keyB")).toBe(id2);
		expect(budget.acquireId("keyC")).toBe(id3);
	});

	it("evicts keys reacquired for images that remain suppressed", () => {
		const budget = new ImageBudget(2, () => {});
		const oldId = budget.acquireId("keyA");
		const id2 = budget.acquireId("keyB");
		const id3 = budget.acquireId("keyC");

		budget.beginPass();
		budget.observe(oldId);
		budget.observe(id2);
		budget.observe(id3);
		budget.endPass();

		budget.beginPass();
		budget.observe(oldId);
		budget.observe(id2);
		budget.observe(id3);
		expect(budget.endPass()).toBe(true);
		expect([...budget.takePurgeIds()]).toEqual([oldId]);

		const suppressedId = budget.acquireId("keyA");
		expect(suppressedId).not.toBe(oldId);

		budget.beginPass();
		expect(budget.observe(suppressedId)).toBe(true);
		expect(budget.observe(id2)).toBe(false);
		expect(budget.observe(id3)).toBe(false);
		expect(budget.endPass()).toBe(false);
		expect([...budget.takePurgeIds()]).toEqual([]);

		expect(budget.acquireId("keyA")).not.toBe(suppressedId);
	});

	it("clears all keys from the map on takeAllTransmittedIds", () => {
		const budget = new ImageBudget(3, () => {});
		const id1 = budget.acquireId("keyA");
		const id2 = budget.acquireId("keyB");

		// ensure they're in the transmit tracking
		budget.enqueueTransmit(id1, "TX1");
		budget.enqueueTransmit(id2, "TX2");

		budget.takeAllTransmittedIds();

		// The keys must yield fresh IDs now.
		expect(budget.acquireId("keyA")).not.toBe(id1);
		expect(budget.acquireId("keyB")).not.toBe(id2);
	});

	it("setCap(0) clears a previously applied demotion threshold", () => {
		const budget = new ImageBudget(2, () => {});
		pass(budget, 3);
		pass(budget, 3);
		expect(pass(budget, 3).suppressed).toEqual([true, false, false]);

		budget.setCap(0);
		const result = pass(budget, 3);
		expect(result.suppressed).toEqual([false, false, false]);
	});

	it("replays the committed live/text split by id during a stable (partial) pass", () => {
		const budget = new ImageBudget(2, () => {});
		// Settle to the steady split for 4 images at cap 2: oldest two (ids 1,2)
		// demoted to text, newest two (ids 3,4) live.
		pass(budget, 4); // threshold rises to 2
		pass(budget, 4); // applies the demotion of ids 1,2
		expect(pass(budget, 4).suppressed).toEqual([true, true, false, false]);

		// The resize fast path observes the visible tail bottom-up and only a
		// subset of images. A stable pass must therefore decide live/text by the
		// committed per-id split, NOT by call order: observing the newest images
		// first (4, then 3) must still report them live, and the oldest text —
		// the index-based path would wrongly suppress whichever arrives first.
		budget.beginPass(true);
		expect(budget.observe(4)).toBe(false); // newest, stays live
		expect(budget.observe(3)).toBe(false); // stays live
		expect(budget.observe(2)).toBe(true); // committed text
		expect(budget.observe(1)).toBe(true); // committed text
		// An id with no committed state (a brand-new image) defaults to live.
		expect(budget.observe(99)).toBe(false);

		// The stable pass left the ledger untouched: the next full pass reports
		// the same split and schedules no purge or redraw.
		const after = pass(budget, 4);
		expect(after.suppressed).toEqual([true, true, false, false]);
		expect(after.reset).toBe(false);
		expect(after.purge).toEqual([]);
	});
});

describe("encodeKittyDeleteImage", () => {
	it("emits an APC delete-by-id that frees the image and suppresses the reply", () => {
		expect(encodeKittyDeleteImage(42)).toBe("\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
	});
});

describe("tmux Kitty graphics passthrough", () => {
	beforeEach(() => {
		Bun.env.TMUX = "/tmp/tmux-1000/default,1,0";
	});

	it("wraps every Kitty graphics command in a tmux DCS envelope", () => {
		const expected = (payload: string) => `\x1bPtmux;${payload.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;

		expect(encodeKitty("AA==", { columns: 1, rows: 1 })).toBe(expected("\x1b_Ga=T,f=100,q=2,C=1,c=1,r=1;AA==\x1b\\"));
		expect(encodeKittyTransmit("AA==", 9)).toBe(expected("\x1b_Ga=t,f=100,q=2,i=9;AA==\x1b\\"));
		expect(encodeKittyPlacement({ imageId: 9, placementId: 9, columns: 3, rows: 2 })).toBe(
			expected("\x1b_Ga=p,q=2,C=1,i=9,p=9,c=3,r=2\x1b\\"),
		);
		expect(encodeKittyVirtualPlacement({ imageId: 9, placementId: 9, columns: 3, rows: 2 })).toBe(
			expected("\x1b_Ga=p,U=1,q=2,i=9,p=9,c=3,r=2\x1b\\"),
		);
		expect(encodeKittyDeleteImage(9)).toBe(expected("\x1b_Ga=d,d=I,i=9,q=2\x1b\\"));
	});

	it("wraps each quiet chunk of a multi-part Kitty transmission separately", () => {
		const sequence = encodeKittyTransmit("A".repeat(4097), 9);
		expect(sequence.match(/\x1bPtmux;/gu)).toHaveLength(2);
		expect(sequence.match(/\x1b\x1b_G/gu)).toHaveLength(2);
		expect(sequence.match(/\x1b\x1b\\\x1b\\/gu)).toHaveLength(2);
		expect(sequence).toContain("\x1b\x1b_Gq=2,m=0;");
	});

	it("leaves Kitty graphics commands bare outside tmux", () => {
		delete Bun.env.TMUX;
		expect(encodeKittyTransmit("AA==", 9)).toBe("\x1b_Ga=t,f=100,q=2,i=9;AA==\x1b\\");
		expect(wrapTmuxPassthrough("\x1b_Gpayload\x1b\\")).toBe("\x1bPtmux;\x1b\x1b_Gpayload\x1b\x1b\\\x1b\\");
	});
});

describe("Image budget integration", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
		// These tests pin the direct `a=p` placement contract.
		setKittyGraphics({ unicodePlaceholders: false });
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
		setKittyGraphics(originalGraphics);
	});

	it("renders within-budget images as graphics carrying their stable id", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "k" },
		);

		budget.beginPass();
		const lines = image.render(20);
		budget.endPass();

		const last = lines.at(-1) ?? "";
		expect(last).toContain("\x1b_G");
		expect(last).toContain(`i=${id}`);
		expect(last).not.toContain("[Image:");
	});

	it("transmits the base64 once via the budget and renders only a placement line", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "k" },
		);

		budget.beginPass();
		const lines = image.render(20);
		budget.endPass();

		// One transmit, carrying the base64 data, keyed by the image id.
		const transmits = [...budget.takeTransmits()];
		expect(transmits).toHaveLength(1);
		expect(transmits[0]).toContain("\x1b_Ga=t");
		expect(transmits[0]).toContain(`i=${id}`);
		expect(transmits[0]).toContain(BASE64_ONE_PIXEL_PNG);
		// The render line is a placement (`a=p`) without the base64.
		const last = lines.at(-1) ?? "";
		expect(last).toContain("\x1b_Ga=p");
		expect(last).not.toContain(BASE64_ONE_PIXEL_PNG);

		// A second render (cache hit) does not re-enqueue the data.
		budget.beginPass();
		image.render(20);
		budget.endPass();
		expect([...budget.takeTransmits()]).toEqual([]);
	});

	it("moves back up before multi-row direct Kitty placements and restores the cursor below them", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "k" },
			{ widthPx: 40, heightPx: 40 },
		);

		budget.beginPass();
		const lines = image.render(20);
		budget.endPass();

		const last = lines.at(-1) ?? "";
		expect(lines).toHaveLength(4);
		expect(lines.slice(0, -1)).toEqual(["\x1b[0m", "\x1b[0m", "\x1b[0m"]);
		expect(last.startsWith("\x1b7\x1b[3A")).toBe(true);
		expect(last.endsWith("\x1b8")).toBe(true);
		expect(last).toContain("\x1b_Ga=p");
		expect(last).toContain("C=1");
		expect(last).toContain(`i=${id}`);
		expect(last).toContain("c=4");
		expect(last).toContain("r=4");
	});

	it("does not move the cursor around single-row direct Kitty placements", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 1, budget, imageKey: "k" },
		);

		budget.beginPass();
		const lines = image.render(20);
		budget.endPass();

		const last = lines.at(-1) ?? "";
		expect(lines).toHaveLength(1);
		expect(last.startsWith("\x1b_Ga=p")).toBe(true);
		expect(last).toContain("C=1");
		expect(last).toContain(`i=${id}`);
		expect(last).toContain("r=1");
		expect(last.endsWith("\x1b\\")).toBe(true);
		expect(last).not.toContain("\x1b[0A");
		expect(last).not.toContain("\x1b[0B");
		expect(last).not.toMatch(/\x1b\[\d+[AB]/);
	});

	it("renders an over-budget image as its text fallback instead of graphics", () => {
		const budget = new ImageBudget(1, () => {});
		const older = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "old" },
		);
		const newer = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "new" },
		);

		// First pass lets the budget notice the overflow; the second applies the
		// demotion (older image is observed first, so it is demoted first).
		let olderLines: readonly string[] = [];
		let newerLines: readonly string[] = [];
		for (let i = 0; i < 2; i++) {
			budget.beginPass();
			olderLines = older.render(20);
			newerLines = newer.render(20);
			budget.endPass();
		}

		expect(olderLines.join("")).toContain("[Image:");
		expect(olderLines.join("")).not.toContain("\x1b_G");
		expect(newerLines.at(-1) ?? "").toContain("\x1b_G");
	});
});

describe("Image budget + Unicode placeholders", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
		setKittyGraphics(originalGraphics);
	});

	it("renders a transmitted image as a virtual-placement placeholder grid", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "k" },
		);

		budget.beginPass();
		const lines = image.render(20);
		budget.endPass();

		// Line 0 carries the U=1 virtual placement keyed by the image id.
		expect(lines[0]).toContain(`\x1b_Ga=p,U=1,q=2,i=${id}`);
		// Every rendered line is a real placeholder-cell row (no empty/cursor-up trick).
		expect(lines.every(l => l.includes(KITTY_PLACEHOLDER))).toBe(true);
		expect(lines.join("")).not.toContain("\x1b[1A");
		// The image id is encoded in the cell foreground color (low 24 bits).
		expect(lines[0]).toContain(`38;2;${(id >> 16) & 0xff};${(id >> 8) & 0xff};${id & 0xff}m`);
		// Render lines never carry the base64 — data goes via the one-time transmit.
		expect(lines.join("")).not.toContain(BASE64_ONE_PIXEL_PNG);
		const transmits = [...budget.takeTransmits()];
		expect(transmits).toHaveLength(1);
		expect(transmits[0]).toContain("\x1b_Ga=t");
		expect(transmits[0]).toContain(`i=${id}`);
	});

	it("re-emits the virtual placement (not base64) on a fresh render after cache invalidation", () => {
		const budget = new ImageBudget(3, () => {});
		const id = budget.acquireId("k");
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "k" },
		);
		budget.beginPass();
		image.render(20);
		budget.endPass();
		expect([...budget.takeTransmits()]).toHaveLength(1);

		// A repaint after invalidation re-emits the placement but never the data.
		image.invalidate();
		budget.beginPass();
		const lines = image.render(20);
		budget.endPass();
		expect(lines[0]).toContain(encodeKittyVirtualPlacement({ imageId: id, placementId: id, columns: 4, rows: 4 }));
		expect([...budget.takeTransmits()]).toEqual([]);
	});
});

describe("TUI inline-image budget", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalTerminalId = terminal.id;
	let originalCellDims: CellDimensions;
	let monotonicNow = 0;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
		// Pin a non-Ghostty id by default so the Ghostty one-shot image re-submit
		// (which re-sends `a=t` data) never fires in the generic budget tests; the
		// dedicated Ghostty tests opt in by setting `terminal.id = "ghostty"`.
		terminal.id = "xterm";
		monotonicNow = 0;
		// Advance one full 30fps frame (>1000/30ms) per tick so the render
		// throttle computes a zero delay and every requestRender flushes inline.
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 40;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
		terminal.id = originalTerminalId;
	});

	async function settle(term: VirtualTerminal): Promise<void> {
		for (let i = 0; i < 4; i++) {
			const tick = Promise.withResolvers<void>();
			process.nextTick(tick.resolve);
			await tick.promise;
			await Bun.sleep(40);
			await term.flush();
		}
	}

	function makeImage(budget: ImageBudget, key: string): Image {
		return new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: key },
		);
	}

	it("renders following text below a multi-row direct Kitty placement", async () => {
		const originalGraphics = { ...getKittyGraphics() };
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		setKittyGraphics({ unicodePlaceholders: false });
		const tui = new TUI(term);
		tui.addChild(
			new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: t => t },
				{ maxWidthCells: 4, maxHeightCells: 4, budget: tui.imageBudget, imageKey: "direct" },
				{ widthPx: 40, heightPx: 40 },
			),
		);
		tui.addChild(new Text("after-image", 0, 0));

		try {
			tui.start();
			await settle(term);

			const output = writes.join("");
			expect(output).toContain("\x1b7\x1b[3A");
			expect(output).toContain("C=1");
			expect(output).toContain("\x1b8");
			const viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport.slice(0, 5)).toEqual(["", "", "", "", "after-image"]);
			expect(viewport.slice(0, 4).some(line => line.includes("after-image"))).toBe(false);
		} finally {
			tui.stop();
			setKittyGraphics(originalGraphics);
		}
	});

	it("clips a direct Kitty placement during an in-place width repaint", async () => {
		const originalGraphics = { ...getKittyGraphics() };
		const originalResizeMode = Bun.env.PI_TUI_RESIZE_IN_PLACE;
		const term = new VirtualTerminal(40, 6);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		setKittyGraphics({ unicodePlaceholders: false });
		Bun.env.PI_TUI_RESIZE_IN_PLACE = "1";
		const tui = new TUI(term);
		tui.addChild(
			new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: t => t },
				{ maxWidthCells: 4, maxHeightCells: 4, budget: tui.imageBudget, imageKey: "resize-direct" },
				{ widthPx: 40, heightPx: 40 },
			),
		);
		tui.addChild(new Text("after-0\nafter-1\nafter-2", 0, 0));

		try {
			tui.start();
			await settle(term);
			writes.length = 0;
			term.resize(30, 6);
			await settle(term);

			const output = writes.join("");
			expect(output).toContain("a=p,q=2,C=1");
			expect(output).toContain("c=4,r=3,y=10,h=30");
		} finally {
			tui.stop();
			setKittyGraphics(originalGraphics);
			if (originalResizeMode === undefined) delete Bun.env.PI_TUI_RESIZE_IN_PLACE;
			else Bun.env.PI_TUI_RESIZE_IN_PLACE = originalResizeMode;
		}
	});

	it("purges demoted image graphics and repaints the fallback without a destructive replay", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		const tui = new TUI(term);
		tui.setMaxInlineImages(1);
		const oldId = tui.imageBudget.acquireId("img-old");
		tui.addChild(makeImage(tui.imageBudget, "img-old"));

		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			// A second image arrives, exceeding the cap of 1.
			tui.addChild(makeImage(tui.imageBudget, "img-new"));
			tui.requestRender();
			await settle(term);

			// The demotion never forces a destructive replay: committed
			// placements are immutable, so no ED2/ED3 is emitted...
			expect(writes.join("")).not.toContain("\x1b[2J");
			expect(writes.join("")).not.toContain("\x1b[3J");
			// ...purges the now-hidden image's graphics by id...
			expect(writes.join("")).toContain(encodeKittyDeleteImage(oldId));
			// ...and the oldest image is now shown as text, with one image still live.
			const viewport = term.getViewport().map(l => l.trimEnd());
			const fallbackCount = viewport.filter(l => l.includes("[Image:")).length;
			expect(fallbackCount).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("deletes every tracked Kitty image during live cleanup", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		const tui = new TUI(term);
		const firstId = tui.imageBudget.acquireId("first");
		const secondId = tui.imageBudget.acquireId("second");
		tui.addChild(makeImage(tui.imageBudget, "first"));
		tui.addChild(makeImage(tui.imageBudget, "second"));

		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			tui.clearInlineImages();

			const output = writes.join("");
			expect(output).toContain(encodeKittyDeleteImage(firstId));
			expect(output).toContain(encodeKittyDeleteImage(secondId));
			expect(tui.imageBudget.shouldTransmit(firstId)).toBe(true);
			expect([...tui.imageBudget.takeAllTransmittedIds()]).toEqual([]);
		} finally {
			tui.stop();
		}
	});
	it("leaves transmitted images in the terminal store on stop so scrollback keeps them", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		const tui = new TUI(term);
		tui.addChild(makeImage(tui.imageBudget, "persist"));
		tui.start();
		await settle(term);
		writes.length = 0;

		tui.stop();

		// Regression: stop() used to delete every transmitted image (`a=d,d=I`),
		// blanking placeholder cells already committed to native scrollback the
		// moment the session exited.
		expect(writes.join("")).not.toContain("a=d,d=I");
	});

	it("lets a full-width non-fullscreen overlay replace Unicode image placeholder rows", async () => {
		const originalGraphics = { ...getKittyGraphics() };
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		setKittyGraphics({ unicodePlaceholders: true });
		const tui = new TUI(term);
		tui.addChild(makeImage(tui.imageBudget, "behind-modal"));
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			const overlay = tui.showOverlay(new Text("MODEL SELECTOR\nMODEL ROW 2\nMODEL ROW 3\nMODEL ROW 4", 0, 0), {
				anchor: "top-left",
				width: "100%",
				maxHeight: "100%",
			});
			await settle(term);

			const modalOutput = writes.join("");
			expect(modalOutput).not.toContain("\x1b[?1049h");
			const modalViewport = term.getViewport().join("\n");
			expect(modalViewport).toContain("MODEL SELECTOR");
			expect(modalViewport).not.toContain(KITTY_PLACEHOLDER);

			writes.length = 0;
			overlay.hide();
			await settle(term);

			expect(term.getViewport().join("\n")).toContain(KITTY_PLACEHOLDER);
		} finally {
			tui.stop();
			setKittyGraphics(originalGraphics);
		}
	});

	it("retransmits current images after a destructive redraw", async () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		const tui = new TUI(term);
		tui.setMaxInlineImages(3); // high cap: no demotion in this test
		tui.addChild(makeImage(tui.imageBudget, "only"));

		try {
			tui.start();
			await settle(term);
			// First paint transmits the data (a=t carrying the base64) and places it.
			const initial = writes.join("");
			expect(initial).toContain("\x1b_Ga=t");
			expect(initial).toContain(BASE64_ONE_PIXEL_PNG);
			writes.length = 0;

			// Force a full redraw (clear scrollback + repaint the whole transcript).
			tui.requestRender(true, { clearScrollback: true });
			await settle(term);

			// The repaint re-sends the base64.
			const repaint = writes.join("");
			expect(repaint).toContain("\x1b_Ga=p");
			expect(repaint).toContain(BASE64_ONE_PIXEL_PNG);
		} finally {
			tui.stop();
		}
	});
	it("deletes every kitty image on a destructive display reset", async () => {
		const originalGraphics = { ...getKittyGraphics() };
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		setKittyGraphics({ unicodePlaceholders: false });
		const tui = new TUI(term);
		tui.setMaxInlineImages(3);
		tui.addChild(makeImage(tui.imageBudget, "only"));

		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			tui.resetDisplay();
			await settle(term);

			// ED2/ED3 erase text but leave graphics untouched. d=A also removes
			// untracked placements; current images must be re-sent and re-placed.
			const repaint = writes.join("");
			const deleteIndex = repaint.indexOf("\x1b_Ga=d,d=A,q=2\x1b\\");
			expect(deleteIndex).toBeGreaterThanOrEqual(0);
			const transmitIndex = repaint.indexOf("\x1b_Ga=t", deleteIndex);
			const placeIndex = repaint.indexOf("\x1b_Ga=p", transmitIndex);
			expect(transmitIndex).toBeGreaterThan(deleteIndex);
			expect(placeIndex).toBeGreaterThan(transmitIndex);
			expect(repaint).toContain(BASE64_ONE_PIXEL_PNG);
		} finally {
			tui.stop();
			setKittyGraphics(originalGraphics);
		}
	});

	it("holds the first Ghostty image paint until the startup settle window passes", () => {
		const originalId = terminal.id;
		const originalGraphics = { ...getKittyGraphics() };
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		let now = 0;
		const scheduled: Array<{ delayMs: number; callback: () => void; canceled: boolean }> = [];
		const renderScheduler = {
			now: () => now,
			scheduleImmediate: (callback: () => void) => callback(),
			scheduleRender: (callback: () => void, delayMs: number) => {
				const entry = { delayMs, callback, canceled: false };
				scheduled.push(entry);
				return {
					cancel: () => {
						entry.canceled = true;
					},
				};
			},
		};

		terminal.id = "ghostty";
		terminal.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });

		const tui = new TUI(term, undefined, { renderScheduler });
		tui.addChild(makeImage(tui.imageBudget, "only"));

		try {
			tui.start();
			expect(writes.join("")).not.toContain("\x1b_Ga=t");

			const delayed = scheduled.find(entry => !entry.canceled && entry.delayMs === 100);
			expect(delayed).toBeDefined();
			now = 100;
			delayed?.callback();

			const output = writes.join("");
			expect(output).toContain("\x1b_Ga=t");
			expect(output).toContain(BASE64_ONE_PIXEL_PNG);
		} finally {
			tui.stop();
			terminal.id = originalId;
			setKittyGraphics(originalGraphics);
		}
	});
});

describe("kitty transmit / placement encoding", () => {
	it("encodeKittyTransmit loads data by id without displaying it", () => {
		const seq = encodeKittyTransmit(BASE64_ONE_PIXEL_PNG, 9);
		expect(seq.startsWith("\x1b_Ga=t,f=100,q=2,i=9;")).toBe(true);
		expect(seq.endsWith("\x1b\\")).toBe(true);
		expect(seq).toContain(BASE64_ONE_PIXEL_PNG);
		expect(seq).not.toContain("a=p");
	});

	it("encodeKittyPlacement displays a transmitted image by id with a stable placement id", () => {
		const seq = encodeKittyPlacement({ imageId: 9, placementId: 9, columns: 3, rows: 2 });
		expect(seq).toBe("\x1b_Ga=p,q=2,C=1,i=9,p=9,c=3,r=2\x1b\\");
		expect(seq).not.toContain(BASE64_ONE_PIXEL_PNG);
	});
});

describe("ImageBudget transmit tracking", () => {
	it("transmits an id once and clears the queue when drained", () => {
		const budget = new ImageBudget(3, () => {});
		expect(budget.shouldTransmit(1)).toBe(true);
		budget.enqueueTransmit(1, "TX1");
		expect(budget.shouldTransmit(1)).toBe(false);
		budget.enqueueTransmit(1, "TX1-dup"); // already transmitted => no-op
		expect([...budget.takeTransmits()]).toEqual(["TX1"]);
		expect([...budget.takeTransmits()]).toEqual([]);
	});

	it("purges all transmitted ids for terminal-session cleanup", () => {
		const budget = new ImageBudget(3, () => {});
		budget.enqueueTransmit(1, "TX1");
		budget.enqueueTransmit(2, "TX2");
		expect(budget.shouldTransmit(1)).toBe(false);

		expect([...budget.takeAllTransmittedIds()]).toEqual([1, 2]);
		expect([...budget.takeTransmits()]).toEqual([]);
		expect(budget.shouldTransmit(1)).toBe(true);
		expect([...budget.takeAllTransmittedIds()]).toEqual([]);
	});

	it("re-transmits an image after a purge frees its data", () => {
		const budget = new ImageBudget(2, () => {});
		budget.enqueueTransmit(1, "TX1");
		expect(budget.shouldTransmit(1)).toBe(false);

		// Push past the cap so the oldest image (id 1) is demoted and purged.
		pass(budget, 3); // overflow frame schedules the demotion
		const demote = pass(budget, 3); // demotion frame purges id 1
		expect(demote.purge).toEqual([1]);

		// d=I freed the data, so the image must transmit again if it returns.
		expect(budget.shouldTransmit(1)).toBe(true);
	});
});
