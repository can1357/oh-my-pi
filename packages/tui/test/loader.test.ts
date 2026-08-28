import { afterEach, describe, expect, it, setSystemTime, spyOn, vi } from "bun:test";
import { Container, TUI } from "@oh-my-pi/pi-tui";
import { Loader, type LoaderMessageColorFn } from "@oh-my-pi/pi-tui/components/loader";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { VirtualTerminal } from "./virtual-terminal";

describe("Loader component", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("clamps rendered lines to terminal width", async () => {
		const term = new VirtualTerminal(1, 4);
		const tui = new TUI(term);
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Checking",
			["⠸"],
		);
		tui.addChild(loader);

		tui.start();
		await Bun.sleep(0);
		await term.flush();

		for (const line of term.getViewport()) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(1);
		}

		loader.stop();
		tui.stop();
	});

	it("keeps spinner cadence when animated messages repaint at 30fps", () => {
		vi.useFakeTimers();
		const ui = { requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => text) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0", "1", "2", "3"]);

		vi.advanceTimersByTime(170);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(3);
		expect(loader.render(20).join("\n")).toContain("2 Checking");
		loader.stop();
	});

	it("falls back to component-scoped renders for lightweight TUI stubs", () => {
		vi.useFakeTimers();
		const ui = { requestComponentRender: vi.fn() };
		const loader = new Loader(
			ui as unknown as TUI,
			text => text,
			text => text,
			"Checking",
			["0"],
		);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);

		loader.setMessage("Still checking");
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		expect(loader.render(30).join("\n")).toContain("0 Still checking");

		loader.stop();
	});

	it("skips animated render requests when composed text is unchanged before the spinner advances", () => {
		vi.useFakeTimers();
		const ui = { requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => text) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0", "1"]);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(34);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(67);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		expect(loader.render(20).join("\n")).toContain("1 Checking");

		loader.stop();
	});

	it("requests component renders for message changes but not repeated identical messages", () => {
		vi.useFakeTimers();
		const ui = { requestComponentRender: vi.fn() };
		const loader = new Loader(
			ui as unknown as TUI,
			text => text,
			text => text,
			"Checking",
			["0"],
		);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);

		loader.setMessage("Still checking");
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		expect(loader.render(30).join("\n")).toContain("0 Still checking");

		loader.setMessage("Still checking");
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);

		loader.stop();
	});

	it("requests component renders when animated message bytes change between spinner frames", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const ui = { synchronizedOutput: true, requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => `${text}-${Date.now()}`) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0"]);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(34);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		expect(loader.render(40).join("\n")).toContain("0 Checking-");

		loader.stop();
	});

	it("backs off animated paints when component renders consume the frame budget", () => {
		vi.useFakeTimers();
		let now = 0;
		const ui = {
			synchronizedOutput: true,
			requestComponentRender: vi.fn(() => {
				now += 40;
			}),
		};
		const colorMessage = ((text: string) => text) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		spyOn(performance, "now").mockImplementation(() => now);
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0"]);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(34);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);

		vi.advanceTimersByTime(200);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(160);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(3);

		loader.stop();
	});

	it("backs off from the completed TUI frame cost when render requests are asynchronous", () => {
		vi.useFakeTimers();
		let lastFrameCostMs = 0;
		const ui = {
			synchronizedOutput: true,
			get lastFrameCostMs() {
				return lastFrameCostMs;
			},
			requestComponentRender: vi.fn(),
		};
		const loader = new Loader(
			ui as unknown as TUI,
			text => text,
			text => text,
			"Checking",
			["0", "1"],
		);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);
		lastFrameCostMs = 40;
		vi.advanceTimersByTime(80);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);

		vi.advanceTimersByTime(359);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(1);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(3);

		loader.stop();
	});

	it("caps backpressure after a pathological one-off frame", () => {
		vi.useFakeTimers();
		const ui = {
			synchronizedOutput: true,
			lastFrameCostMs: 5_000,
			requestComponentRender: vi.fn(),
		};
		const loader = new Loader(
			ui as unknown as TUI,
			text => text,
			text => text,
			"Checking",
			["0", "1"],
		);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(80);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);

		vi.advanceTimersByTime(1_799);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(1);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(3);

		loader.stop();
	});

	it("reuses text layout when only animated ANSI styling changes", () => {
		vi.useFakeTimers();
		let colorFrame = 0;
		const ui = { synchronizedOutput: true, requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => `\x1b[3${colorFrame++ % 3}m${text}\x1b[0m`) as LoaderMessageColorFn & {
			animated: true;
		};
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["⠸"]);
		const stringWidth = spyOn(Bun, "stringWidth");

		const initial = loader.render(40);
		stringWidth.mockClear();
		vi.advanceTimersByTime(34);
		const animated = loader.render(40);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		expect(stringWidth).not.toHaveBeenCalled();
		expect(initial[1]).not.toBe(animated[1]);
		expect(visibleWidth(initial[1])).toBe(visibleWidth(animated[1]));
		loader.stop();
	});

	it("reuses the wrapped layout across static spinner frames without re-measuring", () => {
		vi.useFakeTimers();
		const ui = { synchronizedOutput: true, requestComponentRender: vi.fn() };
		const loader = new Loader(
			ui as unknown as TUI,
			s => s,
			m => m,
			"Checking",
			["⠋", "⠙", "⠹"],
		);
		const stringWidth = spyOn(Bun, "stringWidth");

		const initial = loader.render(40);
		stringWidth.mockClear();
		vi.advanceTimersByTime(80);
		const advanced = loader.render(40);

		// Advancing the spinner glyph must not re-run the wrap/width pipeline:
		// only the leading 1-cell glyph changed, so the cached layout stands.
		expect(stringWidth).not.toHaveBeenCalled();
		expect(advanced[1]).not.toBe(initial[1]);
		expect(advanced[1]).toContain("⠙ Checking");
		expect(visibleWidth(initial[1])).toBe(visibleWidth(advanced[1]));
		loader.stop();
	});

	it("rewraps custom spinner frames when their display widths differ", () => {
		vi.useFakeTimers();
		const ui = { synchronizedOutput: true, requestComponentRender: vi.fn() };
		const loader = new Loader(
			ui as unknown as TUI,
			s => s,
			m => m,
			"Load",
			["*", ">>>>"],
		);

		loader.render(8);
		vi.advanceTimersByTime(80);
		const widerFrame = loader.render(8);

		expect(widerFrame.join("\n")).toContain(">>>>");
		for (const line of widerFrame) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(8);
		}
		loader.stop();
	});

	it("holds animated message-only frames when synchronized output is unavailable", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const ui = { synchronizedOutput: false, requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => `${text}-${Date.now()}`) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0", "1"]);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(34);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(67);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		expect(loader.render(40).join("\n")).toContain("1 Checking-");

		loader.stop();
	});

	it("dispose() stops the animation so no further renders are scheduled", async () => {
		const term = new VirtualTerminal(20, 4);
		const tui = new TUI(term);
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Checking",
			["a", "b", "c"],
		);
		const spy = spyOn(tui, "requestComponentRender");
		loader.dispose();
		const after = spy.mock.calls.length;
		await Bun.sleep(40); // longer than the spinner interval
		expect(spy.mock.calls.length).toBe(after);
		expect(() => loader.dispose()).not.toThrow(); // idempotent
		tui.stop();
	});

	it("container disposeChildren stops detached loader repaints", () => {
		vi.useFakeTimers();
		const term = new VirtualTerminal(20, 4);
		const tui = new TUI(term);
		const spy = spyOn(tui, "requestComponentRender");
		const container = new Container();
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Checking",
			["0", "1"],
		);
		container.addChild(loader);
		const afterMount = spy.mock.calls.length;

		container.disposeChildren();
		vi.advanceTimersByTime(200);

		expect(spy.mock.calls.length).toBe(afterMount);
		expect(container.children).toEqual([]);
		tui.stop();
	});
	it("re-evaluates a dynamic message function on each spinner tick", () => {
		vi.useFakeTimers();
		const ui = { requestDirectWrite: vi.fn(), requestComponentRender: vi.fn() };
		let step = 0;
		const loader = new Loader(
			ui as unknown as TUI,
			t => t,
			t => t,
			() => `step ${step}`,
			["0", "1", "2", "3"],
		);

		// Initial sync at construction evaluates the function once.
		expect(loader.render(20).join("\n")).toContain("step 0");

		// Mutating the closure source alone does not repaint — the function
		// is only re-evaluated when the spinner ticks and #syncText runs.
		step = 1;
		expect(loader.render(20).join("\n")).toContain("step 0");

		vi.advanceTimersByTime(80); // first spinner advance re-evaluates the fn
		expect(loader.render(20).join("\n")).toContain("step 1");
		expect(loader.render(20).join("\n")).not.toContain("step 0");

		loader.stop();
	});
});
