import { type MessagePort, parentPort } from "node:worker_threads";
import {
	type AgentTelemetryConfig,
	finishExecuteToolSpan,
	recordHandoff,
	recordManualChatTelemetry,
	resolveTelemetry,
	runInActiveSpan,
	startExecuteToolSpan,
	startInvokeAgentSpan,
} from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { trace } from "@opentelemetry/api";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { telemetryThreadService } from "../../src/thread/services/telemetry";
import { RemoteSpan, RemoteTracer } from "../../src/thread/services/telemetry-remote";

/** Span ids the worker observed, for comparison with main's exported spans. */
export interface TelemetryRunReport {
	remoteTracer: boolean;
	invokeSpanId: string;
	toolSpanId: string;
	innerSpanId: string;
	activeIsRemote: boolean;
	innerTraceId: string;
}

/** Worker-side operations the test drives. */
export interface TelemetryProbe {
	run(): Promise<TelemetryRunReport>;
	startDangling(): Promise<string>;
}

/** Test-only boot globals. */
export interface TelemetryTestGlobals {
	config: AgentTelemetryConfig;
	ready(probe: TelemetryProbe): void;
}

function isTestGlobals(value: unknown): value is TelemetryTestGlobals {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "config") === "object" &&
		typeof Reflect.get(value, "ready") === "function"
	);
}

/** Class-based provider cost, as a library would report it; `billable` is a prototype getter. */
class CostBreakdown {
	readonly input = 0.1;
	readonly output = 0.15;
	readonly cacheRead = 0;
	readonly cacheWrite = 0;

	get total(): number {
		return this.input + this.output;
	}

	get billable(): boolean {
		return this.total > 0;
	}
}

/** Class-based response headers, as a transport library would hand them over. */
class GatewayHeaders {
	[name: string]: string;

	constructor() {
		this["x-litellm-call-id"] = "litellm-call-1";
	}
}

/** A non-`Error` exception class whose message is a prototype getter. */
class ToolFailure {
	readonly code: string;

	constructor(code: string) {
		this.code = code;
	}

	get message(): string {
		return `tool failed (${this.code})`;
	}
}

function buildProbe(parentTelemetry: AgentTelemetryConfig): TelemetryProbe {
	return {
		run: async () => {
			// Mirrors runSubprocess: handoff on the parent's config, child config derived by spread.
			const toAgent = { id: "child-1", name: "child" };
			recordHandoff(resolveTelemetry(parentTelemetry, parentTelemetry.conversationId), {
				fromAgent: parentTelemetry.agent,
				toAgent,
			});
			const telemetry = resolveTelemetry(
				{ ...parentTelemetry, agent: toAgent, conversationId: undefined },
				"child-session",
			);
			// A class instance with an own function field (`stream`) and a getter returning itself (`model`).
			const model = createMockModel({ id: "mock-model", provider: "mock" });
			const invoke = startInvokeAgentSpan(telemetry, model);
			if (!invoke) throw new Error("telemetry disabled");
			let toolSpanId = "";
			let innerSpanId = "";
			let innerTraceId = "";
			let activeIsRemote = false;
			await runInActiveSpan(invoke, async () => {
				const tool = startExecuteToolSpan(telemetry, {
					tool: undefined,
					toolName: "read",
					toolCallId: "call-1",
					args: { path: "a.txt" },
				});
				if (!tool) throw new Error("no tool span");
				toolSpanId = tool.spanContext().spanId;
				await runInActiveSpan(tool, async () => {
					activeIsRemote = trace.getActiveSpan() instanceof RemoteSpan;
					// The active span must survive a macrotask hop (async-local context manager).
					const hop = Promise.withResolvers<void>();
					setImmediate(hop.resolve);
					await hop.promise;
					const inner = telemetry?.tracer.startSpan("inner");
					if (!inner) throw new Error("no inner span");
					inner.setAttribute("test.inner", true);
					inner.addEvent("inner-event", { step: 1 });
					inner.recordException(new ToolFailure("E42"));
					innerSpanId = inner.spanContext().spanId;
					innerTraceId = inner.spanContext().traceId;
					inner.end();
				});
				finishExecuteToolSpan(telemetry, tool, {
					isError: false,
					toolCallId: "call-1",
					toolName: "read",
				});
				await recordManualChatTelemetry(telemetry, {
					model,
					stepNumber: 0,
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: new CostBreakdown(),
					},
					responseHeaders: new GatewayHeaders(),
				});
			});
			// Hosts may fire lifecycle hooks with their own context (the loop passes no model on end).
			telemetry?.config.onSpanEnd?.({
				kind: "invoke_agent",
				model,
				agent: toAgent,
				conversationId: "child-session",
				span: invoke,
			});
			invoke.end();
			return {
				remoteTracer: telemetry?.tracer instanceof RemoteTracer,
				invokeSpanId: invoke.spanContext().spanId,
				toolSpanId,
				innerSpanId,
				activeIsRemote,
				innerTraceId,
			};
		},
		startDangling: async () => {
			const telemetry = resolveTelemetry(parentTelemetry, undefined);
			const span = telemetry?.tracer.startSpan("dangling");
			if (!span) throw new Error("telemetry disabled");
			return span.spanContext().spanId;
		},
	};
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "telemetry-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	telemetryThreadService.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		await telemetryThreadService.boot?.(globals[telemetryThreadService.name], link);
		const test = globals.test;
		if (!isTestGlobals(test)) throw new Error("telemetry fixture: missing test globals");
		await test.ready(buildProbe(test.config));
	});
	port.postMessage({ ready: true });
});
