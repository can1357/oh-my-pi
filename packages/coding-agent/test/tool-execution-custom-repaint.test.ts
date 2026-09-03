import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, Text, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// Viewport-repaint seams of ToolExecutionComponent, driven through the public
// ToolRenderer flags (`forceFirstResultViewportRepaint`,
// `forceResultViewportRepaintOnSettle`). The removed ssh tool was the last
// built-in exercising them; custom/extension tool renderers remain consumers
// of the contract, so a synthetic tool stands in.

function toolResult(text: string) {
	return { content: [{ type: "text", text }] };
}

// The repaint flag stays armed for any streamed-args shape (raw JSON buffer
// present), while the visible label upgrades to parsed chrome as soon as a
// concrete field lands — mirroring how the removed ssh renderer behaved.
function hasStreamedArgs(args: unknown): boolean {
	return !!args && typeof args === "object" && "__partialJson" in args;
}

function isPlaceholderArgs(args: unknown): boolean {
	return hasStreamedArgs(args) && !(args && typeof args === "object" && "host" in args);
}

/** Synthetic renderer-bearing tool; cast is the test seam for the renderer contract. */
function makeFakeTool(): AgentTool {
	const tool = {
		name: "fake_device",
		label: "Fake",
		renderCall: (args: unknown) => new Text(isPlaceholderArgs(args) ? "FAKE: […]" : "FAKE: [router]", 0, 0),
		renderResult: (result: { content: Array<{ type: string; text?: string }> }, options: { isPartial: boolean }) => {
			const text = result.content[0]?.text ?? "";
			return new Text(options.isPartial ? `provisional ${text}` : `Output ${text}`, 0, 0);
		},
		forceFirstResultViewportRepaint: (args: unknown) => hasStreamedArgs(args),
		forceResultViewportRepaintOnSettle: true,
	};
	return tool as unknown as AgentTool;
}

class Footer implements Component {
	constructor(readonly rows: number) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.rows }, (_, i) => `editor-${i}`);
	}
}

function plainBuffer(term: VirtualTerminal): string[] {
	return term
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(Boolean);
}

async function drain(scheduler: StressRenderScheduler, term: VirtualTerminal): Promise<void> {
	await scheduler.drain(term);
}

describe("ToolExecutionComponent custom-renderer repaint seams", () => {
	const components: ToolExecutionComponent[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		for (const component of components) component.stopAnimation();
		components.length = 0;
		vi.restoreAllMocks();
	});

	function makeComponent(args: unknown) {
		const requestRender = vi.fn();
		const ui = { requestRender, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("fake_device", args, {}, makeFakeTool(), ui);
		components.push(component);
		requestRender.mockClear();
		return { component, requestRender };
	}

	it("forces a viewport repaint when a painted streamed placeholder receives its first result", () => {
		const { component, requestRender } = makeComponent({ __partialJson: '{"host"' });
		// A paint has to land for the placeholder to actually reach the terminal.
		component.render(80);

		component.updateResult(toolResult("partial output"), true);

		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the streamed placeholder never reaches the terminal", () => {
		const { component, requestRender } = makeComponent({ __partialJson: '{"host"' });
		// The placeholder shape was built in memory but never painted — a
		// requestRender here would wipe scrollback for a shape the user never saw.

		component.updateResult(toolResult("partial output"), true);

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("does not repaint complete args on the first result", () => {
		const { component, requestRender } = makeComponent({ host: "router", command: "uptime" });
		component.render(80);

		component.updateResult(toolResult("partial output"), true);

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("forces a viewport repaint when a painted provisional partial result settles", () => {
		const { component, requestRender } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(toolResult("partial output"), true);
		component.render(80);
		requestRender.mockClear();

		component.updateResult(toolResult("final output"), false);

		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the provisional partial result never reaches the terminal", () => {
		const { component, requestRender } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(toolResult("partial output"), true);
		// No render() between the partial and the final update — the provisional
		// frame never reached the terminal, so no reset should fire.

		component.updateResult(toolResult("final output"), false);

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("removes streamed placeholder rows from the terminal buffer when the first result arrives", async () => {
		const term = new VirtualTerminal(90, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = new ToolExecutionComponent(
			"fake_device",
			{ __partialJson: '{"host"' },
			{},
			makeFakeTool(),
			tui,
		);
		components.push(component);
		tui.addChild(component);
		tui.addChild(new Footer(5));

		try {
			tui.start();
			await drain(scheduler, term);
			expect(plainBuffer(term).some(row => row.includes("FAKE: […]"))).toBe(true);

			component.updateArgs({
				host: "router",
				command: "uptime",
				__partialJson: '{"host":"router","command":"uptime"}',
			});
			component.setArgsComplete();
			tui.requestRender();
			await drain(scheduler, term);

			component.updateResult(toolResult("partial output"), true);
			tui.requestRender();
			await drain(scheduler, term);

			const rows = plainBuffer(term);
			expect(rows.some(row => row.includes("FAKE: […]"))).toBe(false);
			expect(rows.some(row => row.includes("FAKE: [router]"))).toBe(true);
			expect(rows.some(row => row.includes("provisional partial output"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("removes provisional partial chrome from the terminal buffer when the result settles", async () => {
		const term = new VirtualTerminal(90, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = new ToolExecutionComponent(
			"fake_device",
			{ host: "router", command: "uptime" },
			{},
			makeFakeTool(),
			tui,
		);
		components.push(component);
		tui.addChild(component);
		tui.addChild(new Footer(5));

		try {
			tui.start();
			await drain(scheduler, term);
			component.updateResult(toolResult("partial output"), true);
			tui.requestRender();
			await drain(scheduler, term);
			const partialRows = plainBuffer(term);
			expect(partialRows.some(row => row.includes("FAKE: [router]"))).toBe(true);
			expect(partialRows.some(row => row.includes("provisional partial output"))).toBe(true);

			component.updateResult(toolResult("final output"), false);
			tui.requestRender();
			await drain(scheduler, term);

			const rows = plainBuffer(term);
			expect(rows.some(row => row.includes("provisional partial output"))).toBe(false);
			expect(rows.filter(row => row.includes("FAKE: [router]"))).toHaveLength(1);
			expect(rows.some(row => row.includes("Output final output"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});
