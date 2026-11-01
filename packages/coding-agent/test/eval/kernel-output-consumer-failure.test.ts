import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disposeAllVmContexts,
	executeInVmContext,
	type VmRunState,
} from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { JsStatusEvent } from "@oh-my-pi/pi-coding-agent/eval/js/shared/types";
import { TempDir } from "@oh-my-pi/pi-utils";

type Language = "py" | "js";
const LANGUAGES = ["py", "js"] as const;

function makeSession(evalSessionId: string, tool?: AgentTool): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "eval.autoProvision": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => evalSessionId,
		...(tool ? { getToolByName: (name: string) => (name === tool.name ? tool : undefined) } : {}),
	};
}

interface Cell {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string;
}

interface Consumers {
	onChunk?: (chunk: string) => unknown;
	onStatus?: (event: JsStatusEvent) => unknown;
	artifactPath?: string;
	artifactId?: string;
	signal?: AbortSignal;
}

/** Runs one cell in the session's retained runtime with caller-supplied output consumers. */
async function run(session: ToolSession, language: Language, code: string, consumers: Consumers = {}): Promise<Cell> {
	const sessionId = session.getEvalSessionId?.() ?? "missing";
	// The public consumer types return void; a consumer that returns a promise must be accepted all the same.
	const onChunk = consumers.onChunk as ((chunk: string) => void) | undefined;
	const onStatus = consumers.onStatus as ((event: JsStatusEvent) => void) | undefined;
	const shared = {
		cwd: session.cwd,
		sessionId,
		onChunk,
		onStatus,
		artifactPath: consumers.artifactPath,
		artifactId: consumers.artifactId,
		timeoutMs: 20_000,
		signal: consumers.signal,
	};
	const result =
		language === "py"
			? await executePython(code, { ...shared, toolSession: session })
			: await executeJs(code, { ...shared, session });
	return {
		output: result.output,
		exitCode: result.exitCode,
		cancelled: result.cancelled,
		truncated: result.truncated,
		artifactId: result.artifactId ?? undefined,
	};
}

const PID_CELL: Record<Language, string> = {
	py: "import os\nprint('pid', os.getpid())",
	js: "print('pid', process.pid)",
};

function pidOf(cell: Cell): string {
	const match = /pid (\d+)/.exec(cell.output);
	if (!match) throw new Error(`no pid in cell output: ${cell.output}`);
	return match[1]!;
}

/**
 * Whether `chunk` holds `line` as a whole printed line. A substring test would
 * also match the notices the executor itself streams: the JavaScript timeout
 * notice ends "variables from earlier cells are gone", which contains "one".
 */
function printsLine(chunk: string, line: string): boolean {
	return chunk.split("\n").includes(line);
}

/**
 * Sets a variable and prints two lines with a pause between them, so the second
 * arrives as a later message, after the consumer refused the first. The pause
 * runs inside the real runtime, which a fake clock cannot reach.
 */
const TWO_LINES: Record<Language, string> = {
	py: "import time\nkept = 42\nprint('one', flush=True)\ntime.sleep(0.3)\nprint('two', flush=True)",
	js: "var kept = 42; print('one'); await new Promise(resolve => setTimeout(resolve, 300)); print('two');",
};

const READ_KEPT: Record<Language, string> = {
	py: "print('kept', kept)",
	js: "print('kept', kept)",
};

/** Ends on a carriage return, so the output sink emits the final newline itself when the cell's result is assembled. */
const ENDS_ON_CARRIAGE_RETURN: Record<Language, string> = {
	py: "print('done')\nprint('end\\r', end='')",
	js: "print('done'); void process.stdout.write('end\\r');",
};

const FAILING_CELL: Record<Language, string> = {
	py: "raise ValueError('cell failed')",
	js: "throw new Error('cell failed')",
};

/** About 194,000 bytes of output, well past the inline output limit. */
const LARGE_OUTPUT: Record<Language, string> = {
	py: "for i in range(2000):\n    print(f'{i:05d} ' + 'x' * 90)",
	js: "for (let i = 0; i < 2000; i++) print(String(i).padStart(5, '0') + ' ' + 'x'.repeat(90));",
};

/** Prints one line, then outlives any short timeout. */
const OUTLIVES_TIMEOUT: Record<Language, string> = {
	py: "import time\nprint('one', flush=True)\ntime.sleep(30)",
	js: "print('one'); await new Promise(resolve => setTimeout(resolve, 30_000));",
};

const CALL_PROGRESS_TOOL: Record<Language, string> = {
	py: "print(await tool.mcp__fixture_progress({}))",
	js: "print(await tool.mcp__fixture_progress({}))",
};

/** An MCP tool that reports progress once, then completes. */
function progressTool(): AgentTool {
	return {
		name: "mcp__fixture_progress",
		label: "MCP fixture",
		description: "Reports progress, then completes",
		parameters: type({}),
		mcpServerName: "fixture",
		async execute(_id: string, _args: unknown, _signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback) {
			onUpdate?.({
				content: [{ type: "text", text: "working" }],
				details: { progress: { progress: 1, total: 2, message: "working" } },
			});
			return { content: [{ type: "text", text: "tool-complete" }], details: {} };
		},
	} as AgentTool;
}

function expectConsumerFailure(cell: Cell, consumer: "stream" | "display", message: string): void {
	expect(cell.output).toContain(`The ${consumer} output consumer failed: ${message}.`);
	// The rest of the sentence depends on how the cell ended, and nothing parses it.
}

/** An error whose `message` getter throws, so even reading the message fails. */
function errorWithThrowingMessage(): Error {
	const error = new Error("unused");
	Object.defineProperty(error, "message", {
		get() {
			throw new Error("the message getter failed");
		},
	});
	return error;
}

/** An error whose `message` is an object that cannot be converted to text. */
function errorWithObjectMessage(): Error {
	const error = new Error("unused");
	Object.defineProperty(error, "message", { value: Object.create(null) });
	return error;
}

/** An object that refers to itself, which a JSON serializer cannot write. */
function circularObject(): object {
	const value: { self?: unknown } = {};
	value.self = value;
	return value;
}

/** A Proxy whose every trap throws: converting it, reading it, even testing `instanceof` on it fails. */
function hostileProxy(): object {
	const refuse = (): never => {
		throw new Error("the proxy refuses every operation");
	};
	return new Proxy({}, new Proxy({}, { get: () => refuse }));
}

/**
 * Values a consumer may throw or reject with whose description is itself a
 * hazard: converting them to text or reading their message throws, or a
 * serializer cannot write them. `described` is how the cell's result names each.
 */
const THROWN_VALUES: ReadonlyArray<{ label: string; make: () => unknown; described: string }> = [
	{ label: "a null-prototype object", make: () => Object.create(null), described: "[object Object]" },
	{ label: "a symbol", make: () => Symbol("refused"), described: "Symbol(refused)" },
	{ label: "an error whose message getter throws", make: errorWithThrowingMessage, described: "[object Error]" },
	{ label: "an error whose message is not text", make: errorWithObjectMessage, described: "[object Error]" },
	{ label: "a circular object", make: circularObject, described: "[object Object]" },
	{
		label: "a proxy that refuses every operation",
		make: hostileProxy,
		described: "a thrown object that cannot be converted to text",
	},
];

type FailureMode = "throws" | "rejects with";

/** A consumer that throws `make()`, or rejects with it after an await, on the printed line "one". */
function refusingLineOne(mode: FailureMode, make: () => unknown): (chunk: string) => unknown {
	if (mode === "throws") {
		return chunk => {
			if (printsLine(chunk, "one")) throw make();
		};
	}
	return async chunk => {
		await Promise.resolve();
		if (printsLine(chunk, "one")) throw make();
	};
}

describe("eval output consumer failure", () => {
	afterEach(async () => {
		await Promise.all([disposeAllKernelSessions(), disposeAllVmContexts()]);
	});

	for (const language of LANGUAGES) {
		it(`${language}: a consumer that throws mid-cell leaves the cell, the runtime and its variables intact, and is reported`, async () => {
			const session = makeSession(`consumer-failure-${language}-${crypto.randomUUID()}`);
			const before = await run(session, language, PID_CELL[language]);

			const delivered: string[] = [];
			const failed = await run(session, language, TWO_LINES[language], {
				onChunk: chunk => {
					if (printsLine(chunk, "one")) throw new Error("consumer refused a chunk");
					delivered.push(chunk);
				},
			});
			const after = await run(session, language, `${PID_CELL[language]}\n${READ_KEPT[language]}`);

			// The cell ran to completion instead of hanging until its timeout killed the runtime.
			expect(failed.cancelled).toBe(false);
			expect(failed.exitCode).toBe(0);
			// The result holds the whole output, including what arrived after the consumer threw.
			expect(failed.output).toContain("one\n");
			expect(failed.output).toContain("two\n");
			// The consumer kept receiving the cell's later output.
			expect(delivered.join("")).toContain("two");
			// The failure reaches the caller when the cell is done, naming the consumer and the risk.
			expectConsumerFailure(failed, "stream", "consumer refused a chunk");
			expect(failed.output).toContain("this result holds all of its output");
			expect(failed.output).toContain("output shown while it ran may be incomplete");
			// Same process, state intact.
			expect(pidOf(after)).toBe(pidOf(before));
			expect(after.output).toContain("kept 42");
		}, 120_000);

		it(`${language}: an async consumer that rejects after an await leaves the cell, the runtime and its variables intact, and is reported`, async () => {
			const session = makeSession(`consumer-async-${language}-${crypto.randomUUID()}`);
			const before = await run(session, language, PID_CELL[language]);

			const failed = await run(session, language, TWO_LINES[language], {
				onChunk: async chunk => {
					await Promise.resolve();
					if (printsLine(chunk, "one")) throw new Error("async consumer refused a chunk");
				},
			});
			const after = await run(session, language, `${PID_CELL[language]}\n${READ_KEPT[language]}`);

			expect(failed.cancelled).toBe(false);
			expect(failed.exitCode).toBe(0);
			expect(failed.output).toContain("one\n");
			expect(failed.output).toContain("two\n");
			expectConsumerFailure(failed, "stream", "async consumer refused a chunk");
			expect(pidOf(after)).toBe(pidOf(before));
			expect(after.output).toContain("kept 42");
		}, 120_000);

		it(`${language}: a consumer that throws on the final newline the result adds is reported, and the cell still succeeds`, async () => {
			const session = makeSession(`consumer-flush-${language}-${crypto.randomUUID()}`);
			let refused = 0;
			const cell = await run(session, language, ENDS_ON_CARRIAGE_RETURN[language], {
				onChunk: chunk => {
					if (chunk !== "\n") return;
					refused += 1;
					throw new Error("consumer refused the final newline");
				},
			});

			expect(refused).toBe(1);
			expect(cell.cancelled).toBe(false);
			expect(cell.exitCode).toBe(0);
			expect(cell.output).toContain("done\nend\n");
			// The consumer's own error is reported once, not appended as if the cell had printed it.
			expect(cell.output).not.toContain("    at ");
			expectConsumerFailure(cell, "stream", "consumer refused the final newline");
		}, 120_000);

		it(`${language}: a consumer that throws on every chunk of a failing cell still gets a result with the cell's error`, async () => {
			const session = makeSession(`consumer-every-${language}-${crypto.randomUUID()}`);
			const before = await run(
				session,
				language,
				`${PID_CELL[language]}\n${language === "py" ? "kept = 42" : "var kept = 42;"}`,
			);

			const failed = await run(session, language, FAILING_CELL[language], {
				onChunk: () => {
					throw new Error("consumer is broken");
				},
			});
			const after = await run(session, language, `${PID_CELL[language]}\n${READ_KEPT[language]}`);

			expect(failed.cancelled).toBe(false);
			expect(failed.exitCode).toBe(1);
			expect(failed.output).toContain("cell failed");
			expectConsumerFailure(failed, "stream", "consumer is broken");
			expect(pidOf(after)).toBe(pidOf(before));
			expect(after.output).toContain("kept 42");
		}, 120_000);

		it(`${language}: a truncated result does not claim to hold all of the output, and names the artifact when one was saved`, async () => {
			using artifacts = TempDir.createSync("@consumer-failure-artifact-");
			const session = makeSession(`consumer-truncated-${language}-${crypto.randomUUID()}`);
			const refuseFirst = (): ((chunk: string) => void) => {
				let refused = false;
				return () => {
					if (refused) return;
					refused = true;
					throw new Error("consumer refused a chunk");
				};
			};

			const unsaved = await run(session, language, LARGE_OUTPUT[language], { onChunk: refuseFirst() });
			expect(unsaved.truncated).toBe(true);
			expect(unsaved.artifactId).toBeUndefined();
			expectConsumerFailure(unsaved, "stream", "consumer refused a chunk");
			expect(unsaved.output).not.toContain("holds all of its output");
			expect(unsaved.output).toContain("usual truncation");

			const saved = await run(session, language, LARGE_OUTPUT[language], {
				onChunk: refuseFirst(),
				artifactPath: path.join(artifacts.path(), "cell.log"),
				artifactId: "consumer-cell",
			});
			expect(saved.truncated).toBe(true);
			expect(saved.artifactId).toBe("consumer-cell");
			expectConsumerFailure(saved, "stream", "consumer refused a chunk");
			expect(saved.output).not.toContain("holds all of its output");
			expect(saved.output).toContain("artifact://consumer-cell");
		}, 120_000);

		it(`${language}: a status consumer that throws during a bridged tool's progress leaves the tool call and the cell intact, and is reported`, async () => {
			const session = makeSession(`consumer-progress-${language}-${crypto.randomUUID()}`, progressTool());
			const progress: string[] = [];
			const cell = await run(session, language, CALL_PROGRESS_TOOL[language], {
				onStatus: event => {
					if (event.op !== "mcp_progress") return;
					progress.push(event.op);
					throw new Error("status consumer refused progress");
				},
			});

			expect(progress).toContain("mcp_progress");
			expect(cell.cancelled).toBe(false);
			expect(cell.exitCode).toBe(0);
			expect(cell.output).toContain("tool-complete");
			expectConsumerFailure(cell, "display", "status consumer refused progress");
		}, 120_000);

		it(`${language}: a cell whose consumer does not throw is unchanged`, async () => {
			const session = makeSession(`consumer-ok-${language}-${crypto.randomUUID()}`);
			const delivered: string[] = [];
			const cell = await run(session, language, TWO_LINES[language], {
				onChunk: chunk => {
					delivered.push(chunk);
				},
			});

			expect(cell.cancelled).toBe(false);
			expect(cell.exitCode).toBe(0);
			expect(cell.output).toBe("one\ntwo\n");
			expect(delivered.join("")).toBe("one\ntwo\n");
		}, 120_000);

		it(`${language}: a cell that times out after its consumer refused a printed line reports the failure without claiming the cell ran on`, async () => {
			const session = makeSession(`consumer-timeout-${language}-${crypto.randomUUID()}`);
			const timeout = new AbortController();
			let refusedLine = false;
			const cell = await run(session, language, OUTLIVES_TIMEOUT[language], {
				onChunk: chunk => {
					// The timeout notice the executor streams must not count as the cell's line.
					if (!printsLine(chunk, "one")) return;
					refusedLine = true;
					// The cell times out only after its consumer failed on the line, whatever the scheduling.
					queueMicrotask(() => timeout.abort(new DOMException("The cell timed out", "TimeoutError")));
					throw new Error("consumer refused a chunk");
				},
				signal: timeout.signal,
			});

			expect(refusedLine).toBe(true);
			expect(cell.cancelled).toBe(true);
			// The executor took its timeout path, not a plain cancellation.
			expect(cell.output).toContain("timed out");
			expectConsumerFailure(cell, "stream", "consumer refused a chunk");
			expect(cell.output).not.toContain("kept running");
			expect(cell.output).not.toContain("holds all of its output");
		}, 120_000);
	}
});

describe("runtime output callback failure", () => {
	afterEach(async () => {
		await disposeAllVmContexts();
	});

	it("py: the kernel reports an async output callback that rejects, and finishes the execution", async () => {
		const kernel = await PythonKernel.start({ cwd: process.cwd() });
		try {
			const chunks: string[] = [];
			const result = await kernel.execute(TWO_LINES.py, {
				onChunk: async text => {
					chunks.push(text);
					await Promise.resolve();
					if (printsLine(text, "one")) throw new Error("callback rejected");
				},
			});

			expect(result.cancelled).toBe(false);
			expect(result.status).toBe("ok");
			expect(chunks.join("")).toBe("one\ntwo\n");
			expect(result.consumerFailure).toEqual({ callback: "onChunk", message: "callback rejected" });
			expect(kernel.isAlive()).toBe(true);
		} finally {
			await kernel.shutdown();
		}
	}, 120_000);

	it("py: the kernel reports an async output callback that rejects its exit message", async () => {
		const kernel = await PythonKernel.start({ cwd: process.cwd() });
		try {
			const result = await kernel.execute("import os, time\nprint('pid', os.getpid(), flush=True)\ntime.sleep(30)", {
				onChunk: async text => {
					const pid = /pid (\d+)/.exec(text);
					if (pid) {
						if (Number(pid[1]) === process.pid) throw new Error("the kernel runs in the test process");
						process.kill(Number(pid[1]), "SIGKILL");
						return;
					}
					await Promise.resolve();
					if (text.startsWith("[kernel]")) throw new Error("callback rejected the exit message");
				},
			});

			expect(result.cancelled).toBe(true);
			expect(result.kernelKilled).toBe(true);
			expect(result.consumerFailure).toEqual({ callback: "onChunk", message: "callback rejected the exit message" });
		} finally {
			await kernel.shutdown();
		}
	}, 120_000);

	it("js: the context manager reports an async output callback that rejects, and finishes the run", async () => {
		const session = makeSession(`runtime-async-js-${crypto.randomUUID()}`);
		const sessionId = session.getEvalSessionId?.() ?? "missing";
		const chunks: string[] = [];
		const runState: VmRunState = {
			// The run state's callback type returns void; a callback that returns a promise must be accepted all the same.
			onText: (async (text: string) => {
				chunks.push(text);
				await Promise.resolve();
				if (printsLine(text, "one")) throw new Error("callback rejected");
			}) as (text: string) => void,
		};

		await executeInVmContext({
			sessionKey: sessionId,
			sessionId,
			cwd: session.cwd,
			session,
			code: TWO_LINES.js,
			filename: "runtime-async.js",
			timeoutMs: 20_000,
			runState,
		});

		expect(chunks.join("")).toBe("one\ntwo\n");
		expect(runState.consumerFailure).toEqual({ callback: "onChunk", message: "callback rejected" });
	}, 120_000);
});

describe("output consumer failure with an arbitrary thrown value", () => {
	afterEach(async () => {
		await Promise.all([disposeAllKernelSessions(), disposeAllVmContexts()]);
	});

	for (const thrown of THROWN_VALUES) {
		for (const language of LANGUAGES) {
			for (const mode of ["throws", "rejects with"] as const) {
				it(`${language}: a consumer that ${mode} ${thrown.label} leaves the cell, the runtime and its variables intact, and is reported`, async () => {
					const session = makeSession(`consumer-thrown-${language}-${crypto.randomUUID()}`);
					const before = await run(session, language, PID_CELL[language]);

					const failed = await run(session, language, TWO_LINES[language], {
						onChunk: refusingLineOne(mode, thrown.make),
					});
					const after = await run(session, language, `${PID_CELL[language]}\n${READ_KEPT[language]}`);

					expect(failed.cancelled).toBe(false);
					expect(failed.exitCode).toBe(0);
					expect(failed.output).toContain("one\n");
					expect(failed.output).toContain("two\n");
					expectConsumerFailure(failed, "stream", thrown.described);
					// Reported as the consumer's failure, not as a delivery failure that may have lost output.
					expect(failed.output).toContain("this result holds all of its output");
					expect(pidOf(after)).toBe(pidOf(before));
					expect(after.output).toContain("kept 42");
				}, 120_000);
			}
		}
	}
});

describe("runtime output callback failure with an arbitrary thrown value", () => {
	afterEach(async () => {
		await disposeAllVmContexts();
	});

	for (const thrown of THROWN_VALUES) {
		it(`py: the kernel reports an output callback that rejects with ${thrown.label}, and keeps serving`, async () => {
			const kernel = await PythonKernel.start({ cwd: process.cwd() });
			try {
				const result = await kernel.execute(TWO_LINES.py, {
					onChunk: refusingLineOne("rejects with", thrown.make) as (text: string) => Promise<void>,
					// Bounds the red case, where the failed report ends the reader and the execution never settles.
					timeoutMs: 20_000,
				});
				const chunks: string[] = [];
				await kernel.execute(READ_KEPT.py, { onChunk: text => void chunks.push(text) });

				expect(result.cancelled).toBe(false);
				expect(result.status).toBe("ok");
				expect(result.consumerFailure).toEqual({ callback: "onChunk", message: thrown.described });
				expect(kernel.isAlive()).toBe(true);
				expect(chunks.join("")).toBe("kept 42\n");
			} finally {
				await kernel.shutdown();
			}
		}, 120_000);

		for (const mode of ["throws", "rejects with"] as const) {
			it(`js: the context manager reports an output callback that ${mode} ${thrown.label}, and finishes the run`, async () => {
				const session = makeSession(`runtime-thrown-js-${crypto.randomUUID()}`);
				const sessionId = session.getEvalSessionId?.() ?? "missing";
				const execute = (code: string, runState: VmRunState) =>
					executeInVmContext({
						sessionKey: sessionId,
						sessionId,
						cwd: session.cwd,
						session,
						code,
						filename: "runtime-thrown.js",
						timeoutMs: 20_000,
						runState,
					});
				// The run state's callback type returns void; a callback that returns a promise must be accepted all the same.
				const runState: VmRunState = { onText: refusingLineOne(mode, thrown.make) as (text: string) => void };
				await execute(TWO_LINES.js, runState);
				const chunks: string[] = [];
				await execute(READ_KEPT.js, { onText: text => void chunks.push(text) });

				expect(runState.consumerFailure).toEqual({ callback: "onChunk", message: thrown.described });
				expect(chunks.join("")).toBe("kept 42\n");
			}, 120_000);
		}
	}
});
