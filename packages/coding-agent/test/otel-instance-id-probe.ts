/**
 * Metric-identity probe for the OTLP metric exporter, run as a subprocess by
 * telemetry-export.test.ts. Out-of-process for the same reason as the other
 * probes: initTelemetryExport() registers process-global providers.
 *
 * Stands up a loopback OTLP/proto receiver for /v1/metrics, records one chat
 * usage through the telemetry hook the agent loop calls, flushes, and inspects
 * the captured payload. The argument picks the resource case. `default` must
 * export a generated v4 service.instance.id. `pinned` sets service.instance.id
 * in OTEL_RESOURCE_ATTRIBUTES, which must win over the generated one. Both cases
 * keep the agent name as a metric label and never export the spawn-unique agent id.
 */

import type { ChatUsageEvent } from "@oh-my-pi/pi-agent-core";
import {
	createTelemetryExportConfig,
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";

const mode = process.argv[2];
if (mode !== "default" && mode !== "pinned") throw new Error("usage: otel-instance-id-probe.ts default|pinned");

const PINNED_INSTANCE_ID = "pinned-by-env";
const SPAWN_AGENT_ID = "spawn-7f3a9c21";
const AGENT_NAME = "probe-explorer";
const GENERATED_INSTANCE_ID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

// The default case must not inherit a developer's own OTEL_RESOURCE_ATTRIBUTES.
if (mode === "pinned") process.env.OTEL_RESOURCE_ATTRIBUTES = `service.instance.id=${PINNED_INSTANCE_ID}`;
else delete process.env.OTEL_RESOURCE_ATTRIBUTES;

const metricPayloads: string[] = [];
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		if (req.method === "POST" && new URL(req.url).pathname === "/v1/metrics") {
			metricPayloads.push(Buffer.from(await req.arrayBuffer()).toString("latin1"));
		}
		return new Response('{"partialSuccess":{}}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	},
});
process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `http://localhost:${server.port}/v1/metrics`;

await initTelemetryExport(true);
const onChatUsage = createTelemetryExportConfig(undefined, () => true)?.onChatUsage;
if (!isTelemetryExportEnabled() || !onChatUsage) {
	console.error("PROBE: providers did not register");
	await server.stop(true);
	process.exit(2);
}

const usage: ChatUsageEvent = {
	span: undefined as never,
	operation: "chat",
	agent: { id: SPAWN_AGENT_ID, name: AGENT_NAME },
	conversationId: "probe-conversation",
	stepNumber: 0,
	model: "claude-haiku-4-5",
	provider: "anthropic",
	serviceTier: undefined,
	usage: {
		inputTokens: 100,
		outputTokens: 20,
		totalTokens: 120,
		cachedInputTokens: undefined,
		cacheWriteTokens: undefined,
		reasoningOutputTokens: undefined,
	},
	cost: undefined,
	attributes: undefined,
	headers: undefined,
};
await onChatUsage(usage);
await flushTelemetryExport();
await server.stop(true);

const payload = metricPayloads.join("\n");
const checks: Record<string, boolean> = {
	metricsExported: payload.includes("gen_ai.client.token.usage"),
	agentNameLabel: payload.includes(AGENT_NAME),
	noSpawnAgentIdLabel: !payload.includes("omp.gen_ai.agent.id") && !payload.includes(SPAWN_AGENT_ID),
	...(mode === "pinned"
		? { pinnedInstanceIdWins: payload.includes(PINNED_INSTANCE_ID) && !GENERATED_INSTANCE_ID.test(payload) }
		: { generatedInstanceId: payload.includes("service.instance.id") && GENERATED_INSTANCE_ID.test(payload) }),
};
const failed = Object.keys(checks).filter(name => !checks[name]);
console.log(failed.length === 0 ? "PROBE: RECEIVED" : `PROBE: FAILED ${failed.join(",")}`);
process.exit(failed.length === 0 ? 0 : 1);
