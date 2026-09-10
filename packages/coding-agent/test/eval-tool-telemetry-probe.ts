// Subprocess-only: registering an OTEL context manager must not affect sibling tests.
import assert from "node:assert/strict";
import { type } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	finishExecuteToolSpan,
	GenAIAttr,
	PiGenAIAttr,
	resolveTelemetry,
	runInActiveSpan,
	startExecuteToolSpan,
} from "@oh-my-pi/pi-agent-core";
import { context, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Settings } from "../src/config/settings";
import { disposeAllVmContexts } from "../src/eval/js/context-manager";
import { executeJs } from "../src/eval/js/executor";
import { callSessionTool } from "../src/eval/js/tool-bridge";
import { disposeAllKernelSessions, executePython } from "../src/eval/py/executor";
import { disposePyToolBridge } from "../src/eval/py/tool-bridge";
import type { ToolSession } from "../src/tools";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer("eval-telemetry-test");
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
const settings = await Settings.init({ inMemory: true, cwd: process.cwd() });
settings.set("tools.outputMaxColumns", 0);
let active = 0;
let peak = 0;
const probe: AgentTool = {
	name: "probe",
	label: "probe",
	description: "Exercise real bridge execution",
	parameters: type({ "mode?": "'throw' | 'returned-error' | 'abort'" }),
	execute: async (_id, args, signal) => {
		const { mode } = args as { mode?: string };
		if (mode === "throw") throw new Error("fixture failure");
		if (mode === "returned-error") return { content: [{ type: "text", text: "failed" }], details: { isError: true } };
		if (mode === "abort") signal?.throwIfAborted();
		const body = tracer.startSpan("probe body");
		active++;
		peak = Math.max(peak, active);
		try {
			await Bun.sleep(20);
			return { content: [{ type: "text", text: "ready" }] };
		} finally {
			active--;
			body.end();
		}
	},
};
const config = { tracer, captureMessageContent: "none" as const };
const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	settings,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	getSessionId: () => "eval-telemetry",
	getTelemetry: () => config,
	getToolByName: name => (name === probe.name ? probe : undefined),
};

try {
	if (process.argv[2] === "direct") {
		await callSessionTool("probe", {}, { session });
		await callSessionTool("probe", { mode: "returned-error" }, { session });
		await assert.rejects(callSessionTool("probe", { mode: "throw" }, { session }), /fixture failure/);
		await assert.rejects(
			callSessionTool("probe", { mode: { invalid: true } }, { session }),
			"validation must reject",
		);
		for (const reason of [
			new DOMException("cancelled", "AbortError"),
			new DOMException("deadline", "TimeoutError"),
		]) {
			await assert.rejects(
				callSessionTool("probe", { mode: "abort" }, { session, signal: AbortSignal.abort(reason) }),
				"abort must reject",
			);
		}
		const spans = exporter.getFinishedSpans().filter(span => span.name === "execute_tool probe");
		assert.deepEqual(
			spans.map(span => span.attributes[PiGenAIAttr.ToolStatus]),
			["ok", "error", "error", "error", "aborted", "timeout"],
		);
		for (const span of spans) {
			assert.equal(span.attributes[GenAIAttr.ToolCallArguments], undefined);
			assert.equal(span.attributes[GenAIAttr.ToolCallResult], undefined);
			if (span.attributes[PiGenAIAttr.ToolStatus] !== "ok") assert.equal(span.status.code, SpanStatusCode.ERROR);
		}
		const before = spans.length;
		await callSessionTool("probe", {}, { session: { ...session, getTelemetry: () => undefined } });
		assert.equal(exporter.getFinishedSpans().filter(span => span.name === "execute_tool probe").length, before);
		await callSessionTool(
			"probe",
			{},
			{ session: { ...session, getTelemetry: () => ({ tracer, captureMessageContent: "full" }) } },
		);
		const captured = exporter
			.getFinishedSpans()
			.filter(span => span.name === "execute_tool probe")
			.at(-1)!;
		assert.equal(typeof captured.attributes[GenAIAttr.ToolCallArguments], "string");
		assert.equal(typeof captured.attributes[GenAIAttr.ToolCallResult], "string");
		console.log(
			"direct: success, returned/thrown/validation errors, abort, timeout, disabled telemetry and capture policy verified",
		);
	} else {
		const python = Bun.which("python3");
		const routes = python ? ["js", "python"] : ["js"];
		for (const route of routes) {
			// The second invocation reuses the worker/server created under a different parent.
			for (let run = 0; run < 2; run++) {
				const telemetry = resolveTelemetry(config, "eval-telemetry")!;
				const parent = startExecuteToolSpan(telemetry, {
					tool: undefined,
					toolName: route,
					toolCallId: `${route}-${run}`,
					args: {},
				})!;
				await runInActiveSpan(parent, async () => {
					const result =
						route === "js"
							? await executeJs(
									"console.log(JSON.stringify(await Promise.all(Array.from({length:4},()=>tool.probe({})))));",
									{ sessionId: "traced-js", cwd: process.cwd(), session, timeoutMs: 10_000 },
								)
							: await executePython(
									"print(json.dumps(await asyncio.gather(*[tool.probe() for _ in range(4)])))",
									{
										sessionId: "traced-python",
										cwd: process.cwd(),
										toolSession: session,
										interpreter: python!,
										timeoutMs: 10_000,
									},
								);
					assert.equal(result.exitCode, 0, result.output);
					assert.deepEqual(JSON.parse(result.output.trim()), ["ready", "ready", "ready", "ready"]);
				});
				finishExecuteToolSpan(telemetry, parent, {
					toolName: route,
					toolCallId: `${route}-${run}`,
					isError: false,
				});
				const children = exporter
					.getFinishedSpans()
					.filter(span => span.parentSpanContext?.spanId === parent.spanContext().spanId);
				assert.equal(children.length, 4);
				for (const child of children) {
					assert.equal(child.name, "execute_tool probe");
					assert.equal(child.spanContext().traceId, parent.spanContext().traceId);
					const bodies = exporter
						.getFinishedSpans()
						.filter(span => span.parentSpanContext?.spanId === child.spanContext().spanId);
					assert.equal(bodies.length, 1);
					assert.equal(bodies[0].name, "probe body");
				}
				assert.equal(telemetry.collector.snapshot({ stepCount: 1 }).summary.tools.total, 1);
			}
		}
		assert.ok(peak > 1, "tracing must preserve parallel execution");
		console.log(
			`kernels: ${routes.join(", ")} parent linkage, downstream context, warm reuse and non-duplicated run totals verified; peak=${peak}`,
		);
	}
} finally {
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	await provider.shutdown();
	context.disable();
}
