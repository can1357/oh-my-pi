import { describe, expect, test } from "bun:test";
import { findHelpRecommendations, renderHelp } from "@pk-nerdsaver-ai/pi-coding-agent/help/recommendations";

describe("built-in help recommendations", () => {
	test("matches a session-sharing question to collab and its documentation", () => {
		const [match] = findHelpRecommendations("How do I share this session with a teammate?");

		expect(match?.id).toBe("collab");
		expect(match?.command).toContain("/collab");
		expect(match?.docs).toBe("docs/collab.md");
		expect(match?.whenToUse).toMatch(/share|watch|remote/i);
	});

	test("renders the matching command, when-to-use guidance, and docs path", () => {
		const output = renderHelp("I want the agent to make a plan before changing files");

		expect(output).toContain("/plan");
		expect(output).toMatch(/when to use/i);
		expect(output).toContain("docs/session-tree-plan.md");
	});

	test("does not invent a feature for an unrelated question", () => {
		const output = renderHelp("What is the weather on Mars today?");

		expect(output).toContain("No close built-in feature match");
		expect(output).toContain("/help <question>");
	});

	test("shows a discoverable overview without a question", () => {
		const output = renderHelp("");

		expect(output).toContain("Built-in feature help");
		expect(output).toContain("/help <question>");
		expect(output).toContain("/mcp");
	});
});
