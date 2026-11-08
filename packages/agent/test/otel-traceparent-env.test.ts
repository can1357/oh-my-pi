/**
 * A root span with no explicit parent and no active span adopts the W3C
 * context from the TRACEPARENT environment variable (set by a launching
 * process that already owns a trace). Anything else keeps the old behavior.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { recordHandoff, resolveTelemetry, startInvokeAgentSpan } from "@oh-my-pi/pi-agent-core/telemetry";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const PARENT_SPAN_ID = "b7ad6b7169203331";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;
const originalTraceparent = process.env.TRACEPARENT;
const model = createMockModel({ id: "mock-model", provider: "mock-provider", responses: [] }).model;

beforeAll(() => {
	trace.disable();
	context.disable();
	// No global propagator is registered: hosts that inject a tracer without registering one still get the parent.
	context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
	provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
	exporter.reset();
	if (originalTraceparent === undefined) delete process.env.TRACEPARENT;
	else process.env.TRACEPARENT = originalTraceparent;
});

afterAll(async () => {
	await provider.shutdown();
	context.disable();
	trace.disable();
});

function startRoot() {
	const span = startInvokeAgentSpan(resolveTelemetry({}, undefined), model);
	span?.end();
	return exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
}

describe("TRACEPARENT as the parent of root spans", () => {
	it("attaches a root span to the trace in TRACEPARENT", () => {
		process.env.TRACEPARENT = TRACEPARENT;
		const root = startRoot();
		expect(root?.spanContext().traceId).toBe(TRACE_ID);
		expect(root?.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
	});

	it("starts a fresh trace when TRACEPARENT is unset", () => {
		delete process.env.TRACEPARENT;
		const root = startRoot();
		expect(root?.parentSpanContext).toBeUndefined();
	});

	it.each(["", "garbage", "00-xyz-b7ad6b7169203331-01", `00-${"0".repeat(32)}-${PARENT_SPAN_ID}-01`])(
		"ignores an invalid TRACEPARENT %p",
		value => {
			process.env.TRACEPARENT = value;
			const root = startRoot();
			expect(root?.parentSpanContext).toBeUndefined();
		},
	);

	it("lets an active span win over TRACEPARENT", () => {
		process.env.TRACEPARENT = TRACEPARENT;
		const outer = trace.getTracer("test").startSpan("outer");
		context.with(trace.setSpan(context.active(), outer), () => {
			const span = startInvokeAgentSpan(resolveTelemetry({}, undefined), model);
			span?.end();
		});
		outer.end();
		const root = exporter.getFinishedSpans().find(s => s.name === "invoke_agent");
		expect(root?.spanContext().traceId).toBe(outer.spanContext().traceId);
		expect(root?.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
	});

	it("lets an explicit parent win over TRACEPARENT", () => {
		process.env.TRACEPARENT = TRACEPARENT;
		const parent = trace.getTracer("test").startSpan("explicit");
		recordHandoff(resolveTelemetry({}, undefined), { fromAgent: undefined, toAgent: { name: "b" }, parent });
		parent.end();
		const handoff = exporter.getFinishedSpans().find(s => s.name.startsWith("handoff"));
		expect(handoff?.spanContext().traceId).toBe(parent.spanContext().traceId);
		expect(handoff?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
	});
});
