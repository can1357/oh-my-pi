import type { Protocol } from "devtools-protocol";
import type { CDPSession, ConsoleMessage, HTTPRequest, Page } from "puppeteer-core";

/** Console levels accepted by the browser console query. */
export type BrowserConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

/** Options for reading captured page console messages. */
export interface BrowserConsoleOptions {
	/** Return only messages at this console level. */
	level?: BrowserConsoleLevel;
	/** Return entries whose sequence is greater than this cursor. */
	since?: number;
	/** Clear the shared capture buffer after reading. */
	clear?: boolean;
	/** Maximum number of entries to return. */
	limit?: number;
}

/** Options for reading captured page errors and failed requests. */
export interface BrowserErrorOptions {
	/** Return entries whose sequence is greater than this cursor. */
	since?: number;
	/** Clear the shared capture buffer after reading. */
	clear?: boolean;
	/** Maximum number of entries to return. */
	limit?: number;
}

/** One captured page console message. */
export interface BrowserConsoleEntry {
	/** Monotonically increasing capture sequence. */
	seq: number;
	/** Capture time as Unix milliseconds. */
	ts: number;
	/** Captured entry kind. */
	type: "console";
	/** Console message level. */
	level: BrowserConsoleLevel;
	/** Browser-rendered console text. */
	text: string;
	/** Source URL, line, and column when Chromium reports them. */
	location?: string;
	/** Best-effort JSON-safe console arguments. */
	args: unknown[];
}

/** One captured uncaught exception or failed request. */
export interface BrowserErrorEntry {
	/** Monotonically increasing capture sequence. */
	seq: number;
	/** Capture time as Unix milliseconds. */
	ts: number;
	/** Captured error kind. */
	type: "pageerror" | "requestfailed";
	/** Error severity. */
	level: "error";
	/** Exception or failed-request description. */
	text: string;
	/** Source location or failed-request URL when available. */
	location?: string;
	/** Exception stack when available. */
	stack?: string;
}

/** Result of a bounded capture-buffer query. */
export interface BrowserCaptureResult<T> {
	/** Matching captured entries in sequence order. */
	entries: T[];
	/** Sequence cursor for a subsequent `since` query. */
	nextSeq: number;
	/** Entries evicted by bounded-buffer overflow since the last clear. */
	dropped: number;
}

type BrowserCaptureEntry = BrowserConsoleEntry | BrowserErrorEntry;

const DEFAULT_CAPTURE_LIMIT = 500;
const MAX_ARG_CHARS = 8_192;
const MAX_TEXT_CHARS = 16_384;
const MAX_STACK_CHARS = 32_768;

function boundedText(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/**
 * Render one console argument as text without throwing.
 *
 * `String()` throws for objects whose `toString`/`valueOf` are not callable
 * (e.g. JSON payloads `{ toString: "x" }`); those fall back to JSON, then to
 * the object's `Object.prototype.toString` tag, then to a fixed marker (the tag
 * itself throws for revoked proxies). Mirrored page-side in
 * {@link CMUX_CONSOLE_CAPTURE_SCRIPT}.
 */
function consoleArgumentText(value: unknown): string {
	try {
		return String(value);
	} catch {
		try {
			const json = JSON.stringify(value);
			if (json !== undefined) return json;
		} catch {
			// Cyclic or otherwise unserializable; use the object tag below.
		}
		try {
			return Object.prototype.toString.call(value);
		} catch {
			return "[unserializable]";
		}
	}
}

function consoleLevel(message: ConsoleMessage): BrowserConsoleLevel {
	const type = message.type();
	switch (type) {
		case "debug":
		case "info":
		case "warn":
		case "error":
		case "log":
			return type;
		case "assert":
			return "error";
		default:
			return "log";
	}
}

function consoleLocation(message: ConsoleMessage): string | undefined {
	const location = message.location();
	if (!location.url) return undefined;
	const line = location.lineNumber;
	const column = location.columnNumber;
	return line === undefined ? location.url : `${location.url}:${line}:${column ?? 0}`;
}

function errorLocation(error: Error): string | undefined {
	const stack = error.stack;
	if (!stack) return undefined;
	for (const line of stack.split("\n").slice(1)) {
		const match = /(?:at .*?\()?(.+):(\d+):(\d+)\)?$/.exec(line.trim());
		if (match) return `${match[1]}:${match[2]}:${match[3]}`;
	}
	return undefined;
}

function boundedArgument(value: unknown): unknown {
	const json = JSON.stringify(value);
	if (json === undefined) return boundedText(String(value), MAX_ARG_CHARS);
	if (json.length <= MAX_ARG_CHARS) return value;
	return `${json.slice(0, MAX_ARG_CHARS)}…`;
}

async function serializeArgument(message: ConsoleMessage, index: number): Promise<unknown> {
	const handle = message.args()[index];
	if (!handle) return undefined;
	const remote = handle.remoteObject();
	if ("value" in remote) return boundedArgument(remote.value);
	if (remote.unserializableValue) return remote.unserializableValue;
	try {
		return boundedArgument(await handle.jsonValue());
	} catch {
		return boundedText(handle.toString(), MAX_ARG_CHARS);
	}
}

async function serializeRemoteObject(session: CDPSession, object: Protocol.Runtime.RemoteObject): Promise<unknown> {
	if ("value" in object) return boundedArgument(object.value);
	if (object.unserializableValue) return object.unserializableValue;
	if (object.objectId) {
		try {
			const response = await session.send("Runtime.callFunctionOn", {
				objectId: object.objectId,
				functionDeclaration: "function() { return this; }",
				returnByValue: true,
				silent: true,
			});
			if ("value" in response.result) return boundedArgument(response.result.value);
		} catch {
			// Fall through to the DevTools description when the object cannot be serialized.
		}
	}
	return boundedText(object.description ?? object.className ?? object.type, MAX_ARG_CHARS);
}

function protocolConsoleLevel(type: Protocol.Runtime.ConsoleAPICalledEvent["type"]): BrowserConsoleLevel {
	if (type === "warning") return "warn";
	if (type === "debug" || type === "info" || type === "error" || type === "log") return type;
	if (type === "assert") return "error";
	return "log";
}

function protocolLocation(stack?: Protocol.Runtime.StackTrace): string | undefined {
	const frame = stack?.callFrames[0];
	return frame?.url ? `${frame.url}:${frame.lineNumber}:${frame.columnNumber}` : undefined;
}

function protocolExceptionLocation(
	details: Protocol.Runtime.ExceptionDetails,
	fallbackUrl: string,
): string | undefined {
	const frame = details.stackTrace?.callFrames[0];
	if (frame?.url) return `${frame.url}:${frame.lineNumber}:${frame.columnNumber}`;
	const url = details.url || fallbackUrl;
	return url ? `${url}:${details.lineNumber}:${details.columnNumber}` : undefined;
}

/** Persistent bounded capture of page console messages, uncaught exceptions, and failed requests. */
export class PageConsoleCapture {
	readonly #limit: number;
	#entries: BrowserCaptureEntry[] = [];
	#nextSeq = 1;
	#dropped = 0;
	#pending: Promise<void> = Promise.resolve();
	#generation = 0;
	#page?: Page;
	#cdp?: CDPSession;
	#consoleHandler?: (message: ConsoleMessage) => void;
	#pageErrorHandler?: (error: unknown) => void;
	#requestFailedHandler?: (request: HTTPRequest) => void;
	#protocolConsoleHandler?: (event: Protocol.Runtime.ConsoleAPICalledEvent) => void;
	#protocolExceptionHandler?: (event: Protocol.Runtime.ExceptionThrownEvent) => void;
	#protocolRequestHandler?: (event: Protocol.Network.RequestWillBeSentEvent) => void;
	#protocolRequestFinishedHandler?: (event: Protocol.Network.LoadingFinishedEvent) => void;
	#protocolRequestFailedHandler?: (event: Protocol.Network.LoadingFailedEvent) => void;
	readonly #requests = new Map<Protocol.Network.RequestId, { method: string; url: string }>();

	constructor(limit = DEFAULT_CAPTURE_LIMIT) {
		this.#limit = Math.max(1, Math.floor(limit));
	}

	/** Sequence cursor immediately after the latest allocated capture entry. */
	get nextSequence(): number {
		return this.#nextSeq;
	}

	/** Attach capture listeners to a page once. */
	async install(page: Page): Promise<void> {
		await this.detach();
		this.#page = page;
		const generation = this.#generation;
		this.#consoleHandler = message => {
			if (this.#cdp) return;
			const seq = this.#allocateSequence();
			const ts = Date.now();
			this.#pending = this.#pending.then(async () => {
				const args = await Promise.all(message.args().map((_, index) => serializeArgument(message, index)));
				if (this.#generation !== generation) return;
				this.#push({
					seq,
					ts,
					type: "console",
					level: consoleLevel(message),
					text: boundedText(message.text(), MAX_TEXT_CHARS),
					location: consoleLocation(message),
					args,
				});
			});
		};
		this.#pageErrorHandler = error => {
			if (this.#cdp) return;
			const normalized = error instanceof Error ? error : new Error(String(error));
			this.#push({
				seq: this.#allocateSequence(),
				ts: Date.now(),
				type: "pageerror",
				level: "error",
				text: boundedText(normalized.message || String(error), MAX_TEXT_CHARS),
				location: errorLocation(normalized),
				stack: normalized.stack ? boundedText(normalized.stack, MAX_STACK_CHARS) : undefined,
			});
		};
		this.#requestFailedHandler = request => {
			if (this.#cdp) return;
			const failure = request.failure()?.errorText ?? "Request failed";
			const url = request.url();
			this.#push({
				seq: this.#allocateSequence(),
				ts: Date.now(),
				type: "requestfailed",
				level: "error",
				text: boundedText(`${request.method()} ${url}: ${failure}`, MAX_TEXT_CHARS),
				location: url,
			});
		};
		page.on("console", this.#consoleHandler);
		page.on("pageerror", this.#pageErrorHandler);
		page.on("requestfailed", this.#requestFailedHandler);

		let session: CDPSession | undefined;
		try {
			const activeSession = await page.createCDPSession();
			session = activeSession;
			this.#protocolConsoleHandler = event => {
				const seq = this.#allocateSequence();
				const serializedArgs = Promise.all(
					event.args.map(argument => serializeRemoteObject(activeSession, argument)),
				);
				this.#pending = this.#pending.then(async () => {
					const args = await serializedArgs;
					if (this.#generation !== generation) return;
					const text = args.map(consoleArgumentText).join(" ");
					this.#push({
						seq,
						ts: event.timestamp,
						type: "console",
						level: protocolConsoleLevel(event.type),
						text: boundedText(text, MAX_TEXT_CHARS),
						location: protocolLocation(event.stackTrace) ?? page.url(),
						args,
					});
				});
			};
			this.#protocolExceptionHandler = event => {
				const details = event.exceptionDetails;
				const description = details.exception?.description;
				const stack = description?.includes("\n") ? description : undefined;
				const text = description?.split("\n", 1)[0] ?? details.text;
				this.#push({
					seq: this.#allocateSequence(),
					ts: event.timestamp,
					type: "pageerror",
					level: "error",
					text: boundedText(text, MAX_TEXT_CHARS),
					location: protocolExceptionLocation(details, page.url()),
					stack: stack ? boundedText(stack, MAX_STACK_CHARS) : undefined,
				});
			};
			this.#protocolRequestHandler = event => {
				this.#requests.set(event.requestId, { method: event.request.method, url: event.request.url });
			};
			this.#protocolRequestFinishedHandler = event => {
				this.#requests.delete(event.requestId);
			};
			this.#protocolRequestFailedHandler = event => {
				const request = this.#requests.get(event.requestId);
				this.#requests.delete(event.requestId);
				if (!request) return;
				this.#push({
					seq: this.#allocateSequence(),
					ts: Date.now(),
					type: "requestfailed",
					level: "error",
					text: boundedText(`${request.method} ${request.url}: ${event.errorText}`, MAX_TEXT_CHARS),
					location: request.url,
				});
			};
			activeSession.on("Runtime.consoleAPICalled", this.#protocolConsoleHandler);
			activeSession.on("Runtime.exceptionThrown", this.#protocolExceptionHandler);
			activeSession.on("Network.requestWillBeSent", this.#protocolRequestHandler);
			activeSession.on("Network.loadingFinished", this.#protocolRequestFinishedHandler);
			activeSession.on("Network.loadingFailed", this.#protocolRequestFailedHandler);
			await Promise.all([activeSession.send("Runtime.enable"), activeSession.send("Network.enable")]);
			this.#cdp = activeSession;
		} catch {
			await session?.detach().catch(() => undefined);
			this.#protocolConsoleHandler = undefined;
			this.#protocolExceptionHandler = undefined;
		}
	}

	/** Read captured console messages after an optional sequence cursor. */
	async console(options: BrowserConsoleOptions = {}): Promise<BrowserCaptureResult<BrowserConsoleEntry>> {
		await this.#pending;
		const entries = this.#query(
			entry => entry.type === "console" && (!options.level || entry.level === options.level),
			options.since,
			options.limit,
		) as BrowserConsoleEntry[];
		const result = this.#result(entries);
		if (options.clear) this.clear();
		return result;
	}

	/** Read captured uncaught exceptions and failed requests after an optional sequence cursor. */
	async errors(options: BrowserErrorOptions = {}): Promise<BrowserCaptureResult<BrowserErrorEntry>> {
		await this.#pending;
		const entries = this.#query(
			entry => entry.type !== "console",
			options.since,
			options.limit,
		) as BrowserErrorEntry[];
		const result = this.#result(entries);
		if (options.clear) this.clear();
		return result;
	}

	/** Count captured page errors and failed requests at or after a sequence cursor. */
	errorCountSince(sequence: number): number {
		return this.#entries.filter(entry => entry.type !== "console" && entry.seq >= sequence).length;
	}

	/** Clear captured entries and the overflow counter while preserving sequence monotonicity. */
	clear(): void {
		this.#entries = [];
		this.#dropped = 0;
	}

	/** Detach listeners and clear all captured state. */
	async detach(): Promise<void> {
		this.#generation += 1;
		if (this.#page && this.#consoleHandler) this.#page.off("console", this.#consoleHandler);
		if (this.#page && this.#pageErrorHandler) this.#page.off("pageerror", this.#pageErrorHandler);
		if (this.#page && this.#requestFailedHandler) this.#page.off("requestfailed", this.#requestFailedHandler);
		if (this.#cdp && this.#protocolConsoleHandler) {
			this.#cdp.off("Runtime.consoleAPICalled", this.#protocolConsoleHandler);
		}
		if (this.#cdp && this.#protocolExceptionHandler) {
			this.#cdp.off("Runtime.exceptionThrown", this.#protocolExceptionHandler);
		}
		if (this.#cdp && this.#protocolRequestHandler) {
			this.#cdp.off("Network.requestWillBeSent", this.#protocolRequestHandler);
		}
		if (this.#cdp && this.#protocolRequestFinishedHandler) {
			this.#cdp.off("Network.loadingFinished", this.#protocolRequestFinishedHandler);
		}
		if (this.#cdp && this.#protocolRequestFailedHandler) {
			this.#cdp.off("Network.loadingFailed", this.#protocolRequestFailedHandler);
		}
		await this.#cdp?.detach().catch(() => undefined);
		this.#page = undefined;
		this.#cdp = undefined;
		this.#consoleHandler = undefined;
		this.#pageErrorHandler = undefined;
		this.#requestFailedHandler = undefined;
		this.#protocolConsoleHandler = undefined;
		this.#protocolExceptionHandler = undefined;
		this.#protocolRequestHandler = undefined;
		this.#protocolRequestFinishedHandler = undefined;
		this.#protocolRequestFailedHandler = undefined;
		this.#requests.clear();
		this.clear();
	}

	#allocateSequence(): number {
		const sequence = this.#nextSeq;
		this.#nextSeq += 1;
		return sequence;
	}

	#push(entry: BrowserCaptureEntry): void {
		const last = this.#entries.at(-1);
		if (!last || last.seq < entry.seq) {
			this.#entries.push(entry);
		} else {
			const index = this.#entries.findIndex(existing => existing.seq > entry.seq);
			this.#entries.splice(index < 0 ? this.#entries.length : index, 0, entry);
		}
		while (this.#entries.length > this.#limit) {
			this.#entries.shift();
			this.#dropped += 1;
		}
	}

	#query(predicate: (entry: BrowserCaptureEntry) => boolean, since?: number, limit?: number): BrowserCaptureEntry[] {
		const cursor = Number.isFinite(since) ? Math.floor(since ?? 0) : 0;
		const maximum = Number.isFinite(limit) ? Math.max(0, Math.floor(limit ?? this.#limit)) : this.#limit;
		return this.#entries.filter(entry => entry.seq > cursor && predicate(entry)).slice(0, maximum);
	}

	#result<T extends BrowserCaptureEntry>(entries: T[]): BrowserCaptureResult<T> {
		return {
			entries,
			nextSeq: entries.at(-1)?.seq ?? this.#nextSeq - 1,
			dropped: this.#dropped,
		};
	}
}

/** Page-side console capture hook used by the cmux backend. */
export const CMUX_CONSOLE_CAPTURE_SCRIPT = String.raw`(() => {
	if (globalThis.__ompConsoleCapture) return true;
	const state = { entries: [], nextSeq: 1, dropped: 0 };
	const push = entry => {
		state.entries.push({ seq: state.nextSeq++, ts: Date.now(), ...entry });
		while (state.entries.length > 500) { state.entries.shift(); state.dropped++; }
	};
	const text = value => {
		try { return String(value); } catch {
			try { const json = JSON.stringify(value); if (json !== undefined) return json; } catch {}
			try { return Object.prototype.toString.call(value); } catch { return "[unserializable]"; }
		}
	};
	const safe = value => {
		try {
			const json = JSON.stringify(value);
			return json && json.length > 8192 ? json.slice(0, 8192) + "…" : value;
		} catch { return text(value); }
	};
	for (const level of ["log", "info", "warn", "error", "debug"]) {
		const original = console[level].bind(console);
		console[level] = (...args) => {
			push({ type: "console", level, text: args.map(text).join(" ").slice(0, 16384), args: args.map(safe) });
			return original(...args);
		};
	}
	addEventListener("error", event => push({
		type: "pageerror", level: "error", text: String(event.message || event.error || "Uncaught error").slice(0, 16384),
		location: event.filename ? event.filename + ":" + event.lineno + ":" + event.colno : undefined,
		stack: event.error && event.error.stack ? String(event.error.stack).slice(0, 32768) : undefined,
	}));
	addEventListener("unhandledrejection", event => {
		const reason = event.reason;
		push({ type: "pageerror", level: "error", text: String(reason && reason.message || reason).slice(0, 16384), stack: reason && reason.stack ? String(reason.stack).slice(0, 32768) : undefined });
	});
	globalThis.__ompConsoleCapture = state;
	return true;
})()`;
