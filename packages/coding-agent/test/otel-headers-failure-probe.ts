/**
 * Failure-path probe for `telemetry.otlpHeaders`, run as a subprocess by
 * telemetry-export.test.ts (it registers global OTel providers).
 *
 * The header resolver runs inside the export itself. A warning emitted on every
 * request would become an OTel log record, whose export calls the resolver
 * again, which warns again — an unbounded loop. So a resolver that throws, and
 * a configured header that resolves to nothing, must each be warned about
 * exactly once until they recover. Exits 0 only if, across several flushes with
 * the log exporter live, exactly one warning of each kind reached the log sink,
 * and exports still went out.
 */

import { flushTelemetryExport, initTelemetryExport } from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { logger } from "@oh-my-pi/pi-utils";
import { trace } from "@opentelemetry/api";

let traceExports = 0;
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		if (req.method === "POST") {
			await req.arrayBuffer();
			if (new URL(req.url).pathname.endsWith("/v1/traces")) traceExports++;
		}
		return new Response('{"partialSuccess":{}}', { status: 200, headers: { "content-type": "application/json" } });
	},
});

const base = `http://localhost:${server.port}`;
process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${base}/v1/traces`;
process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `${base}/v1/logs`;
process.env.OTEL_LOG_LEVEL = "warn";

const warnings: string[] = [];
logger.registerLogSink(event => {
	if (event.level === "warn" && event.message.startsWith("telemetry.otlpHeaders")) warnings.push(event.message);
});

const mode = process.argv[2];
await initTelemetryExport(true, {
	headers:
		mode === "throw"
			? async () => {
					throw new Error("token endpoint unreachable");
				}
			: { authorization: '!"' + process.execPath + '" -e "process.exit(1)"' },
	commandTtlMs: 0,
});

const tracer = trace.getTracer("@oh-my-pi/pi-agent-core");
for (let i = 0; i < 3; i++) {
	tracer.startSpan("agent.llm_call").end();
	await flushTelemetryExport();
}
await server.stop(true);

const expected =
	mode === "throw"
		? "telemetry.otlpHeaders resolution failed"
		: "telemetry.otlpHeaders: header unavailable; exporting without it";
if (traceExports < 3) {
	console.log(`PROBE: NO_EXPORT traces=${traceExports}`);
	process.exit(1);
}
if (warnings.length !== 1 || warnings[0] !== expected) {
	console.log(`PROBE: BAD_WARNINGS ${JSON.stringify(warnings)} (want exactly one ${JSON.stringify(expected)})`);
	process.exit(1);
}
console.log("PROBE: RECEIVED");
process.exit(0);
