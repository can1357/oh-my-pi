/**
 * Wire protocol of the telemetry bridge (see `./telemetry`): remote-object
 * kinds, method tables, and the plain-data forms of OTEL values that hold
 * class instances (`TraceState`) and so cannot cross as-is.
 */
import {
	type Attributes,
	createTraceState,
	type Exception,
	type Link,
	type Span,
	type SpanAttributes,
	type SpanAttributeValue,
	type SpanContext,
	type SpanKind,
	type SpanOptions,
	type SpanStatus,
	type TimeInput,
} from "@opentelemetry/api";
import type { RpcMethod } from "../rpc";

/** Codec kind of a config produced by `toWorkerTelemetryConfig`. */
export const TELEMETRY_CONFIG_KIND = "agent-telemetry-config";
/** Exported-class kind of a main-thread tracer handed to a worker. */
export const TELEMETRY_TRACER_KIND = "otel-tracer";
/** Exported-class kind of a main-thread span a worker started. */
export const TELEMETRY_SPAN_KIND = "otel-span";

/** `SpanContext` with its trace state serialized. */
export interface WireSpanContext {
	readonly traceId: string;
	readonly spanId: string;
	readonly traceFlags: number;
	readonly isRemote?: boolean;
	readonly traceState?: string;
}

/** `Link` with a {@link WireSpanContext}. */
export interface WireLink {
	readonly context: WireSpanContext;
	readonly attributes?: SpanAttributes;
	readonly droppedAttributesCount?: number;
}

/** `SpanOptions` with wire links and a start time stamped by the worker. */
export interface WireSpanOptions {
	readonly kind?: SpanKind;
	readonly attributes?: Attributes;
	readonly links?: WireLink[];
	readonly startTime: TimeInput;
	readonly root?: boolean;
}

/** Parent the worker found on the context it passed to `startSpan`. */
export type WireSpanParent =
	/** No span on the worker context: parent under the context captured when the run left main. */
	| { readonly type: "inherit" }
	/** A span this bridge started (travels back as main's real span). */
	| { readonly type: "span"; readonly span: Span }
	/** A span the worker made itself; only its identity crosses. */
	| { readonly type: "context"; readonly spanContext: WireSpanContext };

/** Main's answer to `startSpan`: the span plus what the worker caches for sync reads. */
export interface StartedSpan {
	readonly span: Span;
	readonly spanContext: WireSpanContext;
	readonly recording: boolean;
}

/** Methods of {@link TELEMETRY_TRACER_KIND}. */
export type TelemetryTracerProtocol = {
	startSpan: RpcMethod<[name: string, options: WireSpanOptions, parent: WireSpanParent], StartedSpan>;
};

/** Methods of {@link TELEMETRY_SPAN_KIND}; everything but the two reads is a notification. */
export type TelemetrySpanProtocol = {
	spanContext: RpcMethod<[], WireSpanContext>;
	isRecording: RpcMethod<[], boolean>;
	setAttribute: RpcMethod<[key: string, value: SpanAttributeValue], void>;
	setAttributes: RpcMethod<[attributes: SpanAttributes], void>;
	addEvent: RpcMethod<[name: string, attributes: SpanAttributes | undefined, time: TimeInput], void>;
	addLink: RpcMethod<[link: WireLink], void>;
	addLinks: RpcMethod<[links: WireLink[]], void>;
	setStatus: RpcMethod<[status: SpanStatus], void>;
	updateName: RpcMethod<[name: string], void>;
	recordException: RpcMethod<[exception: Exception, time: TimeInput], void>;
	end: RpcMethod<[endTime: TimeInput], void>;
};

/** Plain-data form of `context`. */
export function toWireSpanContext(context: SpanContext): WireSpanContext {
	return {
		traceId: context.traceId,
		spanId: context.spanId,
		traceFlags: context.traceFlags,
		isRemote: context.isRemote,
		traceState: context.traceState?.serialize(),
	};
}

/** Rebuild a `SpanContext` from {@link toWireSpanContext}. */
export function fromWireSpanContext(wire: WireSpanContext): SpanContext {
	const context: SpanContext = { traceId: wire.traceId, spanId: wire.spanId, traceFlags: wire.traceFlags };
	if (wire.isRemote !== undefined) context.isRemote = wire.isRemote;
	if (wire.traceState !== undefined) context.traceState = createTraceState(wire.traceState);
	return context;
}

/** Plain-data form of `link`. */
export function toWireLink(link: Link): WireLink {
	return {
		context: toWireSpanContext(link.context),
		attributes: link.attributes,
		droppedAttributesCount: link.droppedAttributesCount,
	};
}

/** Rebuild a `Link` from {@link toWireLink}. */
export function fromWireLink(wire: WireLink): Link {
	return {
		context: fromWireSpanContext(wire.context),
		attributes: wire.attributes,
		droppedAttributesCount: wire.droppedAttributesCount,
	};
}

/** Rebuild `SpanOptions` from {@link WireSpanOptions}. */
export function fromWireSpanOptions(wire: WireSpanOptions): SpanOptions {
	return {
		kind: wire.kind,
		attributes: wire.attributes,
		links: wire.links?.map(fromWireLink),
		startTime: wire.startTime,
		root: wire.root,
	};
}
