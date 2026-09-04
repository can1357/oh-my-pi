/**
 * Resource-attribute probe for the OTLP trace exporter, run as a subprocess by
 * telemetry-export.test.ts. Isolated out-of-process for the same reason as the
 * other probes: initTelemetryExport() registers a process-global provider.
 *
 * Stands up a loopback OTLP/proto receiver, sets OTEL_SERVICE_NAME plus
 * OTEL_RESOURCE_ATTRIBUTES (including a service.name that must lose to
 * OTEL_SERVICE_NAME), exports a span, and inspects the captured protobuf
 * payload. Exits 0 only when the resource carries a generated instance ID,
 * the configured resource attributes, and the OTEL_SERVICE_NAME override.
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
const instanceId =
	has("service.instance.id") && /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(payload);

console.log(merged && precedence && instanceId ? "PROBE: RECEIVED" : "PROBE: NO_EXPORT");
console.log("merged:", merged, "precedence:", precedence, "instanceId:", instanceId);
process.exit(merged && precedence && instanceId ? 0 : 1);
