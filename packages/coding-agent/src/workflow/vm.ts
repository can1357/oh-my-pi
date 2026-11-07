/**
 * Deterministic JavaScript orchestration VM, hosted in a Bun Worker.
 *
 * The script runs as the body of an async function in a fresh `node:vm`
 * context created inside a Worker (worker.ts), so `runWorkflowScript` can
 * terminate a script stuck in a non-yielding stretch at any point, including
 * after an `await`. The context exposes exactly six helpers - `agent`,
 * `parallel`, `pipeline`, `phase`, `log`, `clock` - plus the call's `args`
 * string:
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
import { workerHostEntry } from "@oh-my-pi/pi-utils";
import type { WorkflowHostMessage, WorkflowWorkerMessage } from "./worker-protocol";

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

/** Per-call context handed to the agent bridge; the call path is the journal identity. */
export interface WorkflowAgentContext {
	/** Deterministic, completion-order-independent identity of this agent() call. */
	callPath: string;
	/** Workflow-owned cancellation signal, aborted when the run ends with outstanding calls. */
	signal: AbortSignal;
}

/** The executor seam; a test/host override may ignore the context. */
export type WorkflowAgentCaller = (
	prompt: string,
	opts?: WorkflowAgentOptions,
	context?: WorkflowAgentContext,
) => Promise<WorkflowAgentResult>;

/** The bridge `runWorkflowScript` calls for each `agent()`; context is always supplied. */
export type WorkflowAgentBridge = (
	prompt: string,
	opts: WorkflowAgentOptions | undefined,
	context: WorkflowAgentContext,
) => Promise<WorkflowAgentResult>;

export interface WorkflowRunOptions {
	script: string;
	args?: string;
	agent: WorkflowAgentBridge;
	onLog?: (line: string) => void;
	onPhase?: (name: string) => void;
	/** Optional workflow-owned controller; created internally when omitted. */
	controller?: AbortController;
	/** External abort; cancels and drains outstanding calls. */
	signal?: AbortSignal;
	/** Watchdog bound for any non-yielding stretch, including one after an await. */
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

/** Default watchdog bound on a non-yielding script stretch. */
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
	const hostParallelFailure = __hostParallelFailure;
	const hostWithScope = __hostWithScope;
	const providedArgs = __hostArgs;
	delete globalThis.__hostAgent;
	delete globalThis.__hostLog;
	delete globalThis.__hostPhase;
	delete globalThis.__hostWithScope;
	delete globalThis.__hostParallelFailure;
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

	let poolSeq = 0;
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
		const scopePrefix = "p" + (poolSeq++);
		let next = 0;
		let stopped = false;
		const worker = async () => {
			while (!stopped && next < list.length) {
				const index = next;
				next += 1;
				try {
					results[index] = await hostWithScope(scopePrefix + "." + index, () => fn(list[index], index));
				} catch (error) {
					stopped = true;
					throw error;
				}
			}
		};
		const workers = [];
		for (let i = 0; i < limit; i += 1) workers.push(worker());
		try {
			await Promise.all(workers);
		} catch (error) {
			hostParallelFailure();
			throw error;
		}
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
	const syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_WORKFLOW_SYNC_TIMEOUT_MS;
	const controller = options.controller ?? new AbortController();
	const heartbeatMs = Math.max(5, Math.min(200, Math.floor(syncTimeoutMs / 4)));
	const { promise, resolve, reject } = Promise.withResolvers<WorkflowRunResult>();

	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_workflow"] })
		: new Worker(new URL("./worker.ts", import.meta.url).href, { type: "module" });
	const outstanding = new Set<Promise<unknown>>();
	const send = (message: WorkflowHostMessage): void => {
		try {
			worker.postMessage(message);
		} catch {
			// The worker is already gone; the run has been finished.
		}
	};
	let finished = false;
	let lastActivity = Date.now();

	// A worker blocked in a non-yielding stretch (including one after an
	// await) stops posting heartbeats, so the stale gap trips this watchdog
	// and terminate() actually stops the loop. Yielding scripts keep the
	// heartbeat alive and are bounded only by their agent() calls.
	const watchdog = setInterval(() => {
		if (Date.now() - lastActivity > syncTimeoutMs) {
			fail(
				new WorkflowScriptError(
					`workflow script exceeded its ${syncTimeoutMs}ms synchronous time limit; move long-running work into agent() calls`,
				),
			);
		}
	}, heartbeatMs);

	const onExternalAbort = (): void => fail(new Error("workflow run aborted"));
	options.signal?.addEventListener("abort", onExternalAbort, { once: true });
	if (options.signal?.aborted) onExternalAbort();

	function settle(run: () => void): void {
		if (finished) return;
		finished = true;
		clearInterval(watchdog);
		options.signal?.removeEventListener("abort", onExternalAbort);
		// Stop script execution before cancelling and draining every bridge call.
		worker.terminate();
		controller.abort();
		void Promise.allSettled(Array.from(outstanding)).then(run);
	}

	function fail(error: Error): void {
		settle(() => reject(error));
	}

	function succeed(value: unknown): void {
		settle(() => resolve({ value, logs, phases, agentCalls }));
	}

	function handleEnvelope(envelopeJson: string): void {
		let envelope: unknown;
		try {
			envelope = JSON.parse(envelopeJson);
		} catch (error) {
			fail(
				new WorkflowScriptError(`workflow script envelope was not valid JSON: ${errorText(error)}`, {
					cause: error,
				}),
			);
			return;
		}
		if (!isEnvelope(envelope)) {
			fail(new WorkflowScriptError("workflow script returned an unexpected envelope"));
			return;
		}
		if (!envelope.ok) {
			fail(new WorkflowScriptError(typeof envelope.error === "string" ? envelope.error : "workflow script failed"));
			return;
		}
		succeed(envelope.value);
	}

	function handleAgent(requestId: number, callPath: string, payloadJson: string): Promise<unknown> {
		let prompt: string;
		let opts: WorkflowAgentOptions | undefined;
		try {
			const payload: unknown = JSON.parse(payloadJson);
			if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
				throw new Error("agent() payload was not an object");
			}
			const record = payload as Record<string, unknown>;
			const parsedPrompt = toPrimitiveString(record.prompt);
			if (parsedPrompt === undefined) throw new Error("agent(prompt, opts?): prompt must be a string");
			prompt = parsedPrompt;
			opts = parseAgentOptions(record.opts);
		} catch (error) {
			send({ type: "agentError", requestId, error: errorText(error) });
			return Promise.resolve();
		}
		return Promise.resolve()
			.then(() => options.agent(prompt, opts, { callPath, signal: controller.signal }))
			.then(
				result => {
					if (finished) return;
					send({
						type: "agentResult",
						requestId,
						result: JSON.stringify({
							result: typeof result.result === "string" ? result.result : String(result.result ?? ""),
							tokens: typeof result.tokens === "number" && Number.isFinite(result.tokens) ? result.tokens : 0,
							...(result.cached === true ? { cached: true } : {}),
						}),
					});
				},
				error => {
					if (finished) return;
					send({ type: "agentError", requestId, error: errorText(error) });
				},
			);
	}

	worker.addEventListener("message", (event: MessageEvent): void => {
		const message = event.data as WorkflowWorkerMessage | null;
		if (message === null || typeof message !== "object") return;
		if (finished) {
			if (message.type === "agent") {
				send({ type: "agentError", requestId: message.requestId, error: "workflow run aborted" });
			}
			return;
		}
		if (message.type === "heartbeat") lastActivity = Date.now();
		switch (message.type) {
			case "heartbeat":
				break;
			case "parallelFailure":
				controller.abort();
				break;
			case "log":
				logs.push(message.line);
				options.onLog?.(message.line);
				break;
			case "phase":
				phases.push(message.name);
				options.onPhase?.(message.name);
				break;
			case "agent": {
				agentCalls += 1;
				const call = handleAgent(message.requestId, message.callPath, message.payload);
				outstanding.add(call);
				void call.finally(() => outstanding.delete(call));
				break;
			}
			case "done":
				handleEnvelope(message.envelopeJson);
				break;
			case "error":
				fail(new WorkflowScriptError(message.message));
				break;
		}
	});

	worker.addEventListener("error", (event: ErrorEvent): void => {
		fail(
			new WorkflowScriptError(
				`workflow worker crashed: ${event.error instanceof Error ? event.error.message : event.message}`,
			),
		);
	});

	send({
		type: "init",
		prelude: WORKFLOW_PRELUDE,
		harden: WORKFLOW_HARDEN,
		envelopeSource: scriptEnvelope(options.script),
		args: options.args ?? "",
		heartbeatMs,
	});
	return promise;
}
