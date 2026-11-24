/** A bash run's presented output as Tern is sent it: what the command printed, its closing newline included. */
import { expect, test } from "bun:test";
import { createRoot, isUiNode, type UiNode } from "@oh-my-pi/pi-tui";
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
