import { expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

// The selector used to stay in the topic name: `Unknown topic 'browser:2-3:raw' for eval`.
it("reads a line range of an xd:// doc topic", async () => {
	const evalTool = { docTopics: () => ({ browser: "alpha\nbravo\ncharlie\ndelta" }) } as unknown as Tool;
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getToolByName: name => (name === "eval" ? evalTool : undefined),
	};
	const result = await new ReadTool(session).execute("ranged", { path: "xd://eval/browser:2-3:raw" });
	const text = result.content.map(entry => (entry.type === "text" ? entry.text : "")).join("\n");
	expect(text).toContain("bravo\ncharlie");
	expect(text).not.toContain("alpha");
	expect(text).not.toContain("delta");
});

// Write approval resolves the device from the unpeeled URL; peeling `:raw` would dispatch
// `ast_edit` under the generic write policy instead of `tools.approval.ast_edit`.
it("refuses a selector on an xd:// write target instead of peeling it", () => {
	expect(() => InternalUrlRouter.instance().peelWriteSelector("xd://ast_edit:raw", "write")).toThrow(
		/does not accept the trailing selector ":raw"/,
	);
});
