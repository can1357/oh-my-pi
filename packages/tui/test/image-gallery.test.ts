import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getKittyGraphics,
	ImageGallery,
	ImageProtocol,
	type SgrMouseEvent,
	setKittyGraphics,
	setTerminalImageProtocol,
	TERMINAL,
	TUI,
} from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

const originalProtocol = TERMINAL.imageProtocol;
const originalGraphics = { ...getKittyGraphics() };
const image = { data: BASE64_ONE_PIXEL_PNG, mimeType: "image/png" };

beforeEach(() => {
	setTerminalImageProtocol(null);
});

afterEach(() => {
	setTerminalImageProtocol(originalProtocol);
	setKittyGraphics(originalGraphics);
});

describe("ImageGallery", () => {
	it("renders the selected image status and navigates with keyboard input", () => {
		const gallery = new ImageGallery([image, image], 0, { viewportHeight: 12 });

		expect(gallery.render(40).join("\n")).toContain("[1/2] 100%");
		gallery.handleInput("\x1b[C");

		expect(gallery.selectedIndex).toBe(1);
		expect(gallery.render(40).join("\n")).toContain("[2/2] 100%");
	});

	it("routes wheel and side clicks when an image protocol is available", () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setKittyGraphics({ unicodePlaceholders: true });
		let changes = 0;
		const gallery = new ImageGallery([image, image], 0, {
			viewportHeight: 12,
			onChange: () => {
				changes += 1;
			},
		});
		gallery.render(40);

		const baseEvent: SgrMouseEvent = {
			button: 64,
			col: 0,
			row: 0,
			release: false,
			wheel: 1,
			motion: false,
			leftClick: false,
		};
		expect(gallery.hasMouseTargets()).toBe(true);
		expect(gallery.routeMouse(baseEvent, 0, 0)).toBe(true);
		expect(gallery.zoom).toBe(0.75);

		const click: SgrMouseEvent = { ...baseEvent, button: 0, wheel: null, leftClick: true };
		expect(gallery.routeMouse(click, 6, 39)).toBe(true);
		expect(gallery.selectedIndex).toBe(1);
		expect(changes).toBe(2);
	});

	it("calls onClose for Escape and q", () => {
		let closes = 0;
		const gallery = new ImageGallery([image], 0, { onClose: () => (closes += 1) });

		gallery.handleInput("\u001b");
		gallery.handleInput("q");

		expect(closes).toBe(2);
	});
	it("opens through TUI in an alternate-screen overlay and handles keyboard input", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setKittyGraphics({ unicodePlaceholders: true });
		const term = new VirtualTerminal(40, 12);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });

		try {
			tui.start();
			await scheduler.drain(term);
			const handle = tui.openImageGallery([image, image]);
			await scheduler.drain(term);

			expect(term.getViewport().join("\n")).toContain("[1/2] 100%");
			term.sendInput("\x1b[C");
			await scheduler.drain(term);
			expect(term.getViewport().join("\n")).toContain("[2/2] 100%");

			handle.hide();
			await scheduler.drain(term);
			expect(tui.getFocused()).toBeNull();
		} finally {
			tui.stop();
		}
	});
});
