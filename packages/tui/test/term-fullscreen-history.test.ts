import { describe, expect, it } from "bun:test";
import { TerminalImages } from "@oh-my-pi/pi-tui/driver/images/store";
import { createTerminalDriver } from "@oh-my-pi/pi-tui/driver/index";
import { jsx } from "@oh-my-pi/pi-tui/element";
import { type Host, type PresentedFrame, startHost, type TranscriptScrollState } from "@oh-my-pi/pi-tui/host";
import { registerBlob, releaseBlob } from "@oh-my-pi/pi-tui/native/blobs";
import type { UiNode } from "@oh-my-pi/pi-tui/node";
import { batch, createRoot, effect, signal } from "@oh-my-pi/pi-tui/reactive";
import { createSurface } from "@oh-my-pi/pi-tui/surface";
import { driverImages, TermBackend } from "@oh-my-pi/pi-tui/term/backend";
import { createOwnedPaint, paintForMeasurement, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { SPINNER_INTERVAL_MS } from "@oh-my-pi/pi-tui/term/painters/spinner";
import { memoryTerminal } from "@oh-my-pi/pi-tui/testing/memory-terminal";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { ThemeSymbols } from "@oh-my-pi/pi-tui/theme/symbols";
import { FullscreenTranscript } from "../src/term/fullscreen";

/** Observe a frame the real backend scheduled itself. Publication follows driver.present in the same turn. */
function frameWhen(host: Host, matches: (state: TranscriptScrollState, frame: PresentedFrame) => boolean) {
	const { promise, resolve } = Promise.withResolvers<PresentedFrame>();
	const off = host.onFrame(frame => {
		queueMicrotask(() => {
			if (!matches(host.scroller!.state(), frame)) return;
			off();
			resolve(frame);
		});
	});
	return promise;
}

const canvas = (paint: (width: number) => readonly string[]): UiNode => jsx("canvas", { paint }) as UiNode;
function turn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}
const firstRow = (frame: PresentedFrame): string =>
	stripEscapes(frame.viewport[0]!)
		.slice(0, frame.columns - 2)
		.trimEnd();

describe("fullscreen history indexing", () => {
	it("presents the actual tail of 5,000 cold blocks before indexing, yields between slices and cancels on stop", async () => {
		const painted: number[] = [];
		const main = Array.from({ length: 5000 }, (_, i) =>
			canvas(() => {
				painted.push(i);
				return [`entry ${i}`];
			}),
		);
		const term = memoryTerminal({ columns: 32, rows: 11 });
		const surface = createSurface(() => ({ main }));
		const host = await startHost({
			surface,
			driver: term.options,
			theme: () => PLAIN_THEME,
			native: false,
			presentation: () => "fullscreen",
			separator: () => 0,
		});
		try {
			expect(host.scroller!.state()).toMatchObject({ following: true, height: 10, metricsReady: false });
			expect(painted.length).toBeLessThan(15);
			expect(Math.min(...painted)).toBeGreaterThanOrEqual(4990);
			const output = term.output.join("");
			expect(output).toContain("entry 4990");
			expect(output).toContain("entry 4999");
			const first = painted.length;
			await turn();
			expect(painted.length - first).toBeGreaterThan(0);
			expect(painted.length - first).toBeLessThanOrEqual(16);
		} finally {
			await host.stop();
			surface.dispose();
		}
		const stopped = painted.length;
		await turn();
		expect(painted).toHaveLength(stopped);
	});

	it("reindexes nested offscreen paint, visibility and reactive separators on an unchanged list without forcing a frame", async () => {
		const head = signal(["head", "detail"]);
		const tail = signal(["tail", "detail"]);
		const hidden = signal(false);
		const gap = signal(1);
		const dock = signal(["dock"]);
		let separators = 0;
		const main = Array.from({ length: 80 }, (_, i) => jsx("rows", { lines: [`entry ${i}`, "detail"] }) as UiNode);
		main[0] = jsx("col", { hidden, children: canvas(() => head()) }) as UiNode;
		main[79] = canvas(() => tail());
		const marked = main[40]!;
		const surface = createSurface(() => ({ main, dock: jsx("rows", { lines: dock }) }));
		const host = await startHost({
			surface,
			driver: memoryTerminal({ columns: 32, rows: 7 }).options,
			theme: () => PLAIN_THEME,
			native: false,
			frameInterval: 0,
			presentation: () => "fullscreen",
			marks: () => [{ node: marked, kind: "success" }],
			separator: () => {
				separators++;
				return gap();
			},
		});
		try {
			const scroller = host.scroller!;
			if (!scroller.state().metricsReady) await frameWhen(host, state => state.metricsReady);
			expect(scroller.state().totalRows).toBe(239); // 80 two-row blocks plus 79 separators
			const anchored = frameWhen(host, state => !state.following && state.offset === 120);
			expect(scroller.seekMark(-1)).toBe(true);
			expect(firstRow(await anchored)).toBe("entry 40");

			// The replacement frame watcher must still subscribe to history even on a clean layout read.
			const before = separators;
			const dockOnly = frameWhen(host, (_state, frame) => frame.viewport.at(-1) === "changed dock");
			dock.set(["changed dock"]);
			await dockOnly;
			expect(separators).toBe(before);

			const growth = frameWhen(host, state => state.totalRows === 244 && state.offset === 122);
			batch(() => {
				head.set(["head", "detail", "new", "rows"]);
				tail.set(["tail", "detail", "more", "new", "rows"]);
			});
			expect(firstRow(await growth)).toBe("entry 40");
			expect(scroller.state()).toMatchObject({ following: false, unseen: true, metricsReady: true });

			const hiddenHead = frameWhen(host, state => state.totalRows === 239 && state.offset === 117);
			hidden.set(true); // four rows and the (now spurious) first separator disappear
			expect(firstRow(await hiddenHead)).toBe("entry 40");
			const compact = frameWhen(host, state => state.totalRows === 161 && state.offset === 78);
			gap.set(0); // 79 nonempty nodes, 78 remaining separators, 39 above the reading anchor
			expect(firstRow(await compact)).toBe("entry 40");
		} finally {
			await host.stop();
			surface.dispose();
		}
	});

	it("reports a same-row offscreen stream without a keypress, not cold measurements or resize", async () => {
		const tail = signal("partial");
		const main = Array.from({ length: 80 }, (_, i) => canvas(() => [`entry ${i}`, "detail"]));
		main[79] = jsx("col", { children: jsx("md", { text: tail, stream: true }) }) as UiNode;
		const term = memoryTerminal({ columns: 30, rows: 6 });
		const surface = createSurface(() => ({ main }));
		const host = await startHost({
			surface,
			driver: term.options,
			theme: () => PLAIN_THEME,
			native: false,
			frameInterval: 0,
			presentation: () => "fullscreen",
			separator: () => 1,
		});
		try {
			const scroller = host.scroller!;
			const indexed = frameWhen(host, state => !state.following && state.metricsReady);
			expect(scroller.toTop()).toBe(true);
			expect(firstRow(await indexed)).toBe("entry 0");
			expect(scroller.state().unseen).toBe(false);
			const total = scroller.state().totalRows;

			const resized = frameWhen(host, (state, frame) => frame.columns === 26 && state.metricsReady);
			term.resize(26, 6);
			expect(firstRow(await resized)).toBe("entry 0");
			expect(scroller.state()).toMatchObject({ totalRows: total, unseen: false });

			const output = frameWhen(host, state => state.unseen);
			tail.set("partial text");
			const frame = await output;
			expect(firstRow(frame)).toBe("entry 0");
			expect(stripEscapes(frame.viewport.at(-1)!).trim()).toBe("New output below");
			expect(scroller.state()).toMatchObject({ offset: 0, following: false, totalRows: total });
		} finally {
			await host.stop();
			surface.dispose();
		}
	});

	it("restores a detached position after a shorter dock, but follows when the transcript itself shrinks to fit", async () => {
		const rows = signal(Array.from({ length: 8 }, (_, i) => `entry ${i}`));
		const tall = ["first", "second", "third", "fourth", "fifth"];
		const dock = signal(tall);
		const main = [jsx("rows", { lines: rows }) as UiNode];
		const surface = createSurface(() => ({ main, dock: jsx("rows", { lines: dock }) }));
		const host = await startHost({
			surface,
			driver: memoryTerminal({ columns: 30, rows: 10 }).options,
			theme: () => PLAIN_THEME,
			native: false,
			frameInterval: 0,
			presentation: () => "fullscreen",
		});
		try {
			const scroller = host.scroller!;
			const detached = frameWhen(host, state => !state.following);
			expect(scroller.scrollBy(-2)).toBe(true);
			expect(firstRow(await detached)).toBe("entry 2");

			const fits = frameWhen(host, state => state.height === 8);
			dock.set(["small"]);
			expect(firstRow(await fits)).toBe("entry 0");
			expect(scroller.state().following).toBe(false);
			expect(scroller.scrollBy(-1)).toBe(false);

			const restored = frameWhen(host, state => state.height === 4);
			dock.set(tall);
			expect(firstRow(await restored)).toBe("entry 2");
			const shrank = frameWhen(host, state => state.totalRows === 2);
			rows.set(["short", "end"]);
			expect(firstRow(await shrank)).toBe("short");
			expect(scroller.state()).toMatchObject({ following: true, unseen: false });
		} finally {
			await host.stop();
			surface.dispose();
		}
	});

	it("excludes even an appending spinner frame from unseen output, but not its label", () => {
		const theme = { ...PLAIN_THEME, symbols: new ThemeSymbols({ preset: "unicode", spinnerFrames: [".", ".."] }) };
		const env = staticEnvironment(theme);
		const label = signal("");
		const main = Array.from({ length: 6 }, (_, i) => canvas(() => [`entry ${i}`]));
		main.push(jsx("spinner", { label }) as UiNode);
		const transcript = new FullscreenTranscript({
			theme: () => theme,
			active: () => true,
			cellHeight: () => 16,
			requestRender: () => {},
			paint: (node, width) => createOwnedPaint(node, width, env),
			measure: (node, width) => paintForMeasurement(node, width, env),
			separator: () => 0,
		});
		const draw = (): readonly string[] => {
			const { rows } = transcript.compose(main, 24, 4, 4, false);
			transcript.publish();
			return rows;
		};
		try {
			expect(draw()[2]!.trimStart()).toStartWith(".");
			expect(transcript.scroller.toTop()).toBe(true);
			draw();
			env.setNow(SPINNER_INTERVAL_MS);
			expect(draw()[0]).toStartWith("entry 0");
			expect(transcript.scroller.state().unseen).toBe(false);

			label.set("ready");
			draw();
			expect(transcript.scroller.state().unseen).toBe(true);
			transcript.scroller.toBottom();
			expect(draw()[2]).toStartWith(".. ready");

			label.set("abcdefghijklmnopqrstuvwxyz");
			expect(stripEscapes(draw()[2]!).slice(0, 22)).toBe(".. abcdefghijklmnopqr…");
			transcript.scroller.toTop();
			draw();
			env.setNow(2 * SPINNER_INTERVAL_MS); // shorter glyph, still the same visible part of the label
			draw();
			expect(transcript.scroller.state().unseen).toBe(false);
			transcript.scroller.toBottom();
			expect(stripEscapes(draw()[2]!).slice(0, 22)).toBe(".  abcdefghijklmnopqr…");
		} finally {
			transcript.stop();
		}
	});

	it("measures cold image geometry without occupying the sole visible image slot", async () => {
		const driver = createTerminalDriver(memoryTerminal({ columns: 32, rows: 4 }).options);
		const caps = { ...driver.capabilities, images: "kitty" as const, cell: { w: 10, h: 10 } };
		const images = new TerminalImages({ capabilities: () => caps, budget: 1 });
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
			"base64",
		);
		const blobs = [1, 2].map(i => registerBlob(Buffer.concat([png, Buffer.from([0x74, i])]), "image/png"));
		const pictures = blobs.map(blob => jsx("col", { children: jsx("image", { blob, w: 20, h: 60 }) }) as UiNode);
		const main = Array.from({ length: 20 }, (_, i) => canvas(() => [String(i)]));
		main[0] = pictures[0]!;
		main[10] = pictures[1]!;
		const surface = createSurface(() => ({ main }));
		const backend = new TermBackend({
			driver,
			surface,
			images: driverImages(images, () => caps),
			theme: () => PLAIN_THEME,
			presentation: () => "fullscreen",
			separator: () => 0,
			marks: () => [{ node: main[10]!, kind: "success" }],
		});
		await driver.start();
		backend.start();
		const indexed = Promise.withResolvers<void>();
		const off = createRoot(dispose => {
			effect(() => {
				if (backend.scroller.state().metricsReady) indexed.resolve();
			});
			return dispose;
		});
		try {
			await indexed.promise;
			expect(backend.scroller.state().totalRows).toBe(30); // 18 ordinary rows plus two six-row pictures
			expect(images.settle()).toBe(false);
			expect(images.takeSequences("alternate")).toBe("");
			expect(backend.scroller.toTop()).toBe(true);
			backend.renderNow();
			expect(images.settle()).toBe(false);
			expect(images.takeSequences("alternate")).toContain("\x1b_Ga=t");
			expect(backend.scroller.seekMark(1)).toBe(true);
			backend.renderNow();
			// Keeping the first block's cached painting computation would leave two references and
			// demote the first picture here. Returning to it would then draw fallback instead of pixels.
			expect(images.settle()).toBe(false);
			expect(images.takeSequences("alternate")).toContain("\x1b_Ga=t");
			expect(backend.scroller.toTop()).toBe(true);
			backend.renderNow();
			expect(images.settle()).toBe(false);
		} finally {
			off();
			backend.stop();
			await driver.stop();
			surface.dispose();
			for (const blob of blobs) releaseBlob(blob);
		}
	});

	it("jumps by node before indexing, copies an unvisited interval, and scrolls backwards by real rows", () => {
		const calls = new Set<number>();
		const main = Array.from({ length: 500 }, (_, i) =>
			canvas(() => {
				calls.add(i);
				return i === 482 ? [] : [`${i}:a`, `${i}:b`, `${i}:c`];
			}),
		);
		const env = staticEnvironment(PLAIN_THEME);
		const copied: string[] = [];
		const transcript = new FullscreenTranscript({
			theme: () => PLAIN_THEME,
			active: () => true,
			cellHeight: () => 16,
			requestRender: () => {},
			paint: (node, width) => createOwnedPaint(node, width, env),
			measure: (node, width) => paintForMeasurement(node, width, env),
			separator: (_above, below) => (below === main[484] ? 0 : 1),
			marks: () => [480, 485].map(i => ({ node: main[i]!, kind: "success" })),
			copyText: async text => {
				copied.push(text);
				return "success";
			},
		});
		const paint = (): string[] =>
			transcript
				.compose(main, 30, 3, 3, false)
				.rows.slice(0, 2)
				.map(row => stripEscapes(row).slice(0, 28).trimEnd());
		const mouse = (action: "press" | "release", col: number): void => {
			transcript.mouse({ row: 0, col, button: "left", action, mods: [] }, 0, false, () => false);
		};
		try {
			expect(paint()).toEqual(["499:b", "499:c"]);
			expect(transcript.scroller.seekMark(-1)).toBe(true);
			expect(paint()).toEqual(["485:a", "485:b"]);
			mouse("press", 4);
			expect(transcript.scroller.seekMark(-1)).toBe(true);
			expect(paint()).toEqual(["480:a", "480:b"]);
			mouse("release", 0);
			expect(copied).toEqual([
				"480:a\n480:b\n480:c\n\n481:a\n481:b\n481:c\n\n483:a\n483:b\n483:c\n484:a\n484:b\n484:c\n\n485:a",
			]);
			expect(Math.min(...calls)).toBe(480);
			expect(transcript.scroller.scrollBy(-2)).toBe(true);
			expect(paint()).toEqual(["479:c", ""]);
		} finally {
			transcript.stop();
		}
	});
});
