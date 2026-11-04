/**
 * Telemetry bridge between the main thread and subagent workers.
 *
 * A subagent's `AgentTelemetryConfig` (`ExecutorOptions.parentTelemetry`)
 * must cross to the worker through {@link toWorkerTelemetryConfig}, called on
 * main inside the parent's `execute_tool task` context. The result:
 *
 * - carries a {@link BridgedTracer}: the resolved main tracer plus the OTEL
 *   context active at that call. A worker receives it as a `RemoteTracer` that
 *   starts every span on main's real tracer (one blocking call per span) and
 *   gets back a `RemoteSpan` whose mutators are ordered notifications. Spans
 *   the worker starts with no active span nest under the captured context;
 *   spans started under a bridged span nest under it on main. Hooks receive
 *   spans that travel back as main's real spans. Times are stamped in the
 *   worker so durations do not include main's queueing delay.
 * - wraps the synchronous hooks (`resolveAttributes`, `costEstimator`,
 *   `normalizeProvider`, `normalizeAgentName`, `contentSerializer.*`) so the
 *   worker calls them synchronously, and guards the void hooks (`onSpanStart`,
 *   `onSpanEnd`, `onRunEnd`, `onCostDelta`, `onTelemetryWarning`) on main:
 *   their failures reach `onTelemetryWarning` exactly as in-process instead of
 *   rejecting in the worker. `onChatUsage` crosses as an async call (the loop
 *   awaits it).
 * - accepts whatever an in-process caller would pass: every hook, and the
 *   bridged tracer's and spans' methods, take their arguments lossily
 *   (`rpcLossy`). Spans, functions (`model.resolveHeaders`), and other proxies
 *   still cross by reference and errors keep their class; any other class
 *   instance (a class-based `Model`, a tool, a library object) reaches main as
 *   a plain copy of its data fields and getters instead of failing the call.
 * - is matched by the {@link TELEMETRY_CONFIG_KIND} codec; decoding it on a
 *   worker installs an async-local context manager there if none exists.
 *
 * Spans a worker leaves open when it exits are ended on main with an error status.
 */
import {
	type AgentTelemetryConfig,
	type AgentTelemetryWarning,
	type ChatUsageEvent,
	DEFAULT_TRACER_NAME,
	type TelemetryContentSerializer,
} from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type Context,
	context,
	type Span,
	type SpanOptions,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import type { MainThreadLink, WorkerThreadLink } from "../protocol";
import { type RpcCodec, type RpcServe, rpcLossy, rpcSync } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import {
	fromWireLink,
	fromWireSpanContext,
	fromWireSpanOptions,
	TELEMETRY_CONFIG_KIND,
	TELEMETRY_SPAN_KIND,
	TELEMETRY_TRACER_KIND,
	type TelemetrySpanProtocol,
	type TelemetryTracerProtocol,
	toWireSpanContext,
	type WireSpanParent,
} from "./telemetry-protocol";
import { ensureWorkerContextManager, RemoteSpan, RemoteTracer } from "./telemetry-remote";

/** Main-thread tracer handed to workers: delegates to `target`, remembers the context the run left main in. */
export class BridgedTracer implements Tracer {
	/** The real tracer spans start on. */
	readonly target: Tracer;
	/** Context active when the run was handed off; parents worker spans that have no parent of their own. */
	readonly parentContext: Context;

	constructor(target: Tracer, parentContext: Context) {
		this.target = target;
		this.parentContext = parentContext;
	}

	startSpan(name: string, options?: SpanOptions, ctx?: Context): Span {
		return this.target.startSpan(name, options, ctx);
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
		if (typeof a === "function") return this.target.startActiveSpan(name, a);
		if (typeof b === "function") return this.target.startActiveSpan(name, a ?? {}, b);
		if (c) return this.target.startActiveSpan(name, a ?? {}, b ?? context.active(), c);
		throw new TypeError("startActiveSpan requires a callback");
	}
}

/** Tag on a {@link toWorkerTelemetryConfig} result; selects it for {@link TELEMETRY_CONFIG_KIND}. */
const kWorkerTelemetry = Symbol("thread.telemetry.workerConfig");
/** Tag on main spans a worker started; selects them for {@link TELEMETRY_SPAN_KIND}. */
const kWorkerSpan = Symbol("thread.telemetry.workerSpan");
const kPeerTelemetry = Symbol("thread.telemetry.peer");

function isWorkerTelemetryConfig(value: unknown): value is AgentTelemetryConfig {
	return typeof value === "object" && value !== null && Reflect.get(value, kWorkerTelemetry) === true;
}

function isWorkerSpan(value: unknown): value is Span {
	return typeof value === "object" && value !== null && Reflect.get(value, kWorkerSpan) === true;
}

type WarningCode = AgentTelemetryWarning["code"];
type WarningReporter = (code: WarningCode, message: string, error: unknown) => void;

/** Report a hook failure the way the agent loop does: to `onTelemetryWarning`, else the log. */
function warningReporter(onTelemetryWarning: AgentTelemetryConfig["onTelemetryWarning"]): WarningReporter {
	return (code, message, error) => {
		if (!onTelemetryWarning) {
			logger.warn(message, { code, error: String(error) });
			return;
		}
		try {
			onTelemetryWarning({ code, message, error });
		} catch (warningError) {
			logger.warn("onTelemetryWarning threw; swallowing", { error: String(warningError) });
		}
	};
}

/** A worker calls the result synchronously with lossy arguments; `hook` itself is left untouched. */
function syncHook<A, R>(hook: ((arg: A) => R) | undefined): ((arg: A) => R) | undefined {
	return hook ? rpcSync(rpcLossy((arg: A) => hook(arg))) : undefined;
}

/** `hook` with failures reported instead of thrown, so the worker's async call always resolves. */
function guardHook<A extends unknown[]>(
	hook: ((...args: A) => void) | undefined,
	report: WarningReporter,
	code: WarningCode,
	message: string,
): ((...args: A) => void) | undefined {
	if (!hook) return undefined;
	return rpcLossy((...args: A): void => {
		try {
			hook(...args);
		} catch (error) {
			report(code, message, error);
		}
	});
}

function syncSerializer(serializer: TelemetryContentSerializer): TelemetryContentSerializer {
	return {
		requestMessages: syncHook(serializer.requestMessages),
		responseText: syncHook(serializer.responseText),
		responseToolCalls: syncHook(serializer.responseToolCalls),
		toolCallArguments: syncHook(serializer.toolCallArguments),
		toolCallResult: syncHook(serializer.toolCallResult),
	};
}

/**
 * Prepare `config` for a subagent worker (see the module doc). Call on main
 * inside the OTEL context the subagent's spans should nest under.
 */
export function toWorkerTelemetryConfig(config: AgentTelemetryConfig): AgentTelemetryConfig {
	const target =
		config.tracer instanceof BridgedTracer
			? config.tracer.target
			: (config.tracer ?? trace.getTracer(config.tracerName ?? DEFAULT_TRACER_NAME));
	const tracer = new BridgedTracer(target, context.active());
	const { onTelemetryWarning, onChatUsage } = config;
	const report = warningReporter(onTelemetryWarning);
	const bridged: AgentTelemetryConfig = {
		...config,
		tracer,
		resolveAttributes: syncHook(config.resolveAttributes),
		costEstimator: syncHook(config.costEstimator),
		normalizeProvider: syncHook(config.normalizeProvider),
		normalizeAgentName: syncHook(config.normalizeAgentName),
		onChatUsage: onChatUsage ? rpcLossy((event: ChatUsageEvent) => onChatUsage(event)) : undefined,
		contentSerializer: config.contentSerializer ? syncSerializer(config.contentSerializer) : undefined,
		onSpanStart: guardHook(
			config.onSpanStart,
			report,
			"on_span_start_failed",
			"onSpanStart threw; swallowing telemetry hook failure",
		),
		onSpanEnd: guardHook(
			config.onSpanEnd,
			report,
			"on_span_end_failed",
			"onSpanEnd threw; swallowing telemetry hook failure",
		),
		onRunEnd: guardHook(
			config.onRunEnd,
			report,
			"on_run_end_failed",
			"onRunEnd threw; swallowing telemetry callback failure",
		),
		onCostDelta: guardHook(
			config.onCostDelta,
			report,
			"on_cost_delta_failed",
			"onCostDelta threw; swallowing telemetry callback failure",
		),
		onTelemetryWarning: onTelemetryWarning
			? rpcLossy((warning: AgentTelemetryWarning) => {
					try {
						onTelemetryWarning(warning);
					} catch (error) {
						logger.warn("onTelemetryWarning threw; swallowing", { error: String(error) });
					}
				})
			: undefined,
	};
	Reflect.set(bridged, kWorkerTelemetry, true);
	return bridged;
}

/** Void hooks the worker fires without awaiting; their rejections (a closing link) must not go unhandled. */
const DETACHED_HOOKS: readonly string[] = ["onSpanStart", "onSpanEnd", "onRunEnd", "onCostDelta", "onTelemetryWarning"];

const telemetryConfigCodec: RpcCodec<AgentTelemetryConfig> = {
	kind: TELEMETRY_CONFIG_KIND,
	is: isWorkerTelemetryConfig,
	encode: config => {
		// String keys only: a spread would copy the tag and match this codec again.
		const fields: Record<string, unknown> = {};
		for (const key in config) fields[key] = Reflect.get(config, key);
		return fields;
	},
	decode: data => {
		ensureWorkerContextManager();
		if (typeof data !== "object" || data === null) return data;
		for (const key of DETACHED_HOOKS) {
			const hook: unknown = Reflect.get(data, key);
			if (typeof hook !== "function") continue;
			Reflect.set(data, key, (...args: unknown[]): void => {
				const result: unknown = Reflect.apply(hook, undefined, args);
				if (result instanceof Promise) {
					result.catch((error: unknown) =>
						logger.debug("Telemetry hook call to main failed", { error: String(error) }),
					);
				}
			});
		}
		return data;
	},
};

/** Spans a worker started and has not ended, so its exit can close them. */
class PeerTelemetryState {
	readonly open = new Set<Span>();

	endAll(reason: string): void {
		for (const span of this.open) {
			span.setStatus({ code: SpanStatusCode.ERROR, message: `Subagent worker exited: ${reason}` });
			span.end();
		}
		this.open.clear();
	}
}

function peerState(link: MainThreadLink): PeerTelemetryState {
	const existing: unknown = Reflect.get(link, kPeerTelemetry);
	if (existing instanceof PeerTelemetryState) return existing;
	const state = new PeerTelemetryState();
	Reflect.set(link, kPeerTelemetry, state);
	return state;
}

function parentContext(tracer: BridgedTracer, parent: WireSpanParent): Context {
	switch (parent.type) {
		case "inherit":
			return tracer.parentContext;
		case "span":
			return trace.setSpan(tracer.parentContext, parent.span);
		case "context":
			return trace.setSpanContext(tracer.parentContext, fromWireSpanContext(parent.spanContext));
	}
}

function serveTracer(state: PeerTelemetryState): RpcServe<BridgedTracer, TelemetryTracerProtocol> {
	return {
		startSpan: (tracer, name, options, parent) => {
			const span = tracer.startSpan(name, fromWireSpanOptions(options), parentContext(tracer, parent));
			Reflect.set(span, kWorkerSpan, true);
			const recording = span.isRecording();
			if (recording) state.open.add(span);
			return { span, spanContext: toWireSpanContext(span.spanContext()), recording };
		},
	};
}

function serveSpan(state: PeerTelemetryState): RpcServe<Span, TelemetrySpanProtocol> {
	return {
		spanContext: span => toWireSpanContext(span.spanContext()),
		isRecording: span => span.isRecording(),
		setAttribute: (span, key, value) => {
			span.setAttribute(key, value);
		},
		setAttributes: (span, attributes) => {
			span.setAttributes(attributes);
		},
		addEvent: (span, name, attributes, time) => {
			if (attributes) span.addEvent(name, attributes, time);
			else span.addEvent(name, time);
		},
		addLink: (span, link) => {
			span.addLink(fromWireLink(link));
		},
		addLinks: (span, links) => {
			span.addLinks(links.map(fromWireLink));
		},
		setStatus: (span, status) => {
			span.setStatus(status);
		},
		updateName: (span, name) => {
			span.updateName(name);
		},
		recordException: (span, exception, time) => {
			span.recordException(exception, time);
		},
		end: (span, endTime) => {
			state.open.delete(span);
			span.end(endTime);
		},
	};
}

/** OTEL tracer, span, and telemetry-hook bridging for subagent workers. */
export const telemetryThreadService: ThreadService = {
	name: "telemetry",

	installMain(peer: WorkerPeer): void {
		const link = peer.link;
		const state = peerState(link);
		link.codec(telemetryConfigCodec);
		link.exportClass<BridgedTracer, TelemetryTracerProtocol>(
			TELEMETRY_TRACER_KIND,
			(value): value is BridgedTracer => value instanceof BridgedTracer,
			serveTracer(state),
			{ lossy: true },
		);
		link.exportClass<Span, TelemetrySpanProtocol>(TELEMETRY_SPAN_KIND, isWorkerSpan, serveSpan(state), {
			lossy: true,
		});
	},

	onWorkerExit(peer: WorkerPeer, reason: string): void {
		peerState(peer.link).endAll(reason);
	},

	installWorker(link: WorkerThreadLink): void {
		link.codec(telemetryConfigCodec);
		link.importClass<RemoteTracer, TelemetryTracerProtocol>(
			TELEMETRY_TRACER_KIND,
			remote => new RemoteTracer(remote),
		);
		link.importClass<RemoteSpan, TelemetrySpanProtocol>(TELEMETRY_SPAN_KIND, remote => new RemoteSpan(remote));
	},
};
