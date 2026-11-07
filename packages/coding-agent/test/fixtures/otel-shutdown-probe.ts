import { initTelemetryExport } from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { logger, postmortem } from "@oh-my-pi/pi-utils";

const requested = Promise.withResolvers<void>();
const server = Bun.serve({
	port: 0,
	fetch(request) {
		if (request.method === "POST" && new URL(request.url).pathname === "/v1/logs") requested.resolve();
		return Promise.withResolvers<Response>().promise;
	},
});

process.env.OTEL_SDK_DISABLED = "false";
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `http://127.0.0.1:${server.port}/v1/logs`;
await initTelemetryExport(true);
logger.error("probe export on shutdown");

const start = performance.now();
await postmortem.cleanup();
const elapsed = performance.now() - start;
await server.stop(true);
if (elapsed > 2_500) {
	console.error(`OTLP shutdown held exit for ${Math.round(elapsed)}ms`);
	process.exit(1);
}
// The bounded cleanup must have tried to deliver the buffered record, not skipped export.
await Promise.race([
	requested.promise,
	Bun.sleep(100).then(() => {
		throw new Error("No OTLP request sent");
	}),
]);
process.exit(0);
