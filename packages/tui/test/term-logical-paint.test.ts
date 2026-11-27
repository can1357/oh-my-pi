import { expect, it, spyOn, vi } from "bun:test";
import type { MouseEvent } from "@oh-my-pi/pi-tui/driver/contract";
import { createTerminalDriver } from "@oh-my-pi/pi-tui/driver/index";
import { jsx } from "@oh-my-pi/pi-tui/element";
import { createRoot, effect, onCleanup, signal } from "@oh-my-pi/pi-tui/reactive";
import { createSurface } from "@oh-my-pi/pi-tui/surface";
import { TermBackend } from "@oh-my-pi/pi-tui/term/backend";
import {
	createOwnedPaint,
	defineRolePainter,
	paintForMeasurement,
	paintNode,
	staticEnvironment,
} from "@oh-my-pi/pi-tui/term/paint";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";

it("copies a new hard break even when both transcript rows look identical to the previous soft wrap", async () => {
	const text = signal("abcdef");
	const surface = createSurface(() => ({ main: jsx("col", { children: jsx("text", { text }) }) }));
	// Three text columns plus the marks lane and scrollbar.
	const driver = createTerminalDriver(memoryTerminal({ columns: 5, rows: 4 }).options);
	const frames = spyOn(driver, "present");
	const copies: string[] = [];
	const backend = new TermBackend({
		surface,
		driver,
		theme: () => PLAIN_THEME,
		presentation: () => "fullscreen",
		frameInterval: 0,
		copyText: async value => {
			copies.push(value);
			return "success";
		},
	});
	const pointer = (action: MouseEvent["action"], row: number, col: number): void => {
		backend.dispatch({ type: "mouse", mouse: { action, row, col, button: "left", mods: [] } });
	};
	const cells = () =>
		frames.mock.calls
			.at(-1)?.[0]
			.fullscreen?.slice(0, 2)
			.map(row => Bun.stripANSI(row).slice(0, 3));
	await driver.start();
	vi.useFakeTimers();
	try {
		backend.start();
		expect(cells()).toEqual(["abc", "def"]);
		pointer("press", 0, 0);
		pointer("drag", 1, 2);
		pointer("release", 1, 2);
		expect(copies).toEqual(["abcdef"]);
		backend.scroller.dropHighlight();
		backend.renderNow(); // Drain the selection frame before changing only the logical line break.

		text.set("abc\ndef");
		vi.advanceTimersByTime(1); // Let the reactive paint schedule the frame; don't force a repaint.
		expect(cells()).toEqual(["abc", "def"]);
		pointer("press", 1, 2);
		pointer("drag", 0, 0);
		pointer("release", 0, 0);
		expect(copies).toEqual(["abcdef", "abc\ndef"]);
	} finally {
		backend.stop();
		vi.useRealTimers();
		frames.mockRestore();
		await driver.stop();
		surface.dispose();
	}
});

it("ties child paint resources to the visible block or measurement watcher, not the node cache", () => {
	const line = signal("one");
	let live = 0;
	defineRolePainter("rows", "test.owned-paint", () => {
		live++;
		onCleanup(() => live--);
		return { rows: [line()] };
	});
	const surface = createSurface(() => ({
		main: jsx("col", { children: jsx("rows", { role: "test.owned-paint", lines: [] }) }),
	}));
	const node = surface.main()[0]!;
	const env = staticEnvironment(PLAIN_THEME);
	const owned = createOwnedPaint(node, 3, env);
	try {
		expect(paintNode(env, node, 3).rows).toEqual(["one"]);
		expect(owned.read().rows).toEqual(["one"]);
		expect(live).toBe(2);
		const measured: string[] = [];
		const stop = createRoot(dispose => {
			effect(() => measured.push(...paintForMeasurement(node, 3, env).rows));
			return dispose;
		});
		try {
			expect(live).toBe(3);
			line.set("two");
			expect(measured).toEqual(["one", "two"]);
		} finally {
			stop();
		}
		expect(live).toBe(2);
		owned.dispose();
		expect(live).toBe(1);
	} finally {
		owned.dispose();
		surface.dispose();
	}
	expect(live).toBe(0);
});
