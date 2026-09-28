/**
 * Positive-path probe for the OTLP trace exporter, run as a subprocess by
 * telemetry-export.test.ts. Keeping it out-of-process means the global
 * TracerProvider singleton that initTelemetryExport() registers never leaks
 * into the test runner.
 *
 * Stands up a loopback OTLP/proto receiver, points the standard env vars at it,
 * registers the provider with a `telemetry.otlpHeaders` resolver whose token
 * changes on every call, emits and flushes a span TWICE through the same tracer
 * name the agent core uses, and exits 0 only if both protobuf POSTs at
 * /v1/traces show that OTEL_EXPORTER_OTLP[_TRACES]_HEADERS stay the base
 * (`x-tenant` survives), the configured header overrides env per key, and the
 * resolver ran per export (the second request carries a newer token).
 */

import {
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { trace } from "@opentelemetry/api";

const requests: Array<{ tenant: string | null; authorization: string | null }> = [];

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const path = new URL(req.url).pathname;
		if (req.method === "POST" && path.endsWith("/v1/traces")) {
			const body = await req.arrayBuffer();
			if (body.byteLength > 0 && req.headers.get("content-type") === "application/x-protobuf") {
				requests.push({ tenant: req.headers.get("x-tenant"), authorization: req.headers.get("authorization") });
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
process.env.OTEL_TRACES_EXPORTER = "OTLP";
process.env.OTEL_SERVICE_NAME = "oh-my-pi-export-probe";
// Per the OTLP env contract, header values are percent-decoded and the
// signal-specific list is merged over the common one.
process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-tenant=acme,authorization=Bearer%20common";
process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = "authorization=Bearer%20traces";

let issued = 0;
await initTelemetryExport(true, { headers: async () => ({ authorization: `Bearer fresh-${++issued}` }) });
if (!isTelemetryExportEnabled()) {
	console.error("PROBE: provider did not register");
	await server.stop(true);
	process.exit(2);
}

const tracer = trace.getTracer("@oh-my-pi/pi-agent-core");
for (let i = 0; i < 2; i++) {
	const span = tracer.startSpan("agent.llm_call");
	span.setAttribute("gen_ai.system", "probe");
	span.setAttribute("gen_ai.request.model", "claude-haiku-4-5");
	span.end();
	await flushTelemetryExport();
}
await server.stop(true);

if (requests.length === 0) {
	console.log("PROBE: NO_EXPORT");
	process.exit(1);
}
const expected = [
	{ tenant: "acme", authorization: "Bearer fresh-1" },
	{ tenant: "acme", authorization: "Bearer fresh-2" },
];
if (JSON.stringify(requests) !== JSON.stringify(expected)) {
	console.log(`PROBE: BAD_HEADERS got=${JSON.stringify(requests)} want=${JSON.stringify(expected)}`);
	process.exit(1);
}
console.log("PROBE: RECEIVED");
process.exit(0);
