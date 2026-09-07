import { describe, expect, test } from "bun:test";
import {
	classifyError,
	expectedReadPath,
	expectedWritePath,
	idSafe,
	isSoftPassToolFollowup,
	matchesToolSmokeCall,
	matrixRowFlag,
	parseArgs,
	readLikeShellCommand,
	resolveExplicitMatrixIds,
	splitMatrixIds,
	toolSmokePrompt,
	writeLikeShellCommand,
} from "./grokbot-catalog-matrix/harness";

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

describe("resolveExplicitMatrixIds", () => {
	test("rejects missing catalog ids instead of silently dropping them", () => {
		const live = new Set(["sand-default", "grok-4.6"]);
		expect(resolveExplicitMatrixIds(["sand-default", "typo-model"], live)).toEqual({
			missing: ["typo-model"],
		});
		expect(resolveExplicitMatrixIds(["sand-default", "grok-4.6"], live)).toEqual({
			selected: ["sand-default", "grok-4.6"],
		});
	});
});

describe("matrixRowFlag", () => {
	test("text failures on tool-gated rows still count as FAIL", () => {
		expect(
			matrixRowFlag({ skip: "catalog supports-tools=false", textPass: false, toolsPass: undefined }, "all"),
		).toBe("FAIL");
		expect(matrixRowFlag({ skip: "catalog supports-tools=false", textPass: true, toolsPass: undefined }, "all")).toBe(
			"SKIP",
		);
	});
});

describe("toolSmokePrompt", () => {
	test("embeds the smoke token and expected paths", () => {
		const safe = "claude-opus-5-thinking-max";
		const read = toolSmokePrompt("read", "tools-pong-read-x", safe);
		const write = toolSmokePrompt("write", "tools-pong-write-x", safe);
		const bash = toolSmokePrompt("bash", "tools-pong-bash-x", safe);
		expect(bash).toContain("tools-pong-bash-x");
		expect(read).toContain(expectedReadPath(safe));
		expect(write).toContain("tools-pong-write-x");
		expect(write).toContain(expectedWritePath(safe));
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

	test("rejects tool calls that only match by name", () => {
		const id = "claude-opus-5-thinking-max";
		const ping = "tools-pong-write-x";
		expect(
			matchesToolSmokeCall(
				"write",
				{ name: "Write", arguments: { path: "notes/wrong.txt", content: ping } },
				ping,
				id,
			),
		).toBe(false);
		expect(
			matchesToolSmokeCall(
				"write",
				{
					name: "Shell",
					arguments: { command: `printf '%s\\n' ${ping} > ${expectedWritePath(idSafe(id))}` },
				},
				ping,
				id,
			),
		).toBe(true);
		expect(matchesToolSmokeCall("bash", { name: "Shell", arguments: { command: "echo unrelated" } }, ping, id)).toBe(
			false,
		);
		expect(matchesToolSmokeCall("bash", { name: "Shell", arguments: { command: `echo ${ping}` } }, ping, id)).toBe(
			true,
		);
		expect(
			matchesToolSmokeCall(
				"read",
				{ name: "Shell", arguments: { command: `cat ${expectedReadPath(idSafe(id))}` } },
				"tools-pong-read-x",
				id,
			),
		).toBe(true);
		expect(
			matchesToolSmokeCall(
				"read",
				{ name: "Shell", arguments: { command: "cat notes/other.txt" } },
				"tools-pong-read-x",
				id,
			),
		).toBe(false);
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
