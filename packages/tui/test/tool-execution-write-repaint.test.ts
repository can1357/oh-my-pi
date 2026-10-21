import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { XdevMountedRenderer } from "@oh-my-pi/pi-tui/tools/xdev";

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

	function makeComponent(args: unknown, tool?: ConstructorParameters<typeof ToolExecutionComponent>[3]) {
		const requestRender = vi.fn();
		const ui = { requestRender, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("write", args, {}, tool, ui);
		components.push(component);
		requestRender.mockClear();
		return { component, requestRender };
	}

	/**
	 * A mounted device that is not the write renderer: the dispatch paints the
	 * device's own card, so the write renderer must not arm the repaint for it.
	 */
	function mountedDevice(label: string): XdevMountedRenderer {
		return {
			label,
			renderCall: () => new Text(`${label} device card`, 0, 0),
		};
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

	it("does not repaint a URL card write, whatever its payload length", () => {
		// A URL card (`agent://`) draws a head preview: it is never the
		// filesystem tail window that the first result re-anchors, so it must
		// not wipe the scrollback — however long its payload is.
		const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		const { component, requestRender } = makeComponent({ path: "agent://all", content });
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("does not repaint a delegated xd://write that resolves to a non-write device", () => {
		// The dispatch paints the device's own card, so the write renderer must
		// not arm the scrollback-wiping repaint for it. The dispatch has to be
		// running for the delegation to happen at all: a queued card paints no
		// preview, and the predicate stops at that guard — so this case starts
		// the dispatch and resolves the device to a real non-write renderer.
		const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		const device = mountedDevice("alpha");
		const { component, requestRender } = makeComponent({ path: "xd://alpha", content }, {
			session: {
				xdev: { resolve: (name: string) => (name === "alpha" ? device : undefined) },
			},
		} as unknown as ConstructorParameters<typeof ToolExecutionComponent>[3]);
		component.setExecutionStarted();
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).not.toHaveBeenCalled();
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

	it("repaints a deeply nested xd://write whose payload renders the filesystem tail window", () => {
		// The dispatch keeps delegating as deep as the payload nests: five
		// nested `xd://write` payloads before the final filesystem write. The
		// predicate has to follow the whole chain — a cap of its own would
		// decide "no tail window" for a card the renderer does paint, and the
		// stale tail rows would survive the first result.
		const payload = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		let inner = JSON.stringify({ path: "notes.txt", content: payload });
		for (let depth = 0; depth < 5; depth++) {
			inner = JSON.stringify({ path: "xd://write", content: inner });
		}
		const { component, requestRender } = makeComponent({ path: "xd://write", content: inner });
		component.setExecutionStarted();
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("does not repaint a pending card that was only measured, never shown", () => {
		// The transcript measures a block before it decides whether to show it:
		// a block it then omits never reaches the terminal, so its first result
		// must not replay the viewport for a shape the user never saw.
		const { component, requestRender } = makeComponent(writeArgs(20));
		component.setTranscriptAllocation(Number.MAX_SAFE_INTEGER, { tick: 0, now: 0 }, true);
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("does not repaint when the tool activity was hidden before the first result", () => {
		// The tail window is painted, then the user hides the tool activity: the
		// component renders its empty path, so the tail window is no longer on
		// the terminal and the first result must not replay the viewport for it.
		const { component, requestRender } = makeComponent(writeArgs(20));
		component.render(80);
		component.setToolActivityVisible(false);
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).not.toHaveBeenCalled();
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
