/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, it } from "bun:test";
import { decodeSixelToPng } from "@oh-my-pi/pi-natives";
import { createSurface, signal, startHost } from "@oh-my-pi/pi-tui";
import { emergencyTerminalRestore } from "@oh-my-pi/pi-tui/driver/session";
import { registerBlob, releaseBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { KittyTerminal } from "kitty-vt-wasm";

const theme = loadThemeSync("dark");
const palette = "#1;2;100;0;0#2;2;0;0;100";
/** One fully opaque red/blue stripe per six-pixel band. */
function stripes(colors: number[]): string {
	return `\x1bP9;1;0q"1;1;72;${6 * colors.length}${palette}${colors.map(n => `#${n}!72~$-`).join("")}\x1b\\`;
}
const png = (sequence: string): Uint8Array => decodeSixelToPng(Buffer.from(sequence));
const blue = Array<number>(6).fill(2);
const pixels = png(stripes([...Array<number>(6).fill(1), ...blue]));
const shell = "old shell output\r\npartial> ";

async function session(protocol: "kitty" | "sixel" | "iterm", exitTranscript = true, placeholders = false) {
	const vt = KittyTerminal.createSync({ columns: 16, rows: 6, scrollback: 100 });
	vt.write(shell);
	const terminal = memoryTerminal({
		columns: vt.columns,
		rows: vt.rows,
		env: { PI_FORCE_IMAGE_PROTOCOL: protocol, PI_KITTY_PLACEHOLDERS: placeholders ? "1" : "0" },
		onWrite: data => vt.write(data),
		cursor: () => vt.cursor,
	});
	const tail = signal<readonly string[]>([]);
	const sheet = signal(false);
	const repeat = signal(false);
	const blob = registerBlob(pixels, "image/png");
	const surface = createSurface(() => ({
		main: [
			<image w={72} h={72} alt="stripes" blob={blob} />,
			() => (repeat() ? <image w={72} h={72} alt="stripes again" blob={blob} /> : undefined),
			<rows lines={tail} />,
		],
		dock: <rows lines={["> draft"]} />,
		layer: () => (sheet() ? <overlay anchor="top" size={placeholders ? "sm" : "md"} head="sheet" /> : undefined),
	}));
	const host = await startHost({
		surface,
		driver: terminal.options,
		native: false,
		screen: () => "fullscreen",
		exitTranscript: () => exitTranscript,
		theme: () => theme,
		separator: () => 0,
		frameInterval: 0,
	});
	const next = async (change: () => void = () => {}) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const off = host.onFrame(() => {
			off();
			resolve();
		});
		const before = terminal.output.length;
		change();
		host.requestFrame();
		await promise;
		return terminal.output.slice(before).join("");
	};
	return {
		host,
		terminal,
		vt,
		next,
		tail,
		sheet,
		repeat,
		async dispose() {
			try {
				await host.stop();
			} finally {
				surface.dispose();
				releaseBlob(blob);
				vt.dispose();
			}
		},
	};
}

const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";
const UPLOAD = "\x1b_Ga=t,";
const PLACE = "\x1b_Ga=p,";

function expectUploadAfterSwitch(bytes: string, change: string): void {
	const switched = bytes.indexOf(change);
	const upload = bytes.indexOf(UPLOAD);
	expect(switched).toBeGreaterThanOrEqual(0);
	expect(upload).toBeGreaterThan(switched);
	expect(bytes.indexOf(PLACE)).toBeGreaterThan(upload);
}

describe("fullscreen image frames on a real terminal grid", () => {
	it("uploads Kitty images into the destination buffer and retires only hidden bands when scrolling, resizing or opening a sheet", async () => {
		const s = await session("kitty");
		const bands = (): number[][] => {
			// The wasm host records every parsed placement command. On a terminal the last placement
			// of an (image ID, placement ID) pair replaces the previous one, rather than duplicating it.
			const visible = new Map<string, number[]>();
			for (const p of s.vt.graphicsPlacements())
				visible.set(`${p.imageId}:${p.placementId}`, [p.row, p.numCols, p.numRows]);
			return [...visible.values()].sort((a, b) => a[0]! - b[0]!);
		};
		try {
			expectUploadAfterSwitch(s.terminal.output.join(""), ALT_ENTER);
			expect(bands()).toEqual([
				[0, 8, 1],
				[1, 8, 1],
				[2, 8, 1],
				[3, 8, 1],
			]);
			await s.next(() => s.sheet.set(true));
			expect(s.vt.line(0)).toContain("sheet");
			expect(bands()).toEqual([
				[2, 8, 1],
				[3, 8, 1],
			]);
			const exposed = await s.next(() => s.sheet.set(false));
			expect(exposed).not.toContain(UPLOAD);
			expect(bands()).toHaveLength(4);
			await s.next(() => s.repeat.set(true));
			// The final band of the first copy and the whole second copy share the same blob.
			expect(bands()).toEqual([
				[0, 8, 1],
				[1, 8, 1],
				[2, 8, 1],
				[3, 8, 1],
				[4, 8, 1],
			]);
			await s.next(() => s.repeat.set(false));
			const scrolled = await s.next(() => s.tail.set(["one", "two", "three"]));
			expect(scrolled).toContain(",y=36,");
			expect(scrolled).not.toContain(UPLOAD);
			expect(bands()).toEqual([
				[0, 8, 1],
				[1, 8, 1],
			]);
			await s.next(() => s.tail.set(["a", "b", "c", "d", "e"]));
			expect(bands()).toEqual([]);
			await s.next(() => s.tail.set([]));
			await s.next(() => {
				s.vt.resize(5, 6);
				s.terminal.resize(5, 6);
			});
			expect(bands()).toEqual([
				[0, 4, 1],
				[1, 4, 1],
			]);
			const mark = s.terminal.output.length;
			await s.host.stop();
			expectUploadAfterSwitch(s.terminal.output.slice(mark).join(""), ALT_LEAVE);
			expect(s.vt.isMainScreen).toBe(true);
		} finally {
			await s.dispose();
		}
	});

	it("keeps Kitty placeholder image and placement IDs on either side of a sheet", async () => {
		const s = await session("kitty", true, true);
		try {
			await s.next(() => {
				s.vt.resize(10, 6);
				s.terminal.resize(10, 6);
			});
			const right = s.vt.cell(7, 0);
			const left = s.vt.cell(0, 0);
			expect(right?.ch).toBe("\u{10EEEE}");
			expect(right?.fg).not.toBeNull();
			expect(right?.decorationFg).not.toBeNull();
			await s.next(() => s.sheet.set(true));
			expect(s.vt.cell(3, 0)?.ch).not.toBe(right?.ch);
			expect(s.vt.cell(7, 0)).toEqual(right);
			expect(s.vt.cell(0, 0)).toEqual(left);
		} finally {
			await s.dispose();
		}
	});

	it("draws just the visible SIXEL source pixels above the dock and restores the full raster after uncovering it", async () => {
		const s = await session("sixel");
		const raster = (bytes: string) => /\x1bP[\d;]*q[\s\S]*?\x1b\\/.exec(bytes)?.[0];
		try {
			await s.host.driver.images.whenEncoded();
			await s.next();
			const cut = await s.next(() => s.tail.set(["one", "two", "three"]));
			expect(png(raster(cut)!)).toEqual(png(stripes(blue)));
			expect(s.vt.line(5)).toContain("> draft");
			// A non-six-pixel-aligned cell requires combining two source bands without moving the color boundary.
			const offset = await s.next(() => {
				s.terminal.feed("\x1b[6;17;9t");
				s.tail.set(["end"]);
			});
			const expected = `\x1bP9;1;0q"1;1;72;54${palette}${"#1!72~$-".repeat(3)}#1!72@$#2!72}$-${"#2!72~$-".repeat(5)}\x1b\\`;
			expect(png(raster(offset)!)).toEqual(png(expected));
			// A shorter viewport at the document head clips the last band. The original last-row drawing is outside
			// the window altogether; the top 66 pixels must still be drawn, ending before the dock.
			const top = await s.next(() => {
				s.vt.resize(16, 5);
				s.terminal.resize(16, 5);
				s.host.scroll("start");
			});
			expect(png(raster(top)!)).toEqual(png(stripes([...Array<number>(6).fill(1), ...Array<number>(5).fill(2)])));
			await s.next(() => {
				s.vt.resize(16, 6);
				s.terminal.resize(16, 6);
				s.tail.set([]);
			});
			const covered = await s.next(() => s.sheet.set(true));
			expect(raster(covered)).toBeUndefined();
			expect(s.vt.line(0)).toContain("sheet");
			const restored = await s.next(() => s.sheet.set(false));
			expect(png(raster(restored)!)).toEqual(pixels);
		} finally {
			await s.dispose();
		}
	});

	it("withholds an indivisible iTerm File while clipped or covered and emits it again when its cells are free", async () => {
		const s = await session("iterm");
		const file = "\x1b]1337;File=inline=1;width=8;height=4:";
		try {
			expect(s.terminal.output.join("")).toContain(file);
			const cut = await s.next(() => s.tail.set(["one", "two", "three"]));
			expect(cut).not.toContain(file);
			expect(s.vt.line(2)).toContain("one");
			expect(await s.next(() => s.tail.set([]))).toContain(file);
			expect(await s.next(() => s.sheet.set(true))).not.toContain(file);
			expect(s.vt.line(0)).toContain("sheet");
			expect(await s.next(() => s.sheet.set(false))).toContain(file);
			const mark = s.terminal.output.length;
			await s.host.stop();
			const exit = s.terminal.output.slice(mark).join("");
			expect(exit.indexOf(file)).toBeGreaterThan(exit.indexOf(ALT_LEAVE));
			expect(s.vt.dump({ history: true })).toContain("partial> ".trimEnd());
		} finally {
			await s.dispose();
		}
	});
});

describe("fullscreen handoff on a real terminal grid", () => {
	it("suspends onto the original shell cursor, then reuploads in the fresh alternate buffer and can quit without dumping", async () => {
		const s = await session("kitty", false);
		try {
			s.host.setMouse("drag");
			const mark = s.terminal.output.length;
			await s.host.suspend(async () => {
				expect(s.vt.isMainScreen).toBe(true);
				expect(s.vt.cursor).toMatchObject({ x: 9, y: 1, visible: true });
				expect(s.vt.mode(1002)).toBe(0);
			});
			expect(s.vt.isMainScreen).toBe(false);
			expectUploadAfterSwitch(s.terminal.output.slice(mark).join(""), ALT_ENTER);
			expect(s.vt.mode(1002)).toBe(1);
			await s.host.stop();
			s.vt.write("continued");
			expect(s.vt.line(1).trimEnd()).toBe("partial> continu");
			expect(s.vt.dump({ history: true })).not.toContain("draft");
		} finally {
			await s.dispose();
		}
	});

	it("restores the shell, autowrap, cursor, mouse and paste synchronously on a crash without dumping transcript rows", async () => {
		const s = await session("kitty");
		try {
			s.host.setMouse("drag");
			expect(s.vt.isMainScreen).toBe(false);
			expect(s.vt.mode(1002)).toBe(1);
			emergencyTerminalRestore();
			expect(s.vt.isMainScreen).toBe(true);
			expect(s.vt.cursor).toMatchObject({ x: 9, y: 1, visible: true });
			expect(s.vt.mode(7)).toBe(1);
			expect(s.vt.mode(1002)).toBe(0);
			expect(s.vt.mode(2004)).toBe(0);
			expect(s.vt.dump({ history: true })).not.toContain("draft");
			expect(s.vt.line(0).trimEnd()).toBe("old shell output");
		} finally {
			await s.dispose();
		}
	});
});
