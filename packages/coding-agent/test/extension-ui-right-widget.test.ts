import { describe, expect, it } from "bun:test";
import { Container, type RightPanelBlock, type RightPanelBlockInput } from "@oh-my-pi/pi-tui";
import type { ExtensionUiComponentFactory } from "../src/extensibility/extensions";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../src/modes/types";

// Minimal context: setHookWidget / clearHookWidgets only touch the two hook
// containers, ui.requestRender, and setRightInfo.
function makeCtx(): {
	ctx: InteractiveModeContext;
	rightInfo: (string[][] | undefined)[];
	currentRightInfo: (width?: number) => string[][] | undefined;
} {
	const rightInfo: (string[][] | undefined)[] = [];
	let provider: ((width: number) => readonly RightPanelBlockInput[]) | undefined;
	const snapshot = (width = 80): string[][] | undefined =>
		provider?.(width).map(block => [...(Array.isArray(block) ? block : (block as RightPanelBlock).lines)]);
	const ctx = {
		hookWidgetContainerAbove: new Container(),
		hookWidgetContainerBelow: new Container(),
		ui: { requestRender: () => {} },
		setRightInfo: (blocks: string[][] | ((width: number) => readonly RightPanelBlockInput[]) | undefined) => {
			provider = typeof blocks === "function" ? blocks : blocks === undefined ? undefined : () => blocks;
			rightInfo.push(snapshot());
		},
	} as unknown as InteractiveModeContext;
	return { ctx, rightInfo, currentRightInfo: snapshot };
}

describe("ExtensionUiController rightEditor widgets", () => {
	it("exposes each right widget as its own block (no merge)", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		// Equal height keeps insertion order, so the block split is unambiguous.
		c.setHookWidget("a", ["a1", "a2"], { placement: "rightEditor" });
		c.setHookWidget("b", ["b1", "b2"], { placement: "rightEditor" });

		expect(rightInfo.at(-1)).toEqual([
			["a1", "a2"],
			["b1", "b2"],
		]);
	});

	it("exposes sub-blocks from one right widget independently", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget(
			"usage",
			[{ lines: ["summary"] }, { lines: ["account1", "bar1"] }, { lines: ["account2", "bar2"] }],
			{ placement: "rightEditor" },
		);

		expect(rightInfo.at(-1)).toEqual([["summary"], ["account1", "bar1"], ["account2", "bar2"]]);
	});

	it("uses sub-block priority before widget priority", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget(
			"usage",
			[
				{ lines: ["low"], priority: 5 },
				{ lines: ["high"], priority: -5 },
			],
			{ placement: "rightEditor", priority: 0 },
		);
		c.setHookWidget("memory", ["mem"], { placement: "rightEditor", priority: -1 });

		expect(rightInfo.at(-1)).toEqual([["high"], ["mem"], ["low"]]);
	});

	it("orders blocks by ascending height when no priority is set", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("tall", ["t1", "t2", "t3"], { placement: "rightEditor" });
		c.setHookWidget("short", ["s1"], { placement: "rightEditor" });

		// Shortest first so the small, always-present panels stay visible.
		expect(rightInfo.at(-1)).toEqual([["s1"], ["t1", "t2", "t3"]]);
	});

	it("places lower priority numbers first, overriding height", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("tall", ["t1", "t2", "t3"], { placement: "rightEditor", priority: 0 });
		c.setHookWidget("short", ["s1"], { placement: "rightEditor", priority: 1 });

		expect(rightInfo.at(-1)).toEqual([["t1", "t2", "t3"], ["s1"]]);
	});

	it("preserves right widget insertion order when an existing key updates", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("a", ["a1"], { placement: "rightEditor" });
		c.setHookWidget("b", ["b1"], { placement: "rightEditor" });
		c.setHookWidget("a", ["a2"], { placement: "rightEditor" });

		// Equal height -> insertion order (a before b) is preserved across update.
		expect(rightInfo.at(-1)).toEqual([["a2"], ["b1"]]);
	});

	it("does not cap right widget content before the compositor can place it", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		const lines = Array.from({ length: 15 }, (_, i) => `l${i}`);
		c.setHookWidget("big", lines, { placement: "rightEditor" });

		expect(rightInfo.at(-1)).toEqual([lines]);
	});

	it("clears right-side state when a key moves back to an inline placement", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("a", ["a1"], { placement: "rightEditor" });
		expect(rightInfo.at(-1)).toEqual([["a1"]]);

		// Same key, now aboveEditor → the stale right-side block must be cleared.
		c.setHookWidget("a", ["a1"], { placement: "aboveEditor" });
		expect(rightInfo.at(-1)).toBeUndefined();
	});

	it("clears right-side state when the key is removed (undefined content)", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("a", ["a1"], { placement: "rightEditor" });
		c.setHookWidget("a", undefined, { placement: "rightEditor" });
		expect(rightInfo.at(-1)).toBeUndefined();
	});

	it("clearHookWidgets drops all right-side blocks", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("a", ["a1"], { placement: "rightEditor" });
		c.clearHookWidgets();
		expect(rightInfo.at(-1)).toBeUndefined();
	});

	it("strips terminal-width padding from component-factory right widgets", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		// A width-aware component (like Text) pads its line to the full render width.
		// The stored block must reflect the real content width, not the terminal,
		// or compositeRightPanels would drop it as "too narrow".
		const factory = (() => ({
			render: (width: number) => [`hi${" ".repeat(Math.max(0, width - 2))}`],
			dispose() {},
		})) as unknown as ExtensionUiComponentFactory;
		c.setHookWidget("comp", factory, { placement: "rightEditor" });

		expect(rightInfo.at(-1)).toEqual([["hi"]]);
	});

	it("strips component right-widget padding before trailing SGR resets", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		const factory = (() => ({
			render: (width: number) => [`\x1b[31mhi${" ".repeat(Math.max(0, width - 2))}\x1b[0m`],
			dispose() {},
		})) as unknown as ExtensionUiComponentFactory;
		c.setHookWidget("styled", factory, { placement: "rightEditor" });

		expect(rightInfo.at(-1)).toEqual([["\x1b[31mhi\x1b[0m"]]);
	});

	it("keeps component-factory right widgets alive for render requests", () => {
		const { ctx, rightInfo, currentRightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);
		let text = "first";
		let disposed = 0;
		let requestRender!: () => void;
		const factory = (tui => {
			requestRender = () => tui.requestRender();
			return {
				render: (width: number) => [`${text}${" ".repeat(Math.max(0, width - text.length))}`],
				dispose() {
					disposed++;
				},
			};
		}) as ExtensionUiComponentFactory;

		c.setHookWidget("live", factory, { placement: "rightEditor" });
		expect(rightInfo.at(-1)).toEqual([["first"]]);
		expect(disposed).toBe(0);

		text = "second";
		requestRender();
		expect(currentRightInfo()).toEqual([["second"]]);
		expect(disposed).toBe(0);

		c.setHookWidget("live", undefined, { placement: "rightEditor" });
		expect(rightInfo.at(-1)).toBeUndefined();
		expect(disposed).toBe(1);
	});
	it("re-renders component-factory right widgets when the right panel provider is read", () => {
		const { ctx, currentRightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);
		let renderCount = 0;
		const factory = (() => ({
			render: () => [`render-${++renderCount}`],
			dispose() {},
		})) as unknown as ExtensionUiComponentFactory;

		c.setHookWidget("live", factory, { placement: "rightEditor" });

		expect(currentRightInfo()).toEqual([["render-2"]]);
		expect(currentRightInfo()).toEqual([["render-3"]]);
	});

	it("keeps the old right widget when a replacement component factory throws", () => {
		const { ctx, currentRightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);
		let disposed = 0;
		const oldFactory = (() => ({
			render: () => ["old"],
			dispose() {
				disposed++;
			},
		})) as unknown as ExtensionUiComponentFactory;
		const throwingFactory = (() => {
			throw new Error("boom");
		}) as unknown as ExtensionUiComponentFactory;

		c.setHookWidget("live", oldFactory, { placement: "rightEditor" });

		expect(() => c.setHookWidget("live", throwingFactory, { placement: "rightEditor" })).toThrow("boom");
		expect(disposed).toBe(0);
		expect(currentRightInfo()).toEqual([["old"]]);
	});

	it("keeps the old right widget when a cross-placement (right→inline) factory throws", () => {
		const { ctx, currentRightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);
		let disposed = 0;
		const oldFactory = (() => ({
			render: () => ["old"],
			dispose() {
				disposed++;
			},
		})) as unknown as ExtensionUiComponentFactory;
		const throwingFactory = (() => {
			throw new Error("boom");
		}) as unknown as ExtensionUiComponentFactory;

		c.setHookWidget("live", oldFactory, { placement: "rightEditor" });

		// Move right → aboveEditor with a throwing factory: the inline replacement is
		// built before the old right entry is dropped, so the old widget must survive.
		expect(() => c.setHookWidget("live", throwingFactory, { placement: "aboveEditor" })).toThrow("boom");
		expect(disposed).toBe(0);
		expect(currentRightInfo()).toEqual([["old"]]);
	});

	it("keeps the old inline widget when a cross-placement (inline→right) factory throws", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);
		let disposed = 0;
		const oldInline = (() => ({
			render: () => ["old-inline"],
			dispose() {
				disposed++;
			},
		})) as unknown as ExtensionUiComponentFactory;
		const throwingFactory = (() => {
			throw new Error("boom");
		}) as unknown as ExtensionUiComponentFactory;

		c.setHookWidget("live", oldInline, { placement: "aboveEditor" });

		// Refresh inline → rightEditor with a throwing factory: the right replacement is
		// built before the inline widget is dropped, so the inline widget must survive.
		expect(() => c.setHookWidget("live", throwingFactory, { placement: "rightEditor" })).toThrow("boom");
		expect(disposed).toBe(0);
		expect(rightInfo.at(-1)).toBeUndefined(); // no right widget got installed on failure
	});

	it("passes the supplied width to component-factory right widgets", () => {
		const { ctx, currentRightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);
		let receivedWidth = 0;
		const factory = (() => ({
			render: (width: number) => {
				receivedWidth = width;
				return [`w${width}${" ".repeat(Math.max(0, width - String(width).length - 1))}`];
			},
			dispose() {},
		})) as unknown as ExtensionUiComponentFactory;

		c.setHookWidget("sized", factory, { placement: "rightEditor" });
		const panelWidth = 120 - 30 - 1; // RIGHT_PANEL_MIN_COL=30, 1-col gap
		expect(currentRightInfo(120)).toEqual([[`w${panelWidth}`]]);
		expect(receivedWidth).toBe(panelWidth);
	});

	it("binds non-overridden TUI methods to the real instance so #private access works", () => {
		// A component-backed rightEditor widget may call any TUI API, not just the two
		// overridden render methods. Those methods touch #private fields, so the proxy
		// must invoke them with `this` bound to the real TUI — never the proxy itself.
		class FakeTui {
			#calls: string[] = [];
			requestRender(): void {}
			addChild(name: string): void {
				this.#calls.push(name); // throws if `this` is the proxy, not this instance
			}
			getCalls(): string[] {
				return this.#calls;
			}
		}
		const fakeTui = new FakeTui();
		const ctx = {
			hookWidgetContainerAbove: new Container(),
			hookWidgetContainerBelow: new Container(),
			ui: fakeTui,
			setRightInfo: () => {},
		} as unknown as InteractiveModeContext;
		const c = new ExtensionUiController(ctx);
		let caught: unknown;
		const factory = ((tui: { addChild: (name: string) => void }) => {
			try {
				tui.addChild("from-widget");
			} catch (e) {
				caught = e;
			}
			return { render: () => ["x"], dispose() {} };
		}) as unknown as ExtensionUiComponentFactory;
		c.setHookWidget("w", factory, { placement: "rightEditor" });
		expect(caught).toBeUndefined(); // no #private-access crash
		expect(fakeTui.getCalls()).toEqual(["from-widget"]); // ran on the real instance
	});
	it("clears layout cache on widget removal so re-add emits widget_layout", async () => {
		let provider: ((width: number) => string[][]) | undefined;
		let layoutCb: ((result: { placedBlockIndices: number[]; availableWidth: number }) => void) | undefined;
		const ctx = {
			hookWidgetContainerAbove: new Container(),
			hookWidgetContainerBelow: new Container(),
			ui: { requestRender: () => {} },
			setRightInfo: (
				p: unknown,
				onLayout?: (result: { placedBlockIndices: number[]; availableWidth: number }) => void,
			) => {
				provider = typeof p === "function" ? (p as (width: number) => string[][]) : undefined;
				layoutCb = onLayout;
			},
		} as unknown as InteractiveModeContext;
		const c = new ExtensionUiController(ctx);
		const layouts: string[] = [];
		c.setWidgetLayoutEmitter(event => layouts.push(event.key));

		// Add widget → invoke provider (populates block tracking) + trigger layout
		c.setHookWidget("w", ["line1", "line2"], { placement: "rightEditor" });
		provider?.(80);
		layoutCb?.({ placedBlockIndices: [0], availableWidth: 30 });
		await Promise.resolve(); // flush queueMicrotask
		expect(layouts).toEqual(["w"]);

		// Remove widget
		c.setHookWidget("w", undefined, { placement: "rightEditor" });

		// Re-add with identical content → invoke provider + trigger layout again
		c.setHookWidget("w", ["line1", "line2"], { placement: "rightEditor" });
		provider?.(80);
		layoutCb?.({ placedBlockIndices: [0], availableWidth: 30 });
		await Promise.resolve();

		// Without cache fix: second "w" event suppressed (cache matched).
		// With fix: cache was deleted on removal, so event fires again.
		expect(layouts).toEqual(["w", "w"]);
	});
	it("clears layout cache when every right widget sub-block becomes empty", async () => {
		let provider: ((width: number) => string[][]) | undefined;
		let layoutCb: ((result: { placedBlockIndices: number[]; availableWidth: number }) => void) | undefined;
		const ctx = {
			hookWidgetContainerAbove: new Container(),
			hookWidgetContainerBelow: new Container(),
			ui: { requestRender: () => {} },
			setRightInfo: (
				p: unknown,
				onLayout?: (result: { placedBlockIndices: number[]; availableWidth: number }) => void,
			) => {
				provider = typeof p === "function" ? (p as (width: number) => string[][]) : undefined;
				layoutCb = onLayout;
			},
		} as unknown as InteractiveModeContext;
		const c = new ExtensionUiController(ctx);
		const layouts: string[] = [];
		c.setWidgetLayoutEmitter(event => layouts.push(event.key));

		const visibleBlocks = [{ id: "section", lines: ["line"] }];
		c.setHookWidget("w", visibleBlocks, { placement: "rightEditor" });
		provider?.(80);
		layoutCb?.({ placedBlockIndices: [0], availableWidth: 30 });
		await Promise.resolve();
		expect(layouts).toEqual(["w"]);

		c.setHookWidget("w", [{ id: "section", lines: [] }], { placement: "rightEditor" });
		provider?.(80);
		layoutCb?.({ placedBlockIndices: [], availableWidth: 30 });

		c.setHookWidget("w", visibleBlocks, { placement: "rightEditor" });
		provider?.(80);
		layoutCb?.({ placedBlockIndices: [0], availableWidth: 30 });
		await Promise.resolve();

		expect(layouts).toEqual(["w", "w"]);
	});
	it("clears layout cache on right-to-inline move so re-add emits widget_layout", async () => {
		let provider: ((width: number) => string[][]) | undefined;
		let layoutCb: ((result: { placedBlockIndices: number[]; availableWidth: number }) => void) | undefined;
		const ctx = {
			hookWidgetContainerAbove: new Container(),
			hookWidgetContainerBelow: new Container(),
			ui: { requestRender: () => {} },
			setRightInfo: (
				p: unknown,
				onLayout?: (result: { placedBlockIndices: number[]; availableWidth: number }) => void,
			) => {
				provider = typeof p === "function" ? (p as (width: number) => string[][]) : undefined;
				layoutCb = onLayout;
			},
		} as unknown as InteractiveModeContext;
		const c = new ExtensionUiController(ctx);
		const layouts: string[] = [];
		c.setWidgetLayoutEmitter(event => layouts.push(event.key));

		// Add as rightEditor → trigger layout
		c.setHookWidget("w", ["line1"], { placement: "rightEditor" });
		provider?.(80);
		layoutCb?.({ placedBlockIndices: [0], availableWidth: 30 });
		await Promise.resolve();
		expect(layouts).toEqual(["w"]);

		// Move to aboveEditor (inline) — should clear right cache
		c.setHookWidget("w", ["line1"], { placement: "aboveEditor" });

		// Move back to rightEditor with identical content → should emit again
		c.setHookWidget("w", ["line1"], { placement: "rightEditor" });
		provider?.(80);
		layoutCb?.({ placedBlockIndices: [0], availableWidth: 30 });
		await Promise.resolve();

		// Without cache fix: second event suppressed (stale cache from first add).
		// With fix: cache cleared on right-to-inline move, so event fires again.
		expect(layouts).toEqual(["w", "w"]);
	});
});
