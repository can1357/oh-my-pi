import { expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function sessionWithoutEval(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getToolByName: () => undefined,
	};
}

// The selector used to stay in the topic name: `Unknown topic 'browser:2-3:raw' for eval`.
it("reads a line range of a help:// doc topic", async () => {
	const evalTool = { docTopics: () => ({ browser: "alpha\nbravo\ncharlie\ndelta" }) } as unknown as Tool;
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getToolByName: name => (name === "eval" ? evalTool : undefined),
	};
	const result = await new ReadTool(session).execute("ranged", { path: "help://eval/browser:2-3:raw" });
	const text = result.content.map(entry => (entry.type === "text" ? entry.text : "")).join("\n");
	expect(text).toContain("bravo\ncharlie");
	expect(text).not.toContain("alpha");
	expect(text).not.toContain("delta");
});

// A reviewer subagent without eval still reads the eval docs its assignment links.
it("reads an eval doc topic in a session without the eval tool", async () => {
	const result = await new ReadTool(sessionWithoutEval()).execute("no-eval", { path: "help://eval/helpers" });
	const text = result.content.map(entry => (entry.type === "text" ? entry.text : "")).join("\n");
	expect(text).not.toContain("no doc topics");
	expect(result.isError).not.toBe(true);
	expect(text.length).toBeGreaterThan(200);
});

it("fails an unknown eval doc topic with the available topic names", async () => {
	await expect(new ReadTool(sessionWithoutEval()).execute("unknown", { path: "help://eval/nope" })).rejects.toThrow(
		/helpers/,
	);
});

it("lists a tool's doc topics", async () => {
	const result = await new ReadTool(sessionWithoutEval()).execute("list", { path: "help://eval" });
	const text = result.content.map(entry => (entry.type === "text" ? entry.text : "")).join("\n");
	expect(text).toContain("help://eval/helpers");
});
