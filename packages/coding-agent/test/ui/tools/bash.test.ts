import { expect, test } from "bun:test";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { type BashArgs, bashPresenter, shellPresenter } from "../../../src/ui/tools/bash";
import { ToolCall } from "../../../src/ui/transcript/tool-block";
import { plainToolRows, type ToolScreen, toolScreenSuite } from "./screens";

export const bashScreen: ToolScreen = {
	dir: "tools/bash",
	name: "bash",
	presenter: bashPresenter,
};

/** The corpus drove a shell renderer titled "Shell" whose command is `args.cmd`. */
export const shellScreen: ToolScreen = {
	dir: "tools/shell",
	name: "shell",
	presenter: shellPresenter<{ cmd?: string }>({
		title: () => "Shell",
		command: args => args?.cmd,
		header: true,
	}),
};

toolScreenSuite(bashScreen);
toolScreenSuite(shellScreen);

test("service results paint the preset's compact PID marker in the footer", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "nerd" }));
	const call = new ToolCall({
		id: "bash-1",
		name: "bash",
		presenter: bashPresenter,
		args: { name: "web", command: "echo ready" },
	});
	call.setExecutionStarted();
	call.updateResult(
		{
			content: [{ type: "text", text: "listening" }],
			details: { service: { name: "web", state: "ready", ready: true, timedOut: false, pid: 51234 } },
		},
		false,
	);
	expect(plainToolRows(call, env).findLast(Boolean)).toContain("51234");
});

test.each(["local://7.log", "local://7.log:raw"])("moves a persisted %s spill notice into the footer", url => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "nerd" }));
	const call = new ToolCall({ id: "bash-1", name: "bash", presenter: bashPresenter, args: { command: "ls" } });
	call.updateResult({ content: [{ type: "text", text: `output\n[raw output: ${url}]` }] }, false);
	const rows = plainToolRows(call, env);
	expect(rows.join("\n")).not.toContain("[raw output:");
	expect(rows.findLast(Boolean)).toContain("local://7.log");
});

// The edit tags end the model-facing text after the raw-output notice; left in, they hide that notice from the
// footer fold (losing the raw-output link) and fill the preview with tag lines.
test("strips edit tags so the raw output notice still folds into the footer", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "nerd" }));
	const tag = "[src/a.ts#AB12] lines 1-2";
	const call = new ToolCall({
		id: "bash-1",
		name: "bash",
		presenter: bashPresenter,
		args: { command: "grep -rn x src" },
	});
	call.updateResult(
		{
			content: [{ type: "text", text: `a.ts:1:x\na.ts:2:y\n[raw output: local://13.log]\n\n${tag}` }],
			details: { timeoutSeconds: 300, editTags: [tag] },
		},
		false,
	);
	const rows = plainToolRows(call, env);
	const rendered = rows.join("\n");
	expect(rendered).toContain("a.ts:2:y");
	expect(rendered).not.toContain("[src/a.ts#AB12]");
	expect(rendered).not.toContain("[raw output:");
	expect(rows.findLast(Boolean)).toContain("local://13.log");
});

export type { BashArgs };
