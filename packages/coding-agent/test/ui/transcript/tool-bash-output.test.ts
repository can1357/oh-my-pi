/** A shell run's output as presented to native and fullscreen terminal readers. */
import { expect, test } from "bun:test";
import { createRoot, isUiNode, jsx, type UiNode } from "@oh-my-pi/pi-tui";
import { FullscreenTranscript } from "@oh-my-pi/pi-tui/term/fullscreen";
import { createOwnedPaint, paintForMeasurement, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { Transcript } from "../../../src/ui/shell/transcript";
import "../../../src/ui/styles/tools";
import { bashPresenter } from "../../../src/ui/tools/bash";
import { ToolBlock, ToolCall } from "../../../src/ui/transcript/tool-block";

test("the shell presentation carries the run's output verbatim", () => {
	createRoot(dispose => {
		try {
			const call = new ToolCall({
				id: "call1",
				name: "bash",
				args: { command: "printf 'alpha\\nbeta\\n'" },
				presenter: bashPresenter,
			});
			call.setArgsComplete();
			call.setExecutionStarted();
			call.updateResult({ content: [{ type: "text", text: "alpha\nbeta\n" }] }, false);
			const tree = ToolBlock({ call });
			if (!isUiNode(tree)) throw new Error("ToolBlock must build one node");
			const find = (at: UiNode): UiNode | undefined =>
				at.kind === "shell"
					? at
					: at
							.children()
							.map(find)
							.find(found => found !== undefined);
			const shell = find(tree);
			if (!shell) throw new Error("the bash card must hold a shell node");
			expect((shell.props() as { presentation?: { output?: string } }).presentation?.output).toBe("alpha\nbeta\n");
		} finally {
			dispose();
		}
	});
});

test("a detached reader sees new output when a capped Bash tail advances, not when it shrinks or its clock ticks", () => {
	createRoot(dispose => {
		const blocks = new Transcript();
		const theme = loadThemeSync("dark");
		const env = staticEnvironment(theme, { now: 0 });
		const view = new FullscreenTranscript({
			theme: () => theme,
			active: () => true,
			cellHeight: () => 16,
			requestRender: () => {},
			paint: (node, width) => createOwnedPaint(node, width, env),
			measure: (node, width) => paintForMeasurement(node, width, env),
			separator: blocks.separator,
		});
		const draw = (): readonly string[] => {
			const { rows } = view.compose(blocks.nodes(), 48, 5, 5, false);
			view.publish();
			return rows.map(row => Bun.stripANSI(row).trim());
		};
		try {
			const call = new ToolCall({
				id: "tail-preview",
				name: "bash",
				args: { command: "echo output" },
				presenter: bashPresenter,
				now: () => 0,
			});
			const output = (lines: readonly string[]) =>
				call.updateResult({ content: [{ type: "text", text: lines.join("\n") }] }, true);
			const lines = Array<string>(16).fill("repeat");
			lines[4] = "repeater"; // hidden until the tail rolls backwards
			call.setArgsComplete();
			call.setExecutionStarted();
			output(lines.slice(0, -1));
			blocks.append(() => jsx("rows", { lines: ["reading", "one", "two", "three"] }));
			blocks.append(() => ToolBlock({ call }));
			expect(draw().some(row => row.includes("repeat"))).toBe(true);
			const total = view.scroller.state().totalRows;
			expect(view.scroller.toTop()).toBe(true);
			expect(draw()[0]).toStartWith("reading");
			env.setNow(2_000);
			expect(draw().at(-1)).toBe("");
			const colored = lines.map(line => `\x1b[31m${line}\x1b[0m`);
			colored[0] = "rewritten ".repeat(8); // rewrapping a hidden line doesn't advance the source end
			output(colored.slice(0, -1));
			expect(draw().at(-1)).toBe("");

			output(colored); // all ten visible rows still read "repeat"
			expect(draw().at(-1)).toBe("New output below");
			expect(view.scroller.state()).toMatchObject({ offset: 0, following: false, unseen: true, totalRows: total });

			expect(view.scroller.toBottom()).toBe(true);
			draw();
			expect(view.scroller.toTop()).toBe(true);
			draw();
			output(colored.slice(0, -2)); // the older "repeater" replaces "repeat", not an append
			expect(draw().at(-1)).toBe("");
			expect(view.scroller.state()).toMatchObject({ following: false, unseen: false, totalRows: total });
		} finally {
			view.stop();
			blocks.clear();
			dispose();
		}
	});
});
