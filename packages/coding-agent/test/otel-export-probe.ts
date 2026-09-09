/**
 * Positive-path probe for the OTLP trace exporter, run as a subprocess by
 * telemetry-export.test.ts. Keeping it out-of-process means the global
 * TracerProvider singleton that initTelemetryExport() registers never leaks
 * into the test runner.
 *
 * Stands up a loopback OTLP/proto receiver, points the standard env var at it,
 * registers the provider, emits a span through the same tracer name the agent
 * core uses, flushes, and exits 0 only if the receiver got a non-empty
 * protobuf POST at /v1/traces.
 */

import {
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { trace } from "@opentelemetry/api";

let received = false;

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const path = new URL(req.url).pathname;
		if (req.method === "POST" && path.endsWith("/v1/traces")) {
			const body = await req.arrayBuffer();
			if (body.byteLength > 0 && req.headers.get("content-type") === "application/x-protobuf") {
				received = true;
			}
			return new Response('{"partialSuccess":{}}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("not found", { status: 404 });
	},
});

process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://localhost:${server.port}/v1/traces`;
process.env.OTEL_SERVICE_NAME = "oh-my-pi-export-probe";

await initTelemetryExport();
if (!isTelemetryExportEnabled()) {
	console.error("PROBE: provider did not register");
	await server.stop(true);
	process.exit(2);
}

const span = trace.getTracer("@oh-my-pi/pi-agent-core").startSpan("agent.llm_call");
span.setAttribute("gen_ai.system", "probe");
span.setAttribute("gen_ai.request.model", "claude-haiku-4-5");
span.end();

await flushTelemetryExport();
await server.stop(true);

console.log(received ? "PROBE: RECEIVED" : "PROBE: NO_EXPORT");
process.exit(received ? 0 : 1);
