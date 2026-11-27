/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The `fullscreen` screen mode: every frame is an alternate-screen frame with the dock pinned to the
 * bottom and `main` in an app-owned window that follows the tail or stays anchored to a block, and
 * nothing reaches history until the shutdown flush.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { For, type Signal, settle, signal } from "@oh-my-pi/pi-tui";
import type { ScreenMode } from "@oh-my-pi/pi-tui/term/backend";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";

interface Item {
	readonly lines: readonly string[];
}

const block = (prefix: string, count: number): Item => ({
	lines: Array.from({ length: count }, (_, i) => `${prefix}${i}`),
});

let term: TestTerminal | undefined;

afterEach(() => {
	term?.dispose();
	term = undefined;
});

function mount(
	initial: readonly Item[],
	options: { rows?: number; screen?: Signal<ScreenMode>; layer?: () => unknown } = {},
): { term: TestTerminal; items: Signal<readonly Item[]>; screen: Signal<ScreenMode> } {
	const items = signal<readonly Item[]>(initial);
	const screen = options.screen ?? signal<ScreenMode>("fullscreen");
	term = createTestTerminal(
		() => ({
			main: <For each={items}>{item => <rows lines={item.lines} />}</For>,
			dock: <rows lines={["> prompt"]} />,
			layer: options.layer?.() as never,
		}),
		{ columns: 20, rows: options.rows ?? 6, separator: () => 0, screen, scrollbar: () => false, wheelLines: () => 3 },
	);
	return { term, items, screen };
}

const append = (items: Signal<readonly Item[]>, item: Item): void => items.set([...items.peek(), item]);

const wheel = (t: TestTerminal, button: "wheel-up" | "wheel-down"): void =>
	t.mouse({ row: 0, col: 0, button, action: "press", mods: [] });

it("uses every row above the composer for transcript text when the scrollbar supplies position", () => {
	term = createTestTerminal(
		() => ({
			main: <rows lines={Array.from({ length: 12 }, (_, i) => `line ${i}`)} />,
			dock: [<rows lines={["", ""]} />, <rows lines={["", "> draft"]} />],
		}),
		{ rows: 5, columns: 20, screen: () => "fullscreen" },
	);
	term.backend.scroll("start");
	term.render();
	expect(
		term
			.screen()
			.slice(0, 4)
			.map(row => row.match(/^line \d+/)?.[0]),
	).toEqual(["line 0", "line 1", "line 2", "line 3"]);
	expect(term.screen()[4]).toBe("> draft");
});

describe("fullscreen screen mode", () => {
	it("pins the dock to the bottom row under a short transcript and writes no history", () => {
		const { term } = mount([block("a", 2)]);
		expect(term.fullscreen()).toBeDefined();
		expect(term.screen()).toEqual(["a0", "a1", "", "", "", "> prompt"]);
		expect(term.history()).toEqual([]);
	});

	it("follows the tail as blocks arrive", () => {
		const { term, items } = mount([block("a", 4)]);
		append(items, block("b", 3));
		term.render();
		expect(term.screen()).toEqual(["a2", "a3", "b0", "b1", "b2", "> prompt"]);
		expect(term.backend.following).toBe(true);
		expect(term.history()).toEqual([]);
	});

	it("pages up, stays put while output arrives below, and counts what is below", () => {
		const { term, items } = mount([block("a", 10)]);
		// Window: 5 rows (a5..a9); a page is 4 rows.
		expect(term.backend.scroll("page-up")).toBe(true);
		term.render();
		expect(term.screen()).toEqual(["a1", "a2", "a3", "a4", "↓ 5 lines below", "> prompt"]);
		append(items, block("b", 2));
		term.render();
		expect(term.screen()).toEqual(["a1", "a2", "a3", "a4", "↓ 7 lines below", "> prompt"]);
		expect(term.backend.following).toBe(false);
	});

	it("clamps at the top and follows again once scrolled back to the end", () => {
		const { term } = mount([block("a", 10)]);
		term.backend.scroll("page-up");
		term.backend.scroll("page-up");
		term.backend.scroll("page-up");
		term.render();
		expect(term.screen()).toEqual(["a0", "a1", "a2", "a3", "↓ 6 lines below", "> prompt"]);
		term.backend.scroll("page-down");
		term.backend.scroll("page-down");
		term.render();
		expect(term.screen()).toEqual(["a5", "a6", "a7", "a8", "a9", "> prompt"]);
		expect(term.backend.following).toBe(true);
		term.backend.scroll("start");
		term.render();
		expect(term.screen()[0]).toBe("a0");
		term.backend.scroll("end");
		term.render();
		expect(term.screen()).toEqual(["a5", "a6", "a7", "a8", "a9", "> prompt"]);
	});

	it("scrolls by the configured three rows per wheel tick", () => {
		const { term } = mount([block("a", 10)]);
		wheel(term, "wheel-up");
		expect(term.screen()).toEqual(["a2", "a3", "a4", "a5", "↓ 4 lines below", "> prompt"]);
		wheel(term, "wheel-down");
		expect(term.screen()).toEqual(["a5", "a6", "a7", "a8", "a9", "> prompt"]);
	});

	it("crosses block boundaries and counts separator rows", () => {
		const items = signal<readonly Item[]>([block("a", 3), block("b", 3), block("c", 3)]);
		term = createTestTerminal(
			() => ({
				main: <For each={items}>{item => <rows lines={item.lines} />}</For>,
				dock: <rows lines={["> prompt"]} />,
			}),
			{ columns: 20, rows: 6, separator: () => 1, screen: () => "fullscreen", scrollbar: () => false },
		);
		// Tail: b2, "", c0..c2.
		expect(term.screen()).toEqual(["b2", "", "c0", "c1", "c2", "> prompt"]);
		term.backend.scroll(-5);
		term.render();
		expect(term.screen()).toEqual(["a1", "a2", "", "b0", "↓ 6 lines below", "> prompt"]);
	});

	it("keeps the anchored block at the top across a resize", () => {
		const { term } = mount([block("a", 4), block("b", 4), block("c", 4)]);
		term.backend.scroll("start");
		term.backend.scroll(4);
		term.render();
		expect(term.screen()[0]).toBe("b0");
		term.resize(30, 8);
		expect(term.screen()).toEqual(["b0", "b1", "b2", "b3", "c0", "c1", "↓ 2 lines below", "> prompt"]);
		// Taller still: everything from the anchor fits, so the window follows the tail again.
		term.resize(30, 12);
		expect(term.backend.following).toBe(true);
	});

	it("clamps an anchor row past a block that shrank", () => {
		const items = signal<readonly Item[]>([]);
		const first: Signal<readonly string[]> = signal(block("a", 6).lines);
		term = createTestTerminal(
			() => ({
				main: [<rows lines={first} />, <For each={items}>{item => <rows lines={item.lines} />}</For>],
				dock: <rows lines={["> prompt"]} />,
			}),
			{ columns: 20, rows: 4, separator: () => 0, screen: () => "fullscreen", scrollbar: () => false },
		);
		items.set([block("b", 6)]);
		term.render();
		term.backend.scroll("start");
		term.backend.scroll(5);
		term.render();
		expect(term.screen()[0]).toBe("a5");
		first.set(["a0", "a1"]);
		term.render();
		expect(term.screen()).toEqual(["a1", "b0", "↓ 5 lines below", "> prompt"]);
	});

	it("draws sheets over the frame and returns to the scroll position after a page", () => {
		const page = signal(false);
		const { term } = mount([block("a", 10)], {
			layer: () => () =>
				page() ? (
					<overlay size="full">
						<rows lines={["page"]} />
					</overlay>
				) : undefined,
		});
		term.backend.scroll("page-up");
		term.render();
		const scrolled = term.screen();
		page.set(true);
		term.render();
		expect(term.screen().some(row => row.includes("page"))).toBe(true);
		// No transcript window while a page is up: the key goes to the page.
		expect(term.backend.scroll("page-up")).toBe(false);
		page.set(false);
		term.render();
		expect(term.screen()).toEqual(scrolled);
	});

	it("writes the whole transcript into history once at the shutdown flush", () => {
		const { term } = mount([block("a", 4), block("b", 4)]);
		term.backend.scroll("start");
		term.render();
		term.backend.flush();
		expect(term.fullscreen()).toBeUndefined();
		expect(term.history()).toEqual([...block("a", 4).lines, ...block("b", 4).lines]);
		expect(term.screen()).toEqual(["> prompt"]);
	});

	it("switches modes live without writing a block twice", () => {
		const screen = signal<ScreenMode>("inline");
		const { term, items } = mount([block("a", 8)], { screen });
		expect(term.fullscreen()).toBeUndefined();
		// Inline: the settled block's rows that do not fit retire into history.
		settle(term.surface.main()[0]!);
		term.render();
		const retired = term.history().length;
		expect(retired).toBeGreaterThan(0);
		screen.set("fullscreen");
		term.render();
		expect(term.fullscreen()).toBeDefined();
		append(items, block("b", 3));
		term.render();
		expect(term.history().length).toBe(retired);
		screen.set("inline");
		term.render();
		expect(term.fullscreen()).toBeUndefined();
		term.backend.flush();
		expect(term.history()).toEqual([...block("a", 8).lines, ...block("b", 3).lines]);
	});

	it("leaves inline mode untouched: no window, scroll declines", () => {
		const { term } = mount([block("a", 3)], { screen: signal<ScreenMode>("inline") });
		expect(term.fullscreen()).toBeUndefined();
		expect(term.backend.scroll("page-up")).toBe(false);
		expect(term.screen()).toEqual(["a0", "a1", "a2", "> prompt"]);
	});
});
