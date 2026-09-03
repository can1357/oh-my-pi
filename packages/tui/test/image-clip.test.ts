import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Image, ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	encodeKittyPlacementLine,
	getCellDimensions,
	ImageProtocol,
	parseKittyDirectPlacementLine,
	setCellDimensions,
	TERMINAL,
	wrapTmuxPassthrough,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
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

const originalProtocol = TERMINAL.imageProtocol;
const originalTerminalId = terminal.id;
const originalGraphics = { ...getKittyGraphics() };
let originalCellDims: CellDimensions;

beforeEach(() => {
	originalCellDims = getCellDimensions();
	setCellDimensions({ widthPx: 10, heightPx: 10 });
	terminal.imageProtocol = ImageProtocol.Kitty;
	terminal.id = "wezterm";
	setKittyGraphics({ unicodePlaceholders: false });
});

afterEach(() => {
	setCellDimensions(originalCellDims);
	terminal.imageProtocol = originalProtocol;
	terminal.id = originalTerminalId;
	setKittyGraphics(originalGraphics);
});

describe("kitty direct-placement wire format", () => {
	it("round-trips the exact line Image renders for a direct placement", () => {
		const budget = new ImageBudget(8, () => {});
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
		const parsed = parseKittyDirectPlacementLine(lines[lines.length - 1]!);
		expect(parsed).toEqual({ imageId, placementId: imageId, columns: 4, rows: 6 });
	});

	it("rejects non-placement image lines", () => {
		// Placeholder virtual placement (a=p,U=1 lead) is not a direct placement.
		expect(parseKittyDirectPlacementLine("\x1b_Ga=p,U=1,q=2,i=5,p=5,c=4,r=4\x1b\\")).toBeNull();
		// tmux-wrapped placements stay untouched.
		expect(parseKittyDirectPlacementLine(wrapTmuxPassthrough("\x1b_Ga=p,q=2,C=1,i=5,p=5,c=4,r=4\x1b\\"))).toBeNull();
		// Transmit-and-display and plain text never match.
		expect(parseKittyDirectPlacementLine("\x1b_Ga=T,f=100,q=2,C=1,c=4,r=4;AAAA\x1b\\")).toBeNull();
		expect(parseKittyDirectPlacementLine("plain text")).toBeNull();
	});

	it("encodes the anchored, clipped, and last-row-only placement forms", () => {
		const base = { imageId: 7, columns: 4, rows: 6, imageHeightPx: 60 };
		// Whole block visible (last line at viewport row 9): full anchored form.
		expect(encodeKittyPlacementLine({ ...base, placementId: 1, screenRow: 9 })).toBe(
			"\x1b7\x1b[5A\x1b_Ga=p,q=2,C=1,i=7,p=1,c=4,r=6\x1b\\\x1b8",
		);
		// Straddling (last line at row 3): two rows hidden above, four visible —
		// the source slice starts at 60*2/6 = 20px.
		expect(encodeKittyPlacementLine({ ...base, placementId: 2, screenRow: 3 })).toBe(
			"\x1b7\x1b[3A\x1b_Ga=p,q=2,C=1,i=7,p=2,c=4,r=4,y=20,h=40\x1b\\\x1b8",
		);
		// Only the last row visible: no cursor movement, bottom slice only.
		expect(encodeKittyPlacementLine({ ...base, placementId: 3, screenRow: 0 })).toBe(
			"\x1b_Ga=p,q=2,C=1,i=7,p=3,c=4,r=1,y=50,h=10\x1b\\",
		);
	});
});

// Unit tests cover only the epoch transitions the TUI integration below cannot
// reach deterministically (ledger rewinds, position-less emits, purge
// lifecycle, reset reporting). The ordinary advance/stability arithmetic is
// proven end-to-end by the integration tests' exact placement-id assertions.
describe("ImageBudget placement epochs", () => {
	it("skips epoch bookkeeping for emits without a frame position", () => {
		const budget = new ImageBudget(8, () => {});
		budget.registerPlacementGeometry(5, 40, 60);
		expect(budget.resolvePlacementEmit(5, 10, 4)?.placementId).toBe(1);
		// Alt-screen/resize emit: unknown position, unknown commits.
		expect(budget.resolvePlacementEmit(5, -1, -1)?.placementId).toBe(1);
		// The unknown emit must not have overwritten the tracked attach top.
		expect(budget.resolvePlacementEmit(5, 10, 12)?.placementId).toBe(2);
	});

	it("returns null for unregistered ids and after a full purge", () => {
		const budget = new ImageBudget(8, () => {});
		expect(budget.resolvePlacementEmit(9, 0, 0)).toBeNull();
		budget.registerPlacementGeometry(9, 40, 60);
		budget.enqueueTransmit(9, "seq");
		expect(budget.resolvePlacementEmit(9, 0, -1)).not.toBeNull();
		budget.takeAllTransmittedIds();
		expect(budget.resolvePlacementEmit(9, 0, -1)).toBeNull();
	});

	it("detects archived cells across commit-ledger rewinds without churning afterwards", () => {
		const budget = new ImageBudget(8, () => {});
		budget.registerPlacementGeometry(5, 40, 60);
		// Placement 1 attaches from row 100 while commits sit at 90.
		expect(budget.resolvePlacementEmit(5, 100, 90)?.placementId).toBe(1);
		// Later frames (no re-emission) commit past the attach top...
		budget.observeCommitWatermark(120);
		// ...then a divergence recommit rewinds the ledger to 50. The archived
		// cells are physically in scrollback, so the re-emit must not re-use
		// placement 1 (Kitty replace would strip the archive).
		expect(budget.resolvePlacementEmit(5, 60, 50)?.placementId).toBe(2);
		// The stale pre-rewind peak must NOT keep advancing the epoch: rewrites
		// with no commit progression replace placement 2 in place.
		expect(budget.resolvePlacementEmit(5, 60, 50)?.placementId).toBe(2);
		budget.observeCommitWatermark(55);
		expect(budget.resolvePlacementEmit(5, 60, 50)?.placementId).toBe(2);
		// The recommit re-crossing the new attach top advances exactly once.
		budget.observeCommitWatermark(61);
		expect(budget.resolvePlacementEmit(5, 60, 50)?.placementId).toBe(3);
	});

	it("reports every image with its highest epoch when resetting", () => {
		const budget = new ImageBudget(8, () => {});
		budget.registerPlacementGeometry(5, 40, 60);
		budget.registerPlacementGeometry(7, 40, 60);
		expect(budget.resolvePlacementEmit(5, 10, 4)?.placementId).toBe(1);
		expect(budget.resolvePlacementEmit(5, 12, 12)?.placementId).toBe(2);
		expect(budget.resolvePlacementEmit(7, 30, 12)?.placementId).toBe(1);
		// Every image is reported — an image absent from the replay never
		// re-places, so even its epoch-1 registry entry must be deleted.
		expect(budget.resetPlacementEpochs()).toEqual([
			{ imageId: 5, lastEpoch: 2 },
			{ imageId: 7, lastEpoch: 1 },
		]);
		// After the reset both images are back at epoch 1.
		expect(budget.resolvePlacementEmit(5, 10, -1)?.placementId).toBe(1);
	});
});
