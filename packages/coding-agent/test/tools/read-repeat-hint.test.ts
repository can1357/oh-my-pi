import { expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

// #17631: the hint advised `path:A-B` on xd:// topics, whose scheme passes the tail into the topic name.
it("does not suggest a line selector on a repeated selector-free xd:// read", async () => {
	const evalTool = { docTopics: () => ({ browser: "line 1\nline 2" }) } as unknown as Tool;
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getToolByName: name => (name === "eval" ? evalTool : undefined),
	};
	const tool = new ReadTool(session);
	await tool.execute("first", { path: "xd://eval/browser" });
	await tool.execute("second", { path: "xd://eval/browser" });
	const result = await tool.execute("third", { path: "xd://eval/browser" });
	const text = result.content.map(entry => (entry.type === "text" ? entry.text : "")).join("\n");
	expect(text).toContain("identical output 3 times");
	expect(text).not.toContain("path:A-B");
});
