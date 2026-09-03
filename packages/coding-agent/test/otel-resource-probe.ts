/**
 * Resource-attribute probe for the OTLP trace exporter, run as a subprocess by
 * telemetry-export.test.ts. Isolated out-of-process for the same reason as the
 * other probes: initTelemetryExport() registers a process-global provider.
 *
 * Stands up a loopback OTLP/proto receiver, sets OTEL_SERVICE_NAME plus
 * OTEL_RESOURCE_ATTRIBUTES (including a service.name that must lose to
 * OTEL_SERVICE_NAME), exports a span, and inspects the captured protobuf
 * payload. Exits 0 only when the resource carries the OTEL_RESOURCE_ATTRIBUTES
 * entries and service.name resolves to OTEL_SERVICE_NAME.
 */

import {
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { trace } from "@opentelemetry/api";

let body: Buffer | undefined;
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const path = new URL(req.url).pathname;
		if (req.method === "POST" && path.endsWith("/v1/traces")) {
			body = Buffer.from(await req.arrayBuffer());
			return new Response('{"partialSuccess":{}}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("not found", { status: 404 });
	},
});

process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://localhost:${server.port}/v1/traces`;
process.env.OTEL_SERVICE_NAME = "svc-probe";
process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.environment=staging,tenant.id=acme,service.name=should-lose";

await initTelemetryExport();
if (!isTelemetryExportEnabled()) {
	console.error("PROBE: provider did not register");
	await server.stop(true);
	process.exit(2);
}

const span = trace.getTracer("@oh-my-pi/pi-agent-core").startSpan("agent.llm_call");
span.setAttribute("gen_ai.request.model", "claude-haiku-4-5");
span.end();

await flushTelemetryExport();
await server.stop(true);

// Attribute keys/values are inline UTF-8 in the OTLP protobuf payload.
const payload = body ? body.toString("latin1") : "";
const has = (s: string) => payload.includes(s);

const merged = has("deployment.environment") && has("staging") && has("tenant.id") && has("acme");
// OTEL_SERVICE_NAME must win over the service.name in OTEL_RESOURCE_ATTRIBUTES.
const precedence = has("svc-probe") && !has("should-lose");

console.log(merged && precedence ? "PROBE: RECEIVED" : "PROBE: NO_EXPORT");
console.log("merged:", merged, "precedence:", precedence);
process.exit(merged && precedence ? 0 : 1);
