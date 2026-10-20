import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

function writeArgs(lineCount: number) {
	return {
		path: "notes.txt",
		content: Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n"),
	};
}

function partialWriteResult(text = "Writing notes.txt...") {
	return { content: [{ type: "text", text }] };
}

describe("ToolExecutionComponent write repaint seam", () => {
	const components: ToolExecutionComponent[] = [];
	/**
	 * The write repaint threshold is the collapsed streaming window budget,
	 * which is sized from the live viewport. Pin it so the thresholds below do
	 * not follow the test runner's terminal.
	 */
	const VIEWPORT_ROWS = 32;
	const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: VIEWPORT_ROWS });
	});

	afterEach(() => {
		for (const component of components) component.stopAnimation();
		components.length = 0;
		vi.restoreAllMocks();
		if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
		else Reflect.deleteProperty(process.stdout, "rows");
	});

	function makeComponent(args: unknown) {
		const requestRender = vi.fn();
		const ui = { requestRender, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("write", args, {}, undefined, ui);
		components.push(component);
		requestRender.mockClear();
		return { component, requestRender };
	}

	it("forces a viewport repaint when a painted collapsed tail window receives its first result", () => {
		// 20 lines > WRITE_STREAMING_PREVIEW_LINES (12): the pending preview is a
		// tail window the first-result render re-anchors to the top of the file.
		const { component, requestRender } = makeComponent(writeArgs(20));
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the pending tail window never reaches the terminal", () => {
		const { component, requestRender } = makeComponent(writeArgs(20));
		// No render() before the result: no repaint for a shape the user never saw.

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("does not repaint a collapsed preview that fits the streaming window", () => {
		// 12 lines render top-anchored without a tail window, so the first result
		// does not re-anchor the frame; wiping scrollback would be gratuitous.
		const { component, requestRender } = makeComponent(writeArgs(12));
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("does not repaint an expanded pending preview", () => {
		// Expanded previews show the whole file top-anchored — no tail window to
		// re-anchor.
		const { component, requestRender } = makeComponent(writeArgs(20));
		component.setExpanded(true);
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("does not repaint a write that never renders the filesystem tail window", () => {
		// A URL card (`agent://`) draws a head preview and an `xd://` device
		// write delegates to the mounted tool's own renderer: neither is the
		// filesystem tail window that the first result re-anchors, so neither
		// may wipe the scrollback — however long their payload is.
		const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		for (const path of ["agent://all", "xd://alpha"]) {
			const { component, requestRender } = makeComponent({ path, content });
			component.render(80);

			component.updateResult(partialWriteResult(), true);

			expect(requestRender).not.toHaveBeenCalled();
		}
	});

	it("does not repaint a call that has no path to preview", () => {
		// A streamed or malformed call can expose its content while the path is
		// still missing: the renderer draws nothing at its missing-path guard,
		// so no preview reached the terminal and no repaint is owed.
		const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		const { component, requestRender } = makeComponent({ content });
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("repaints a delegated xd://write whose payload renders the filesystem tail window", () => {
		// The write transport accepts the active top-level tools, so `xd://write`
		// delegates back to the write renderer: it paints the same tail window,
		// and its first result re-anchors that frame to the head of the file.
		const payload = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		const { component, requestRender } = makeComponent({
			path: "xd://write",
			content: JSON.stringify({ path: "notes.txt", content: payload }),
		});
		// The delegated card stays queued until the dispatch starts executing.
		component.setExecutionStarted();
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the transcript squeezes the pending card to its compact row", () => {
		// The transcript measures every block with an unlimited allocation, so
		// the pending tail window arms the repaint flag even when the block is
		// later squeezed to its compact row. The compact row is the shape that
		// reaches the terminal, and it carries no tail window to re-anchor.
		const { component, requestRender } = makeComponent(writeArgs(20));
		component.render(80);
		component.setTranscriptAllocation(2, { tick: 0, now: 0 });
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).not.toHaveBeenCalled();
	});
});
