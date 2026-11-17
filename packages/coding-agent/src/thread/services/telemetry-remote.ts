/**
 * Worker half of the telemetry bridge (see `./telemetry`): a `Tracer` whose
 * spans are started, mutated, and ended on the main thread's real tracer.
 */
import { logger } from "@oh-my-pi/pi-utils";
import {
	type Context,
	context,
	type Exception,
	type Link,
	type Span,
	type SpanAttributes,
	type SpanAttributeValue,
	type SpanContext,
	type SpanOptions,
	type SpanStatus,
	type TimeInput,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { RemoteObject } from "../rpc";
import {
	fromWireSpanContext,
	type TelemetrySpanProtocol,
	type TelemetryTracerProtocol,
	toWireLink,
	toWireSpanContext,
	type WireSpanParent,
} from "./telemetry-protocol";

let contextManagerChecked = false;

/**
 * Give this thread an async-local OTEL context manager unless one is already
 * registered, so `context.with(span)` nests the worker's spans. Idempotent.
 */
export function ensureWorkerContextManager(): void {
	if (contextManagerChecked) return;
	contextManagerChecked = true;
	const manager = new AsyncLocalStorageContextManager().enable();
	if (!context.setGlobalContextManager(manager)) manager.disable();
}

/**
 * Epoch milliseconds for `time`, stamped now when absent. Worker-relative
 * performance timestamps are rebased: main has its own time origin.
 */
function wireTime(time: TimeInput | undefined): TimeInput {
	if (time === undefined) return performance.timeOrigin + performance.now();
	if (typeof time === "number" && time < performance.timeOrigin) return performance.timeOrigin + time;
	return time;
}

function isTimeInput(value: unknown): value is TimeInput {
	return typeof value === "number" || Array.isArray(value) || value instanceof Date;
}

/**
 * A main-thread span seen from a worker. Mutators are ordered notifications;
 * `spanContext()` and `isRecording()` answer from what main reported at start.
 */
export class RemoteSpan implements Span {
	readonly #remote: RemoteObject<TelemetrySpanProtocol>;
	#context: SpanContext | undefined;
	#recording: boolean | undefined;
	#ended = false;

	constructor(remote: RemoteObject<TelemetrySpanProtocol>) {
		this.#remote = remote;
	}

	/** Seed the identity and recording state main reported when it started the span. */
	prime(spanContext: SpanContext, recording: boolean): void {
		this.#context = spanContext;
		this.#recording = recording;
	}

	spanContext(): SpanContext {
		this.#context ??= fromWireSpanContext(this.#remote.callSync("spanContext"));
		return this.#context;
	}

	isRecording(): boolean {
		if (this.#ended) return false;
		this.#recording ??= this.#remote.callSync("isRecording");
		return this.#recording;
	}

	setAttribute(key: string, value: SpanAttributeValue): this {
		if (this.isRecording()) this.#send("setAttribute", key, value);
		return this;
	}

	setAttributes(attributes: SpanAttributes): this {
		if (this.isRecording()) this.#send("setAttributes", attributes);
		return this;
	}

	addEvent(name: string, attributesOrStartTime?: SpanAttributes | TimeInput, startTime?: TimeInput): this {
		if (!this.isRecording()) return this;
		if (isTimeInput(attributesOrStartTime)) this.#send("addEvent", name, undefined, wireTime(attributesOrStartTime));
		else this.#send("addEvent", name, attributesOrStartTime, wireTime(startTime));
		return this;
	}

	addLink(link: Link): this {
		if (this.isRecording()) this.#send("addLink", toWireLink(link));
		return this;
	}

	addLinks(links: Link[]): this {
		if (this.isRecording()) this.#send("addLinks", links.map(toWireLink));
		return this;
	}

	setStatus(status: SpanStatus): this {
		if (this.isRecording()) this.#send("setStatus", status);
		return this;
	}

	updateName(name: string): this {
		if (this.isRecording()) this.#send("updateName", name);
		return this;
	}

	recordException(exception: Exception, time?: TimeInput): void {
		if (this.isRecording()) this.#send("recordException", exception, wireTime(time));
	}

	end(endTime?: TimeInput): void {
		if (!this.isRecording()) return;
		this.#ended = true;
		this.#send("end", wireTime(endTime));
	}

	/** Notify main; a value structured clone still rejects (a function inside a `Map`) drops this one update, never the caller. */
	#send<K extends keyof TelemetrySpanProtocol & string>(method: K, ...args: TelemetrySpanProtocol[K]["args"]): void {
		try {
			this.#remote.notify(method, ...args);
		} catch (error) {
			logger.warn("Dropped a span update that cannot cross threads", { method, error: String(error) });
		}
	}
}

function wireParent(span: Span | undefined): WireSpanParent {
	if (!span) return { type: "inherit" };
	if (span instanceof RemoteSpan) return { type: "span", span };
	return { type: "context", spanContext: toWireSpanContext(span.spanContext()) };
}

/**
 * A main-thread tracer seen from a worker: spans start on main (blocking, so
 * the returned span is real immediately), parented by the worker's active
 * context or, without one, by the context active when the run left main.
 */
export class RemoteTracer implements Tracer {
	readonly #remote: RemoteObject<TelemetryTracerProtocol>;

	constructor(remote: RemoteObject<TelemetryTracerProtocol>) {
		this.#remote = remote;
		ensureWorkerContextManager();
	}

	startSpan(name: string, options?: SpanOptions, ctx: Context = context.active()): Span {
		const started = this.#remote.callSync(
			"startSpan",
			name,
			{
				kind: options?.kind,
				attributes: options?.attributes,
				links: options?.links?.map(toWireLink),
				startTime: wireTime(options?.startTime),
				root: options?.root,
			},
			options?.root ? { type: "inherit" } : wireParent(trace.getSpan(ctx)),
		);
		const span = started.span;
		if (span instanceof RemoteSpan) span.prime(fromWireSpanContext(started.spanContext), started.recording);
		return span;
	}

	startActiveSpan<R>(name: string, fn: (span: Span) => R): R;
	startActiveSpan<R>(name: string, options: SpanOptions | undefined, fn: (span: Span) => R): R;
	startActiveSpan<R>(
		name: string,
		options: SpanOptions | undefined,
		ctx: Context | undefined,
		fn: (span: Span) => R,
	): R;
	startActiveSpan<R>(
		name: string,
		a: SpanOptions | undefined | ((span: Span) => R),
		b?: Context | ((span: Span) => R),
		c?: (span: Span) => R,
	): R {
		let options: SpanOptions | undefined;
		let ctx: Context | undefined;
		let fn: (span: Span) => R;
		if (typeof a === "function") {
			fn = a;
		} else if (typeof b === "function") {
			options = a;
			fn = b;
		} else if (c) {
			options = a;
			ctx = b;
			fn = c;
		} else {
			throw new TypeError("startActiveSpan requires a callback");
		}
		const parent = ctx ?? context.active();
		const span = this.startSpan(name, options, parent);
		return context.with(trace.setSpan(parent, span), fn, undefined, span);
	}
}
