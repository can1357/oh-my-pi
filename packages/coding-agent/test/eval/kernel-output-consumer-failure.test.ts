import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as vm from "node:vm";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disposeAllVmContexts,
	executeInVmContext,
	type VmRunState,
} from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { isCancellationError, isTimedOutCancellation } from "@oh-my-pi/pi-coding-agent/eval/executor-base";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { KernelExecuteResult } from "@oh-my-pi/pi-coding-agent/eval/kernel-base";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { JsStatusEvent } from "@oh-my-pi/pi-coding-agent/eval/js/shared/types";
import { catchRejection } from "@oh-my-pi/pi-coding-agent/utils/ipc";
import { describeError, logger, postmortem, TempDir } from "@oh-my-pi/pi-utils";

type Language = "py" | "js";
const LANGUAGES = ["py", "js"] as const;

// Real Python kernels only under PI_PYTHON_INTEGRATION=1, like the other real-kernel suites.
const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";

/** Whether a row in `language` is skipped: Python rows need a real interpreter, which only an opted-in host has. */
function skipped(language: Language): boolean {
	return language === "py" && !PYTHON_INTEGRATION;
}

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
	/** Absent: 20 seconds. Set to `undefined` to run the cell with no timeout of its own. */
	timeoutMs?: number;
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
		timeoutMs: "timeoutMs" in consumers ? consumers.timeoutMs : 20_000,
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

/** The built-in, restored after each test in case a value below left its replacement installed. */
const OBJECT_TO_STRING = Object.prototype.toString;

/**
 * A value whose conversion to text replaces `Object.prototype.toString` with a
 * function that returns an object, then throws: the next description attempt
 * gets an object, not text. The replacement puts the built-in back the first
 * time it runs, so the test process and the worker are not left changed.
 */
function retargetingToString(): object {
	return {
		[Symbol.toPrimitive]() {
			const current = Object.prototype.toString as (() => string) & { original?: () => string };
			const original = current.original ?? current;
			const replacement = Object.assign(
				() => {
					Object.prototype.toString = original;
					return Object.create(null);
				},
				{ original },
			);
			Object.prototype.toString = replacement as unknown as () => string;
			throw new Error("the value refuses conversion");
		},
	};
}

/** {@link retargetingToString}, built inside a JavaScript cell. */
const RETARGETING_TO_STRING_SOURCE =
	"({ [Symbol.toPrimitive]() { const current = Object.prototype.toString; const original = current.original ?? current; " +
	"const replacement = () => { Object.prototype.toString = original; return Object.create(null); }; " +
	'replacement.original = original; Object.prototype.toString = replacement; throw new Error("the value refuses conversion"); } })';

/**
 * Values a consumer may throw or reject with whose description is itself a
 * hazard: converting them to text or reading their message throws, or a
 * serializer cannot write them. `described` is how the cell's result names
 * each: a value whose text cannot be read is named without running its code.
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
		described: "[object Object]",
	},
	{
		label: "a value whose conversion replaces Object.prototype.toString",
		make: retargetingToString,
		described: "[object Object]",
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

/** A Proxy revoked before it is thrown: every operation on it, `instanceof` included, throws. */
function revokedProxy(): object {
	const revocable = Proxy.revocable({}, {});
	revocable.revoke();
	return revocable.proxy;
}

/**
 * An error whose `stack` getter returns text on its first read and a null-prototype
 * object on the next: code that checks the stack's type and then reads it again
 * gets an object it cannot search.
 */
function errorWithUnstableStack(): Error {
	let reads = 0;
	const error = new Error("unstable stack");
	Object.defineProperty(error, "stack", {
		get() {
			reads += 1;
			return reads % 2 === 1 ? "Error: unstable stack" : Object.create(null);
		},
	});
	return error;
}

/** An error behind a Proxy whose `get` and `has` traps throw: `instanceof Error` holds, yet reading any property fails. */
function errorProxy(): Error {
	const refuse = (): never => {
		throw new Error("the error proxy refuses every read");
	};
	return new Proxy(new Error("unused"), { get: refuse, has: refuse });
}

/**
 * Values whose description is a hazard: converting them to text, reading their
 * message, stack or any property, or testing their prototype fails, or a second
 * read of the stack answers differently from the first. `make` builds one in the
 * test process, for a tool to throw; `source` builds the same value inside a
 * JavaScript cell. `described` is how the result names each.
 */
const UNDESCRIBABLE_VALUES: ReadonlyArray<{ label: string; make: () => unknown; source: string; described: string }> = [
	{
		label: "a null-prototype object",
		make: () => Object.create(null),
		source: "Object.create(null)",
		described: "[object Object]",
	},
	{
		label: "an error whose message getter throws",
		make: errorWithThrowingMessage,
		source:
			'Object.defineProperty(new Error("unused"), "message", { get() { throw new Error("the message getter failed"); } })',
		described: "[object Error]",
	},
	{
		label: "a proxy that refuses every operation",
		make: hostileProxy,
		source:
			'new Proxy({}, new Proxy({}, { get: () => () => { throw new Error("the proxy refuses every operation"); } }))',
		described: "[object Object]",
	},
	{
		label: "a revoked proxy",
		make: revokedProxy,
		source: "(() => { const revocable = Proxy.revocable({}, {}); revocable.revoke(); return revocable.proxy; })()",
		described: "a thrown object that cannot be converted to text",
	},
	{
		label: "a value whose conversion replaces Object.prototype.toString",
		make: retargetingToString,
		source: RETARGETING_TO_STRING_SOURCE,
		described: "[object Object]",
	},
	{
		label: "an error whose stack is text on one read and an object on the next",
		make: errorWithUnstableStack,
		source:
			'(() => { let reads = 0; const error = new Error("unstable stack"); Object.defineProperty(error, "stack", { get() { reads += 1; return reads % 2 === 1 ? "Error: unstable stack" : Object.create(null); } }); return error; })()',
		described: "unstable stack",
	},
	{
		label: "an error proxy that refuses every read",
		make: errorProxy,
		source:
			'new Proxy(new Error("unused"), { get() { throw new Error("the error proxy refuses every read"); }, has() { throw new Error("the error proxy refuses every read"); } })',
		described: "[object Error]",
	},
];

/**
 * How a JavaScript cell can fail with a value: thrown before or after an await,
 * or left as an unawaited rejection while the cell still runs. The worker
 * attributes a floating rejection to the cell only while the cell is live, so
 * that cell outlives the rejection by a pause inside the real runtime.
 */
const CELL_FAILURES: ReadonlyArray<{ label: string; code: (source: string) => string }> = [
	{ label: "throws", code: source => `throw ${source};` },
	{ label: "throws, after an await,", code: source => `await Promise.resolve(); throw ${source};` },
	{
		label: "leaves an unawaited promise rejected with",
		code: source => `void Promise.reject(${source}); await new Promise(resolve => setTimeout(resolve, 300));`,
	},
];

/** An MCP tool whose call fails by throwing `make()`. */
function refusingTool(make: () => unknown): AgentTool {
	return {
		name: "mcp__fixture_refuse",
		label: "MCP fixture",
		description: "Fails with a value that cannot be described",
		parameters: type({}),
		mcpServerName: "fixture",
		async execute() {
			throw make();
		},
	} as AgentTool;
}

/** Calls the refusing tool and prints the error the cell receives. */
const CALL_REFUSING_TOOL: Record<Language, string> = {
	py: "try:\n    await tool.mcp__fixture_refuse({})\n    print('returned')\nexcept Exception as error:\n    print('caught', error)",
	js: "try { await tool.mcp__fixture_refuse({}); print('returned'); } catch (error) { print('caught', error.message); }",
};

/** A rejected native promise, observed by nothing yet, changed so that no ordinary way of handling it works. */
const NATIVE_PROMISE_SHAPES: ReadonlyArray<{ label: string; make: () => Promise<never> }> = [
	{
		label: "whose own then is null",
		make: () => {
			const promise = Promise.reject(new Error("the consumer's promise rejected"));
			Object.defineProperty(promise, "then", { value: null });
			return promise;
		},
	},
	{
		label: "whose then getter throws",
		make: () => {
			const promise = Promise.reject(new Error("the consumer's promise rejected"));
			Object.defineProperty(promise, "then", {
				get() {
					throw new Error("the then getter refused");
				},
			});
			return promise;
		},
	},
];

/** Thrown values that carry a rejected native promise one plain read reaches: describing each must observe it. */
const PROMISE_CARRYING_THROWS: ReadonlyArray<{ label: string; make: () => unknown }> = [
	{ label: "a rejected promise", make: () => Promise.reject(new Error("the thrown promise rejected")) },
	{
		label: "an error whose message getter returns a rejected promise",
		make: () => {
			const error = new Error("unused");
			Object.defineProperty(error, "message", {
				get: () => Promise.reject(new Error("the message promise rejected")),
			});
			return error;
		},
	},
	{
		label: "an error whose message getter throws a rejected promise",
		make: () => {
			const error = new Error("unused");
			Object.defineProperty(error, "message", {
				get() {
					throw Promise.reject(new Error("the thrown message promise rejected"));
				},
			});
			return error;
		},
	},
];

/**
 * What a Python exception's own code can raise while the kernel describes the
 * exception. Uncaught, each leaves by its own path: a `RuntimeError` or a
 * `GeneratorExit` ends the request without its `done` frame, so the cell waits
 * for its timeout; a `KeyboardInterrupt` or a `SystemExit` ends the kernel's
 * event loop, and with it the kernel.
 */
const DESCRIPTION_RAISES = ["RuntimeError", "KeyboardInterrupt", "SystemExit", "GeneratorExit"] as const;

/**
 * Places where describing a Python exception runs the exception's own code.
 * `code` raises an exception named `Unprintable` whose code at that place
 * raises `raised`.
 */
const DESCRIPTION_SITES: ReadonlyArray<{ label: string; code: (raised: string) => string }> = [
	{
		label: "an exception whose __str__ raises",
		code: raised =>
			`class Unprintable(Exception):\n    def __str__(self):\n        raise ${raised}()\n\nraise Unprintable()`,
	},
	{
		label: "an exception whose __notes__ raises",
		code: raised =>
			`class Unprintable(Exception):\n    @property\n    def __notes__(self):\n        raise ${raised}()\n\nraise Unprintable()`,
	},
	{
		label: "an exception whose class name raises",
		code: raised =>
			`class Nameless(type):\n    @property\n    def __name__(cls):\n        raise ${raised}()\n\n` +
			"class Unprintable(Exception, metaclass=Nameless):\n    pass\n\nraise Unprintable()",
	},
	{
		label: "a SyntaxError whose filename raises",
		code: raised =>
			`class Unprintable(SyntaxError):\n    @property\n    def filename(self):\n        raise ${raised}()\n\nraise Unprintable()`,
	},
	{
		label: "a ModuleNotFoundError whose name raises",
		code: raised =>
			`class Unprintable(ModuleNotFoundError):\n    @property\n    def name(self):\n        raise ${raised}()\n\nraise Unprintable()`,
	},
];

/**
 * Cells whose output the kernel renders by running a printed value's own code,
 * which raises `SystemExit`. Each prints `after` once that output is done.
 */
const RENDERING_REFUSALS: ReadonlyArray<{ label: string; code: string }> = [
	{
		label: "printed value's Markdown probe",
		code:
			"class Refuses:\n    def __str__(self):\n        return 'plain refuses'\n    def _repr_markdown_(self):\n        raise SystemExit(3)\n\n" +
			"print(Refuses())\nprint('after')",
	},
	{
		label: "printed list's JSON view",
		code:
			"class Opaque:\n    def __repr__(self):\n        return 'opaque'\n    def __str__(self):\n        raise SystemExit(3)\n\n" +
			"print([Opaque()] * 40)\nprint('after')",
	},
	{
		label: "printed dict's image probe",
		code:
			"class Refuses(dict):\n    def get(self, key, default=None):\n        raise SystemExit(3)\n\n" +
			"print(Refuses(a=1))\nprint('after')",
	},
	{
		label: "status event",
		code:
			"class Unrepresentable:\n    def __repr__(self):\n        raise SystemExit(3)\n\n" +
			"__omp_emit_status('probe', value=Unrepresentable())\nprint('after')",
	},
];

/**
 * Prints a value whose Markdown probe announces itself, then sleeps: an
 * interrupt sent on the announcement lands inside the probe.
 */
const SLOW_PROBE =
	"import time\n\nclass Slow:\n    def _repr_markdown_(self):\n        print('probing', flush=True)\n        time.sleep(30)\n        return 'never'\n\n" +
	"print(Slow())\nprint('after')";

/** Kernel tools whose failure or result the kernel describes by running the tool's own values' code. */
const DESCRIBED_KERNEL_TOOLS = [
	"@tool",
	"def refuses() -> str:",
	'    """Raises an exception that cannot describe itself."""',
	"    class Unprintable(Exception):",
	"        def __str__(self):",
	"            raise KeyboardInterrupt()",
	"    raise Unprintable()",
	"",
	"@tool",
	"def unrepresentable() -> str:",
	'    """Returns a value whose repr raises."""',
	"    class Unrepresentable:",
	"        def __repr__(self):",
	"            raise SystemExit(3)",
	"    return Unrepresentable()",
].join("\n");

/**
 * A consumer result whose `then` getter returns a method that rejects with
 * `reason` on its first read, and nothing on later reads: a caller that tests
 * for a thenable and then reads `then` again finds no method to call.
 */
function thenableOnFirstRead(reason: unknown): PromiseLike<void> {
	let reads = 0;
	const thenable = {
		// oxlint-disable-next-line unicorn/no-thenable -- the consumer result under test is a thenable on purpose
		get then() {
			reads += 1;
			if (reads > 1) return undefined;
			return (_onFulfilled: unknown, onRejected?: (reason: unknown) => void) => onRejected?.(reason);
		},
	};
	return thenable as unknown as PromiseLike<void>;
}

/** A consumer result whose `then` is async and throws `reason`: it calls back neither callback, and rejects the promise it returns. */
function asyncThenThatThrows(reason: unknown): PromiseLike<void> {
	const thenable = {
		// oxlint-disable-next-line unicorn/no-thenable -- the consumer result under test is a thenable on purpose
		async then() {
			throw reason;
		},
	};
	return thenable as unknown as PromiseLike<void>;
}

/**
 * Collects the host's unhandled rejections while `body` runs. The runtime
 * reports one once the microtask queue drains, so one macrotask turn after
 * `body` settles is enough for a rejection `body` left behind to be seen.
 */
async function unhandledRejectionsDuring(body: () => Promise<void>): Promise<unknown[]> {
	const seen: unknown[] = [];
	const listener = (reason: unknown): void => {
		seen.push(reason);
	};
	process.on("unhandledRejection", listener);
	try {
		await body();
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
	} finally {
		process.off("unhandledRejection", listener);
	}
	return seen;
}

/** An error whose `message` getter answers `read <n>` on its n-th read, and whose `stack` getter throws. */
function errorWithCountingMessage(reads: { count: number }): Error {
	const error = new Error("unused");
	Object.defineProperty(error, "message", {
		get() {
			reads.count += 1;
			return `read ${reads.count}`;
		},
	});
	Object.defineProperty(error, "stack", {
		get() {
			throw new Error("the stack getter failed");
		},
	});
	return error;
}

/** {@link errorWithCountingMessage}, built inside a JavaScript cell; `messageReads()` returns its count. */
const COUNTING_MESSAGE_SOURCE =
	'(() => { let reads = 0; globalThis.messageReads = () => reads; const error = new Error("unused"); ' +
	'Object.defineProperty(error, "message", { get() { reads += 1; return "read " + reads; } }); ' +
	'Object.defineProperty(error, "stack", { get() { throw new Error("the stack getter failed"); } }); return error; })()';

/** A Python exception whose `__notes__` never end: each note takes a millisecond, so a reader that never stops grows slowly. */
const ENDLESS_NOTES_EXCEPTION =
	"import time\n\nclass Endless(list):\n    def __iter__(self):\n        while True:\n            time.sleep(0.001)\n            yield 'note'\n\n" +
	"def endless_error(text):\n    error = ValueError(text)\n    error.__notes__ = Endless()\n    return error\n";

describe("eval output consumer failure", () => {
	afterEach(async () => {
		await Promise.all([disposeAllKernelSessions(), disposeAllVmContexts()]);
	});

	for (const language of LANGUAGES) {
		it.skipIf(skipped(language))(
			`${language}: a consumer that throws mid-cell leaves the cell, the runtime and its variables intact, and is reported`,
			async () => {
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
				// It opens with the cell's own output, so a line the runtime leads with keeps its place.
				expect(failed.output.startsWith("one\ntwo\n")).toBe(true);
				// The consumer kept receiving the cell's later output.
				expect(delivered.join("")).toContain("two");
				// The failure reaches the caller when the cell is done, naming the consumer and the risk.
				expectConsumerFailure(failed, "stream", "consumer refused a chunk");
				expect(failed.output).toContain("this result holds all of its output");
				expect(failed.output).toContain("output shown while it ran may be incomplete");
				// Same process, state intact.
				expect(pidOf(after)).toBe(pidOf(before));
				expect(after.output).toContain("kept 42");
			},
			120_000,
		);

		it.skipIf(skipped(language))(
			`${language}: an async consumer that rejects after an await leaves the cell, the runtime and its variables intact, and is reported`,
			async () => {
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
			},
			120_000,
		);

		it.skipIf(skipped(language))(
			`${language}: a consumer that throws on the final newline the result adds is reported, and the cell still succeeds`,
			async () => {
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
			},
			120_000,
		);

		it.skipIf(skipped(language))(
			`${language}: a consumer that throws on every chunk of a failing cell still gets a result with the cell's error`,
			async () => {
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
			},
			120_000,
		);

		it.skipIf(skipped(language))(
			`${language}: a truncated result does not claim to hold all of the output, and names the artifact when one was saved`,
			async () => {
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
			},
			120_000,
		);

		it.skipIf(skipped(language))(
			`${language}: a status consumer that throws during a bridged tool's progress leaves the tool call and the cell intact, and is reported`,
			async () => {
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
			},
			120_000,
		);

		it.skipIf(skipped(language))(
			`${language}: a status consumer that turns a field of its event into a throwing getter, then throws, changes nothing the executor keeps`,
			async () => {
				const session = makeSession(`consumer-mutates-${language}-${crypto.randomUUID()}`, progressTool());
				const cell = await run(session, language, CALL_PROGRESS_TOOL[language], {
					onStatus: event => {
						if (event.op !== "mcp_progress") return;
						Object.defineProperty(event, "op", {
							configurable: true,
							get() {
								throw new Error("the mutated field refuses every read");
							},
						});
						throw new Error("status consumer refused progress");
					},
				});

				expect(cell.cancelled).toBe(false);
				expect(cell.exitCode).toBe(0);
				expect(cell.output).toContain("tool-complete");
				expect(cell.output).not.toContain("the mutated field refuses every read");
				expect(cell.output).not.toContain("Delivering the cell's output failed");
				expectConsumerFailure(cell, "display", "status consumer refused progress");
			},
			120_000,
		);

		for (const shape of NATIVE_PROMISE_SHAPES) {
			it.skipIf(skipped(language))(
				`${language}: a consumer that returns a rejected native promise ${shape.label} is reported, and the cell and host go on`,
				async () => {
					const session = makeSession(`consumer-promise-${language}-${crypto.randomUUID()}`);
					const cell = await run(session, language, TWO_LINES[language], {
						onChunk: chunk => (printsLine(chunk, "one") ? shape.make() : undefined),
					});

					expect(cell.cancelled).toBe(false);
					expect(cell.exitCode).toBe(0);
					expect(printsLine(cell.output, "two")).toBe(true);
					expect(cell.output).toContain("The stream output consumer failed:");
				},
				120_000,
			);
		}

		it.skipIf(skipped(language))(
			`${language}: a consumer that fails once, then throws rejected promises, leaves nothing unhandled`,
			async () => {
				const unhandled: unknown[] = [];
				const onUnhandled = (reason: unknown): void => {
					unhandled.push(reason);
				};
				process.on("unhandledRejection", onUnhandled);
				try {
					const session = makeSession(`consumer-later-promise-${language}-${crypto.randomUUID()}`);
					const cell = await run(session, language, TWO_LINES[language], {
						onChunk: chunk => {
							if (printsLine(chunk, "one")) throw new Error("the first failure");
							throw Promise.reject(new Error("a later failure's promise rejected"));
						},
					});
					// Unhandled rejections are reported after the microtask queue drains.
					await Bun.sleep(50);
					expect(cell.exitCode).toBe(0);
					expect(printsLine(cell.output, "two")).toBe(true);
					expectConsumerFailure(cell, "stream", "the first failure");
					expect(unhandled).toEqual([]);
				} finally {
					process.off("unhandledRejection", onUnhandled);
				}
			},
			120_000,
		);

		for (const shape of PROMISE_CARRYING_THROWS) {
			it.skipIf(skipped(language))(
				`${language}: a consumer that throws ${shape.label} is reported, and nothing is left unhandled`,
				async () => {
					const unhandled: unknown[] = [];
					const onUnhandled = (reason: unknown): void => {
						unhandled.push(reason);
					};
					process.on("unhandledRejection", onUnhandled);
					try {
						const session = makeSession(`consumer-promise-throw-${language}-${crypto.randomUUID()}`);
						const cell = await run(session, language, TWO_LINES[language], {
							onChunk: chunk => {
								if (printsLine(chunk, "one")) throw shape.make();
							},
						});
						// Unhandled rejections are reported after the microtask queue drains.
						await Bun.sleep(50);
						expect(cell.exitCode).toBe(0);
						expect(printsLine(cell.output, "two")).toBe(true);
						expect(cell.output).toContain("The stream output consumer failed:");
						expect(unhandled).toEqual([]);
					} finally {
						process.off("unhandledRejection", onUnhandled);
					}
				},
				120_000,
			);
		}

		it.skipIf(skipped(language))(
			`${language}: hostile consumers leave the host's own unhandledRejection and uncaughtException listeners as they were`,
			async () => {
				const rejectionListeners = process.listeners("unhandledRejection");
				const exceptionListeners = process.listeners("uncaughtException");
				const session = makeSession(`consumer-listeners-${language}-${crypto.randomUUID()}`);
				const refusingPromise = (): Promise<never> => {
					const refusing = Promise.reject(new Error("the refusing promise rejected"));
					// Handled here: this row checks the listeners, not this promise's fate (outside the guarantee).
					refusing.catch(() => {});
					Object.defineProperty(refusing, "constructor", {
						get() {
							throw new Error("the constructor getter refused");
						},
					});
					return refusing;
				};
				// Each value is made when the consumer returns it, as a real consumer would.
				const factories: Array<() => unknown> = [
					...NATIVE_PROMISE_SHAPES.map(shape => shape.make),
					refusingPromise,
					...PROMISE_CARRYING_THROWS.map(shape => () => Promise.reject(shape.make())),
				];
				for (const make of factories) {
					await run(session, language, TWO_LINES[language], {
						onChunk: chunk => (printsLine(chunk, "one") ? make() : undefined),
					});
				}
				expect(process.listeners("unhandledRejection")).toEqual(rejectionListeners);
				expect(process.listeners("uncaughtException")).toEqual(exceptionListeners);
			},
			240_000,
		);

		it.skipIf(skipped(language))(
			`${language}: a cell whose consumer does not throw is unchanged`,
			async () => {
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
			},
			120_000,
		);

		it.skipIf(skipped(language))(
			`${language}: a consumer that returns a thenable whose then getter answers once is reported with the thenable's own rejection`,
			async () => {
				const session = makeSession(`consumer-thenable-${language}-${crypto.randomUUID()}`);
				const cell = await run(session, language, TWO_LINES[language], {
					onChunk: chunk =>
						printsLine(chunk, "one") ? thenableOnFirstRead(new Error("consumer refused a chunk")) : undefined,
				});

				expect(cell.cancelled).toBe(false);
				expect(cell.exitCode).toBe(0);
				// The failure is the thenable's own rejection, not the error of calling a `then` read a second time.
				expectConsumerFailure(cell, "stream", "consumer refused a chunk");
			},
			120_000,
		);

		it.skipIf(skipped(language))(
			`${language}: a consumer whose thenable has an async then that throws is reported, and leaves no unhandled rejection`,
			async () => {
				const session = makeSession(`consumer-async-then-${language}-${crypto.randomUUID()}`);
				let cell: Cell | undefined;
				const unhandled = await unhandledRejectionsDuring(async () => {
					cell = await run(session, language, TWO_LINES[language], {
						onChunk: chunk =>
							printsLine(chunk, "one") ? asyncThenThatThrows(new Error("then refused")) : undefined,
					});
				});

				expect(unhandled).toEqual([]);
				expect(cell?.exitCode).toBe(0);
				// The rejection of the promise that `then` returned is the consumer's failure.
				expectConsumerFailure(cell!, "stream", "then refused");
			},
			120_000,
		);

		it.skipIf(skipped(language))(
			`${language}: a cell that times out after its consumer refused a printed line reports the failure without claiming the cell ran on`,
			async () => {
				const session = makeSession(`consumer-timeout-${language}-${crypto.randomUUID()}`);
				// Start the runtime first, so a slow kernel or worker start cannot delay the printed line.
				const warm = await run(session, language, PID_CELL[language]);
				expect(warm.exitCode).toBe(0);
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
					// No wall-clock timeout of the cell's own: only the refused line times it out, and the
					// cell prints that line before its 30-second sleep, so it is always seen first.
					timeoutMs: undefined,
				});

				expect(refusedLine).toBe(true);
				expect(cell.cancelled).toBe(true);
				// The executor took its timeout path, not a plain cancellation.
				expect(cell.output).toContain("timed out");
				expectConsumerFailure(cell, "stream", "consumer refused a chunk");
				expect(cell.output).not.toContain("kept running");
				expect(cell.output).not.toContain("holds all of its output");
			},
			120_000,
		);
	}
});

describe("runtime output callback failure", () => {
	afterEach(async () => {
		await disposeAllVmContexts();
	});

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: the kernel reports an async output callback that rejects, and finishes the execution",
		async () => {
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
		},
		120_000,
	);

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: the kernel reports an async output callback that rejects its exit message",
		async () => {
			const kernel = await PythonKernel.start({ cwd: process.cwd() });
			try {
				const result = await kernel.execute(
					"import os, time\nprint('pid', os.getpid(), flush=True)\ntime.sleep(30)",
					{
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
					},
				);

				expect(result.cancelled).toBe(true);
				expect(result.kernelKilled).toBe(true);
				expect(result.consumerFailure).toEqual({
					callback: "onChunk",
					message: "callback rejected the exit message",
				});
			} finally {
				await kernel.shutdown();
			}
		},
		120_000,
	);

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

	it("js: the context manager reports the rejection of a thenable whose then getter answers once", async () => {
		const session = makeSession(`runtime-thenable-js-${crypto.randomUUID()}`);
		const sessionId = session.getEvalSessionId?.() ?? "missing";
		const runState: VmRunState = {
			// The run state's callback type returns void; a callback that returns a thenable must be accepted all the same.
			onText: (text =>
				printsLine(text, "one") ? thenableOnFirstRead(new Error("callback refused")) : undefined) as (
				text: string,
			) => void,
		};

		await executeInVmContext({
			sessionKey: sessionId,
			sessionId,
			cwd: session.cwd,
			session,
			code: TWO_LINES.js,
			filename: "runtime-thenable.js",
			timeoutMs: 20_000,
			runState,
		});

		expect(runState.consumerFailure).toEqual({ callback: "onChunk", message: "callback refused" });
	}, 120_000);

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: the kernel reports an output callback whose thenable has an async then that throws, and keeps serving",
		async () => {
			const kernel = await PythonKernel.start({ cwd: process.cwd() });
			try {
				let result: KernelExecuteResult | undefined;
				const unhandled = await unhandledRejectionsDuring(async () => {
					result = await kernel.execute(TWO_LINES.py, {
						onChunk: (text =>
							printsLine(text, "one") ? asyncThenThatThrows(new Error("then refused")) : undefined) as (
							text: string,
						) => Promise<void>,
						// Bounds the red case, where awaiting the thenable stalls the reader and the execution never settles.
						timeoutMs: 20_000,
					});
				});
				const chunks: string[] = [];
				await kernel.execute(READ_KEPT.py, { onChunk: text => void chunks.push(text) });

				expect(unhandled).toEqual([]);
				expect(result?.status).toBe("ok");
				expect(result?.consumerFailure).toEqual({ callback: "onChunk", message: "then refused" });
				expect(chunks.join("")).toBe("kept 42\n");
			} finally {
				await kernel.shutdown();
			}
		},
		120_000,
	);

	it("js: the context manager reports an output callback whose thenable has an async then that throws", async () => {
		const session = makeSession(`runtime-async-then-js-${crypto.randomUUID()}`);
		const sessionId = session.getEvalSessionId?.() ?? "missing";
		const runState: VmRunState = {
			// The run state's callback type returns void; a callback that returns a thenable must be accepted all the same.
			onText: (text => (printsLine(text, "one") ? asyncThenThatThrows(new Error("then refused")) : undefined)) as (
				text: string,
			) => void,
		};

		const unhandled = await unhandledRejectionsDuring(async () => {
			await executeInVmContext({
				sessionKey: sessionId,
				sessionId,
				cwd: session.cwd,
				session,
				code: TWO_LINES.js,
				filename: "runtime-async-then.js",
				timeoutMs: 20_000,
				runState,
			});
		});

		expect(unhandled).toEqual([]);
		expect(runState.consumerFailure).toEqual({ callback: "onChunk", message: "then refused" });
	}, 120_000);
});

describe("output consumer failure with an arbitrary thrown value", () => {
	afterEach(async () => {
		Object.prototype.toString = OBJECT_TO_STRING;
		await Promise.all([disposeAllKernelSessions(), disposeAllVmContexts()]);
	});

	for (const thrown of THROWN_VALUES) {
		for (const language of LANGUAGES) {
			for (const mode of ["throws", "rejects with"] as const) {
				it.skipIf(skipped(language))(
					`${language}: a consumer that ${mode} ${thrown.label} leaves the cell, the runtime and its variables intact, and is reported`,
					async () => {
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
					},
					120_000,
				);
			}
		}
	}
});

describe("runtime output callback failure with an arbitrary thrown value", () => {
	afterEach(async () => {
		Object.prototype.toString = OBJECT_TO_STRING;
		await disposeAllVmContexts();
	});

	for (const thrown of THROWN_VALUES) {
		it.skipIf(!PYTHON_INTEGRATION)(
			`py: the kernel reports an output callback that rejects with ${thrown.label}, and keeps serving`,
			async () => {
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
			},
			120_000,
		);

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

describe("a cell or tool failing with a value that cannot be described", () => {
	afterEach(async () => {
		Object.prototype.toString = OBJECT_TO_STRING;
		await Promise.all([disposeAllKernelSessions(), disposeAllVmContexts()]);
	});

	for (const value of UNDESCRIBABLE_VALUES) {
		for (const failure of CELL_FAILURES) {
			it(`js: a cell that ${failure.label} ${value.label} fails at once, and the worker keeps its variables`, async () => {
				const session = makeSession(`cell-thrown-js-${crypto.randomUUID()}`);
				const before = await run(session, "js", `${PID_CELL.js}\nvar kept = 42;`);

				const failed = await run(session, "js", failure.code(value.source));
				const after = await run(session, "js", `${PID_CELL.js}\n${READ_KEPT.js}`);

				// The cell failed by itself, instead of waiting for its timeout to kill the worker.
				expect(failed.cancelled).toBe(false);
				expect(failed.exitCode).toBe(1);
				expect(failed.output).toContain(value.described);
				expect(pidOf(after)).toBe(pidOf(before));
				expect(after.output).toContain("kept 42");
			}, 120_000);
		}

		for (const language of LANGUAGES) {
			it.skipIf(skipped(language))(
				`${language}: a tool that throws ${value.label} fails the call with a description, and the runtime keeps its variables`,
				async () => {
					const session = makeSession(`tool-thrown-${language}-${crypto.randomUUID()}`, refusingTool(value.make));
					const before = await run(
						session,
						language,
						`${PID_CELL[language]}\n${language === "py" ? "kept = 42" : "var kept = 42;"}`,
					);

					const cell = await run(session, language, CALL_REFUSING_TOOL[language]);
					const after = await run(session, language, `${PID_CELL[language]}\n${READ_KEPT[language]}`);

					expect(cell.cancelled).toBe(false);
					expect(cell.exitCode).toBe(0);
					expect(cell.output).toContain("caught");
					expect(cell.output).toContain(value.described);
					expect(pidOf(after)).toBe(pidOf(before));
					expect(after.output).toContain("kept 42");
				},
				120_000,
			);
		}
	}

	for (const site of DESCRIPTION_SITES) {
		for (const raised of DESCRIPTION_RAISES) {
			it.skipIf(!PYTHON_INTEGRATION)(
				`py: a cell that raises ${site.label} ${raised} fails at once, and the kernel keeps its variables`,
				async () => {
					const session = makeSession(`cell-unprintable-py-${crypto.randomUUID()}`);
					const before = await run(session, "py", `${PID_CELL.py}\nkept = 42`);

					const failed = await run(session, "py", site.code(raised));
					const after = await run(session, "py", `${PID_CELL.py}\n${READ_KEPT.py}`);

					// The cell failed by itself, instead of waiting for its timeout to interrupt or kill the kernel.
					expect(failed.cancelled).toBe(false);
					expect(failed.exitCode).toBe(1);
					expect(failed.output).toContain("Unprintable");
					expect(pidOf(after)).toBe(pidOf(before));
					expect(after.output).toContain("kept 42");
				},
				120_000,
			);
		}
	}

	for (const refusal of RENDERING_REFUSALS) {
		it.skipIf(!PYTHON_INTEGRATION)(
			`py: a cell whose ${refusal.label} raises SystemExit runs on, and the kernel keeps its variables`,
			async () => {
				const session = makeSession(`rendering-refusal-py-${crypto.randomUUID()}`);
				const before = await run(session, "py", `${PID_CELL.py}\nkept = 42`);

				const cell = await run(session, "py", refusal.code);
				const after = await run(session, "py", `${PID_CELL.py}\n${READ_KEPT.py}`);

				expect(cell.cancelled).toBe(false);
				expect(cell.exitCode).toBe(0);
				expect(printsLine(cell.output, "after")).toBe(true);
				expect(pidOf(after)).toBe(pidOf(before));
				expect(after.output).toContain("kept 42");
			},
			120_000,
		);
	}

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: an interrupt that lands while print inspects a value stops the cell, and the kernel keeps its variables",
		async () => {
			const session = makeSession(`probe-interrupt-py-${crypto.randomUUID()}`);
			const before = await run(session, "py", `${PID_CELL.py}\nkept = 42`);

			const interrupt = new AbortController();
			const cell = await run(session, "py", SLOW_PROBE, {
				onChunk: chunk => {
					if (printsLine(chunk, "probing")) interrupt.abort();
				},
				signal: interrupt.signal,
			});
			const after = await run(session, "py", `${PID_CELL.py}\n${READ_KEPT.py}`);

			expect(cell.cancelled).toBe(true);
			// The interrupt stopped the cell inside the probe; a probe that kept it would let the cell print on.
			expect(printsLine(cell.output, "after")).toBe(false);
			expect(pidOf(after)).toBe(pidOf(before));
			expect(after.output).toContain("kept 42");
		},
		120_000,
	);

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: a kernel tool that raises an exception whose __str__ raises KeyboardInterrupt fails with that exception's name, and the kernel keeps serving",
		async () => {
			const kernel = await PythonKernel.start({ cwd: process.cwd() });
			try {
				const defined = await kernel.execute(DESCRIBED_KERNEL_TOOLS);
				expect(defined.status).toBe("ok");

				const failed = await kernel.invokeTool({ op: "call", name: "refuses", args: {} });
				const chunks: string[] = [];
				await kernel.execute("kept = 42\nprint('kept', kept)", { onChunk: text => void chunks.push(text) });

				expect(failed.status).toBe("error");
				expect(failed.error?.name).toBe("Unprintable");
				expect(kernel.isAlive()).toBe(true);
				expect(chunks.join("")).toBe("kept 42\n");
			} finally {
				await kernel.shutdown();
			}
		},
		120_000,
	);

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: a kernel tool that returns a value whose repr raises SystemExit returns a placeholder, and the kernel keeps serving",
		async () => {
			const kernel = await PythonKernel.start({ cwd: process.cwd() });
			try {
				const defined = await kernel.execute(DESCRIBED_KERNEL_TOOLS);
				expect(defined.status).toBe("ok");

				const result = await kernel.invokeTool({ op: "call", name: "unrepresentable", args: {} });
				const chunks: string[] = [];
				await kernel.execute("kept = 42\nprint('kept', kept)", { onChunk: text => void chunks.push(text) });

				expect(result.status).toBe("ok");
				expect(result.reply).toEqual({ ok: true, value: "<unrepr Unrepresentable>" });
				expect(kernel.isAlive()).toBe(true);
				expect(chunks.join("")).toBe("kept 42\n");
			} finally {
				await kernel.shutdown();
			}
		},
		120_000,
	);
});

describe("a value read once, and a failure after its cell finished", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all([disposeAllKernelSessions(), disposeAllVmContexts()]);
	});

	it("js: a cell that throws an error whose stack getter throws is described with one read of its message", async () => {
		const session = makeSession(`counting-message-js-${crypto.randomUUID()}`);
		const failed = await run(session, "js", `throw ${COUNTING_MESSAGE_SOURCE};`);
		const after = await run(session, "js", "print('reads', messageReads())");

		expect(failed.exitCode).toBe(1);
		expect(failed.output).toContain("read 1");
		expect(failed.output).not.toContain("read 2");
		expect(after.output).toContain("reads 1");
	}, 120_000);

	for (const language of LANGUAGES) {
		it.skipIf(skipped(language))(
			`${language}: a tool that throws an error whose stack getter throws is described once for its status and its reply`,
			async () => {
				const reads = { count: 0 };
				const tool = refusingTool(() => errorWithCountingMessage(reads));
				const session = makeSession(`counting-tool-${language}-${crypto.randomUUID()}`, tool);
				const cell = await run(session, language, CALL_REFUSING_TOOL[language]);

				expect(cell.exitCode).toBe(0);
				expect(reads.count).toBe(1);
				expect(cell.output).toContain("read 1");
				expect(cell.output).not.toContain("read 2");
			},
			120_000,
		);
	}

	it("js: a cell that throws a value whose description floats a rejection fails, and the worker keeps its variables", async () => {
		const session = makeSession(`floating-description-js-${crypto.randomUUID()}`);
		const before = await run(session, "js", `${PID_CELL.js}\nvar kept = 42;`);
		const failed = await run(
			session,
			"js",
			// describeError() reads an error's message, so the getter floats its rejection while the worker describes it.
			'const error = new Error("unused"); Object.defineProperty(error, "message", { get() { void Promise.reject(Object.create(null)); return "described"; } }); throw error;',
		);
		const after = await run(session, "js", `${PID_CELL.js}\n${READ_KEPT.js}`);

		expect(failed.exitCode).toBe(1);
		expect(failed.output).toContain("described");
		expect(pidOf(after)).toBe(pidOf(before));
		expect(after.output).toContain("kept 42");
	}, 120_000);

	it("js: a rejection floated after its cell finished is logged on the host, and the worker keeps its variables", async () => {
		const reported = Promise.withResolvers<unknown>();
		vi.spyOn(logger, "warn").mockImplementation((message: string, meta?: Record<string, unknown>) => {
			if (message === "Unhandled rejection after every eval cell finished (missing await?)") reported.resolve(meta);
		});
		const session = makeSession(`late-rejection-js-${crypto.randomUUID()}`);
		const before = await run(
			session,
			"js",
			`${PID_CELL.js}\nvar kept = 42;\nsetTimeout(() => { void Promise.reject(Object.create(null)); }, 50);`,
		);
		// A cell started before the rejection surfaced would own it, so wait for the report itself.
		const meta = await reported.promise;
		const after = await run(session, "js", `${PID_CELL.js}\n${READ_KEPT.js}`);

		expect(before.exitCode).toBe(0);
		expect(meta).toMatchObject({ error: { message: "[object Object]" } });
		expect(pidOf(after)).toBe(pidOf(before));
		expect(after.output).toContain("kept 42");
	}, 120_000);

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: a cell that raises an exception whose notes never end fails at once with no timeout, and the kernel keeps its variables",
		async () => {
			const session = makeSession(`endless-notes-py-${crypto.randomUUID()}`);
			const before = await run(session, "py", `${PID_CELL.py}\nkept = 42`);
			const failed = await run(session, "py", `${ENDLESS_NOTES_EXCEPTION}\nraise endless_error('endless notes')`, {
				timeoutMs: undefined,
			});
			const after = await run(session, "py", `${PID_CELL.py}\n${READ_KEPT.py}`);

			expect(failed.cancelled).toBe(false);
			expect(failed.exitCode).toBe(1);
			expect(failed.output).toContain("ValueError: endless notes");
			expect(failed.output).toContain("further notes not shown");
			expect(pidOf(after)).toBe(pidOf(before));
			expect(after.output).toContain("kept 42");
		},
		120_000,
	);

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: a background task that fails after its cell with an exception whose notes never end is reported, and the kernel keeps serving",
		async () => {
			const logged: string[] = [];
			const reportLogged = Promise.withResolvers<void>();
			vi.spyOn(logger, "warn").mockImplementation((message: string, meta?: Record<string, unknown>) => {
				if (message !== "Python runner stderr") return;
				logged.push(String(meta?.text));
				if (logged.join("\n").includes("further notes not shown")) reportLogged.resolve();
			});
			const session = makeSession(`background-failure-py-${crypto.randomUUID()}`);
			const before = await run(session, "py", `${PID_CELL.py}\nkept = 42`);
			// Nothing awaits the task, so once it fails the event loop reports its exception, after this cell returned.
			const started = await run(
				session,
				"py",
				`${ENDLESS_NOTES_EXCEPTION}\nimport asyncio\n\nasync def fail():\n    raise endless_error('background failure')\n\nasyncio.ensure_future(fail())\nprint('started')`,
				{ timeoutMs: undefined },
			);
			// The collector runs first, so a task nobody kept is reported by the time this cell prints.
			const after = await run(session, "py", `import gc\ngc.collect()\n${PID_CELL.py}\n${READ_KEPT.py}`, {
				timeoutMs: undefined,
			});
			// Reported on the stderr of the cell running at the time; with none running, on the host's log,
			// which the host reads from the kernel's stderr as it arrives.
			if (!after.output.includes("Task exception was never retrieved")) await reportLogged.promise;
			const reports = [started.output, after.output, ...logged].join("\n");

			expect(started.exitCode).toBe(0);
			expect(pidOf(after)).toBe(pidOf(before));
			expect(after.output).toContain("kept 42");
			expect(reports).toContain("Task exception was never retrieved");
			expect(reports).toContain("further notes not shown");
		},
		120_000,
	);
});

describe("cancellation checks and descriptions read a thrown value or abort reason only through describeError", () => {
	class Cancelled extends Error {
		constructor(readonly timedOut: boolean) {
			super("cancelled");
		}
	}
	const aborted = (reason: unknown): AbortSignal => {
		const controller = new AbortController();
		controller.abort(reason);
		return controller.signal;
	};

	it("answers no, without throwing, for a Proxy or an error proxy as the value or the abort reason", () => {
		for (const make of [hostileProxy, errorProxy]) {
			expect(isCancellationError(make(), Cancelled)).toBe(false);
			expect(isTimedOutCancellation(make(), Cancelled, aborted(make()))).toBe(false);
		}
	});

	it("answers no for a cancellation whose timedOut getter throws, and still recognises real timeouts", () => {
		const refusing = new Cancelled(true);
		Object.defineProperty(refusing, "timedOut", {
			get() {
				throw new Error("timedOut refuses");
			},
		});
		expect(isCancellationError(refusing, Cancelled)).toBe(true);
		expect(isTimedOutCancellation(refusing, Cancelled)).toBe(false);
		expect(isTimedOutCancellation(new Cancelled(true), Cancelled)).toBe(true);
		const timeout = new DOMException("late", "TimeoutError");
		expect(isCancellationError(timeout, Cancelled)).toBe(true);
		expect(isTimedOutCancellation(new Error("other"), Cancelled, aborted(timeout))).toBe(true);
	});

	const SLEEPING_CELL: Record<Language, string> = {
		py: "import time\nkept = 42\nprint('started', flush=True)\ntime.sleep(30)\nprint('after')",
		js: "globalThis.kept = 42;\nprint('started');\nawait new Promise(resolve => setTimeout(resolve, 30_000));\nprint('after');",
	};

	for (const language of LANGUAGES) {
		it.skipIf(skipped(language))(
			`${language}: a cell aborted mid-run with a Proxy reason whose traps throw comes back cancelled, and the runtime keeps serving`,
			async () => {
				const session = makeSession(`hostile-abort-${language}-${crypto.randomUUID()}`);
				const interrupt = new AbortController();
				const cell = await run(session, language, SLEEPING_CELL[language], {
					onChunk: chunk => {
						if (printsLine(chunk, "started")) interrupt.abort(hostileProxy());
					},
					signal: interrupt.signal,
				});
				const after = await run(session, language, "print('next', 1 + 1)");

				expect(cell.cancelled).toBe(true);
				expect(printsLine(cell.output, "after")).toBe(false);
				expect(after.exitCode).toBe(0);
				expect(after.output).toContain("next 2");
				if (language === "py") expect((await run(session, "py", READ_KEPT.py)).output).toContain("kept 42");
			},
			120_000,
		);

		it.skipIf(skipped(language))(
			`${language}: a call whose signal was already aborted with such a Proxy returns a cancelled result instead of rejecting`,
			async () => {
				const session = makeSession(`hostile-preabort-${language}-${crypto.randomUUID()}`);
				const cell = await run(session, language, "print('ran')", { signal: aborted(hostileProxy()) });
				expect(cell.cancelled).toBe(true);
				expect(printsLine(cell.output, "ran")).toBe(false);
			},
			120_000,
		);
	}

	it("describes an error whose message getter returns the error itself with one read of that getter", () => {
		// `Error.prototype.toString` on such a message reads the getter again, until the stack overflows.
		let reads = 0;
		const error = new TypeError("unused");
		Object.defineProperty(error, "message", {
			get() {
				reads += 1;
				return error;
			},
		});
		const description = describeError(error);
		expect(reads).toBe(1);
		expect(description.message).toBe("[object Error]");
		expect(description.name).toBe("TypeError");
	});

	it("describes another realm's error as an error, reading its self-returning message getter once", () => {
		let reads = 0;
		const foreign = vm.runInNewContext('new RangeError("foreign")') as object;
		Object.defineProperty(foreign, "message", {
			get() {
				reads += 1;
				return foreign;
			},
		});
		const description = describeError(foreign);
		expect(reads).toBe(1);
		expect(description.errorClass).toBe("Error");
		expect(description.name).toBe("RangeError");
		expect(description.message).toBe("[object Error]");
	});

	it("does not convert a Proxy whose prototype cannot be read, so its self-returning name getter is never read", () => {
		let reads = 0;
		const target = new Error("hidden");
		Object.defineProperty(target, "name", {
			get() {
				reads += 1;
				return proxy;
			},
		});
		const proxy: object = new Proxy(target, {
			getPrototypeOf() {
				throw new Error("the prototype refuses to be read");
			},
		});
		expect(describeError(proxy).message).toBe("[object Object]");
		expect(reads).toBe(0);
	});

	it("leaves no rejection unhandled when an error's fields are rejected promises", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const error = new Error("unused");
			for (const key of ["message", "name", "stack", "code", "syscall"]) {
				Object.defineProperty(error, key, { get: () => Promise.reject(new Error(`${key} rejected`)) });
			}
			expect(describeError(error).message).toBe("[object Error]");
			// Unhandled rejections are reported after the microtask queue drains.
			await Bun.sleep(50);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("leaves no rejection unhandled for promises one plain read reaches: a nested reason, a then field, a prototype, a cleanup cause", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const rejected = (label: string): Promise<never> => Promise.reject(new Error(label));
			// A rejection whose reason is itself a rejected promise.
			describeError(Promise.reject(rejected("nested reason")));
			// A thenable whose `then` getter returns a rejected promise instead of a function.
			catchRejection(Object.defineProperty({}, "then", { get: () => rejected("then field") }), () => {});
			// A Proxy whose `getPrototypeOf` trap returns a rejected promise.
			describeError(new Proxy({}, { getPrototypeOf: () => rejected("prototype") }));
			// A cleanup check whose `cause` getter returns a rejected promise.
			const error = new Error("unused");
			Object.defineProperty(error, "cause", { get: () => rejected("cleanup cause") });
			postmortem.isExpectedCleanupError(error);
			await Bun.sleep(50);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
