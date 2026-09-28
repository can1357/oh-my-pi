/**
 * OTLP telemetry export bootstrap.
 *
 * omp's agent core (`@oh-my-pi/pi-agent-core`) emits OpenTelemetry GenAI
 * spans through the global `@opentelemetry/api` tracer, and exposes run-level
 * callbacks for metrics/log pipelines. This module resolves the standard
 * `OTEL_*` env contract (endpoint, exporter selection, protocol,
 * `OTEL_SDK_DISABLED`) and, only when at least one signal has an OTLP endpoint,
 * loads `./telemetry-export-otlp` to register the trace/log/metric providers —
 * keeping the OTel SDK + exporter module graph (~100ms) out of default startup.
 *
 * Only the `http/protobuf` transport is supported — an
 * `OTEL_EXPORTER_OTLP*_PROTOCOL` of `grpc` or `http/json` declines rather than
 * misrouting protobuf payloads.
 *
 * Export request headers start from `OTEL_EXPORTER_OTLP*_HEADERS`;
 * `telemetry.otlpHeaders` layers over them per key on every export request,
 * with values resolved through the same `!command` / `$ENV` / literal contract
 * as models.yml and MCP headers — so a rotating bearer token is one config line.
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type ConfigHeaderResolver,
	type ConfigHeaderSource,
	createConfigHeaderResolver,
} from "./config/resolve-config-value";

/** Per-signal OTLP export toggles resolved from the `OTEL_*` env contract. */
export interface TelemetrySignalConfig {
	readonly trace: boolean;
	readonly log: boolean;
	readonly metric: boolean;
}

type TelemetrySignal = "trace" | "log" | "metric";

/** `telemetry.otlpHeaders` plus its `!command` reuse window, resolved by the caller from settings. */
export interface TelemetryHeadersConfig {
	/** Header record whose values may be literals, `$ENV` names, or `!command`; or an already-composed resolver. */
	headers: ConfigHeaderSource;
	/** Reuse window for `!command` output; `0` runs it on every export request. Omitted: process lifetime. */
	commandTtlMs?: number;
}

/** Loaded OTLP implementation module; `undefined` until a signal registers. */
interface OtlpExportModule {
	registerProviders(signalConfig: TelemetrySignalConfig): Promise<void>;
	isTelemetryExportEnabled(): boolean;
	createTelemetryExportConfig(config: AgentTelemetryConfig | undefined): AgentTelemetryConfig | undefined;
	flushTelemetryExport(): Promise<void>;
}

let otlp: OtlpExportModule | undefined;
let initPromise: Promise<void> | undefined;
let headersResolver: ConfigHeaderResolver | undefined;
/** Names from the `telemetry.otlpHeaders` record, so a value that resolves to nothing can be reported. */
let configuredHeaders: string[] = [];
/** Configured names currently resolving to nothing; each is warned about once, on the transition. */
const missingHeaders = new Set<string>();
/** Whether the last resolution threw; the throw is warned about once, on the transition. */
let resolverFailed = false;

/**
 * Whether {@link initTelemetryExport} registered any real OTLP signal provider.
 * The CLI uses this to decide whether to switch on the agent loop's telemetry
 * hooks; metrics and structured logs need those callbacks even when traces are
 * disabled.
 */
export function isTelemetryExportEnabled(): boolean {
	return otlp?.isTelemetryExportEnabled() ?? false;
}

/**
 * Merge OTLP metrics/log hooks into an existing agent telemetry config.
 *
 * The caller still owns content-capture policy, cost estimation, and custom
 * attributes. This only appends host-level metrics/log forwarding for the
 * providers registered by {@link initTelemetryExport}; a passthrough when
 * export is disabled.
 */
export function createTelemetryExportConfig(
	config: AgentTelemetryConfig | undefined,
): AgentTelemetryConfig | undefined {
	return otlp ? otlp.createTelemetryExportConfig(config) : config;
}

/**
 * Register global trace/log/meter providers when enabled and OTLP endpoints are
 * configured through env. Idempotent, and a no-op when disabled, no signal has
 * an endpoint, or the OTEL kill-switch is engaged.
 *
 * @param exportEnabled `telemetry.otlpExportEnabled`; required so every caller
 *   decides whether the user's opt-out applies.
 * @param headers `telemetry.otlpHeaders`, when set. Resolved per export request,
 *   so a `!command` value only ever runs while export is actually on.
 */
export async function initTelemetryExport(exportEnabled: boolean, headers?: TelemetryHeadersConfig): Promise<void> {
	if (initPromise) return initPromise;

	if (!exportEnabled || process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return;

	const signalConfig = resolveSignalConfig();
	if (!signalConfig.trace && !signalConfig.log && !signalConfig.metric) return;

	headersResolver = headers
		? createConfigHeaderResolver([headers.headers], { commandTtlMs: headers.commandTtlMs })
		: undefined;
	configuredHeaders = headers && typeof headers.headers === "object" ? Object.keys(headers.headers) : [];

	initPromise = (async () => {
		// Branch-only: the OTel SDK + OTLP exporter graph loads only when an endpoint is configured.
		const impl: OtlpExportModule = await import("./telemetry-export-otlp");
		await impl.registerProviders(signalConfig);
		otlp = impl;
	})();
	return initPromise;
}

/**
 * Flush buffered spans, log records, and metrics. No-op when export is disabled.
 * Hosts embedding the agent can call this at natural boundaries (e.g. the end
 * of a turn) so telemetry surfaces promptly rather than on the batch interval.
 */
export async function flushTelemetryExport(): Promise<void> {
	if (otlp) await otlp.flushTelemetryExport();
}

/**
 * Headers for one OTLP export request, layered by the exporter over the env
 * headers per key; `{}` when none are configured. Never throws — the exporter's
 * header factory must not.
 *
 * A configured header that resolves to nothing (its `!command` failed or is in
 * failure backoff), or a resolver that throws outright, is logged once, on the
 * transition into that state, and again only after recovery: this runs inside
 * the export itself, so a warning per request would become a log record whose
 * export triggers the next warning.
 */
export async function resolveTelemetryHeaders(): Promise<Record<string, string>> {
	if (!headersResolver) return {};
	let resolved: Record<string, string> | undefined;
	try {
		resolved = await headersResolver();
		resolverFailed = false;
	} catch (error) {
		if (!resolverFailed) logger.warn("telemetry.otlpHeaders resolution failed", { error });
		resolverFailed = true;
	}
	for (const name of configuredHeaders) {
		if (resolved?.[name] !== undefined) {
			missingHeaders.delete(name);
		} else if (!missingHeaders.has(name)) {
			missingHeaders.add(name);
			logger.warn("telemetry.otlpHeaders: header unavailable; exporting without it", { header: name });
		}
	}
	return resolved ?? {};
}

function resolveSignalConfig(): TelemetrySignalConfig {
	return {
		trace: signalEnabled(
			"trace",
			process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
			process.env.OTEL_TRACES_EXPORTER,
			process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
		log: signalEnabled(
			"log",
			process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
			process.env.OTEL_LOGS_EXPORTER,
			process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
		metric: signalEnabled(
			"metric",
			process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
			process.env.OTEL_METRICS_EXPORTER,
			process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
	};
}

function signalEnabled(
	signal: TelemetrySignal,
	endpoint: string | undefined,
	exporterSelection: string | undefined,
	protocolSelection: string | undefined,
): boolean {
	if (exporterSelection) {
		let hasSelection = false;
		let hasOtlp = false;
		for (const entry of exporterSelection.split(",")) {
			const selection = entry.trim().toLowerCase();
			if (!selection) continue;
			hasSelection = true;
			if (selection === "none") return false;
			if (selection === "otlp") hasOtlp = true;
		}
		if (hasSelection && !hasOtlp) return false;
	}
	if (!endpoint) return false;

	const protocol = protocolSelection?.trim().toLowerCase();
	if (protocol && protocol !== "http/protobuf") {
		logger.warn(`OTEL ${signal} export disabled: OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is unsupported`, {
			supported: "http/protobuf",
		});
		return false;
	}
	return true;
}
