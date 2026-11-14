import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MessageChannel } from "node:worker_threads";
import type {
	AgentTelemetryConfig,
	AgentTelemetryWarning,
	ChatUsageEvent,
	CostEstimatorContext,
	TelemetryAttributeContext,
	TelemetryHookContext,
} from "@oh-my-pi/pi-agent-core";
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { MainThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { WorkerPeer } from "../../src/thread/services";
import { BridgedTracer, telemetryThreadService, toWorkerTelemetryConfig } from "../../src/thread/services/telemetry";
import type { TelemetryProbe, TelemetryTestGlobals } from "../fixtures/telemetry-bridge-worker";

describe("telemetry thread service", () => {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	const tracer = provider.getTracer("telemetry-bridge-test");
	let contextManager: AsyncLocalStorageContextManager | undefined;
	let worker: Worker | undefined;
	let link: MainThreadLink | undefined;
	let peer: WorkerPeer;
	let probe: TelemetryProbe;
	let parent: Span;
	/** Spans `onSpanStart` received; `unknown` so the exporter's `ReadableSpan`s compare by identity. */
	let startedSpans: unknown[];
	let endedKinds: string[];
	let estimates: CostEstimatorContext[];
	/** Hook contexts as main received them, to check what crossed from the worker. */
	let resolved: TelemetryAttributeContext[];
	let startedContexts: TelemetryHookContext[];
	let endedContexts: TelemetryHookContext[];
	let chatUsages: ChatUsageEvent[];
	let warnings: AgentTelemetryWarning[];

	beforeAll(() => {
		const manager = new AsyncLocalStorageContextManager().enable();
		if (context.setGlobalContextManager(manager)) contextManager = manager;
		else manager.disable();
	});

	afterAll(() => {
		if (contextManager) context.disable();
	});

	beforeEach(async () => {
		exporter.reset();
		startedSpans = [];
		endedKinds = [];
		estimates = [];
		resolved = [];
		startedContexts = [];
		endedContexts = [];
		chatUsages = [];
		warnings = [];
		const config: AgentTelemetryConfig = {
			tracer,
			agent: { id: "parent-1", name: "parent" },
			conversationId: "parent-conversation",
			resolveAttributes: ctx => {
				resolved.push(ctx);
				return { "test.tenant": "acme", "test.model": ctx.model?.id ?? "none" };
			},
			normalizeAgentName: name => name?.toUpperCase(),
			costEstimator: input => {
				estimates.push(input);
				return { usd: 0.42 };
			},
			onChatUsage: event => {
				chatUsages.push(event);
			},
			onSpanStart: (ctx: TelemetryHookContext) => {
				startedSpans.push(ctx.span);
				startedContexts.push(ctx);
			},
			onSpanEnd: (ctx: TelemetryHookContext) => {
				endedKinds.push(ctx.kind);
				endedContexts.push(ctx);
				ctx.span.setAttribute("test.end_hook", ctx.kind);
			},
			onTelemetryWarning: warning => {
				warnings.push(warning);
			},
		};
		parent = tracer.startSpan("execute_tool task");
		const workerConfig = context.with(trace.setSpan(context.active(), parent), () => toWorkerTelemetryConfig(config));

		const spawned = new Worker(new URL("../fixtures/telemetry-bridge-worker.ts", import.meta.url).href, {
			type: "module",
		});
		worker = spawned;
		const channel = new MessageChannel();
		const counter = new SharedArrayBuffer(4);
		const { promise: ready, resolve: onReady } = Promise.withResolvers<void>();
		const readyListener = (event: MessageEvent): void => {
			if (event.data?.ready) {
				spawned.removeEventListener("message", readyListener);
				onReady();
			}
		};
		spawned.addEventListener("message", readyListener);
		spawned.postMessage({ sync: channel.port2, counter }, [channel.port2]);
		await ready;
		const mainLink: MainThreadLink = new RpcLink(
			{
				send: frame => spawned.postMessage(frame),
				listen: handler => {
					const listener = (event: MessageEvent<RpcFrame>): void => handler(event.data);
					spawned.addEventListener("message", listener);
					return () => spawned.removeEventListener("message", listener);
				},
			},
			{ name: "main↔telemetry-fixture", syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
		);
		link = mainLink;
		mainLink.handle("ping", nonce => nonce);
		peer = { threadId: "w1", link: mainLink };
		telemetryThreadService.installMain?.(peer);
		const { promise: probed, resolve: onProbe } = Promise.withResolvers<TelemetryProbe>();
		const test: TelemetryTestGlobals = { config: workerConfig, ready: received => onProbe(received) };
		await mainLink.call("boot", { test });
		probe = await probed;
	});

	afterEach(async () => {
		link?.close("test done");
		link = undefined;
		await worker?.terminate();
		worker = undefined;
	});

	function finished(name: string): ReadableSpan {
		const span = exporter.getFinishedSpans().find(candidate => candidate.name === name);
		if (!span) {
			throw new Error(`no finished span ${name}: ${exporter.getFinishedSpans().map(s => s.name)}`);
		}
		return span;
	}

	it("starts worker spans on main's tracer, nested under the hand-off context", async () => {
		// Hook calls and span updates precede the run's reply on the port, so main has applied them all here.
		const report = await probe.run();
		parent.end();

		expect(report.remoteTracer).toBe(true);
		expect(report.activeIsRemote).toBe(true);
		const parentId = parent.spanContext().spanId;
		const traceId = parent.spanContext().traceId;

		const handoff = finished("handoff PARENT → CHILD");
		expect(handoff.parentSpanContext?.spanId).toBe(parentId);

		const invoke = finished("invoke_agent CHILD");
		expect(invoke.spanContext().spanId).toBe(report.invokeSpanId);
		expect(invoke.parentSpanContext?.spanId).toBe(parentId);
		expect(invoke.spanContext().traceId).toBe(traceId);
		expect(invoke.attributes["test.tenant"]).toBe("acme");

		const tool = finished("execute_tool read");
		expect(tool.spanContext().spanId).toBe(report.toolSpanId);
		expect(tool.parentSpanContext?.spanId).toBe(report.invokeSpanId);
		expect(tool.attributes["test.end_hook"]).toBe("execute_tool");

		const inner = finished("inner");
		expect(inner.spanContext().spanId).toBe(report.innerSpanId);
		expect(inner.spanContext().traceId).toBe(traceId);
		expect(report.innerTraceId).toBe(traceId);
		expect(inner.parentSpanContext?.spanId).toBe(report.toolSpanId);
		expect(inner.attributes["test.inner"]).toBe(true);
		expect(inner.events.map(event => event.name)).toEqual(["inner-event", "exception"]);

		const chat = finished("chat mock-model");
		expect(chat.parentSpanContext?.spanId).toBe(report.invokeSpanId);
		expect(chat.attributes["omp.gen_ai.cost.estimated_usd"]).toBe(0.42);
		expect(estimates).toHaveLength(1);
		expect(estimates[0]?.usage.inputTokens).toBe(10);

		// onSpanStart saw main's real span objects, the same ones the exporter received.
		expect(startedSpans).toContain(invoke);
		expect(startedSpans).toContain(tool);
		expect(startedSpans).toContain(chat);
		expect(endedKinds).toContain("handoff");
		expect(endedKinds).toContain("execute_tool");
	});

	it("hands class-instance hook arguments to main's hooks as their data", async () => {
		await probe.run();
		parent.end();

		// No hook call was refused or failed on the way.
		expect(warnings).toEqual([]);
		const invoke = finished("invoke_agent CHILD");
		const chat = finished("chat mock-model");

		// The class-based MockModel crossed as its fields and getters; its function field by reference.
		const modelSeen = startedContexts.find(ctx => ctx.kind === "chat")?.model;
		expect(modelSeen).toMatchObject({
			id: "mock-model",
			provider: "mock",
			api: "mock",
			contextWindow: 200_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			calls: [],
		});
		expect(typeof Reflect.get(modelSeen ?? {}, "stream")).toBe("function");
		// The `model` getter returns the instance itself: the cycle survives the copy.
		expect(Reflect.get(modelSeen ?? {}, "model")).toBe(modelSeen);
		expect(resolved.filter(ctx => ctx.model?.id === "mock-model").map(ctx => ctx.kind)).toEqual(
			expect.arrayContaining(["invoke_agent", "chat"]),
		);
		expect(invoke.attributes["test.model"]).toBe("mock-model");
		expect(chat.attributes["test.model"]).toBe("mock-model");

		// costEstimator: the provider's class-based cost, getters included.
		expect(estimates).toHaveLength(1);
		expect(estimates[0]?.usageCost).toMatchObject({ input: 0.1, output: 0.15, total: 0.25, billable: true });
		expect(chat.attributes["omp.gen_ai.cost.estimated_usd"]).toBe(0.42);

		// onChatUsage: class-based headers as data, and main's real chat span.
		expect(chatUsages).toHaveLength(1);
		expect(chatUsages[0]?.headers?.["x-litellm-call-id"]).toBe("litellm-call-1");
		const usageSpan: unknown = chatUsages[0]?.span;
		expect(usageSpan).toBe(chat);

		// onSpanEnd: the class-based model plus the span, which still links to main's invoke span.
		const ended = endedContexts.find(ctx => ctx.kind === "invoke_agent");
		expect(ended?.model).toMatchObject({ id: "mock-model", provider: "mock", maxTokens: 32_768 });
		const endedSpan: unknown = ended?.span;
		expect(endedSpan).toBe(invoke);
		expect(invoke.attributes["test.end_hook"]).toBe("invoke_agent");

		// A non-Error exception class reaches the span as its data, getter-backed message included.
		const inner = finished("inner");
		const exception = inner.events.find(event => event.name === "exception");
		expect(exception?.attributes?.["exception.message"]).toBe("tool failed (E42)");
		expect(exception?.attributes?.["exception.type"]).toBe("E42");
	});

	it("ends spans a worker leaves open when the worker exits", async () => {
		const spanId = await probe.startDangling();
		expect(exporter.getFinishedSpans().some(span => span.spanContext().spanId === spanId)).toBe(false);

		telemetryThreadService.onWorkerExit?.(peer, "crashed");

		const dangling = finished("dangling");
		expect(dangling.spanContext().spanId).toBe(spanId);
		expect(dangling.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
		expect(dangling.status).toEqual({ code: SpanStatusCode.ERROR, message: "Subagent worker exited: crashed" });
		parent.end();
	});

	it("keeps the converted config usable in-process", () => {
		const config = toWorkerTelemetryConfig({ tracer });
		expect(config.tracer).toBeInstanceOf(BridgedTracer);
		const span = config.tracer?.startSpan("local");
		span?.end();
		expect(finished("local").spanContext().traceId).toBe(span?.spanContext().traceId ?? "");
		parent.end();
	});
});
