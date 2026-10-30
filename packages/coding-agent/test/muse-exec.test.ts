import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	buildMuseExecInvocation,
	describeMuseExecFailure,
	prepareMusePrompt,
	resolveMuseTempRoot,
	runMuseExec,
	type MuseExecSpawn,
} from "../src/muse/exec";
import {
	MUSE_MAX_ANSWER_BYTES,
	MUSE_MAX_LINE_CHARS,
	MuseExecStreamParser,
	sanitizeMuseText,
	type MuseExecOutcome,
} from "../src/muse/protocol";
import { ToolAbortError } from "../src/tools/tool-errors";

const ECHO_FIXTURE = path.join(import.meta.dir, "fixtures", "muse-exec-echo.jsonl");

function echoLines(): string[] {
	return fs.readFileSync(ECHO_FIXTURE, "utf8").trimEnd().split("\n");
}

function parseLines(lines: string[]): MuseExecOutcome {
	const parser = new MuseExecStreamParser();
	for (const line of lines) parser.pushLine(line);
	return parser.finish();
}

function makeWorkspace(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "omp-muse-ws-"));
}

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new Blob([text]).stream();
}

function terminalLine(terminal: string, text = "", reason: string | null = null): string {
	return JSON.stringify({
		id: `terminal-${terminal}`,
		payload_type: `run.terminal.${terminal}`,
		payload: { terminal, text, reason },
	});
}

describe("MuseExecStreamParser", () => {
	it("parses the observed echo run, including task.lifecycle.failed activity", () => {
		const outcome = parseLines(echoLines());
		expect(outcome.status).toBe("completed");
		expect(outcome.terminal).toBe("completed");
		expect(outcome.reason).toBeNull();
		expect(outcome.answer).toBe("echo: say hello and finish");
		expect(outcome.records).toBe(35);
		expect(outcome.skippedLines).toBe(0);
		expect(outcome.duplicates).toBe(0);
		expect(outcome.tasks).toEqual({ total: 4, failed: 2, cancelled: 0 });
		expect(outcome.usage?.calls).toBe(1);
		expect(outcome.usage?.completedCalls).toBe(1);
		expect(outcome.usage?.models[0]?.model).toBe("");
		expect(outcome.deltaCount).toBe(1);
		expect(outcome.warnings.some(warning => warning.includes("not a run failure"))).toBe(true);
	});

	it("does not treat task.lifecycle.failed as a run failure", () => {
		const outcome = parseLines([
			JSON.stringify({
				id: "task-1",
				payload_type: "task.lifecycle.failed",
				payload: { task_id: "t", event: { kind: "failed", task_id: "t", reason: "reminder failed" } },
			}),
			terminalLine("completed", "answer"),
		]);
		expect(outcome.status).toBe("completed");
		expect(outcome.tasks.failed).toBe(1);
	});

	it("surfaces an unverified non-completed terminal as a failure", () => {
		const outcome = parseLines([terminalLine("failed", "", "provider exploded")]);
		expect(outcome.status).toBe("failed");
		expect(outcome.terminal).toBe("failed");
		expect(outcome.reason).toBe("provider exploded");
		expect(describeMuseExecFailure(0, "", outcome)).toContain('terminal "failed"');
		expect(describeMuseExecFailure(0, "", outcome)).toContain("Reason: provider exploded");
	});

	it("treats an unknown terminal value as a failure rather than success", () => {
		const outcome = parseLines([terminalLine("cancelled")]);
		expect(outcome.status).toBe("failed");
		expect(outcome.terminal).toBe("cancelled");
	});

	it("reports EOF without a terminal record as incomplete even at exit 0", () => {
		const outcome = parseLines([
			'{"id":"a","payload_type":"turn.input.user","payload":{"prompt":"hi"}}',
			'{"id":"b","payload_type":"run.lifecycle.started","payload":{"prompt":"hi"}}',
		]);
		expect(outcome.status).toBe("incomplete");
		expect(outcome.terminal).toBeNull();
		expect(describeMuseExecFailure(0, "", outcome)).toContain("without a run.terminal.* record");
	});

	it("keeps a later terminal even when an earlier payload shape is unusable", () => {
		const outcome = parseLines([
			'{"id":"u1","payload_type":"run.usage","payload":{"calls":"lots","models":"nope"}}',
			terminalLine("completed", "ok"),
		]);
		expect(outcome.status).toBe("completed");
		expect(outcome.answer).toBe("ok");
		expect(outcome.skippedLines).toBe(1);
		expect(outcome.usage).toBeNull();
		expect(outcome.warnings.some(warning => warning.includes("run.usage"))).toBe(true);
	});

	it("drops duplicate envelope ids and counts unknown payloads", () => {
		const delta = JSON.stringify({
			id: "d1",
			payload_type: "run.output.delta",
			payload: { text: "once" },
		});
		const outcome = parseLines([
			delta,
			delta,
			'{"id":"x","payload_type":"future.unknown","payload":{}}',
			terminalLine("completed", "once"),
		]);
		expect(outcome.records).toBe(3);
		expect(outcome.duplicates).toBe(1);
		expect(outcome.unknownPayloads).toBe(1);
		expect(outcome.deltaText).toBe("once");
	});

	it("bounds and sanitizes the terminal answer", () => {
		const answer = `\u001b[31m${"x".repeat(MUSE_MAX_ANSWER_BYTES + 100)}\u001b[0m\u0007`;
		const outcome = parseLines([terminalLine("completed", answer)]);
		expect(outcome.answerTruncated).toBe(true);
		expect(outcome.answer.startsWith("x".repeat(100))).toBe(true);
		expect(outcome.answer).toContain("bytes omitted");
		expect(outcome.answer).not.toContain("\u001b[");
		expect(outcome.answer).not.toContain("\u0007");
	});

	it("fails fast on a stdout line that is not a usable envelope", () => {
		const parser = new MuseExecStreamParser();
		expect(() => parser.pushLine("not json")).toThrow(ToolError);
		expect(() => parser.pushLine("x".repeat(MUSE_MAX_LINE_CHARS + 1))).toThrow(ToolError);
	});
});

describe("sanitizeMuseText", () => {
	it("strips ANSI and control characters", () => {
		expect(sanitizeMuseText("\u001b[31mred\u001b[0m\u0007", 100).text).toBe("red");
		expect(sanitizeMuseText(undefined, 100)).toEqual({ text: "", bytes: 0, truncated: false });
	});
});

describe("buildMuseExecInvocation", () => {
	it("uses the documented headless flags and keeps the licensed provider", () => {
		const workspace = makeWorkspace();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omp-muse-tmp-"));
		try {
			const promptFile = path.join(outside, "prompt.md");
			const invocation = buildMuseExecInvocation({ workspace, promptFile, tempDir: outside, maxModelSteps: 3 });
			expect(invocation.command.slice(0, 2)).toEqual(["muse", "exec"]);
			expect(invocation.command).toContain("--json");
			expect(invocation.command).toContain("--no-session-log");
			expect(invocation.command).toContain("--user-input-auto-resolve");
			expect(invocation.command[invocation.command.indexOf("--workspace") + 1]).toBe(workspace);
			expect(invocation.command[invocation.command.indexOf("--prompt-file") + 1]).toBe(promptFile);
			expect(invocation.command[invocation.command.indexOf("--max-model-steps") + 1]).toBe("3");
			expect(invocation.command).not.toContain("--provider");
			for (const forbidden of [
				"--yolo",
				"--disable-approval",
				"--disable-sandbox",
				"--trust-workspace",
				"--sandbox-network",
				"--base-url",
				"--api-key-stdin",
			]) {
				expect(invocation.command).not.toContain(forbidden);
			}
			expect(invocation.cwd).toBe(workspace);
			expect(invocation.env.MUSE_NO_AUTO_UPDATE).toBe("1");
			expect(invocation.env.TMPDIR).toBe(outside);
			expect(invocation.env.TMP).toBe(outside);
			expect(invocation.env.TEMP).toBe(outside);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("adds --provider echo only through the explicit offline seam", () => {
		const workspace = makeWorkspace();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omp-muse-tmp-"));
		try {
			const invocation = buildMuseExecInvocation({
				workspace,
				promptFile: path.join(outside, "prompt.md"),
				tempDir: outside,
				provider: "echo",
			});
			expect(invocation.command.slice(-2)).toEqual(["--provider", "echo"]);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("invokes the configured binary from the bin option", () => {
		const workspace = makeWorkspace();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omp-muse-tmp-"));
		try {
			const invocation = buildMuseExecInvocation({
				workspace,
				bin: "/opt/muse/muse",
				promptFile: path.join(outside, "prompt.md"),
				tempDir: outside,
			});
			expect(invocation.command.slice(0, 3)).toEqual(["/opt/muse/muse", "exec", "--json"]);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("rejects relative workspaces and a temp directory inside the workspace", () => {
		const workspace = makeWorkspace();
		try {
			expect(() =>
				buildMuseExecInvocation({ workspace: "relative", promptFile: "/tmp/p.md", tempDir: os.tmpdir() }),
			).toThrow(/absolute/);
			const inside = fs.mkdtempSync(path.join(workspace, "tmp-"));
			expect(() =>
				buildMuseExecInvocation({ workspace, promptFile: path.join(inside, "p.md"), tempDir: inside }),
			).toThrow(/outside the workspace/);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("places the temp root outside the workspace", () => {
		const workspace = makeWorkspace();
		try {
			const root = resolveMuseTempRoot(workspace);
			expect(path.relative(workspace, root).startsWith("..")).toBe(true);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});
});

describe("runMuseExec", () => {
	it("writes a 0600 prompt file outside the workspace", async () => {
		const workspace = makeWorkspace();
		try {
			const { tempDir, promptFile } = await prepareMusePrompt(workspace, "do the thing");
			try {
				expect(path.relative(workspace, tempDir).startsWith("..")).toBe(true);
				expect(fs.readFileSync(promptFile, "utf8")).toBe("do the thing");
				expect(fs.statSync(promptFile).mode & 0o077).toBe(0);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("runs the client through the bounded stream and returns the terminal answer", async () => {
		const workspace = makeWorkspace();
		try {
			const calls: { command: string[]; env: NodeJS.ProcessEnv; cwd: string; stdin: string }[] = [];
			const spawn: MuseExecSpawn = (command, options) => {
				calls.push({ command, env: options.env, cwd: options.cwd, stdin: options.stdin });
				return {
					stdout: streamOf(echoLines().join("\n")),
					stderr: streamOf("muse: workspace root: explicit\n"),
					exited: Promise.resolve(0),
					kill: () => {},
				};
			};
			const result = await runMuseExec({ prompt: "say hello and finish", workspace, spawn });
			expect(result.outcome.answer).toBe("echo: say hello and finish");
			expect(result.exitCode).toBe(0);
			expect(result.stdoutLines).toBe(35);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.stdin).toBe("ignore");
			expect(calls[0]?.cwd).toBe(workspace);
			expect(calls[0]?.env.MUSE_NO_AUTO_UPDATE).toBe("1");
			expect(calls[0]?.command).not.toContain("--provider");
			expect(result.stderr).toContain("workspace root");
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("surface a usage error from exit 2 and stderr", async () => {
		const workspace = makeWorkspace();
		try {
			const spawn: MuseExecSpawn = () => ({
				stdout: streamOf(""),
				stderr: streamOf("missing prompt\nusage: muse exec [OPTIONS] [PROMPT]\n"),
				exited: Promise.resolve(2),
				kill: () => {},
			});
			await expect(runMuseExec({ prompt: "x", workspace, spawn })).rejects.toThrow(/usage error/);
			await expect(runMuseExec({ prompt: "x", workspace, spawn })).rejects.toThrow(/missing prompt/);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("rejects exit 0 without a terminal record", async () => {
		const workspace = makeWorkspace();
		try {
			const spawn: MuseExecSpawn = () => ({
				stdout: streamOf('{"id":"a","payload_type":"turn.input.user","payload":{"prompt":"hi"}}'),
				stderr: streamOf(""),
				exited: Promise.resolve(0),
				kill: () => {},
			});
			await expect(runMuseExec({ prompt: "x", workspace, spawn })).rejects.toThrow(
				/without a run\.terminal\.\* record/,
			);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("kills the client and reports cancellation", async () => {
		const workspace = makeWorkspace();
		const controller = new AbortController();
		let killed = false;
		try {
			const exit = Promise.withResolvers<number>();
			const spawn: MuseExecSpawn = () => {
				// Simulate an abort landing while the child is being created, before
				// the listener registration point.
				controller.abort();
				return {
					stdout: streamOf(""),
					stderr: streamOf(""),
					exited: exit.promise,
					kill: () => {
						killed = true;
						exit.resolve(143);
					},
				};
			};
			await expect(runMuseExec({ prompt: "x", workspace, spawn, signal: controller.signal })).rejects.toBeInstanceOf(
				ToolAbortError,
			);
			expect(killed).toBe(true);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("bounds a hung client with a timeout", async () => {
		const workspace = makeWorkspace();
		const exit = Promise.withResolvers<number>();
		try {
			const spawn: MuseExecSpawn = () => ({
				stdout: streamOf(""),
				stderr: streamOf(""),
				exited: exit.promise,
				kill: () => {
					exit.resolve(137);
				},
			});
			await expect(runMuseExec({ prompt: "x", workspace, spawn, timeoutMs: 20 })).rejects.toThrow(/timed out/);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("does not spawn when the caller is already cancelled", async () => {
		const workspace = makeWorkspace();
		const controller = new AbortController();
		controller.abort();
		let spawned = false;
		try {
			const spawn: MuseExecSpawn = () => {
				spawned = true;
				return {
					stdout: streamOf(""),
					stderr: streamOf(""),
					exited: Promise.resolve(0),
					kill: () => {},
				};
			};
			await expect(runMuseExec({ prompt: "x", workspace, spawn, signal: controller.signal })).rejects.toBeInstanceOf(
				ToolAbortError,
			);
			expect(spawned).toBe(false);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});
});
