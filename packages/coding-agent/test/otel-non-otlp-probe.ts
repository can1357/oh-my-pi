/**
 * Negative-path probe for explicit non-OTLP exporter selections. Runs in a
 * subprocess so a broken bootstrap can register process-global providers and
 * attempt real exports without contaminating the test runner.
 */

import {
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { logger } from "@oh-my-pi/pi-utils";
import { metrics, trace } from "@opentelemetry/api";

const received = new Set<string>();

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const path = new URL(req.url).pathname;
		if (req.method === "POST") {
			const body = await req.arrayBuffer();
			if (body.byteLength > 0) received.add(path);
		}
		return new Response('{"partialSuccess":{}}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	},
});

const base = `http://localhost:${server.port}`;
process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${base}/v1/traces`;
process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `${base}/v1/logs`;
process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `${base}/v1/metrics`;
process.env.OTEL_TRACES_EXPORTER = "console";
process.env.OTEL_LOGS_EXPORTER = "console";
process.env.OTEL_METRICS_EXPORTER = "console";

await initTelemetryExport();
const enabled = isTelemetryExportEnabled();

const span = trace.getTracer("@oh-my-pi/pi-agent-core").startSpan("non-otlp-probe");
span.end();
logger.error("non-OTLP probe");
metrics.getMeter("@oh-my-pi/pi-coding-agent").createCounter("non_otlp_probe").add(1);
await flushTelemetryExport();
await server.stop(true);

const ok = !enabled && received.size === 0;
console.log(ok ? "PROBE: NO_EXPORT" : `PROBE: UNEXPECTED_EXPORT enabled=${enabled} paths=${[...received].join(",")}`);
process.exit(ok ? 0 : 1);
