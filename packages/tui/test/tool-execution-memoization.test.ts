import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, Text, type TUI } from "@oh-my-pi/pi-tui";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";

/**
 * Contract under test (tool-result render memoization):
 *
 * `ToolExecutionComponent` shapes a tool result into UI components by calling
 * the tool's `renderResult` — an O(result-size) pass. A dirty-key guard at the
 * top of `#updateDisplay()` must collapse the result version, expand state,
 * partial flag, spinner frame, show-images flag, and theme epoch into one key
 * and skip `#rebuildDisplay()` when nothing meaningful changed. So:
 *
 *   - A flood of `invalidate()` calls (one per render frame) after a final
 *     result must re-shape EXACTLY ONCE, not once per frame — this is the
 *     regression guard against the per-frame re-shape stall.
 *   - A state change that actually alters output (`setExpanded(true)`) must
 *     force exactly one additional shaping pass, and the new output must be
 *     observable; a redundant no-op set of the same state must not re-shape.
 *   - Bumping the result version (a NEW result) must force exactly one more
 *     shaping pass, and the rendered output must reflect the new result.
 */
describe("ToolExecutionComponent tool-result render memoization", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// A custom tool whose `renderResult` is the single O(result-size) shaping
	// function. It echoes the result text so the rendered frame reflects which
	// result was last shaped — letting us assert the memo never suppresses a
	// real change, only redundant repaints.
	function makeShapingTool() {
		return {
			name: "custom_render",
			label: "Custom",
			renderResult(result: { content: Array<{ type: string; text?: string }> }): Text {
				const joined = result.content.map(c => c.text ?? "").join("");
				return new Text(`shaped:${joined}`, 0, 0);
			},
		};
	}

	function finalResult(text: string) {
		return { content: [{ type: "text", text }] };
	}

	it("re-shapes once per meaningful change, never per invalidate() frame", () => {
		const tool = makeShapingTool();
		const shapeSpy = vi.spyOn(tool, "renderResult");
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const component = new ToolExecutionComponent(
			"custom_render",
			{},
			{},
			tool as unknown as AgentTool,
			ui,
			process.cwd(),
		);

		// No result yet: the shaping pass has not run.
		expect(shapeSpy).toHaveBeenCalledTimes(0);

		// Phase 1 — a final (non-partial) result shapes exactly once, and a
		// flood of per-frame invalidate()s must NOT re-shape (the regression).
		component.updateResult(finalResult("ALPHA"), false);
		expect(shapeSpy).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 12; i++) component.invalidate();
		expect(shapeSpy).toHaveBeenCalledTimes(1);
		expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("shaped:ALPHA");

		// Phase 2 — a state change that alters output forces exactly one more
		// shaping pass; further invalidate()s and a redundant same-value set do
		// not, and the expanded frame is observable.
		component.setExpanded(true);
		expect(shapeSpy).toHaveBeenCalledTimes(2);
		for (let i = 0; i < 12; i++) component.invalidate();
		component.setExpanded(true);
		expect(shapeSpy).toHaveBeenCalledTimes(2);

		// Phase 3 — a NEW result (bumped version) forces exactly one more pass,
		// and the rendered output reflects the new result, not the stale one.
		component.updateResult(finalResult("BRAVO"), false);
		expect(shapeSpy).toHaveBeenCalledTimes(3);
		const frame = stripVTControlCharacters(component.render(80).join("\n"));
		expect(frame).toContain("shaped:BRAVO");
		expect(frame).not.toContain("shaped:ALPHA");
	});

	// Regression: the memo key must also cover streamed call-arg changes. The
	// dirty key folds in a display-input version bumped by updateArgs(), so a
	// new args object re-shapes the call preview instead of freezing it at the
	// first render (the bug: key omitted #args, so once the display was built
	// every streamed delta was swallowed by the guard).
	it("re-shapes the call preview when streamed args change, not only on key fields", () => {
		const tool = {
			name: "custom_render",
			label: "Custom",
			renderCall(args: { cmd?: string }): Text {
				return new Text(`call:${args?.cmd ?? ""}`, 0, 0);
			},
		};
		const callSpy = vi.spyOn(tool, "renderCall");
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const component = new ToolExecutionComponent(
			"custom_render",
			{ cmd: "A" },
			{},
			tool as unknown as AgentTool,
			ui,
			process.cwd(),
		);

		// Constructor shaped the call preview once with the initial args.
		expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("call:A");
		const afterCtor = callSpy.mock.calls.length;

		// A flood of per-frame invalidate()s must NOT re-shape (memo still holds).
		for (let i = 0; i < 12; i++) component.invalidate();
		expect(callSpy.mock.calls.length).toBe(afterCtor);

		// A NEW args object (streamed delta) MUST re-shape and reflect the change,
		// even though no key field (result version, expanded, …) moved.
		component.updateArgs({ cmd: "B" });
		expect(callSpy.mock.calls.length).toBe(afterCtor + 1);
		const frame = stripVTControlCharacters(component.render(80).join("\n"));
		expect(frame).toContain("call:B");
		expect(frame).not.toContain("call:A");

		// A same-reference updateArgs is the documented no-op and must not re-shape.
		const sameArgs = { cmd: "C" };
		component.updateArgs(sameArgs);
		const afterReal = callSpy.mock.calls.length;
		component.updateArgs(sameArgs);
		expect(callSpy.mock.calls.length).toBe(afterReal);
	});

	it("renders passive context as one sanitized dim line", () => {
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("probe", {}, {}, undefined, ui, process.cwd());
		component.updateResult(finalResult("done"), false);

		component.setAdditionalContext("first\tinstruction\nsecond instruction\u001b[31m");

		const rawFrame = component.render(120).join("\n");
		expect(rawFrame).not.toContain("\u001b[31m");
		const frame = stripVTControlCharacters(rawFrame);
		const contextLines = frame.split("\n").filter(line => line.includes("Context:"));
		expect(contextLines).toHaveLength(1);
		expect(contextLines[0]).toContain("first instruction second instruction");
		expect(contextLines[0]).not.toContain("\t");
	});

	it("keeps the passive context line below result images added after it", () => {
		const originalProtocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Iterm2);
		try {
			const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
			const component = new ToolExecutionComponent("probe", {}, { showImages: true }, undefined, ui, process.cwd());
			// Context first, result later: the result's image is mounted by the rebuild that follows.
			component.setAdditionalContext("after the image");
			component.updateResult(
				{
					content: [
						{ type: "text", text: "out" },
						{
							type: "image",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
							mimeType: "image/png",
						},
					],
				},
				false,
			);

			const frame = component.render(80).join("\n");
			const image = frame.indexOf("\u001b]1337;File=");
			expect(image).toBeGreaterThan(-1);
			expect(frame.indexOf("Context: after the image")).toBeGreaterThan(image);
		} finally {
			setTerminalImageProtocol(originalProtocol);
		}
	});

	it("truncates long passive context to one line until tools are expanded, then shows all of it", () => {
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("probe", {}, {}, undefined, ui, process.cwd());
		component.updateResult(finalResult("done"), false);
		const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
		component.setAdditionalContext(words.join(" "));
		const contextText = () => {
			const lines = stripVTControlCharacters(component.render(60).join("\n")).split("\n");
			const start = lines.findIndex(line => line.includes("Context:"));
			return lines.slice(start).join(" ");
		};

		expect(contextText()).not.toContain("word39");
		component.setExpanded(true);
		expect(contextText()).toContain("word39");
		component.setExpanded(false);
		expect(contextText()).not.toContain("word39");
	});

	it("shows passive context in both native serializers after they were cached", () => {
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("probe", {}, {}, undefined, ui, process.cwd());
		component.updateResult(finalResult("done"), false);
		const toolCx: DescribeContext = {
			cols: 120,
			reduceMotion: false,
			dark: true,
			supports: kind => kind === "tool",
			feature: () => true,
		};
		// Prime the describe cache: setting context afterwards must still reach native output.
		component.describe(toolCx);
		component.describe();

		component.setAdditionalContext("native\tguidance\u001b[31m");

		const contextOf = (described: NativeNode): string[] => {
			// The context sits beside the card, so the card's collapse clamp never hides it.
			expect(described.k).toBe("col");
			const [card, ...rest] = (described.c ?? []) as NativeNode[];
			expect(JSON.stringify(card)).not.toContain("Context:");
			expect(rest.map(n => n.p?.role)).toEqual(["omp.tool.context"]);
			return rest.map(n => (n.k === "text" ? (n.p?.spans ?? []).map(s => s.t).join("") : ""));
		};
		for (const described of [component.describe(toolCx), component.describe()]) {
			expect(contextOf(described)).toEqual(["↳ Context: native guidance"]);
		}

		component.setAdditionalContext("updated guidance");
		for (const described of [component.describe(toolCx), component.describe()]) {
			expect(contextOf(described)).toEqual(["↳ Context: updated guidance"]);
		}

		// Collapsed: one clamped line, the full text as its tooltip. Expanded: wrapped, no clamp.
		expect(component.describe().c?.[1]).toMatchObject({ p: { lines: 1, title: "↳ Context: updated guidance" } });
		component.setExpanded(true);
		const expanded = component.describe().c?.[1] as NativeNode;
		expect(expanded.p).toMatchObject({ wrap: "word" });
		expect(expanded.p).not.toHaveProperty("lines");
	});
	// Regression: freezing a backgrounded task (seal()) flips #backgroundTaskFrozen,
	// which the render context consumes (context.frozen) — so it must be in the memo
	// key. The bug: the key omitted it, so once the display was built seal()'s
	// #updateDisplay() early-returned and the row stayed styled as live progress.
});
