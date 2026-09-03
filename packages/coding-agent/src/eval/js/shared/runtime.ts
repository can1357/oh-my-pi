import { AsyncLocalStorage } from "node:async_hooks";
import { Console } from "node:console";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Writable } from "node:stream";
import * as util from "node:util";

import * as logger from "@oh-my-pi/pi-utils/logger";

import { createHelpers, type HelperBundle } from "./helpers";
import { awaitMaybePromise, indirectEval } from "./indirect-eval";
import { LocalModuleLoader } from "./local-module-loader";
import { JAVASCRIPT_PRELUDE_SOURCE } from "./prelude";
import { wrapCode } from "./rewrite-imports";
import type { JsDisplayOutput, JsStatusEvent } from "./types";

/**
 * Per-run callbacks. Runtime globals resolve these from AsyncLocalStorage so
 * overlapping async cells can route output/tool calls back to their own run.
 */
export interface RuntimeHooks {
	onText(chunk: string): void;
	onDisplay(output: JsDisplayOutput): void;
	callTool(name: string, args: unknown): Promise<unknown>;
}

/**
 * Bridged tool results carry image blocks as a base64 `images` array that no
 * cell code consumes. Emit each block as an image display output so the model
 * receives real image content — matching the direct tool path — and replace
 * the payload with a note so echoing the result cannot flood the transcript
 * with base64.
 */
function surfaceBridgedToolImages(value: unknown, hooks: RuntimeHooks): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const { images, ...rest } = value as { images?: unknown } & Record<string, unknown>;
	if (!Array.isArray(images) || images.length === 0) return value;
	let displayed = 0;
	for (const image of images) {
		if (!image || typeof image !== "object") continue;
		const { data, mimeType } = image as { data?: unknown; mimeType?: unknown };
		if (typeof data !== "string" || typeof mimeType !== "string") continue;
		hooks.onDisplay({ type: "image", data, mimeType });
		displayed++;
	}
	if (displayed === 0) return value;
	return { ...rest, images: `(${displayed} image${displayed === 1 ? "" : "s"} displayed)` };
}

export interface RunContext {
	runId: string;
	hooks: RuntimeHooks;
	cwd: string;
	finalExpressionSet: boolean;
	finalExpressionValue: unknown;
}

export interface RuntimeOptions {
	initialCwd: string;
	sessionId: string;
	/**
	 * Extra globals installed alongside `__omp_helpers__` / prelude. Use for stable, lifetime-
	 * of-the-worker bindings (e.g. browser's `page`, `browser`). Per-run scope should be set
	 * via `setRunScope()` instead.
	 */
	extraGlobals?: Record<string, unknown>;
	/**
	 * On-disk roots the helpers substitute for internal-URL schemes (e.g.
	 * `{ local: "/…/artifacts/local" }`). Stable for the worker's lifetime.
	 */
	localRoots?: Record<string, string>;
}

// Strict base64: characters from the standard alphabet plus optional `=` padding, and a
// length that is a multiple of four. URL-safe base64 and embedded whitespace are not
// accepted — the Anthropic API only honors strict base64 in image sources.
const BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DECIMAL_CSV_RE = /^\d{1,3}(?:,\d{1,3})*$/;

const PRELUDE_GLOBAL_KEYS = [
	"__omp_js_prelude_loaded__",
	"__omp_tools__",
	"console",
	"print",
	"display",
	"tool",
	"completion",
	"output",
	"agent",
	"wait",
	"AgentHandle",
	"CompletionHandle",
	"workpool",
	"WorkPool",
	"log",
	"phase",
	"budget",
	"read",
	"write",
	"env",
];

function isStrictBase64(s: string): boolean {
	if (s.length === 0 || s.length % 4 !== 0) return false;
	return BASE64_STRICT_RE.test(s);
}

/**
 * Normalize the `data` field of an `{ type: "image", data, mimeType }` display payload
 * into strict base64. Accepts:
 *   - already-valid base64 strings (passed through verbatim)
 *   - `Uint8Array` / `Buffer` / `ArrayBuffer` / typed array views
 *   - `{ type: "Buffer", data: number[] }` (the shape Node serializes Buffers to via
 *     `JSON.stringify`)
 *   - decimal-CSV byte strings (the output of `uint8array.toString("base64")`, which
 *     silently ignores the encoding argument and returns `Array.prototype.toString` —
 *     a footgun for callers expecting `Buffer.toString` semantics)
 * Returns `null` if no recovery is possible.
 */
function coerceImageBase64(data: unknown): string | null {
	if (typeof data === "string") {
		if (isStrictBase64(data)) return data;
		if (DECIMAL_CSV_RE.test(data)) {
			const parts = data.split(",");
			const bytes = new Uint8Array(parts.length);
			for (let i = 0; i < parts.length; i++) {
				const n = Number(parts[i]);
				if (!Number.isInteger(n) || n < 0 || n > 255) return null;
				bytes[i] = n;
			}
			return Buffer.from(bytes).toString("base64");
		}
		return null;
	}
	if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
	}
	if (data && typeof data === "object") {
		const obj = data as { type?: unknown; data?: unknown };
		if (obj.type === "Buffer" && Array.isArray(obj.data)) {
			const arr = obj.data as unknown[];
			const bytes = new Uint8Array(arr.length);
			for (let i = 0; i < arr.length; i++) {
				const n = arr[i];
				if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) return null;
				bytes[i] = n;
			}
			return Buffer.from(bytes).toString("base64");
		}
	}
	return null;
}

function describeDataType(data: unknown): string {
	if (data === null) return "null";
	if (data instanceof Uint8Array) return "Uint8Array";
	if (data instanceof ArrayBuffer) return "ArrayBuffer";
	if (ArrayBuffer.isView(data)) return data.constructor.name;
	if (typeof data === "string") return `string(${data.length})`;
	return typeof data;
}

/**
 * Shared JS runtime for the eval worker and the browser tab worker. Owns the prelude,
 * helper bag, console bridge, and indirect-eval execution. Emits text/display/tool-call
 * back through `RuntimeHooks` that the embedder supplies — wire format is the embedder's
 * concern.
 */
export class JsRuntime {
	#globalOwner = Symbol("JsRuntime globals");
	#ownedGlobalKeys = new Set<string>();
	#disposed = false;
	#runHookResolver = () => this.#als.getStore()?.hooks;

	#ownGlobal(key: string): void {
		if (this.#ownedGlobalKeys.has(key)) return;
		claimGlobalKey(key, this.#globalOwner);
		this.#ownedGlobalKeys.add(key);
	}

	#activateGlobals(action: string): void {
		if (this.#disposed) throw new Error(`Cannot ${action} on a disposed JS runtime`);
		activateGlobalOwner(this.#globalOwner, this.#ownedGlobalKeys, action);
	}

	readonly helpers: HelperBundle;
	#cwd: string;
	#session: { cwd: string; sessionId: string };
	readonly sessionId: string;
	#env: Map<string, string>;
	#als = new AsyncLocalStorage<RunContext>();
	#moduleLoader: LocalModuleLoader;
	#localRoots: Record<string, string>;

	constructor(opts: RuntimeOptions) {
		this.#cwd = opts.initialCwd;
		this.#session = { cwd: opts.initialCwd, sessionId: opts.sessionId };
		this.sessionId = opts.sessionId;
		this.#env = new Map();
		this.#moduleLoader = new LocalModuleLoader(this.sessionId);
		this.#localRoots = opts.localRoots ?? {};
		this.helpers = createHelpers({
			cwd: () => this.#activeCwd(),
			env: this.#env,
			localRoots: () => this.#localRoots,
			emitStatus: event => this.#activeHooks("emitStatus")?.onDisplay({ type: "status", event }),
		});
		this.#install(opts.extraGlobals);
	}

	get cwd(): string {
		return this.#cwd;
	}

	setCwd(cwd: string): void {
		if (this.#disposed) throw new Error("Cannot set cwd on a disposed JS runtime");
		// Always stamp the runtime and session state: WorkerCore/browser/cmux call
		// setCwd from init and pre-run paths that may race another same-realm
		// runtime, and a throw here used to escape the inline-worker microtask
		// path as a fatal unhandledRejection that killed the whole session.
		// #session is the same object saved in this owner's global stack entry,
		// so the new cwd survives deferred activation and is visible to this
		// runtime's next run; run()/setRunScope still assert exclusive ownership.
		this.#cwd = cwd;
		this.#session.cwd = cwd;
		if (activeGlobalRunOwner === null || activeGlobalRunOwner === this.#globalOwner) {
			this.#activateGlobals("set cwd");
		}
	}

	/**
	 * Install per-run globals. Intended for run-scoped state (browser's `tab`, `display`
	 * overrides, etc.). Overwrites previous assignments — caller is responsible for any
	 * cleanup it wants.
	 */
	setRunScope(scope: Record<string, unknown>): void {
		this.#activateGlobals("set run scope");
		Object.assign(globalThis, scope);
	}

	/** Read a prelude-owned global from this runtime's active global set. */
	getGlobal(name: string): unknown {
		this.#activateGlobals("read runtime global");
		return Reflect.get(globalThis, name);
	}

	/** Invoke a callback inside this runtime's async run context. */
	async runCallback<T>(runId: string, hooks: RuntimeHooks, callback: () => T | Promise<T>): Promise<T> {
		this.#activateGlobals("run callback");
		const leaveRun = enterGlobalRun(this.#globalOwner, "run callback");
		const context: RunContext = {
			runId,
			hooks,
			cwd: this.#cwd,
			finalExpressionSet: false,
			finalExpressionValue: undefined,
		};
		try {
			return await this.#als.run(context, callback);
		} finally {
			leaveRun();
		}
	}

	async run(
		code: string,
		filename: string | undefined,
		hooks: RuntimeHooks,
		options: { runId?: string; cwd?: string } = {},
	): Promise<unknown> {
		this.#activateGlobals("run code");
		const leaveRun = enterGlobalRun(this.#globalOwner, "run code");
		const context: RunContext = {
			runId: options.runId ?? crypto.randomUUID(),
			hooks,
			cwd: options.cwd ?? this.#cwd,
			finalExpressionSet: false,
			finalExpressionValue: undefined,
		};
		try {
			return await this.#als.run(context, async () => {
				const wrapped = await wrapCode(code);
				const value = indirectEval(wrapped.source, filename);
				if (wrapped.finalExpressionReturned) {
					const awaited = await awaitMaybePromise(value);
					if (context.finalExpressionSet) {
						const finalValue = context.finalExpressionValue;
						context.finalExpressionSet = false;
						context.finalExpressionValue = undefined;
						return await awaitMaybePromise(finalValue);
					}
					return awaited;
				}
				return await awaitMaybePromise(value);
			});
		} finally {
			leaveRun();
		}
	}

	displayValue(value: unknown, hooks: RuntimeHooks | undefined = this.#als.getStore()?.hooks): void {
		if (value === undefined) return;
		if (!hooks) {
			logger.warn("js runtime display called outside an active run");
			return;
		}
		if (value && typeof value === "object") {
			const record = value as Record<string, unknown>;
			if (record.type === "image" && typeof record.mimeType === "string") {
				const data = coerceImageBase64(record.data);
				if (data !== null) {
					hooks.onDisplay({ type: "image", data, mimeType: record.mimeType });
					return;
				}
				logger.warn("js displayValue: dropping image with unrecognized data shape", {
					mimeType: record.mimeType,
					dataType: describeDataType(record.data),
				});
				hooks.onText(
					`[display: image dropped — \`data\` must be a base64 string, Uint8Array/Buffer, or ArrayBuffer; got ${describeDataType(record.data)}]\n`,
				);
				return;
			}
			try {
				hooks.onDisplay({ type: "json", data: structuredClone(value) });
			} catch (err) {
				logger.debug("js displayValue: value is not structured-cloneable, falling back to text", {
					error: err instanceof Error ? err.message : String(err),
				});
				hooks.onText(`${Object.prototype.toString.call(value)}\n`);
			}
			return;
		}
		hooks.onText(`${String(value)}\n`);
	}

	#activeCwd(): string {
		return this.#als.getStore()?.cwd ?? this.#cwd;
	}

	#activeHooks(action: string): RuntimeHooks | undefined {
		const hooks = this.#als.getStore()?.hooks;
		if (!hooks) {
			logger.warn("js runtime helper called outside an active run", { action });
		}
		return hooks;
	}

	#activeRequire(moduleUrlOrPath?: string): NodeJS.Require {
		return this.#moduleLoader.requireForFile(moduleUrlOrPath, this.#activeCwd());
	}

	#moduleFilename(moduleUrlOrPath?: string): string {
		return this.#moduleLoader.filenameForUrl(moduleUrlOrPath) ?? path.join(this.#activeCwd(), "[eval]");
	}

	#moduleDirname(moduleUrlOrPath?: string): string {
		return this.#moduleLoader.dirnameForUrl(moduleUrlOrPath, this.#activeCwd());
	}

	#buildDynamicRequire(): NodeJS.Require {
		const dynamicRequire = ((id: string) => this.#activeRequire()(id)) as NodeJS.Require;
		const resolve = ((id: string, options?: { paths?: string[] }) =>
			this.#activeRequire().resolve(id, options)) as NodeJS.Require["resolve"] & {
			paths(request: string): string[] | null;
		};
		resolve.paths = request => this.#activeRequire().resolve.paths(request);
		Object.defineProperties(dynamicRequire, {
			resolve: { value: resolve, configurable: true },
			cache: { get: () => this.#activeRequire().cache, configurable: true },
			extensions: { get: () => this.#activeRequire().extensions, configurable: true },
			main: { get: () => this.#activeRequire().main, configurable: true },
		});
		return dynamicRequire;
	}

	#install(extraGlobals: Record<string, unknown> | undefined): void {
		// Constructing a runtime while another same-realm runtime is mid-run would
		// silently replace the live runtime's globals (Object.assign + prelude eval
		// below). Fail before any global/stack mutation; WorkerCore reports it as
		// init-failed instead of corrupting the active run.
		assertCanUseGlobalOwner(this.#globalOwner, "initialize a JS runtime");
		const injected: Record<string, unknown> = {
			__omp_session__: this.#session,
			__omp_helpers__: this.helpers,
			__omp_call_tool__: async (name: string, args: unknown) => {
				const hooks = this.#activeHooks("tool");
				if (!hooks) return undefined;
				return surfaceBridgedToolImages(await hooks.callTool(name, args), hooks);
			},
			__omp_import__: async (source: string, options?: ImportCallOptions) => {
				const resolved = await this.#moduleLoader.resolveForRun(this.#activeCwd(), source);
				if (resolved.mode === "local") return resolved.value;
				const target = resolved.target;
				return options !== undefined ? await import(target, options) : await import(target);
			},
			__omp_import_from__: async (moduleUrl: string, source: string, options?: ImportCallOptions) => {
				const resolved = await this.#moduleLoader.resolveForModule(moduleUrl, source, this.#activeCwd());
				if (resolved.mode === "local") return resolved.value;
				const target = resolved.target;
				return options !== undefined ? await import(target, options) : await import(target);
			},
			__omp_get_require__: (moduleUrl?: string) => this.#activeRequire(moduleUrl),
			__omp_get_filename__: (moduleUrl?: string) => this.#moduleFilename(moduleUrl),
			__omp_get_dirname__: (moduleUrl?: string) => this.#moduleDirname(moduleUrl),
			__omp_emit_status__: (op: string, data: Record<string, unknown> = {}) => {
				const event: JsStatusEvent = { op, ...data };
				this.#activeHooks("emitStatus")?.onDisplay({ type: "status", event });
			},
			__omp_log__: (level: string, ...args: unknown[]) => {
				const prefix = level === "error" ? "[error] " : level === "warn" ? "[warn] " : "";
				const text = `${prefix}${formatConsoleArgs(args)}`;
				this.#activeHooks("log")?.onText(text.endsWith("\n") ? text : `${text}\n`);
			},
			__omp_table__: (...args: unknown[]) => {
				const hooks = this.#activeHooks("table");
				if (!hooks) return;
				let buffer = "";
				const stream = new Writable({
					write(chunk, _enc, cb) {
						buffer += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
						cb();
					},
				});
				const tableConsole = new Console({ stdout: stream, colorMode: false });
				(tableConsole.table as (...a: unknown[]) => void)(...args);
				hooks.onText(buffer.endsWith("\n") ? buffer : `${buffer}\n`);
			},
			__omp_display__: (value: unknown) => this.displayValue(value),
			__omp_set_final_expr__: (value: unknown) => {
				const context = this.#als.getStore();
				if (!context) {
					logger.warn("js runtime final expression set outside an active run");
					return;
				}
				context.finalExpressionSet = true;
				context.finalExpressionValue = value;
			},
			webcrypto: crypto,
			// `process` is intentionally not overridden — user code gets the host worker's real
			// `process` object. Subsetting it caused segfaults in workers that share state with
			// puppeteer/worker_threads internals.
			require: this.#buildDynamicRequire(),
			createRequire,
			fs,
		};

		const allGlobalKeys = new Set<string>([
			...Object.keys(injected),
			...Object.keys(extraGlobals ?? {}),
			...PRELUDE_GLOBAL_KEYS,
		]);

		for (const key of allGlobalKeys) {
			this.#ownGlobal(key);
		}

		Object.assign(globalThis, injected, extraGlobals ?? {});
		// Prelude assigns console bridge + short aliases (`read`, `write`, `tool`, `display`, ...)
		// onto globalThis. Must run after helpers are in place.
		indirectEval(JAVASCRIPT_PRELUDE_SOURCE);
		for (const key of allGlobalKeys) recordGlobalValue(key, this.#globalOwner);
		RUN_HOOK_RESOLVERS.add(this.#runHookResolver);
		patchStdioOnce();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		RUN_HOOK_RESOLVERS.delete(this.#runHookResolver);
		for (const key of this.#ownedGlobalKeys) releaseGlobalKey(key, this.#globalOwner);
		this.#ownedGlobalKeys.clear();
	}
}

interface GlobalSnapshot {
	exists: boolean;
	value: unknown;
}

interface GlobalOwnerEntry {
	owner: symbol;
	value: unknown;
}

interface GlobalStack {
	base: GlobalSnapshot;
	entries: GlobalOwnerEntry[];
}

// Inline fallback and cmux tabs can create multiple JsRuntime instances in one Bun realm.
// Track reserved helper globals by owner so disposing one runtime restores the next active
// owner (or the original process global after the last owner), not a stale snapshot.
const GLOBAL_STACKS = new Map<string, GlobalStack>();

function snapshotGlobal(key: string): GlobalSnapshot {
	return {
		exists: key in globalThis,
		value: (globalThis as Record<string, unknown>)[key],
	};
}

function restoreGlobal(key: string, state: GlobalSnapshot): void {
	if (state.exists) {
		(globalThis as Record<string, unknown>)[key] = state.value;
	} else {
		delete (globalThis as Record<string, unknown>)[key];
	}
}

function claimGlobalKey(key: string, owner: symbol): void {
	let stack = GLOBAL_STACKS.get(key);
	if (!stack) {
		stack = { base: snapshotGlobal(key), entries: [] };
		GLOBAL_STACKS.set(key, stack);
	}
	stack.entries.push({ owner, value: (globalThis as Record<string, unknown>)[key] });
}

function recordGlobalValue(key: string, owner: symbol): void {
	const stack = GLOBAL_STACKS.get(key);
	const entry = stack?.entries.findLast(item => item.owner === owner);
	if (entry) entry.value = (globalThis as Record<string, unknown>)[key];
}

function releaseGlobalKey(key: string, owner: symbol): void {
	const stack = GLOBAL_STACKS.get(key);
	if (!stack) return;
	const index = stack.entries.findIndex(entry => entry.owner === owner);
	if (index === -1) return;
	const wasTop = index === stack.entries.length - 1;
	stack.entries.splice(index, 1);
	if (!wasTop) return;
	const next = stack.entries.at(-1);
	if (next) {
		(globalThis as Record<string, unknown>)[key] = next.value;
		return;
	}
	restoreGlobal(key, stack.base);
	GLOBAL_STACKS.delete(key);
}

// Plain globalThis cannot safely serve two different runtimes at the same instant:
// helpers dereference reserved globals on every call. Sequential cmux tab revisits
// re-activate their owner stack; overlapping cross-runtime runs fail explicitly.
let activeGlobalRunOwner: symbol | null = null;
let activeGlobalRunDepth = 0;

function assertCanUseGlobalOwner(owner: symbol, action: string): void {
	if (activeGlobalRunOwner === null || activeGlobalRunOwner === owner) return;
	throw new Error(`Cannot ${action} while another same-realm JS runtime is running`);
}

function activateGlobalOwner(owner: symbol, keys: Iterable<string>, action: string): void {
	assertCanUseGlobalOwner(owner, action);
	for (const key of keys) {
		const stack = GLOBAL_STACKS.get(key);
		const index = stack?.entries.findIndex(entry => entry.owner === owner) ?? -1;
		if (!stack || index === -1) throw new Error(`Cannot ${action} on a disposed JS runtime`);
		const entry = stack.entries[index];
		stack.entries.splice(index, 1);
		stack.entries.push(entry);
		(globalThis as Record<string, unknown>)[key] = entry.value;
	}
}

function enterGlobalRun(owner: symbol, action: string): () => void {
	assertCanUseGlobalOwner(owner, action);
	activeGlobalRunOwner = owner;
	activeGlobalRunDepth++;
	let left = false;
	return () => {
		if (left) return;
		left = true;
		activeGlobalRunDepth--;
		if (activeGlobalRunDepth === 0) activeGlobalRunOwner = null;
	};
}

/** Resolvers for each live runtime's active-run hooks (one per JsRuntime instance). */
const RUN_HOOK_RESOLVERS = new Set<() => RuntimeHooks | undefined>();

/** Streams whose `write` the runtime has already wrapped (patch-once guard). */
const PATCHED_STDIO_STREAMS = new WeakSet<NodeJS.WriteStream>();

/** Hooks for whichever registered runtime currently has an active run, if any. */
function activeRunHooks(): RuntimeHooks | undefined {
	for (const resolve of RUN_HOOK_RESOLVERS) {
		const hooks = resolve();
		if (hooks) return hooks;
	}
	return undefined;
}

/**
 * Wrap `process.stdout` / `process.stderr` `write` exactly once per process so
 * user `process.stdout.write(...)` lands in the active run's text sink. Models
 * reach for it out of Node habit, but `process` is intentionally the host
 * worker's real object (see {@link JsRuntime} `#install`), so unrouted writes
 * escape to the worker's own stdio and never reach the cell — and `write()`
 * returns a boolean, so a cell ending in `process.stdout.write("x")` captured
 * `true` while losing the text. Patch only the `write` method (never replace
 * `process`), preserve exact bytes (no trailing newline), and fall through to
 * the real stream when no run is active so the worker's own logging is intact.
 */
function patchStdioOnce(): void {
	const streams: NodeJS.WriteStream[] = [process.stdout, process.stderr];
	for (const stream of streams) {
		if (!stream || PATCHED_STDIO_STREAMS.has(stream)) continue;
		PATCHED_STDIO_STREAMS.add(stream);
		const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
		const routed = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
			const hooks = activeRunHooks();
			if (!hooks) return original(chunk, encoding, callback);
			const cb = typeof encoding === "function" ? encoding : callback;
			const enc = typeof encoding === "string" ? (encoding as BufferEncoding) : undefined;
			hooks.onText(chunkToString(chunk, enc));
			if (typeof cb === "function") (cb as (error?: Error | null) => void)();
			return true;
		};
		stream.write = routed as unknown as typeof stream.write;
	}
}

/** Coerce a `write()` chunk to text, honoring an explicit encoding for byte chunks. */
function chunkToString(chunk: unknown, encoding?: BufferEncoding): string {
	if (typeof chunk === "string") return chunk;
	if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString(encoding ?? "utf8");
	return String(chunk);
}

function formatConsoleArgs(args: unknown[]): string {
	return args
		.map(arg => (typeof arg === "string" ? arg : util.inspect(arg, { depth: 6, colors: false, breakLength: 120 })))
		.join(" ");
}
