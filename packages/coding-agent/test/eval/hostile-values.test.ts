/**
 * Generative check of the eval runtimes against hostile values.
 *
 * A seeded generator builds values whose description is a hazard: getters that
 * throw, change type between reads, count their calls, return the value itself
 * or a new hostile value, or return a huge string or an endless iterable;
 * Proxies whose traps throw or whose prototype chain never ends; thenables of
 * every shape. Each value is thrown by a cell, rejected after its cell
 * finished, or thrown, rejected or returned by an output consumer. After each
 * one the worker or kernel must be the same process, keep its variables, have
 * left no unhandled rejection on the host, and have called every getter at
 * most once while describing the value.
 *
 * A getter that never returns is covered for Python only, where the cell's
 * timeout interrupts it and the kernel lives on; in JavaScript it blocks the
 * worker like any code that never returns, until the timeout ends the worker.
 *
 * A failing row names its seed and case; `HOSTILE_SEED=<n>` reruns one seed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

// A private agent directory: the shared one's agent.db is busy under other agents' load (SQLITE_BUSY).
let agentTemp: TempDir;
let previousAgentDir: string;
beforeAll(() => {
	previousAgentDir = getAgentDir();
	agentTemp = TempDir.createSync("@eval-hostile-values-");
	setAgentDir(path.join(agentTemp.path(), "agent"));
});
afterAll(() => {
	setAgentDir(previousAgentDir);
	agentTemp.removeSync();
});

const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";
const SEEDS = Bun.env.HOSTILE_SEED ? [Number(Bun.env.HOSTILE_SEED)] : [1, 2, 3];
/** Cases per seed and path. */
const CASES = 12;

type Language = "py" | "js";

interface Cell {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
}

function makeSession(evalSessionId: string): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "eval.autoProvision": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => evalSessionId,
	};
}

/** Runs one cell; `timeoutMs` `undefined` gives it no timeout of its own. */
async function run(
	session: ToolSession,
	language: Language,
	code: string,
	onChunk?: (chunk: string) => unknown,
	timeoutMs: number | undefined = 30_000,
): Promise<Cell> {
	const shared = {
		cwd: session.cwd,
		sessionId: session.getEvalSessionId?.() ?? "missing",
		// The public consumer type returns void; a consumer that returns anything must be accepted all the same.
		onChunk: onChunk as ((chunk: string) => void) | undefined,
		timeoutMs,
	};
	const result =
		language === "py"
			? await executePython(code, { ...shared, toolSession: session })
			: await executeJs(code, { ...shared, session });
	return { output: result.output, exitCode: result.exitCode, cancelled: result.cancelled };
}

interface Rng {
	int(n: number): number;
	pick<T>(items: readonly T[]): T;
	chance(p: number): boolean;
}

/** mulberry32: a small, seedable generator, so a failing case can be rerun. */
function generator(seed: number): Rng {
	let state = seed >>> 0;
	const next = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		int: n => Math.floor(next() * n),
		pick: items => items[Math.floor(next() * items.length)]!,
		chance: p => next() < p,
	};
}

/** What a check cell prints: the process, the kept variable, and each counted read under the case's tag. */
function parseCheck(cell: Cell): { pid: string; kept: string; reads: Array<[string, number]> } {
	const pid = /^pid (\d+)$/m.exec(cell.output)?.[1];
	const kept = /^kept (\S+)$/m.exec(cell.output)?.[1];
	const reads = /^reads (.*)$/m.exec(cell.output)?.[1];
	if (!pid || !kept || reads === undefined) throw new Error(`check cell output is incomplete:\n${cell.output}`);
	return { pid, kept, reads: JSON.parse(reads) as Array<[string, number]> };
}

/** Collects the host's unhandled rejections while `body` runs, and for one macrotask turn after, when the runtime reports them. */
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

// ---------------------------------------------------------------------------
// JavaScript values
// ---------------------------------------------------------------------------
//
// A value is built from JavaScript source evaluated where it is used: inside a
// cell, or in the test process for a consumer. The source is an expression
// over `count` (counts a getter call under a key) and `tag` (the case's key
// prefix). `floats` lets a getter leave a rejected promise behind; only a cell
// may, since the worker owns those, while one a consumer's getter left would be
// the consumer's own unhandled rejection.

const ERROR_BASES = [
	"new Error('base')",
	"new TypeError('base')",
	"new SyntaxError('base')",
	"new AggregateError([], 'base')",
];
const OBJECT_BASES = ["{}", "Object.create(null)", "[]", "(function hostile() {})"];
const KEYS = ["message", "name", "stack", "code", "syscall", "cause", "errors", "then", "constructor"] as const;
const METHOD_KEYS = ["toString", "valueOf", "Symbol.toPrimitive", "Symbol.toStringTag"] as const;

/** A getter body; `id` names the getter, whose `<id>_calls` counter lets it change type on its second read. */
function getterBody(rng: Rng, depth: number, floats: boolean, id: string): string {
	const choices = [
		"return 'text';",
		"return 42;",
		"return Object.create(null);",
		"return this;",
		`return (${id}_calls += 1) === 1 ? 'first read' : Object.create(null);`,
		"return 'x'.repeat(1 << 20);",
		"return (function* () { while (true) yield 1; })();",
		"throw new Error('getter threw');",
		"throw Object.create(null);",
		"throw this;",
	];
	if (floats) choices.push("void Promise.reject(Object.create(null)); return 'floated';");
	if (depth > 0) choices.push(`return ${jsValue(rng, depth - 1, floats, `${id}n`)};`);
	return rng.pick(choices);
}

function jsValue(rng: Rng, depth: number, floats: boolean, id = "v"): string {
	const kind = rng.int(10);
	if (kind === 0) return rng.pick(["'plain text'", "'y'.repeat(1 << 21)", "Symbol('s')", "12n", "undefined", "null"]);
	if (kind === 1) return "(() => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; })()";
	const statements: string[] = [`const ${id} = ${rng.pick(kind < 6 ? ERROR_BASES : OBJECT_BASES)};`];
	const counters: string[] = [];
	const define = (property: string, getterId: string, body: string): void => {
		counters.push(`let ${getterId}_calls = 0;`);
		statements.push(
			`Object.defineProperty(${id}, ${property}, { configurable: true, get() { count(tag + ${JSON.stringify(`:${getterId}`)}); ${body} } });`,
		);
	};
	for (const key of KEYS) {
		if (rng.chance(0.5)) define(JSON.stringify(key), `${id}_${key}`, getterBody(rng, depth, floats, `${id}_${key}`));
	}
	for (const key of METHOD_KEYS) {
		if (!rng.chance(0.3)) continue;
		const getterId = `${id}_${key.replace(/\W/g, "")}`;
		const body = getterBody(rng, depth, floats, getterId);
		define(
			key.startsWith("Symbol.") ? key : JSON.stringify(key),
			getterId,
			rng.chance(0.5) ? `return () => { count(tag + ${JSON.stringify(`:${getterId}:call`)}); ${body} };` : body,
		);
	}
	let result = id;
	if (rng.chance(0.4)) {
		const traps: string[] = [];
		const get = rng.pick(["pass", "throw", "count"]);
		if (get === "throw") traps.push("get() { throw new Error('trap threw'); }");
		if (get === "count") {
			traps.push(
				`get(target, key, receiver) { count(tag + ':${id}:get:' + String(key)); return Reflect.get(target, key, receiver); }`,
			);
		}
		const prototype = rng.pick(["pass", "throw", "endless", "error"]);
		if (prototype === "throw") traps.push("getPrototypeOf() { throw new Error('trap threw'); }");
		if (prototype === "endless") traps.push("getPrototypeOf() { return new Proxy({}, this); }");
		if (prototype === "error") traps.push("getPrototypeOf() { return Error.prototype; }");
		if (rng.chance(0.3))
			traps.push("has() { throw new Error('trap threw'); }", "ownKeys() { throw new Error('trap threw'); }");
		result = `new Proxy(${id}, { ${traps.join(", ")} })`;
	}
	return `(() => { ${counters.join(" ")} ${statements.join(" ")} return ${result}; })()`;
}

/** Builds `source` in the test process, counting its getter calls in `reads`. */
function hostValue(source: string, reads: Record<string, number>, tag: string): unknown {
	const count = (key: string): void => {
		reads[key] = (reads[key] ?? 0) + 1;
	};
	return new Function("count", "tag", `return ${source};`)(count, tag);
}

/** Cell source, in a block of its own, that defines the counter the generated values call. */
function jsCase(tag: string, body: string): string {
	return (
		"{ globalThis.__hostileReads ??= {}; const count = key => { globalThis.__hostileReads[key] = (globalThis.__hostileReads[key] ?? 0) + 1; }; " +
		`const tag = ${JSON.stringify(tag)}; ${body} }`
	);
}

/** Prints the process, the kept variable and the reads under `tag` counted more than once (the output sink cuts long lines). */
function jsCheck(tag: string): string {
	return `print('pid', process.pid); print('kept', kept); print('reads', JSON.stringify(Object.entries(globalThis.__hostileReads ?? {}).filter(([key, count]) => key.startsWith(${JSON.stringify(tag)}) && count > 1)));`;
}

/**
 * What a consumer does with a hostile value: throws it, returns a promise
 * rejected with it, or returns a thenable that misbehaves in one way. Each
 * thenable counts reads of its `then` under `tag:then`.
 */
function consumerResult(rng: Rng, value: () => unknown, reads: Record<string, number>, tag: string): () => unknown {
	const thenable = (then: () => unknown): unknown =>
		// oxlint-disable-next-line unicorn/no-thenable -- the consumer result under test is a thenable on purpose
		Object.defineProperty({}, "then", {
			get() {
				reads[`${tag}:then`] = (reads[`${tag}:then`] ?? 0) + 1;
				return then();
			},
		});
	const shapes: Array<() => unknown> = [
		() => {
			throw value();
		},
		() => Promise.reject(value()),
		() =>
			thenable(() => {
				throw value();
			}),
		() => thenable(() => 42),
		() => thenable(() => (_: unknown, onRejected: (reason: unknown) => void) => onRejected(value())),
		() =>
			thenable(() => (_: unknown, onRejected: (reason: unknown) => void) => {
				onRejected(value());
				onRejected(value());
			}),
		() => thenable(() => (onFulfilled: () => void) => onFulfilled()),
		() =>
			thenable(() => async () => {
				throw value();
			}),
		() => thenable(() => () => Promise.reject(value())),
		() => thenable(() => () => undefined),
		() =>
			thenable(() => () => {
				throw value();
			}),
		() =>
			thenable(() => (onFulfilled: () => void, onRejected: (reason: unknown) => void) => {
				onFulfilled();
				onRejected(value());
			}),
		() => thenable(() => () => thenable(() => () => Promise.reject(value()))),
	];
	return rng.pick(shapes);
}

describe("eval runtimes survive hostile values", () => {
	afterEach(async () => {
		await Promise.all([disposeAllKernelSessions(), disposeAllVmContexts()]);
	});

	for (const seed of SEEDS) {
		it(`js: seed ${seed}: a cell that throws a hostile value fails, and the worker keeps its variables`, async () => {
			const rng = generator(seed);
			const session = makeSession(`hostile-thrown-js-${seed}-${crypto.randomUUID()}`);
			const first = parseCheck(await run(session, "js", `var kept = 'yes'; ${jsCheck("none")}`));
			for (let index = 0; index < CASES; index++) {
				const tag = `thrown-${seed}-${index}`;
				const source = jsValue(rng, 2, true);
				// Compiles without running: a generated syntax error would fail the cell for the wrong reason.
				new Function("count", "tag", `return ${source};`);
				const failed = await run(session, "js", jsCase(tag, `throw ${source};`));
				const check = parseCheck(await run(session, "js", jsCheck(tag)));
				const context = `seed ${seed} case ${index}: ${source}`;
				expect(failed.exitCode, context).toBe(1);
				expect(check.pid, context).toBe(first.pid);
				expect(check.kept, context).toBe("yes");
				expect(
					check.reads.filter(([, count]) => count > 1),
					context,
				).toEqual([]);
			}
		}, 300_000);

		it(`js: seed ${seed}: a hostile value rejected after its cell finished leaves the worker and its variables`, async () => {
			const rng = generator(seed + 1000);
			const session = makeSession(`hostile-late-js-${seed}-${crypto.randomUUID()}`);
			const first = parseCheck(await run(session, "js", `var kept = 'yes'; ${jsCheck("none")}`));
			for (let index = 0; index < CASES; index++) {
				const tag = `late-${seed}-${index}`;
				const source = jsValue(rng, 2, true);
				const scheduled = await run(
					session,
					"js",
					jsCase(tag, `const value = ${source}; setTimeout(() => { void Promise.reject(value); }, 0);`),
				);
				// One more cell lets the worker's timer fire and its rejection surface; whether the
				// rejection lands before this cell or during it, the worker must carry on.
				await run(session, "js", "await new Promise(resolve => setImmediate(resolve));");
				const check = parseCheck(await run(session, "js", jsCheck(tag)));
				const context = `seed ${seed} case ${index}: ${source}`;
				expect(scheduled.exitCode, context).toBe(0);
				expect(check.pid, context).toBe(first.pid);
				expect(check.kept, context).toBe("yes");
				expect(
					check.reads.filter(([, count]) => count > 1),
					context,
				).toEqual([]);
			}
		}, 300_000);

		for (const language of ["js", "py"] as const) {
			it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
				`${language}: seed ${seed}: an output consumer that throws, rejects or returns hostile values leaves the cell, the runtime and the host intact`,
				async () => {
					const rng = generator(seed + 2000);
					const session = makeSession(`hostile-consumer-${language}-${seed}-${crypto.randomUUID()}`);
					const pidPattern = /^pid (\d+)$/m;
					const setup =
						language === "py"
							? "import os\nkept = 'yes'\nprint('pid', os.getpid())"
							: "var kept = 'yes'; print('pid', process.pid);";
					const firstPid = pidPattern.exec((await run(session, language, setup)).output)?.[1];
					const twoLines =
						language === "py"
							? "import os\nprint('one', flush=True)\nprint('two', flush=True)\nprint('pid', os.getpid())\nprint('kept', kept)"
							: "print('one'); await Promise.resolve(); print('two'); print('pid', process.pid); print('kept', kept);";
					for (let index = 0; index < CASES; index++) {
						const tag = `consumer-${seed}-${index}`;
						const source = jsValue(rng, 2, false);
						const reads: Record<string, number> = {};
						const shape = consumerResult(rng, () => hostValue(source, reads, tag), reads, tag);
						let cell: Cell | undefined;
						const unhandled = await unhandledRejectionsDuring(async () => {
							cell = await run(session, language, twoLines, chunk =>
								chunk.split("\n").includes("one") ? shape() : undefined,
							);
						});
						const context = `seed ${seed} case ${index}: ${source}`;
						expect(unhandled, context).toEqual([]);
						expect(cell?.exitCode, context).toBe(0);
						expect(cell?.output, context).toContain("two\n");
						expect(pidPattern.exec(cell?.output ?? "")?.[1], context).toBe(firstPid);
						expect(cell?.output, context).toContain("kept yes");
						expect(
							Object.entries(reads).filter(([, count]) => count > 1),
							context,
						).toEqual([]);
					}
				},
				300_000,
			);
		}
	}
});

// ---------------------------------------------------------------------------
// Python exceptions
// ---------------------------------------------------------------------------
//
// Each case defines an exception class whose members misbehave, raises an
// instance (or leaves one for a background task or a `__del__` to raise after
// the cell), then checks the kernel. Members count their reads per instance in
// `_hostile_reads`, keyed by case, member and `id(self)`, so a chain of new
// exceptions counts each one separately; a metaclass member counts per case.
// Names start with one underscore: a class body would mangle two.

const PY_COUNTER =
	"import itertools, time, asyncio, gc\n" +
	"_hostile_reads = globals().setdefault('_hostile_reads', {})\n" +
	"def _hostile_count(key):\n    _hostile_reads[key] = _hostile_reads.get(key, 0) + 1\n" +
	"class _HostileEndless(list):\n    def __iter__(self):\n        while True:\n            time.sleep(0.001)\n            yield 'note'\n" +
	"class _HostileEndlessDir:\n    def __dir__(self):\n        return itertools.count()\n";

const PY_RAISES = ["RuntimeError('member raised')", "KeyboardInterrupt()", "SystemExit(3)", "GeneratorExit()"];

function pyMember(rng: Rng, member: string, cls: string): string {
	const behaviors: Record<string, string[]> = {
		__notes__: ["_HostileEndless()", "['n'] * 100000", "[object()] * 3", "object()", "'a string'", `${cls}('fresh')`],
		__cause__: [`${cls}('fresh cause')`, "self", "42", "None"],
		__context__: [`${cls}('fresh context')`, "self", "42", "None"],
		__suppress_context__: ["True", "False", "'yes'"],
		__traceback__: ["42", "None", "self"],
		exceptions: ["itertools.count()", "[ValueError(str(i)) for i in range(1000)]", "(self,)", "42"],
		name: ["'apend'", "42", "None", "'x' * 1000"],
		obj: ["_HostileEndlessDir()", "[]", "self"],
		filename: ["'<cell>'", "42", "'f' * 10000"],
		lineno: ["1", "'one'", "10**9"],
		offset: ["10**9", "-10**9", "1", "'x'"],
		end_offset: ["10**9", "-10**9", "2"],
		text: ["'x = ('", "42", "'t' * 100000"],
		msg: ["'bad'", "42"],
	};
	const value = rng.chance(0.3) ? `raise ${rng.pick(PY_RAISES)}` : `return ${rng.pick(behaviors[member] ?? ["None"])}`;
	const setter = member.startsWith("__")
		? `    @${member}.setter\n    def ${member}(self, value):\n        pass\n`
		: "";
	return `    @property\n    def ${member}(self):\n        _hostile_count(f'{_hostile_case}:${member}:{id(self)}')\n        ${value}\n${setter}`;
}

/**
 * A hostile exception class for one case, and the expression that makes one.
 * `withTraceback` leaves out a `__traceback__` member: asyncio reads that of a
 * task's exception itself, outside any description.
 */
function pyCase(
	rng: Rng,
	caseTag: string,
	withTraceback = true,
): { define: string; make: string; reportedNames: string[] } {
	const cls = `Hostile_${caseTag.replace(/\W/g, "_")}`;
	const base = rng.pick([
		"Exception",
		"ValueError",
		"SyntaxError",
		"AttributeError",
		"NameError",
		"ModuleNotFoundError",
		"ExceptionGroup",
	]);
	const members = ["__notes__", "__cause__", "__context__", "__suppress_context__"];
	if (withTraceback) members.push("__traceback__");
	if (base === "ExceptionGroup") members.push("exceptions");
	if (base === "AttributeError") members.push("name", "obj");
	if (base === "NameError" || base === "ModuleNotFoundError") members.push("name");
	if (base === "SyntaxError") members.push("filename", "lineno", "offset", "end_offset", "text", "msg");
	const meta =
		"class _HostileMeta(type):\n" +
		"    @property\n    def __name__(cls):\n        _hostile_count(f'{_hostile_case}:__name__')\n        raise RuntimeError('name')\n" +
		// Not `__qualname__`: a class body may only bind that name to text.
		"    @property\n    def __module__(cls):\n        _hostile_count(f'{_hostile_case}:__module__')\n        return 42\n";
	const str = rng.pick([`raise ${rng.pick(PY_RAISES)}`, "return 'x' * 1000000", "return 'fine'", "return 42"]);
	// A metaclass that makes `__name__` raise leaves the traceback its `__qualname__`, except where the runner
	// falls back to `<unnamed exception>` (for example after the traceback is cut), so either names the class.
	const namelessClass = rng.chance(0.2);
	let body = `class ${cls}(${base}${namelessClass ? ", metaclass=_HostileMeta" : ""}):\n`;
	body += `    def __str__(self):\n        _hostile_count(f'{_hostile_case}:__str__:{id(self)}')\n        ${str}\n`;
	for (const member of members) if (rng.chance(0.5)) body += pyMember(rng, member, cls);
	const make =
		base === "ExceptionGroup"
			? `${cls}('group', [ValueError('member')])`
			: base === "AttributeError"
				? `${cls}('no attribute', name='apend', obj=[])`
				: `${cls}('hostile')`;
	return {
		define: `${meta}${body}`,
		make,
		reportedNames: namelessClass ? [cls, "<unnamed exception>"] : [cls],
	};
}

function pyCheck(caseTag: string): string {
	return (
		"import os, json\nprint('pid', os.getpid())\nprint('kept', kept)\n" +
		`print('reads', json.dumps([[k, v] for k, v in _hostile_reads.items() if k.startswith(${JSON.stringify(caseTag)}) and v > 1]))`
	);
}

describe("the Python kernel survives hostile exceptions", () => {
	afterEach(async () => {
		await disposeAllKernelSessions();
	});

	for (const seed of SEEDS) {
		it.skipIf(!PYTHON_INTEGRATION)(
			`py: seed ${seed}: a cell that raises a hostile exception fails, and the kernel keeps its variables`,
			async () => {
				const rng = generator(seed + 3000);
				const session = makeSession(`hostile-raised-py-${seed}-${crypto.randomUUID()}`);
				const first = parseCheck(await run(session, "py", `${PY_COUNTER}kept = 'yes'\n${pyCheck("none")}`));
				for (let index = 0; index < CASES; index++) {
					const caseTag = `raised-${seed}-${index}`;
					const { define, make, reportedNames } = pyCase(rng, caseTag);
					const code = `_hostile_case = ${JSON.stringify(caseTag)}\n${define}\nraise ${make}`;
					// No timeout of its own: describing the exception must end by itself.
					const failed = await run(session, "py", code, undefined, undefined);
					const check = parseCheck(await run(session, "py", pyCheck(caseTag)));
					const context = `seed ${seed} case ${index}:\n${code}`;
					expect(failed.cancelled, context).toBe(false);
					expect(failed.exitCode, context).toBe(1);
					// The name the runner can read, so the cell failed on the hostile exception, not while defining it.
					expect(
						reportedNames.some(name => failed.output.includes(name)),
						`${context}\n--- output ---\n${failed.output.slice(0, 2000)}`,
					).toBe(true);
					expect(check.pid, context).toBe(first.pid);
					expect(check.kept, context).toBe("yes");
					expect(
						check.reads.filter(([, count]) => count > 1),
						context,
					).toEqual([]);
				}
			},
			600_000,
		);

		it.skipIf(!PYTHON_INTEGRATION)(
			`py: seed ${seed}: a hostile exception raised after its cell, by a task or a __del__, leaves the kernel serving`,
			async () => {
				const rng = generator(seed + 4000);
				const session = makeSession(`hostile-late-py-${seed}-${crypto.randomUUID()}`);
				const first = parseCheck(await run(session, "py", `${PY_COUNTER}kept = 'yes'\n${pyCheck("none")}`));
				for (let index = 0; index < CASES; index++) {
					const caseTag = `late-${seed}-${index}`;
					const byTask = rng.chance(0.5);
					const { define, make } = pyCase(rng, caseTag, !byTask);
					const later = byTask
						? `async def _hostile_fail():\n    raise ${make}\n\nasyncio.ensure_future(_hostile_fail())\n`
						: `class _HostileDies:\n    def __del__(self):\n        raise ${make}\n\n_HostileDies()\n`;
					const code = `_hostile_case = ${JSON.stringify(caseTag)}\n${define}\n${later}print('scheduled')`;
					const scheduled = await run(session, "py", code, undefined, undefined);
					// The check runs the collector, so a task nobody kept is reported by now.
					const check = parseCheck(
						await run(session, "py", `gc.collect()\n${pyCheck(caseTag)}`, undefined, undefined),
					);
					const context = `seed ${seed} case ${index}:\n${code}`;
					expect(scheduled.exitCode, context).toBe(0);
					expect(check.pid, context).toBe(first.pid);
					expect(check.kept, context).toBe("yes");
					expect(
						check.reads.filter(([, count]) => count > 1),
						context,
					).toEqual([]);
				}
			},
			600_000,
		);
	}

	it.skipIf(!PYTHON_INTEGRATION)(
		"py: an exception whose __str__ never returns is cut short by the cell's timeout, and the kernel keeps its variables",
		async () => {
			const session = makeSession(`hostile-endless-str-py-${crypto.randomUUID()}`);
			const first = parseCheck(await run(session, "py", `${PY_COUNTER}kept = 'yes'\n${pyCheck("none")}`));
			const code =
				"class Endless(Exception):\n    def __str__(self):\n        while True:\n            time.sleep(0.01)\n\nraise Endless()";
			const failed = await run(session, "py", code, undefined, 3_000);
			const check = parseCheck(await run(session, "py", pyCheck("none")));

			expect(failed.cancelled).toBe(true);
			expect(check.pid).toBe(first.pid);
			expect(check.kept).toBe("yes");
		},
		120_000,
	);
});
