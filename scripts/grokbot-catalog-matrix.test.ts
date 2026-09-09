import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import {
	classifyError,
	echoLikeShellCommand,
	expectedReadPath,
	expectedWritePath,
	evaluateToolFollowupText,
	idSafe,
	matchesToolSmokeCall,
	matrixOmpThinkingArgs,
	matrixProbeEffort,
	matrixRowFlag,
	ompToolsExecutionEvidence,
	parseArgs,
	readLikeShellCommand,
	resolveExplicitMatrixIds,
	splitMatrixIds,
	toolSmokePrompt,
	writeLikeShellCommand,
} from "./grokbot-catalog-matrix/harness";

function probeModel(partial: Partial<Model<Api>> & Pick<Model<Api>, "id">): Model<Api> {
	return {
		provider: "grokbot",
		api: "grokbot-sand",
		name: partial.id,
		baseUrl: "https://api2.cursor.sh",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
		reasoning: false,
		...partial,
	} as Model<Api>;
}

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

describe("evaluateToolFollowupText", () => {
	test("fails when the follow-up omits the unique ping outside Gemini Write empty-stop", () => {
		expect(
			evaluateToolFollowupText({
				kind: "bash",
				body: "ok, done.",
				ping: "tools-pong-bash-x",
				stopReason: "stop",
				modelId: "gemini-3-flash",
			}).pass,
		).toBe(false);
		expect(
			evaluateToolFollowupText({
				kind: "write",
				body: "",
				ping: "tools-pong-write-x",
				stopReason: "stop",
				modelId: "gemini-3-flash",
			}),
		).toEqual({ pass: true, detail: "empty-followup-after-write" });
		expect(
			evaluateToolFollowupText({
				kind: "write",
				body: "",
				ping: "tools-pong-write-x",
				stopReason: "stop",
				modelId: "grok-4.6",
			}).pass,
		).toBe(false);
		expect(
			evaluateToolFollowupText({
				kind: "bash",
				body: "tools-pong-bash-x",
				ping: "tools-pong-bash-x",
				stopReason: "stop",
				modelId: "grok-4.6",
			}).pass,
		).toBe(true);
		expect(
			evaluateToolFollowupText({
				kind: "bash",
				body: "tools-pong",
				ping: "tools-pong-bash-x",
				stopReason: "stop",
				modelId: "grok-4.6",
			}).pass,
		).toBe(false);
	});

	test("fails when the follow-up includes the ping but stops with toolUse", () => {
		expect(
			evaluateToolFollowupText({
				kind: "bash",
				body: "tools-pong-bash-x and calling another tool",
				ping: "tools-pong-bash-x",
				stopReason: "toolUse",
				modelId: "grok-4.6",
			}).pass,
		).toBe(false);
	});

	test("Gemini empty Write uses the canonical request model, not an opaque selector", () => {
		// Opaque legacy/variant display ids classify as unknown; callers must pass requestModelId.
		expect(
			evaluateToolFollowupText({
				kind: "write",
				body: "",
				ping: "tools-pong-write-x",
				stopReason: "stop",
				modelId: "opaque-legacy-gemini-selector",
			}).pass,
		).toBe(false);
		expect(
			evaluateToolFollowupText({
				kind: "write",
				body: "",
				ping: "tools-pong-write-x",
				stopReason: "stop",
				modelId: "gemini-3-flash",
			}),
		).toEqual({ pass: true, detail: "empty-followup-after-write" });
	});
});

describe("matrixProbeEffort", () => {
	test("prefers supported low, then defaultLevel, then max-only, then sand defaults; omits when unknown", () => {
		expect(
			matrixProbeEffort(
				probeModel({
					id: "with-low",
					reasoning: true,
					thinking: { efforts: [Effort.Low, Effort.High] },
				}),
			),
		).toBe(Effort.Low);
		expect(
			matrixProbeEffort(
				probeModel({
					id: "default-high",
					reasoning: true,
					thinking: { efforts: [Effort.Medium, Effort.High], defaultLevel: Effort.High },
				}),
			),
		).toBe(Effort.High);
		expect(
			matrixProbeEffort(
				probeModel({
					id: "max-only",
					reasoning: true,
					thinking: { efforts: [Effort.Max] },
				}),
			),
		).toBe(Effort.Max);
		expect(
			matrixProbeEffort(
				probeModel({
					id: "adaptive-default",
					sandParameterDefaults: { effort: "adaptive" },
				}),
			),
		).toBe("adaptive");
		expect(matrixProbeEffort(probeModel({ id: "no-effort" }))).toBeUndefined();
	});

	test("matrixOmpThinkingArgs mirrors probe effort or omits --thinking when unknown", () => {
		expect(
			matrixOmpThinkingArgs(
				probeModel({
					id: "max-only",
					reasoning: true,
					thinking: { efforts: [Effort.Max] },
				}),
			),
		).toEqual(["--thinking", Effort.Max]);
		// Sand-only defaults like adaptive are not CLI ThinkingLevel values.
		expect(
			matrixOmpThinkingArgs(
				probeModel({
					id: "adaptive-default",
					sandParameterDefaults: { effort: "adaptive" },
				}),
			),
		).toEqual([]);
		expect(matrixOmpThinkingArgs(probeModel({ id: "no-effort" }))).toEqual([]);
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
		// Quoted `>` is not a redirect — must not look like a write.
		expect(writeLikeShellCommand("echo 'tools-pong-write-x > notes/grokbot-write-x.txt'")).toBe(false);
	});

	test("requires bash smoke commands to echo/printf the ping, not comment it", () => {
		const ping = "tools-pong-bash-x";
		expect(echoLikeShellCommand(`echo ${ping}`, ping)).toBe(true);
		expect(echoLikeShellCommand(`printf '%s\\n' ${ping}`, ping)).toBe(true);
		expect(echoLikeShellCommand(`true # ${ping}`, ping)).toBe(false);
		expect(echoLikeShellCommand(`echo unrelated`, ping)).toBe(false);
		// Token in a sibling statement does not count — must be an echo/printf arg.
		expect(echoLikeShellCommand(`echo wrong; true ${ping}`, ping)).toBe(false);
		expect(echoLikeShellCommand(`echo wrong && true ${ping}`, ping)).toBe(false);
		// Redirect / diverted stdout / pipelines must not count as echoed output.
		expect(echoLikeShellCommand(`echo wrong > ${ping}`, ping)).toBe(false);
		expect(echoLikeShellCommand(`echo ${ping} >/dev/null`, ping)).toBe(false);
		expect(echoLikeShellCommand(`printf '%s\\n' ${ping} > /tmp/out.txt`, ping)).toBe(false);
		expect(echoLikeShellCommand(`echo ${ping} | tee /tmp/out.txt`, ping)).toBe(false);
		expect(echoLikeShellCommand(`echo ${ping} | grep -v ${ping}`, ping)).toBe(false);
		expect(echoLikeShellCommand(`echo ${ping} | cat`, ping)).toBe(false);
		// Conditional arms after `&&` / `||` are unreachable for fabricated results.
		expect(echoLikeShellCommand(`false && echo ${ping}`, ping)).toBe(false);
		expect(echoLikeShellCommand(`true || echo ${ping}`, ping)).toBe(false);
		// Earlier exit/return stops the shell before a later echo can run.
		expect(echoLikeShellCommand(`exit 0; echo ${ping}`, ping)).toBe(false);
		expect(echoLikeShellCommand(`return; echo ${ping}`, ping)).toBe(false);
	});

	test("binds read/write shell smoke evidence to the operation statement", () => {
		const id = "claude-opus-5";
		const readPath = expectedReadPath(idSafe(id));
		const writePath = expectedWritePath(idSafe(id));
		const ping = "tools-pong-write-x";
		expect(
			matchesToolSmokeCall(
				"read",
				{ name: "Shell", arguments: { command: `cat /dev/null; echo ${readPath}` } },
				"tools-pong-read-x",
				id,
			),
		).toBe(false);
		expect(
			matchesToolSmokeCall(
				"read",
				{ name: "Shell", arguments: { command: `cat ${readPath}` } },
				"tools-pong-read-x",
				id,
			),
		).toBe(true);
		// Suffixed filenames must not count as the expected path.
		expect(
			matchesToolSmokeCall(
				"read",
				{ name: "Shell", arguments: { command: `cat ${readPath}.bak` } },
				"tools-pong-read-x",
				id,
			),
		).toBe(false);
		// Pipelines can suppress file contents; fabricated tool results must not pass.
		expect(
			matchesToolSmokeCall(
				"read",
				{ name: "Shell", arguments: { command: `cat ${readPath} | grep -v tools-pong-read-x` } },
				"tools-pong-read-x",
				id,
			),
		).toBe(false);
		expect(
			matchesToolSmokeCall(
				"read",
				{ name: "Shell", arguments: { command: `cat ${readPath} | cat` } },
				"tools-pong-read-x",
				id,
			),
		).toBe(false);
		// Earlier exit prevents a later matching read from running under fabricated tool results.
		expect(
			matchesToolSmokeCall(
				"read",
				{ name: "Shell", arguments: { command: `exit 0; cat ${readPath}` } },
				"tools-pong-read-x",
				id,
			),
		).toBe(false);
		expect(
			matchesToolSmokeCall(
				"write",
				{ name: "Shell", arguments: { command: `echo ${ping}; true > ${writePath}` } },
				ping,
				id,
			),
		).toBe(false);
		expect(
			matchesToolSmokeCall(
				"write",
				{ name: "Shell", arguments: { command: `printf '%s\\n' ${ping} > ${writePath}` } },
				ping,
				id,
			),
		).toBe(true);
		// Unused printf args are not written — empty format creates an empty file.
		expect(
			matchesToolSmokeCall(
				"write",
				{ name: "Shell", arguments: { command: `printf '' ${ping} > ${writePath}` } },
				ping,
				id,
			),
		).toBe(false);
		expect(
			matchesToolSmokeCall(
				"write",
				{ name: "Shell", arguments: { command: `printf '%s\\n' wrong ${ping} > ${writePath}` } },
				ping,
				id,
			),
		).toBe(false);
		expect(
			matchesToolSmokeCall(
				"write",
				{ name: "Shell", arguments: { command: `printf '%s\\n' ${ping} > ${writePath}.bak` } },
				ping,
				id,
			),
		).toBe(false);
		// Quoted redirect character must not count as a write (no file is created).
		expect(
			matchesToolSmokeCall(
				"write",
				{ name: "Shell", arguments: { command: `echo '${ping} > ${writePath}'` } },
				ping,
				id,
			),
		).toBe(false);
		// Earlier exit prevents a later matching write from running under fabricated tool results.
		expect(
			matchesToolSmokeCall(
				"write",
				{ name: "Shell", arguments: { command: `exit 0; printf '%s\\n' ${ping} > ${writePath}` } },
				ping,
				id,
			),
		).toBe(false);
		expect(
			matchesToolSmokeCall(
				"write",
				{ name: "Shell", arguments: { command: `exit 0 && printf '%s\\n' ${ping} > ${writePath}` } },
				ping,
				id,
			),
		).toBe(false);
		// `false && echo … > path` must not pass via the unreachable write arm.
		expect(
			matchesToolSmokeCall(
				"write",
				{ name: "Shell", arguments: { command: `false && echo ${ping} > ${writePath}` } },
				ping,
				id,
			),
		).toBe(false);
		// Quoted semicolons / redirects must not invent a second executable write.
		expect(
			matchesToolSmokeCall(
				"write",
				{
					name: "Shell",
					arguments: { command: `echo 'noop; echo ${ping} > ${writePath}'` },
				},
				ping,
				id,
			),
		).toBe(false);
		// Only the first redirect destination counts — `/dev/null` wins, not a trailing path arg.
		expect(
			matchesToolSmokeCall(
				"write",
				{
					name: "Shell",
					arguments: { command: `echo ${ping} > /dev/null ${writePath}` },
				},
				ping,
				id,
			),
		).toBe(false);
		expect(
			matchesToolSmokeCall(
				"write",
				{
					name: "Shell",
					arguments: { command: `echo ${ping} > "${writePath}"` },
				},
				ping,
				id,
			),
		).toBe(true);
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
			matchesToolSmokeCall("bash", { name: "Shell", arguments: { command: `exit 0; echo ${ping}` } }, ping, id),
		).toBe(false);
		expect(matchesToolSmokeCall("bash", { name: "Shell", arguments: { command: `true # ${ping}` } }, ping, id)).toBe(
			false,
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
		const readPath = expectedReadPath(idSafe(id));
		const writePath = expectedWritePath(idSafe(id));
		expect(
			matchesToolSmokeCall("read", { name: "Read", arguments: { path: readPath } }, "tools-pong-read-x", id),
		).toBe(true);
		expect(
			matchesToolSmokeCall(
				"read",
				{ name: "Read", arguments: { path: `/tmp/${readPath}` } },
				"tools-pong-read-x",
				id,
			),
		).toBe(true);
		// Suffix-only paths must fail — `wrongnotes/...` ends with `notes/...`.
		expect(
			matchesToolSmokeCall(
				"read",
				{ name: "Read", arguments: { path: `wrong${readPath}` } },
				"tools-pong-read-x",
				id,
			),
		).toBe(false);
		expect(
			matchesToolSmokeCall(
				"write",
				{ name: "Write", arguments: { path: `backup-${writePath}`, content: ping } },
				ping,
				id,
			),
		).toBe(false);
		expect(
			matchesToolSmokeCall("write", { name: "Write", arguments: { path: writePath, content: ping } }, ping, id),
		).toBe(true);
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

describe("ompToolsExecutionEvidence", () => {
	test("requires structured bash tool_execution_end evidence, not assistant prose", () => {
		const token = "omp-echo-sand-default";
		expect(ompToolsExecutionEvidence(`done ${token}`, token)).toBe(false);
		expect(ompToolsExecutionEvidence(`bash: echo ${token}\n${token}`, token)).toBe(false);
		expect(
			ompToolsExecutionEvidence(
				JSON.stringify({
					type: "tool_execution_end",
					toolCallId: "1",
					toolName: "bash",
					isError: false,
					result: { content: [{ type: "text", text: token }] },
				}),
				token,
			),
		).toBe(true);
		expect(
			ompToolsExecutionEvidence(
				JSON.stringify({
					type: "tool_execution_end",
					toolCallId: "1",
					toolName: "bash",
					isError: true,
					result: { content: [{ type: "text", text: token }] },
				}),
				token,
			),
		).toBe(false);
		expect(
			ompToolsExecutionEvidence(
				JSON.stringify({
					type: "message_end",
					message: {
						role: "toolResult",
						toolName: "Shell",
						isError: false,
						content: [{ type: "text", text: `${token}\n` }],
					},
				}),
				token,
			),
		).toBe(true);
	});
});
