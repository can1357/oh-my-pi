import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Text, type TUI } from "@oh-my-pi/pi-tui";

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
	// Regression: freezing a backgrounded task (seal()) flips #backgroundTaskFrozen,
	// which the render context consumes (context.frozen) — so it must be in the memo
	// key. The bug: the key omitted it, so once the display was built seal()'s
	// #updateDisplay() early-returned and the row stayed styled as live progress.
});
