import { describe, expect, test } from "bun:test";
import {
	classifyError,
	parseArgs,
	readLikeShellCommand,
	splitIdList,
	toolSmokePrompt,
	writeLikeShellCommand,
} from "./grokbot-catalog-matrix/harness";
import toolsFollowupSystemPrompt from "./grokbot-catalog-matrix/tools-followup-system.md" with { type: "text" };
import toolsSystemPrompt from "./grokbot-catalog-matrix/tools-system.md" with { type: "text" };

describe("splitIdList", () => {
	test("keeps commas inside bracket params as one id", () => {
		// Naive .split(",") would yield two tokens and drop this catalog id.
		expect(splitIdList("gpt-5.3-codex[reasoning=medium,fast=false]")).toEqual([
			"gpt-5.3-codex[reasoning=medium,fast=false]",
		]);
	});

	test("still splits sibling ids outside brackets", () => {
		expect(splitIdList("claude-opus-5-thinking-max,gpt-5.3-codex[reasoning=medium,fast=false]")).toEqual([
			"claude-opus-5-thinking-max",
			"gpt-5.3-codex[reasoning=medium,fast=false]",
		]);
	});

	test("trims empty slots", () => {
		expect(splitIdList(" a , , b[x=1,y=2] , ")).toEqual(["a", "b[x=1,y=2]"]);
	});
});

describe("parseArgs --ids", () => {
	test("selects exactly one bracketed gpt-5.3-codex id", () => {
		const args = parseArgs(["--ids", "gpt-5.3-codex[reasoning=medium,fast=false]"]);
		expect(args.ids).toEqual(["gpt-5.3-codex[reasoning=medium,fast=false]"]);
	});
});

describe("toolSmokePrompt", () => {
	test("uses bland product-tool wording and relative paths", () => {
		const read = toolSmokePrompt("read", "tools-pong-read-x", "claude-opus-5-thinking-max");
		const write = toolSmokePrompt("write", "tools-pong-write-x", "claude-opus-5-thinking-max");
		const bash = toolSmokePrompt("bash", "tools-pong-bash-x", "claude-opus-5-thinking-max");
		// Aggressive "coding agent" / absolute /tmp / "Call the tool now" probes
		// were blocked under Anthropic Usage Policy on opus-thinking keep-model.
		for (const text of [read, write, bash]) {
			expect(text).not.toMatch(/coding agent/i);
			expect(text).not.toMatch(/call the tool now/i);
			expect(text).not.toContain("/tmp/");
			expect(text).not.toMatch(/Usage Policy/);
		}
		expect(read).toContain("Shell");
		expect(read).toContain("cat notes/");
		expect(write).toContain("Shell");
		expect(write).toContain("printf");
		expect(write).toContain("tools-pong-write-x");
		expect(write).toMatch(/>\s*notes\//);
		expect(bash).toContain("Shell");
		expect(bash).toContain("echo tools-pong-bash-x");
	});

	test("counts Shell printf-redirect as write and cat as read", () => {
		// Write tool name still policy-blocks opus-thinking; the smoke asks for
		// this command and isWriteLikeCall must accept it or the id FAILs.
		expect(writeLikeShellCommand("printf '%s\\n' tools-pong-write-x > notes/x.txt")).toBe(true);
		expect(writeLikeShellCommand("echo TOKEN > notes/x.txt")).toBe(true);
		expect(readLikeShellCommand("cat notes/x.txt")).toBe(true);
		expect(readLikeShellCommand("printf '%s\\n' x > notes/x.txt")).toBe(false);
	});

	test("tool-turn system prompts stay bland", () => {
		for (const text of [toolsSystemPrompt, toolsFollowupSystemPrompt]) {
			expect(text).not.toMatch(/coding agent/i);
			expect(text).not.toMatch(/call the tool now/i);
		}
	});
});

describe("classifyError", () => {
	test("classifies Anthropic Usage Policy as provider-policy-block even on HTTP 400", () => {
		const message =
			"ERROR_OPENAI: Request blocked by Anthropic: this request was blocked under Anthropic's Usage Policy";
		expect(classifyError(message, 400)).toBe("provider-policy-block");
		expect(classifyError(message)).toBe("provider-policy-block");
	});

	test("leaves ordinary provider 400s as http-400", () => {
		expect(classifyError("ERROR_PROVIDER_ERROR: invalid tools", 400)).toBe("http-400");
		expect(classifyError("HTTP 400 bad request")).toBe("http-400");
	});
});
