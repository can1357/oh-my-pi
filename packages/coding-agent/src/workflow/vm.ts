/**
 * Deterministic JavaScript orchestration VM.
 *
 * The script runs as the body of an async function in a fresh `node:vm`
 * context. The context exposes exactly six helpers — `agent`, `parallel`,
 * `pipeline`, `phase`, `log`, `clock` — plus the call's `args` string:
 *
 * - `agent(prompt, opts?)` awaits one child agent and resolves to
 *   `{ result, tokens, cached? }`;
 * - `parallel(items, fn, opts?)` runs `fn` with a bounded worker pool and
 *   returns results in item order;
 * - `pipeline(items, ...stages)` flows each item through stages in order
 *   (stages for different items may overlap);
 * - `phase(name)` records progress, `log(...)` appends to the run log, and
 *   `clock()` is a deterministic counter.
 *
 * Determinism rules are enforced by the context itself, not by a preflight
 * lint: `require`, `process`, `Date`, and `Math.random` are replaced with
 * throwing stubs, `import`/`import()` are rejected before execution, and
 * `codeGeneration` is disabled so `eval`/`new Function` cannot mint code.
 *
 * Isolation notes: `node:vm` is not a security boundary against hostile host
 * code, but this context leaks no host object. The only host values crossing
 * the boundary are (a) primitives, (b) JSON strings, and (c) bridge functions
 * hardened with a null prototype and frozen. The bridges are captured by the
 * prelude closure and deleted from the global object before any user code
 * runs; a bridge failure rejects with a primitive string, never a host Error.
 */
import { parse } from "@babel/parser";
import * as vm from "node:vm";

export interface WorkflowAgentOptions {
	/** Agent definition name; the session default when omitted. */
	agent?: string;
	/** Shared background passed to the child. */
	context?: string;
}

export interface WorkflowAgentResult {
	result: string;
	tokens: number;
	/** Set when the call was replayed from a resumed run's journal. */
	cached?: boolean;
}

export type WorkflowAgentCaller = (prompt: string, opts?: WorkflowAgentOptions) => Promise<WorkflowAgentResult>;

export interface WorkflowRunOptions {
	script: string;
	args?: string;
	agent: WorkflowAgentCaller;
	onLog?: (line: string) => void;
	onPhase?: (name: string) => void;
	/** Cancels the await of the script's envelope (the sandbox itself cannot be interrupted asynchronously). */
	signal?: AbortSignal;
	/** Bound on the synchronous portion, i.e. until the script first awaits. */
	syncTimeoutMs?: number;
}

export interface WorkflowRunResult {
	value: unknown;
	logs: string[];
	phases: string[];
	agentCalls: number;
}

/** The script itself failed (syntax gate, determinism guard, or an uncaught throw). */
export class WorkflowScriptError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkflowScriptError";
	}
}

/** Bound on synchronous script execution; `runInContext` interrupts a tight loop. */
export const DEFAULT_WORKFLOW_SYNC_TIMEOUT_MS = 30_000;

const WRAP_HEAD = "(async () => {\n";
const WRAP_TAIL = "\n})";

/**
 * Globals permitted to survive inside the workflow context. Everything else —
 * including runtime-injected host helpers — is deleted or poisoned after the
 * prelude. `Date`, `Math`, `ShadowRealm`, `Temporal`, `console`, `require`, and
 * `process` in this list are the deterministic/throwing stubs installed by the
 * prelude, never the host originals.
 */
export const WORKFLOW_GLOBAL_ALLOWLIST: readonly string[] = [
	"AggregateError",
	"Array",
	"ArrayBuffer",
	"AsyncDisposableStack",
	"Atomics",
	"BigInt",
	"BigInt64Array",
	"BigUint64Array",
	"Boolean",
	"DataView",
	"Date",
	"DisposableStack",
	"Error",
	"EvalError",
	"FinalizationRegistry",
	"Float16Array",
	"Float32Array",
	"Float64Array",
	"Function",
	"Infinity",
	"Int16Array",
	"Int32Array",
	"Int8Array",
	"Intl",
	"Iterator",
	"JSON",
	"Map",
	"Math",
	"NaN",
	"Number",
	"Object",
	"Promise",
	"Proxy",
	"RangeError",
	"ReferenceError",
	"Reflect",
	"RegExp",
	"Set",
	"ShadowRealm",
	"SharedArrayBuffer",
	"String",
	"SuppressedError",
	"Symbol",
	"SyntaxError",
	"Temporal",
	"TypeError",
	"URIError",
	"Uint16Array",
	"Uint32Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"WeakMap",
	"WeakRef",
	"WeakSet",
	"WebAssembly",
	"console",
	"decodeURI",
	"decodeURIComponent",
	"encodeURI",
	"encodeURIComponent",
	"escape",
	"eval",
	"globalThis",
	"isFinite",
	"isNaN",
	"parseFloat",
	"parseInt",
	"undefined",
	"unescape",
	"agent",
	"parallel",
	"pipeline",
	"phase",
	"log",
	"clock",
	"args",
	"require",
	"process",
];

/**
 * Reject module loading before the VM compiles anything. Static `import` is a
 * syntax error in a function body anyway, but parsing first gives one clear
 * message for both forms and catches dynamic `import()` — which would
 * otherwise surface a host-realm TypeError whose constructor chain reaches the
 * host `Function`.
 */
export function assertNoModuleLoading(script: string): void {
	let ast: unknown;
	try {
		ast = parse(`${WRAP_HEAD}${script}${WRAP_TAIL}`, { sourceType: "script" });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new WorkflowScriptError(`workflow script syntax error: ${detail}`, { cause: error });
	}
	if (containsDynamicImport(ast)) {
		throw new WorkflowScriptError(
			"dynamic import() is not available in workflow scripts: the sandbox loads no modules; call agent() for delegated work instead",
		);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function containsDynamicImport(node: unknown): boolean {
	if (Array.isArray(node)) return node.some(containsDynamicImport);
	if (!isRecord(node)) return false;
	// Babel AST nodes are plain objects.
	if (node.type === "ImportExpression") return true;
	// Babel < 8 encodes `import(x)` as a CallExpression whose callee is Import.
	if (node.type === "CallExpression" && isRecord(node.callee) && node.callee.type === "Import") return true;
	for (const [key, child] of Object.entries(node)) {
		if (key === "loc" || key === "start" || key === "end") continue;
		if (isRecord(child) && containsDynamicImport(child)) return true;
	}
	return false;
}

/**
 * The prelude is one IIFE: it captures the host bridges, removes them from
 * the global object, installs the forbidden-global stubs, and publishes the
 * six helper functions. It runs to completion before user code is compiled.
 */
const WORKFLOW_PRELUDE = String.raw`
(() => {
	"use strict";
	const hostAgent = __hostAgent;
	const hostLog = __hostLog;
	const hostPhase = __hostPhase;
	const providedArgs = __hostArgs;
	delete globalThis.__hostAgent;
	delete globalThis.__hostLog;
	delete globalThis.__hostPhase;
	delete globalThis.__hostArgs;

	const format = value => {
		if (typeof value === "string") return value;
		if (value === undefined) return "undefined";
		try {
			const json = JSON.stringify(value);
			return json === undefined ? String(value) : json;
		} catch {
			return String(value);
		}
	};
	const log = (...parts) => { hostLog(parts.map(format).join(" ")); };
	const phase = name => { hostPhase(String(name)); };

	const agent = (prompt, opts) => new Promise((resolve, reject) => {
		if (typeof prompt !== "string") {
			reject(new Error("agent(prompt, opts?): prompt must be a string"));
			return;
		}
		let payload;
		try {
			payload = JSON.stringify({ prompt, opts: opts === undefined ? null : opts });
		} catch {
			reject(new Error("agent(prompt, opts?): opts must be JSON-serializable"));
			return;
		}
		try {
			hostAgent(payload, resolve, reject);
		} catch {
			reject(new Error("agent() bridge call failed"));
		}
	}).then(raw => {
		const parsed = JSON.parse(raw);
		const out = { result: parsed.result, tokens: parsed.tokens };
		if (parsed.cached === true) out.cached = true;
		return out;
	}, reason => {
		throw new Error(typeof reason === "string" ? reason : "agent() failed");
	});

	const runPool = async (items, fn, opts) => {
		if (!Array.isArray(items)) throw new TypeError("parallel(items, fn, opts?): items must be an array");
		if (typeof fn !== "function") throw new TypeError("parallel(items, fn, opts?): fn must be a function");
		const list = items.slice();
		const requested = opts && typeof opts === "object" && opts.concurrency !== undefined
			? Number(opts.concurrency)
			: 4;
		let limit = requested >= 1 ? Math.floor(requested) : 1;
		if (list.length < limit) limit = list.length;
		if (limit < 1) return [];
		const results = new Array(list.length);
		let next = 0;
		const worker = async () => {
			while (next < list.length) {
				const index = next;
				next += 1;
				results[index] = await fn(list[index], index);
			}
		};
		const workers = [];
		for (let i = 0; i < limit; i += 1) workers.push(worker());
		await Promise.all(workers);
		return results;
	};

	let poolDepth = 0;
	const enterPool = () => {
		if (poolDepth > 0) {
			throw new Error("only one parallel()/pipeline() may be in flight at a time; await the current fan-out before starting another");
		}
		poolDepth += 1;
	};
	const exitPool = () => { poolDepth -= 1; };

	const parallel = async (items, fn, opts) => {
		enterPool();
		try {
			return await runPool(items, fn, opts);
		} finally {
			exitPool();
		}
	};

	const pipeline = async (items, ...stages) => {
		let opts;
		if (stages.length > 0) {
			const last = stages[stages.length - 1];
			if (last !== null && typeof last === "object" && !Array.isArray(last) && typeof last !== "function") {
				opts = stages.pop();
			}
		}
		for (const stage of stages) {
			if (typeof stage !== "function") throw new TypeError("pipeline(items, ...stages): every stage must be a function");
		}
		enterPool();
		try {
			return await runPool(items, async (item, index) => {
				let value = item;
				for (const stage of stages) value = await stage(value, item, index);
				return value;
			}, opts);
		} finally {
			exitPool();
		}
	};

	let ticks = 0;
	const clock = () => { ticks += 1; return ticks; };

	const forbiddenDate = function Date() {
		throw new ReferenceError("Date is disabled in workflow scripts for determinism; use clock() for a counter and pass inputs through args");
	};
	Object.defineProperty(forbiddenDate, "now", {
		value: function now() {
			throw new ReferenceError("Date.now is disabled in workflow scripts for determinism; use clock() for a counter and pass inputs through args");
		},
		writable: false,
		configurable: false,
	});

	const nativeMath = Math;
	const workflowMath = {};
	for (const key of Object.getOwnPropertyNames(nativeMath)) {
		Object.defineProperty(workflowMath, key, Object.getOwnPropertyDescriptor(nativeMath, key));
	}
	Object.defineProperty(workflowMath, "random", {
		value: function random() {
			throw new ReferenceError("Math.random is disabled in workflow scripts for determinism; derive variation from args or clock() instead");
		},
		writable: false,
		configurable: false,
	});

	globalThis.Date = forbiddenDate;
	globalThis.Math = Object.freeze(workflowMath);
	globalThis.require = function require() {
		throw new ReferenceError("require is not available in workflow scripts: the sandbox loads no modules; call agent() for delegated work instead");
	};
	Object.defineProperty(globalThis, "process", {
		configurable: false,
		enumerable: false,
		get: function process() {
			throw new ReferenceError("process is not available in workflow scripts: the sandbox has no host globals; pass inputs through args");
		},
	});
	// ShadowRealm.evaluate() escapes the context's global restrictions (Bun's
	// realm can still see the host process), so the constructor is removed.
	Object.defineProperty(globalThis, "ShadowRealm", {
		configurable: false,
		writable: false,
		value: function ShadowRealm() {
			throw new ReferenceError("ShadowRealm is disabled in workflow scripts: it would create an unguarded realm");
		},
	});
	// Temporal.Now is the same clock as Date.now under another name.
	const nativeTemporal = globalThis.Temporal;
	if (nativeTemporal !== null && typeof nativeTemporal === "object") {
		const temporal = {};
		for (const key of Object.getOwnPropertyNames(nativeTemporal)) {
			if (key === "Now") continue;
			Object.defineProperty(temporal, key, Object.getOwnPropertyDescriptor(nativeTemporal, key));
		}
		const forbiddenNow = {};
		for (const method of ["instant", "plainDateTimeISO", "plainDateISO", "plainTimeISO", "timeZoneId", "zonedDateTimeISO"]) {
			Object.defineProperty(forbiddenNow, method, {
				value: function forbiddenTemporalNow() {
					throw new ReferenceError("Temporal.Now is disabled in workflow scripts for determinism; use clock() for a counter and pass inputs through args");
				},
				writable: false,
				configurable: false,
			});
		}
		Object.defineProperty(temporal, "Now", {
			value: Object.freeze(forbiddenNow),
			writable: false,
			configurable: false,
		});
		Object.defineProperty(globalThis, "Temporal", {
			value: Object.freeze(temporal),
			writable: false,
			configurable: false,
		});
	}
	globalThis.console = Object.freeze({ log, info: log, warn: log, error: log, debug: log });

	globalThis.agent = agent;
	globalThis.parallel = parallel;
	globalThis.pipeline = pipeline;
	globalThis.phase = phase;
	globalThis.log = log;
	globalThis.clock = clock;
	globalThis.args = providedArgs;
})();
`;

/** Wraps the user body so `return` and top-level `await` both work. */
function scriptEnvelope(script: string): string {
	return (
		`(async () => {${script}})()` +
		`
	.then(value => {
		try {
			return JSON.stringify({ ok: true, value: value === undefined ? null : value });
		} catch (error) {
			return JSON.stringify({ ok: false, error: "workflow script result is not JSON-serializable: " + String(error && error.message ? error.message : error) });
		}
	})
	.catch(error => JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error), stack: error && typeof error.stack === "string" ? error.stack : undefined }))`
	);
}

function hardenBridge(fn: (...args: unknown[]) => void): (...args: unknown[]) => void {
	// Null prototype keeps `bridge.constructor` out of reach; code generation
	// is disabled in the context, but the host `Function` would bypass that.
	Object.setPrototypeOf(fn, null);
	return Object.freeze(fn);
}

function toPrimitiveString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseAgentOptions(value: unknown): WorkflowAgentOptions | undefined {
	if (value === null || value === undefined || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const agent = toPrimitiveString(record.agent);
	const context = toPrimitiveString(record.context);
	if (agent === undefined && context === undefined) return undefined;
	return { ...(agent !== undefined ? { agent } : {}), ...(context !== undefined ? { context } : {}) };
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Reject the wait on abort; the script's own asynchronous continuations cannot be cancelled. */
function awaitWithSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return pending;
	if (signal.aborted) return Promise.reject(new Error("workflow run aborted"));
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const onAbort = (): void => reject(new Error("workflow run aborted"));
	signal.addEventListener("abort", onAbort, { once: true });
	pending.then(
		value => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		error => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		},
	);
	return promise;
}

/**
 * Deny-by-default global sweep. A runtime can inject a host helper into a new
 * `node:vm` context (Bun exposed `console`/`ShadowRealm` this way); the
 * allowlist names every global the workflow contract needs, and anything else
 * is removed before user code can see it.
 */
const WORKFLOW_HARDEN =
	String.raw`(() => {
	"use strict";
	const allowed = new Set(` +
	JSON.stringify(WORKFLOW_GLOBAL_ALLOWLIST) +
	String.raw`);
	for (const name of Object.getOwnPropertyNames(globalThis)) {
		if (allowed.has(name)) continue;
		let removed = false;
		try { removed = delete globalThis[name]; } catch {}
		if (removed) continue;
		try {
			Object.defineProperty(globalThis, name, {
				configurable: false,
				enumerable: false,
				get: function forbiddenGlobal() {
					throw new ReferenceError(name + " is not available in workflow scripts");
				},
			});
		} catch {
			try { globalThis[name] = undefined; } catch {}
		}
	}
})();`;

function isEnvelope(value: unknown): value is { ok: boolean; value?: unknown; error?: string; stack?: string } {
	return isRecord(value) && typeof value.ok === "boolean";
}

export async function runWorkflowScript(options: WorkflowRunOptions): Promise<WorkflowRunResult> {
	assertNoModuleLoading(options.script);

	const logs: string[] = [];
	const phases: string[] = [];
	let agentCalls = 0;

	const recordLog = (line: unknown): void => {
		if (typeof line !== "string") return;
		logs.push(line);
		options.onLog?.(line);
	};
	const recordPhase = (name: unknown): void => {
		if (typeof name !== "string") return;
		phases.push(name);
		options.onPhase?.(name);
	};
	const callAgent = (payloadJson: unknown, resolve: unknown, reject: unknown): void => {
		if (typeof resolve !== "function" || typeof reject !== "function") return;
		const resolveFn = resolve as (value: string) => void;
		const rejectFn = reject as (reason: string) => void;
		const safeReject = (reason: string): void => {
			try {
				rejectFn(reason);
			} catch {
				// The VM realm is gone (run aborted); nothing left to settle.
			}
		};
		let payload: unknown;
		try {
			payload = JSON.parse(String(payloadJson));
		} catch {
			safeReject("agent() payload was not valid JSON");
			return;
		}
		if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
			safeReject("agent() payload was not an object");
			return;
		}
		const record = payload as Record<string, unknown>;
		const prompt = toPrimitiveString(record.prompt);
		if (prompt === undefined) {
			safeReject("agent(prompt, opts?): prompt must be a string");
			return;
		}
		agentCalls += 1;
		const settleResult = (result: WorkflowAgentResult): void => {
			const serialized = JSON.stringify({
				result: typeof result.result === "string" ? result.result : String(result.result ?? ""),
				tokens: typeof result.tokens === "number" && Number.isFinite(result.tokens) ? result.tokens : 0,
				...(result.cached === true ? { cached: true } : {}),
			});
			try {
				resolveFn(serialized);
			} catch (error) {
				safeReject(errorText(error));
			}
		};
		try {
			options
				.agent(prompt, parseAgentOptions(record.opts))
				.then(settleResult, error => safeReject(errorText(error)));
		} catch (error) {
			safeReject(errorText(error));
		}
	};

	const sandbox: Record<string, unknown> = Object.create(null);
	sandbox.__hostAgent = hardenBridge(callAgent);
	sandbox.__hostLog = hardenBridge(recordLog);
	sandbox.__hostPhase = hardenBridge(recordPhase);
	sandbox.__hostArgs = options.args ?? "";

	let context: vm.Context;
	try {
		context = vm.createContext(sandbox, {
			name: "omp-workflow",
			codeGeneration: { strings: false, wasm: false },
		});
	} catch (error) {
		throw new WorkflowScriptError(`workflow sandbox could not start: ${errorText(error)}`, { cause: error });
	}

	try {
		new vm.Script(WORKFLOW_PRELUDE, { filename: "workflow-prelude.js" }).runInContext(context);
		new vm.Script(WORKFLOW_HARDEN, { filename: "workflow-harden.js" }).runInContext(context);
	} catch (error) {
		throw new WorkflowScriptError(`workflow sandbox prelude failed: ${errorText(error)}`, { cause: error });
	}

	const syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_WORKFLOW_SYNC_TIMEOUT_MS;
	let pending: unknown;
	try {
		pending = new vm.Script(scriptEnvelope(options.script), { filename: "workflow-script.js" }).runInContext(
			context,
			{
				timeout: syncTimeoutMs,
			},
		);
	} catch (error) {
		const detail = errorText(error);
		if (/timed out/i.test(detail)) {
			throw new WorkflowScriptError(
				`workflow script exceeded its ${syncTimeoutMs}ms synchronous time limit; move long-running work into agent() calls`,
				{ cause: error },
			);
		}
		throw new WorkflowScriptError(`workflow script syntax error: ${detail}`, { cause: error });
	}

	const envelopeJson = await awaitWithSignal(Promise.resolve(pending), options.signal);
	if (typeof envelopeJson !== "string") {
		throw new WorkflowScriptError("workflow script returned an unexpected envelope");
	}
	let envelope: unknown;
	try {
		envelope = JSON.parse(envelopeJson);
	} catch (error) {
		throw new WorkflowScriptError(`workflow script envelope was not valid JSON: ${errorText(error)}`, {
			cause: error,
		});
	}
	if (!isEnvelope(envelope)) throw new WorkflowScriptError("workflow script returned an unexpected envelope");
	if (!envelope.ok) {
		const message = typeof envelope.error === "string" ? envelope.error : "workflow script failed";
		throw new WorkflowScriptError(message);
	}
	return { value: envelope.value, logs, phases, agentCalls };
}
