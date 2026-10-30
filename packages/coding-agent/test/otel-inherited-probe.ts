/**
 * Inherited-collector probe, run under the test runtime as a subprocess by
 * telemetry-export.test.ts. The parent serves a stand-in for a developer's own
 * loopback collector and passes its address down in OTEL_EXPORTER_OTLP_ENDPOINT, as
 * the developer's shell would. With no argument the probe declares no receiver; with
 * `own-receiver` it serves and declares one for traces only, so logs and metrics
 * still name the inherited collector. Either way it emits a span, a log record and a
 * metric, flushes, and prints what it observed as one JSON line. Out of process,
 * because a registered exporter is process-global.
 */

import {
	allowTelemetryReceiverForTests,
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { isBunTestRuntime, logger } from "@oh-my-pi/pi-utils";
import { metrics, trace } from "@opentelemetry/api";

const ownReceived = new Set<string>();
const ownReceiver =
	process.argv[2] === "own-receiver"
		? Bun.serve({
				port: 0,
				async fetch(req) {
					if ((await req.arrayBuffer()).byteLength > 0) ownReceived.add(new URL(req.url).pathname);
					return new Response('{"partialSuccess":{}}', {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				},
			})
		: undefined;
if (ownReceiver) {
	const base = `http://localhost:${ownReceiver.port}`;
	allowTelemetryReceiverForTests(base);
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${base}/v1/traces`;
}

await initTelemetryExport(true);
const enabled = isTelemetryExportEnabled();

trace.getTracer("@oh-my-pi/pi-agent-core").startSpan("inherited-collector-probe").end();
logger.error("inherited-collector probe");
metrics.getMeter("@oh-my-pi/pi-coding-agent").createCounter("inherited_collector_probe").add(1);
await flushTelemetryExport();
await ownReceiver?.stop(true);

console.log(
	`PROBE: ${JSON.stringify({ testRuntime: isBunTestRuntime(), enabled, ownReceived: [...ownReceived].sort() })}`,
);
process.exit(0);
