/**
 * Probe for the OMP-owned OTEL_* design, run as a subprocess by
 * otel-env-window.test.ts with an agent dir whose `.env` carries the OTLP
 * configuration. The loader keeps those values out of `process.env`, so this
 * proves what the design depends on:
 *
 * - `exporter`: an `OTLPTraceExporter` constructed inside `withOmpOtelEnv`
 *   still sends to the endpoint, with the headers, from the agent `.env` at
 *   export time, i.e. the SDK reads its env only at construction. The span
 *   pipeline is built outside the window on purpose.
 * - `init`: `initTelemetryExport` exports one span, one log record and one
 *   metric with each signal's `.env` endpoint and headers plus the resource
 *   attributes, and leaves no `OTEL_*` behind in `process.env`.
 * - `init-log-none` / `init-disabled`: the same path with `OTEL_LOG_LEVEL=none`
 *   or `OTEL_SDK_DISABLED=true` in the agent `.env`, which omp itself must
 *   honor through `$otelEnv`.
 */
import {
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { logger, withOmpOtelEnv } from "@oh-my-pi/pi-utils";
import { metrics, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

const mode = process.argv[2];

function leakedOtelNames(): string[] {
	return Object.keys(process.env).filter(name => name.startsWith("OTEL_"));
}

if (mode === "exporter") {
	const exporter = withOmpOtelEnv(() => new OTLPTraceExporter());
	const afterWindow = leakedOtelNames();
	const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	provider.getTracer("otel-env-window-probe").startSpan("probe-span").end();
	await provider.forceFlush();
	await provider.shutdown();
	process.stdout.write(`PROBE: ${JSON.stringify({ afterWindow })}\n`);
} else if (mode === "gate") {
	await initTelemetryExport(true);
	process.stdout.write(`PROBE: ${JSON.stringify({ enabled: isTelemetryExportEnabled() })}\n`);
} else if (mode === "init" || mode === "init-log-none" || mode === "init-disabled") {
	await initTelemetryExport(true);
	trace.getTracer("otel-env-window-probe").startSpan("probe-span").end();
	logger.error("probe-log-record-7731");
	metrics.getMeter("otel-env-window-probe").createCounter("probe.counter").add(1);
	await flushTelemetryExport();
	process.stdout.write(`PROBE: ${JSON.stringify({ afterInit: leakedOtelNames() })}\n`);
} else {
	throw new Error(`unknown probe mode: ${mode}`);
}
process.exit(0);
