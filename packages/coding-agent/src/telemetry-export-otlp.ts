/**
 * OTLP provider registration and signal recording for telemetry export.
 *
 * Loaded on demand by `./telemetry-export` only when an `OTEL_*` endpoint is
 * configured — the OTel SDK + OTLP exporter graph costs ~100ms of module
 * evaluation, so it must stay out of default CLI startup.
 *
 * Only the `http/protobuf` transport is supported — an
 * `OTEL_EXPORTER_OTLP*_PROTOCOL` of `grpc` or `http/json` declines rather than
 * misrouting protobuf payloads. The exporter line is pinned to the 0.218/2.7
 * family validated under Bun; the 1.x OTLP line deadlocks when its
 * `req.on("close")` handler fires after a successful export.
 */
import type {
	AgentRunCoverage,
	AgentRunSummary,
	AgentTelemetryConfig,
	AgentTelemetryWarning,
	ChatUsageEvent,
	ToolStatus,
} from "@oh-my-pi/pi-agent-core";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import {
	type Attributes,
	type AttributeValue,
	type Counter,
	context,
	type Histogram,
	type Meter,
	metrics,
} from "@opentelemetry/api";
import { type LogAttributes, logs, type Logger as OtelLogger, SeverityNumber } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { TelemetrySignalConfig } from "./telemetry-export";

/**
 * Periodic flush interval. A long-lived `omp` process (the ACP server is
 * spawned once and reused across many turns) would otherwise hold finished
 * telemetry until a batch window elapses or the process exits.
 */
const FLUSH_INTERVAL_MS = 30_000;

const SERVICE_NAME = "oh-my-pi";

type OtelLogLevel = "none" | logger.LogLevel;

const LOG_SEVERITY: Record<logger.LogLevel, SeverityNumber> = {
	error: SeverityNumber.ERROR,
	warn: SeverityNumber.WARN,
	info: SeverityNumber.INFO,
	debug: SeverityNumber.DEBUG,
};

const LOG_LEVEL_WEIGHT: Record<logger.LogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
};

const TOOL_STATUSES = ["ok", "error", "skipped", "blocked", "timeout", "aborted"] satisfies readonly ToolStatus[];

let traceProvider: NodeTracerProvider | undefined;
let logProvider: LoggerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let metricRecorder: AgentMetricRecorder | undefined;
let otelLogger: OtelLogger | undefined;
let unregisterLogSink: (() => void) | undefined;

/** Whether {@link registerProviders} registered any real OTLP signal provider. */
export function isTelemetryExportEnabled(): boolean {
	if (traceProvider) return true;
	if (logProvider) return true;
	if (meterProvider) return true;
	return false;
}

/**
 * Merge OTLP metrics/log hooks into an existing agent telemetry config.
 *
 * The caller still owns content-capture policy, cost estimation, and custom
 * attributes. This only appends host-level metrics/log forwarding for the
 * providers registered by {@link registerProviders}.
 */
export function createTelemetryExportConfig(
	config: AgentTelemetryConfig | undefined,
): AgentTelemetryConfig | undefined {
	if (!isTelemetryExportEnabled()) return config;
	return {
		...config,
		onChatUsage: async event => {
			await config?.onChatUsage?.(event);
			metricRecorder?.recordChatUsage(event);
		},
		onRunEnd: (summary, coverage) => {
			config?.onRunEnd?.(summary, coverage);
			metricRecorder?.recordRun(summary, coverage);
			emitRunSummaryLog(summary, coverage);
		},
		onTelemetryWarning: warning => {
			config?.onTelemetryWarning?.(warning);
			emitTelemetryWarningLog(warning);
		},
	};
}

/** Register global trace/log/meter providers for the enabled signals. */
export async function registerProviders(signalConfig: TelemetrySignalConfig): Promise<void> {
	// `envDetector` parses OTEL_RESOURCE_ATTRIBUTES (percent-decoded, per spec) and
	// OTEL_SERVICE_NAME; merged last so both take precedence over the fallback
	// service.name — with OTEL_SERVICE_NAME still winning service.name inside the
	// detector itself.
	const resource = resourceFromAttributes({ "service.name": SERVICE_NAME }).merge(
		detectResources({ detectors: [envDetector] }),
	);

	if (signalConfig.trace) {
		const exporter = new OTLPTraceExporter();
		traceProvider = new NodeTracerProvider({
			resource,
			spanProcessors: [new BatchSpanProcessor(exporter)],
		});
		traceProvider.register({ contextManager: new AsyncLocalStorageContextManager().enable() });
	}

	if (signalConfig.metric) {
		const exporter = new OTLPMetricExporter();
		meterProvider = new MeterProvider({
			resource,
			readers: [new PeriodicExportingMetricReader({ exporter })],
		});
		metrics.setGlobalMeterProvider(meterProvider);
		metricRecorder = new AgentMetricRecorder(metrics.getMeter("@oh-my-pi/pi-coding-agent"));
	}

	if (signalConfig.log) {
		const exporter = new OTLPLogExporter();
		logProvider = new LoggerProvider({
			resource,
			processors: [new BatchLogRecordProcessor({ exporter })],
		});
		logs.setGlobalLoggerProvider(logProvider);
		otelLogger = logProvider.getLogger("@oh-my-pi/pi-coding-agent");
		unregisterLogSink = logger.registerLogSink(event => {
			emitOtelLog(
				event.level,
				event.message,
				logAttributesFromContext(event.context),
				"pi.omp.log",
				event.timestamp,
			);
		});
	}

	const flushTimer = setInterval(() => {
		flushTelemetryExport().catch(() => {});
	}, FLUSH_INTERVAL_MS);
	flushTimer.unref();

	postmortem.register("otel-export", async () => {
		clearInterval(flushTimer);
		unregisterLogSink?.();
		unregisterLogSink = undefined;
		const shutdowns: Promise<void>[] = [];
		if (traceProvider) shutdowns.push(traceProvider.shutdown());
		if (logProvider) shutdowns.push(logProvider.shutdown());
		if (meterProvider) shutdowns.push(meterProvider.shutdown());
		await Promise.all(shutdowns);
	});
}

class AgentMetricRecorder {
	readonly #tokenUsage: Histogram<Attributes>;
	readonly #chatCostUsd: Counter<Attributes>;
	readonly #runs: Counter<Attributes>;
	readonly #steps: Counter<Attributes>;
	readonly #chatCalls: Counter<Attributes>;
	readonly #chatDurationMs: Histogram<Attributes>;
	readonly #toolCalls: Counter<Attributes>;
	readonly #toolDurationMs: Histogram<Attributes>;
	readonly #errors: Counter<Attributes>;

	constructor(meter: Meter) {
		this.#tokenUsage = meter.createHistogram("gen_ai.client.token.usage", {
			description: "Token usage reported by GenAI chat calls.",
			unit: "{token}",
		});
		this.#chatCostUsd = meter.createCounter("pi.omp.agent.chat.cost.estimated_usd", {
			description: "Estimated USD cost for completed chat calls.",
			unit: "USD",
		});
		this.#runs = meter.createCounter("pi.omp.agent.runs", {
			description: "Completed agent runs.",
			unit: "{run}",
		});
		this.#steps = meter.createCounter("pi.omp.agent.steps", {
			description: "Agent loop steps completed inside a run.",
			unit: "{step}",
		});
		this.#chatCalls = meter.createCounter("pi.omp.agent.chat.calls", {
			description: "Chat calls completed inside agent runs.",
			unit: "{call}",
		});
		this.#chatDurationMs = meter.createHistogram("pi.omp.agent.chat.duration", {
			description: "Total chat latency observed in an agent run.",
			unit: "ms",
		});
		this.#toolCalls = meter.createCounter("pi.omp.agent.tool.calls", {
			description: "Tool calls completed inside agent runs.",
			unit: "{call}",
		});
		this.#toolDurationMs = meter.createHistogram("pi.omp.agent.tool.duration", {
			description: "Total tool latency observed in an agent run.",
			unit: "ms",
		});
		this.#errors = meter.createCounter("pi.omp.agent.errors", {
			description: "Errors observed in chat and tool execution.",
			unit: "{error}",
		});
	}

	recordChatUsage(event: ChatUsageEvent): void {
		const baseAttrs = metricAttributes({
			"gen_ai.operation.name": "chat",
			"gen_ai.provider.name": event.provider,
			"gen_ai.request.model": event.model,
			"gen_ai.response.service_tier": event.serviceTier,
			"pi.gen_ai.agent.id": event.agent?.id,
			"pi.gen_ai.agent.name": event.agent?.name,
		});

		this.#recordToken(event.usage.inputTokens, baseAttrs, "input");
		this.#recordToken(event.usage.outputTokens, baseAttrs, "output");
		this.#recordToken(event.usage.totalTokens, baseAttrs, "total");
		this.#recordToken(event.usage.cachedInputTokens, baseAttrs, "cache_read_input");
		this.#recordToken(event.usage.cacheWriteTokens, baseAttrs, "cache_write_input");
		this.#recordToken(event.usage.reasoningOutputTokens, baseAttrs, "reasoning_output");

		if (event.cost && "usd" in event.cost && event.cost.usd > 0) {
			this.#chatCostUsd.add(event.cost.usd, baseAttrs);
		}
	}

	recordRun(summary: AgentRunSummary, coverage: AgentRunCoverage): void {
		const runAttrs = metricAttributes({
			"pi.omp.agent.models_used.count": coverage.modelsUsed.length,
			"pi.omp.agent.providers_used.count": coverage.providersUsed.length,
			"pi.omp.agent.tools_available.count": coverage.toolsAvailable.length,
			"pi.omp.agent.tools_invoked.count": coverage.toolsInvoked.length,
			"pi.omp.agent.tools_unused.count": coverage.toolsUnused.length,
		});

		this.#runs.add(1, runAttrs);
		if (summary.stepCount > 0) this.#steps.add(summary.stepCount, runAttrs);
		if (summary.chats.totalLatencyMs > 0) this.#chatDurationMs.record(summary.chats.totalLatencyMs, runAttrs);

		for (const reason in summary.chats.byStopReason) {
			const count = summary.chats.byStopReason[reason];
			if (count > 0)
				this.#chatCalls.add(count, metricAttributes({ ...runAttrs, "gen_ai.response.finish_reason": reason }));
		}
		for (const toolName in summary.tools.byName) {
			const counters = summary.tools.byName[toolName];
			const toolAttrs = metricAttributes({ ...runAttrs, "gen_ai.tool.name": toolName });
			if (counters.totalLatencyMs > 0) this.#toolDurationMs.record(counters.totalLatencyMs, toolAttrs);
			for (const status of TOOL_STATUSES) {
				const count = counters[status];
				if (count > 0) this.#toolCalls.add(count, metricAttributes({ ...toolAttrs, "pi.omp.tool.status": status }));
			}
		}
		for (const errorType in summary.errors.byType) {
			const count = summary.errors.byType[errorType];
			if (count > 0) this.#errors.add(count, metricAttributes({ ...runAttrs, "error.type": errorType }));
		}
	}

	#recordToken(value: number | undefined, baseAttrs: Attributes, tokenType: string): void {
		if (!value || value <= 0) return;
		this.#tokenUsage.record(value, metricAttributes({ ...baseAttrs, "gen_ai.token.type": tokenType }));
	}
}

function metricAttributes(fields: Readonly<Record<string, unknown>>): Attributes {
	const out: Attributes = {};
	for (const key in fields) {
		const value = fields[key];
		if (value === undefined || value === null) continue;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			out[key] = value;
			continue;
		}
		const text = String(value);
		if (text.length > 0) out[key] = text;
	}
	return out;
}

function emitRunSummaryLog(summary: AgentRunSummary, coverage: AgentRunCoverage): void {
	emitOtelLog(
		"info",
		"agent run completed",
		{
			"pi.omp.agent.step_count": summary.stepCount,
			"pi.omp.agent.chats.total": summary.chats.total,
			"pi.omp.agent.chats.total_latency_ms": summary.chats.totalLatencyMs,
			"pi.omp.agent.tools.total": summary.tools.total,
			"pi.omp.agent.tools.ok": summary.tools.ok,
			"pi.omp.agent.tools.error": summary.tools.error,
			"pi.omp.agent.tools.skipped": summary.tools.skipped,
			"pi.omp.agent.tools.blocked": summary.tools.blocked,
			"pi.omp.agent.tools.timeout": summary.tools.timeout,
			"pi.omp.agent.tools.aborted": summary.tools.aborted,
			"pi.omp.agent.tools.total_latency_ms": summary.tools.totalLatencyMs,
			"pi.omp.agent.usage.input_tokens": summary.usage.inputTokens,
			"pi.omp.agent.usage.output_tokens": summary.usage.outputTokens,
			"pi.omp.agent.usage.cached_input_tokens": summary.usage.cachedInputTokens,
			"pi.omp.agent.usage.cache_write_tokens": summary.usage.cacheWriteTokens,
			"pi.omp.agent.usage.reasoning_output_tokens": summary.usage.reasoningOutputTokens,
			"pi.omp.agent.usage.total_tokens": summary.usage.totalTokens,
			"pi.omp.agent.cost.estimated_usd": summary.cost.estimatedUsd,
			"pi.omp.agent.cost.unavailable_reasons": summary.cost.unavailableReasons.join(","),
			"pi.omp.agent.errors.total": summary.errors.total,
			"pi.omp.agent.coverage.tools_available": coverage.toolsAvailable.join(","),
			"pi.omp.agent.coverage.tools_invoked": coverage.toolsInvoked.join(","),
			"pi.omp.agent.coverage.tools_unused": coverage.toolsUnused.join(","),
			"pi.omp.agent.coverage.models_used": coverage.modelsUsed.join(","),
			"pi.omp.agent.coverage.providers_used": coverage.providersUsed.join(","),
		},
		"pi.omp.agent.run.completed",
	);
}

function emitTelemetryWarningLog(warning: AgentTelemetryWarning): void {
	const attrs = logAttributesFromContext({
		code: warning.code,
		error: warning.error,
	});
	emitOtelLog("warn", warning.message, attrs, "pi.omp.telemetry.warning");
}

function emitOtelLog(
	level: logger.LogLevel,
	body: string,
	attributes: LogAttributes,
	eventName: string,
	timestamp = new Date(),
): void {
	if (!otelLogger) return;
	const minLevel = parseOtelLogLevel(process.env.OTEL_LOG_LEVEL);
	if (minLevel === "none") return;
	if (LOG_LEVEL_WEIGHT[level] > LOG_LEVEL_WEIGHT[minLevel]) return;
	otelLogger.emit({
		eventName,
		timestamp,
		observedTimestamp: new Date(),
		severityNumber: LOG_SEVERITY[level],
		severityText: level.toUpperCase(),
		body,
		attributes,
		context: context.active(),
	});
}

function parseOtelLogLevel(raw: string | undefined): OtelLogLevel {
	if (!raw) return "info";
	switch (raw.trim().toLowerCase()) {
		case "none":
			return "none";
		case "error":
			return "error";
		case "warn":
		case "warning":
			return "warn";
		case "debug":
			return "debug";
		default:
			return "info";
	}
}

function logAttributesFromContext(input: Record<string, unknown> | undefined): LogAttributes {
	const out: LogAttributes = { "process.pid": process.pid };
	if (!input) return out;
	for (const key in input) {
		const attr = logAttributeValue(input[key]);
		if (attr !== undefined) out[key] = attr;
	}
	return out;
}

function logAttributeValue(value: unknown): AttributeValue | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (value instanceof Error) {
		return `${value.name}: ${value.message}`;
	}
	try {
		const text = JSON.stringify(value);
		if (text && text.length > 0) return text;
	} catch {
		return String(value);
	}
	return String(value);
}

/** Flush buffered spans, log records, and metrics across all registered providers. */
export async function flushTelemetryExport(): Promise<void> {
	const flushes: Promise<void>[] = [];
	if (traceProvider) flushes.push(traceProvider.forceFlush());
	if (logProvider) flushes.push(logProvider.forceFlush());
	if (meterProvider) flushes.push(meterProvider.forceFlush());
	await Promise.all(flushes);
}
