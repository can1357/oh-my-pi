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
 * Under the test runtime a signal exports only to a receiver the test declared
 * through {@link allowTelemetryReceiverForTests}.
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { isBunTestRuntime, logger } from "@oh-my-pi/pi-utils";

/** Whether the model registered under a provider id and requested model id has known pricing. */
export type TelemetryModelPricingResolver = (providerId: string, modelId: string) => boolean;

/** Per-signal OTLP export toggles resolved from the `OTEL_*` env contract. */
export interface TelemetrySignalConfig {
	readonly trace: boolean;
	readonly log: boolean;
	readonly metric: boolean;
}

type TelemetrySignal = "trace" | "log" | "metric";

/** Loaded OTLP implementation module; `undefined` until a signal registers. */
interface OtlpExportModule {
	registerProviders(signalConfig: TelemetrySignalConfig): Promise<void>;
	isTelemetryExportEnabled(): boolean;
	createTelemetryExportConfig(
		config: AgentTelemetryConfig | undefined,
		modelPricingResolver?: TelemetryModelPricingResolver,
	): AgentTelemetryConfig | undefined;
	flushTelemetryExport(): Promise<void>;
}

let otlp: OtlpExportModule | undefined;
let initPromise: Promise<void> | undefined;
/** Origins this test process declared through {@link allowTelemetryReceiverForTests}. */
const testReceiverOrigins = new Set<string>();

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
 * The caller still owns content-capture policy and custom attributes, and its
 * own `costEstimator` wins. Without one, `modelPricingResolver` makes chat
 * telemetry report each request's provider-computed cost. Beyond that, this
 * only appends host-level metrics/log forwarding for the providers registered
 * by {@link initTelemetryExport}; a passthrough when export is disabled.
 */
export function createTelemetryExportConfig(
	config: AgentTelemetryConfig | undefined,
	modelPricingResolver?: TelemetryModelPricingResolver,
): AgentTelemetryConfig | undefined {
	return otlp ? otlp.createTelemetryExportConfig(config, modelPricingResolver) : config;
}

/**
 * Register global trace/log/meter providers when enabled and OTLP endpoints are
 * configured through env. Idempotent, and a no-op when disabled, no signal has
 * an endpoint, the OTEL kill-switch is engaged, or, under the test runtime, no
 * signal's endpoint is a receiver the test declared.
 *
 * @param exportEnabled `telemetry.otlpExportEnabled`; required so every caller
 *   decides whether the user's opt-out applies.
 */
export async function initTelemetryExport(exportEnabled: boolean): Promise<void> {
	if (initPromise) return initPromise;

	if (!exportEnabled || process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return;

	const signalConfig = resolveSignalConfig();
	if (!signalConfig.trace && !signalConfig.log && !signalConfig.metric) return;

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
 * Let this test process export OTLP telemetry to a loopback receiver it serves itself.
 *
 * Under the test runtime a signal exports only to an endpoint whose origin was declared
 * here. A test inherits the developer's `OTEL_*` endpoints from the shell and from the
 * dotenv files `@oh-my-pi/pi-utils` loads, and they name the developer's own collector,
 * which listens on loopback as readily as a test's receiver does; so no address is
 * consent by itself. The declaration lives in this process: a child does not inherit it.
 *
 * @param receiver URL of the receiver; only its origin counts.
 * @returns a handle that withdraws the declaration when disposed.
 * @throws outside the test runtime, and for a receiver that is not on loopback.
 */
export function allowTelemetryReceiverForTests(receiver: string | URL): Disposable {
	if (!isBunTestRuntime()) throw new Error("allowTelemetryReceiverForTests is test-only");
	const { origin, hostname } = new URL(receiver);
	if (!isLoopbackHostname(hostname)) {
		throw new Error(`A test's telemetry receiver must be on loopback, not ${origin}`);
	}
	testReceiverOrigins.add(origin);
	return {
		[Symbol.dispose]() {
			testReceiverOrigins.delete(origin);
		},
	};
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
	// Under test, every in-process `runRootCommand` would ship its spans, logs and
	// metrics to whatever collector the inherited `OTEL_*` endpoints name. Only a
	// receiver the test declared may be the target. An inherited endpoint is the
	// common case here, not a misconfiguration, so declining it does not warn.
	if (isBunTestRuntime() && !isDeclaredTestReceiver(endpoint)) {
		logger.debug(`OTEL ${signal} export disabled: a test process exports only to a receiver it declared`, {
			endpoint,
		});
		return false;
	}

	const protocol = protocolSelection?.trim().toLowerCase();
	if (protocol && protocol !== "http/protobuf") {
		logger.warn(`OTEL ${signal} export disabled: OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is unsupported`, {
			supported: "http/protobuf",
		});
		return false;
	}
	return true;
}

function isDeclaredTestReceiver(endpoint: string): boolean {
	let origin: string;
	try {
		origin = new URL(endpoint).origin;
	} catch {
		return false;
	}
	return testReceiverOrigins.has(origin);
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
