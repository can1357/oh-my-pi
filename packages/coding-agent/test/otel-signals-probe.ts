/**
 * Positive-path probe for the OTLP log + metric exporters, run as a subprocess
 * by telemetry-export.test.ts. Keeping it out-of-process means the global
 * LoggerProvider / MeterProvider singletons that initTelemetryExport() registers
 * never leak into the test runner.
 *
 * Stands up a loopback OTLP/proto receiver, points the standard env vars at it,
 * registers the providers, drives a log record through the bridged
 * `@oh-my-pi/pi-utils` logger and metric instruments through the agent
 * telemetry hooks, flushes, and exits 0 only if the receiver got a non-empty
 * protobuf POST at both /v1/logs and /v1/metrics, each carrying the
 * `telemetry.otlpHeaders` value minted by a real `!command` — one run shared by
 * both exporters within the cache window — and none carrying a configured
 * header whose `!command` fails (that export goes out without it).
 */

import type { AgentRunCoverage, AgentRunSummary, ChatUsageEvent } from "@oh-my-pi/pi-agent-core";
import { emptyAgentRunCoverage, emptyAgentRunSummary } from "@oh-my-pi/pi-agent-core";
import {
	createTelemetryExportConfig,
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { logger } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

const seen = new Set<string>();
const headers: Record<string, { authorization: string | null; failing: string | null }> = {};
const metricPayloads: Uint8Array[] = [];

interface ProtobufField {
	readonly number: number;
	readonly bytes?: Uint8Array;
}

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
	let value = 0;
	let shift = 0;
	while (offset < bytes.length) {
		const byte = bytes[offset++];
		value += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) return [value, offset];
		shift += 7;
	}
	throw new Error("Truncated protobuf varint");
}

function protobufFields(bytes: Uint8Array): ProtobufField[] {
	const fields: ProtobufField[] = [];
	for (let offset = 0; offset < bytes.length;) {
		const [tag, nextOffset] = readVarint(bytes, offset);
		offset = nextOffset;
		const wireType = tag & 7;
		const number = tag >>> 3;
		if (wireType === 0) {
			[, offset] = readVarint(bytes, offset);
			fields.push({ number });
		} else if (wireType === 1) {
			offset += 8;
			fields.push({ number });
		} else if (wireType === 2) {
			const [length, valueOffset] = readVarint(bytes, offset);
			offset = valueOffset;
			const end = offset + length;
			if (end > bytes.length) throw new Error("Truncated protobuf field");
			fields.push({ number, bytes: bytes.slice(offset, end) });
			offset = end;
		} else if (wireType === 5) {
			offset += 4;
			fields.push({ number });
		} else {
			throw new Error(`Unsupported protobuf wire type ${wireType}`);
		}
	}
	return fields;
}

function pointCountForMetric(bytes: Uint8Array, metricName: string): number | undefined {
	const fields = protobufFields(bytes);
	const isMetric = fields.some(
		field => field.number === 1 && field.bytes && new TextDecoder().decode(field.bytes) === metricName,
	);
	if (isMetric) {
		const aggregation = fields.find(field => field.number === 7 || field.number === 9)?.bytes;
		if (!aggregation) return undefined;
		return protobufFields(aggregation).filter(field => field.number === 1).length;
	}
	for (const field of fields) {
		if (!field.bytes) continue;
		try {
			const count = pointCountForMetric(field.bytes, metricName);
			if (count !== undefined) return count;
		} catch {
			// This length-delimited field is a scalar string or bytes value, not a nested message.
		}
	}
	return undefined;
}

function assertSingleMetricPoint(metricName: string): void {
	const counts = metricPayloads.map(payload => pointCountForMetric(payload, metricName));
	if (!counts.includes(1)) {
		throw new Error(`${metricName} expected one dimensioned point, got ${counts.join(",")}`);
	}
}

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const path = new URL(req.url).pathname;
		if (req.method === "POST" && req.headers.get("content-type")?.startsWith("application/x-protobuf")) {
			const body = await req.arrayBuffer();
			if (path.endsWith("/v1/metrics")) metricPayloads.push(new Uint8Array(body));
			if (body.byteLength > 0) {
				if (path.endsWith("/v1/logs")) seen.add("logs");
				if (path.endsWith("/v1/metrics")) seen.add("metrics");
				headers[path] = { authorization: req.headers.get("authorization"), failing: req.headers.get("x-failing") };
			}
		}
		return new Response('{"partialSuccess":{}}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	},
});

const base = `http://localhost:${server.port}`;
process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `${base}/v1/logs`;
process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `${base}/v1/metrics`;
process.env.OTEL_SERVICE_NAME = "oh-my-pi-signals-probe";
// Real `!command` values through the canonical config resolver: a Bun helper that
// counts its runs is the token minter, and a command that exits non-zero is a
// header that must be left out rather than break the export.
const workDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "omp-otel-signals-"));
const counterPath = nodePath.join(workDir, "count");
const helperPath = nodePath.join(workDir, "token.ts");
fs.writeFileSync(
	helperPath,
	[
		'import * as fs from "node:fs";',
		"const file = process.argv[2];",
		"const n = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;",
		"fs.writeFileSync(file, String(n));",
		'console.log("Bearer token-" + n);',
	].join("\n"),
);
// Mixed case on purpose: the env spells it `Authorization`, settings `authorization`.
// The wire must carry exactly one — the settings value; a duplicate would arrive
// comma-joined in `Headers.get`, so one exact value proves one header.
process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer%20static";
const otlpHeaders = {
	authorization: `!"${process.execPath}" "${helperPath}" "${counterPath}"`,
	"x-failing": `!"${process.execPath}" -e "process.exit(1)"`,
};

await initTelemetryExport(true, { headers: otlpHeaders, commandTtlMs: 60_000 });
if (!isTelemetryExportEnabled()) {
	console.error("PROBE: providers did not register");
	await server.stop(true);
	process.exit(2);
}

const config = createTelemetryExportConfig(undefined);
if (!config) {
	console.error("PROBE: export config not produced");
	await server.stop(true);
	process.exit(2);
}

// Bridged utility logger -> OTel log record.
logger.error("probe error", { code: "probe" });

// Metric instruments via the agent telemetry hooks.
const usage: ChatUsageEvent = {
	span: undefined as never,
	operation: "chat",
	agent: { id: "main", name: "Main" },
	conversationId: "probe-session",
	stepNumber: 0,
	model: "claude-haiku-4-5",
	provider: "anthropic",
	serviceTier: undefined,
	usage: {
		inputTokens: 1000,
		outputTokens: 200,
		totalTokens: 1200,
		cachedInputTokens: 0,
		cacheWriteTokens: 0,
		reasoningOutputTokens: 0,
	},
	cost: { usd: 0.01 },
	attributes: undefined,
	headers: undefined,
};
await config.onChatUsage?.(usage);

const summary: AgentRunSummary = {
	...emptyAgentRunSummary(),
	chats: { total: 1, byStopReason: { end_turn: 1 }, totalLatencyMs: 1500 },
	tools: {
		total: 1,
		ok: 1,
		error: 0,
		skipped: 0,
		blocked: 0,
		timeout: 0,
		aborted: 0,
		totalLatencyMs: 42,
		byName: {
			read: { total: 1, ok: 1, error: 0, skipped: 0, blocked: 0, timeout: 0, aborted: 0, totalLatencyMs: 42 },
		},
	},
	stepCount: 1,
};
const coverage: AgentRunCoverage = {
	...emptyAgentRunCoverage(),
	toolsAvailable: ["read", "write"],
	toolsInvoked: ["read"],
	toolsUnused: ["write"],
	modelsUsed: ["claude-haiku-4-5"],
	providersUsed: ["anthropic"],
};
config.onRunEnd?.(summary, coverage);

await flushTelemetryExport();
assertSingleMetricPoint("omp.agent.chat.calls");
assertSingleMetricPoint("omp.agent.tool.calls");
assertSingleMetricPoint("omp.agent.tool.duration");
await server.stop(true);
const runs = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0;
fs.rmSync(workDir, { recursive: true, force: true });

const missing = ["logs", "metrics"].filter(s => !seen.has(s));
if (missing.length > 0) {
	console.log(`PROBE: MISSING ${missing.join(",")}`);
	process.exit(1);
}
const problems: string[] = [];
for (const signal of ["logs", "metrics"]) {
	const got = headers[`/v1/${signal}`];
	if (got?.authorization !== "Bearer token-1")
		problems.push(`${signal}.authorization=${JSON.stringify(got?.authorization)}`);
	if (got?.failing !== null) problems.push(`${signal}.x-failing=${JSON.stringify(got?.failing)} (want absent)`);
}
// Both exporters resolved within one cache window, so the minter ran once.
if (runs !== 1) problems.push(`command runs=${runs} (want 1)`);
if (problems.length > 0) {
	console.log(`PROBE: BAD_HEADERS ${problems.join(" ")}`);
	process.exit(1);
}
console.log("PROBE: RECEIVED");
process.exit(0);
