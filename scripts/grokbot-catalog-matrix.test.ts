import { describe, expect, test } from "bun:test";
import {
	classifyError,
	isSoftPassToolFollowup,
	parseArgs,
	readLikeShellCommand,
	splitMatrixIds,
	toolSmokePrompt,
	writeLikeShellCommand,
} from "./grokbot-catalog-matrix/harness";
import toolsFollowupSystemPrompt from "./grokbot-catalog-matrix/tools-followup-system.md" with { type: "text" };
import toolsSystemPrompt from "./grokbot-catalog-matrix/tools-system.md" with { type: "text" };

describe("splitMatrixIds", () => {
	test("keeps commas inside bracket params as one id", () => {
		// Naive .split(",") would yield two tokens and drop this catalog id.
		expect(splitMatrixIds("gpt-5.3-codex[reasoning=medium,fast=false]")).toEqual([
			"gpt-5.3-codex[reasoning=medium,fast=false]",
		]);
	});

	test("still splits sibling ids outside brackets", () => {
		expect(splitMatrixIds("claude-opus-5-thinking-max,gpt-5.3-codex[reasoning=medium,fast=false]")).toEqual([
			"claude-opus-5-thinking-max",
			"gpt-5.3-codex[reasoning=medium,fast=false]",
		]);
	});

	test("trims empty slots", () => {
		expect(splitMatrixIds(" a , , b[x=1,y=2] , ")).toEqual(["a", "b[x=1,y=2]"]);
	});
});

describe("parseArgs --ids", () => {
	test("selects exactly one bracketed gpt-5.3-codex id", () => {
		const args = parseArgs(["--ids", "gpt-5.3-codex[reasoning=medium,fast=false]"]);
		expect(args.ids).toEqual(["gpt-5.3-codex[reasoning=medium,fast=false]"]);
	});
});

describe("toolSmokePrompt", () => {
	test("uses live-verified Shell probes", () => {
		const safe = "claude-opus-5-thinking-max";
		const read = toolSmokePrompt("read", "tools-pong-read-x", safe);
		const write = toolSmokePrompt("write", "tools-pong-write-x", safe);
		const bash = toolSmokePrompt("bash", "tools-pong-bash-x", safe);
		expect(bash).toBe("Please use the Shell tool to run: echo tools-pong-bash-x");
		expect(read).toBe(
			"Please use the Shell tool to run exactly: cat notes/grokbot-read-claude-opus-5-thinking-max.txt",
		);
		expect(write).toBe(
			"Please use the Shell tool to run exactly: printf '%s\\n' tools-pong-write-x > notes/grokbot-write-claude-opus-5-thinking-max.txt",
		);
		for (const text of [read, write, bash]) {
			expect(text).not.toMatch(/coding agent/i);
			expect(text).not.toMatch(/\bRead\b/);
			expect(text).not.toMatch(/\bWrite\b/);
			expect(text).not.toContain("/tmp/");
		}
	});

	test("counts Shell printf-redirect as write and cat/sed as read", () => {
		expect(writeLikeShellCommand("printf '%s\\n' tools-pong-write-x > notes/grokbot-write-x.txt")).toBe(true);
		expect(readLikeShellCommand("cat notes/grokbot-read-x.txt")).toBe(true);
		expect(readLikeShellCommand("sed -n '1p' notes/grokbot-read-x.txt")).toBe(true);
		expect(readLikeShellCommand("printf '%s\\n' x > notes/grokbot-write-x.txt")).toBe(false);
	});

	test("tool-turn system prompts match the live-verified wording", () => {
		expect(toolsSystemPrompt.trim()).toBe("You are a helpful assistant. When a tool is needed, call it.");
		expect(toolsFollowupSystemPrompt.trim()).toBe("After a tool result, reply with the exact result text.");
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

	test("soft-passes tool follow-up after a successful turn-1 call", () => {
		// Anthropic often blocks the echo follow-up after a successful Shell call.
		expect(isSoftPassToolFollowup("provider-policy-block")).toBe(true);
		expect(isSoftPassToolFollowup("incomplete-tool")).toBe(true);
		expect(isSoftPassToolFollowup("empty-body")).toBe(true);
		expect(isSoftPassToolFollowup("http-400")).toBe(false);
	});
});
