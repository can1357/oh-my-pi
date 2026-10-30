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
 * through {@link allowTelemetryReceiverForTests}. Each exporter is handed the
 * destination this module resolved and checked, never left to read `OTEL_*` again.
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { isBunTestRuntime, logger } from "@oh-my-pi/pi-utils";

/** Whether the model registered under a provider id and requested model id has known pricing. */
export type TelemetryModelPricingResolver = (providerId: string, modelId: string) => boolean;

type TelemetrySignal = "trace" | "log" | "metric";

/**
 * The URL each signal exports to, resolved from the `OTEL_*` env contract;
 * `undefined` for a signal that does not export.
 */
export type TelemetryDestinations = Readonly<Record<TelemetrySignal, string | undefined>>;

/** Path the OTLP exporter appends beneath a generic `OTEL_EXPORTER_OTLP_ENDPOINT` for each signal. */
const SIGNAL_RESOURCE_PATHS: Record<TelemetrySignal, string> = {
	trace: "v1/traces",
	log: "v1/logs",
	metric: "v1/metrics",
};

/** Loaded OTLP implementation module; `undefined` until a signal registers. */
interface OtlpExportModule {
	registerProviders(destinations: TelemetryDestinations): void;
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
 * Each signal's destination is resolved from the environment once, by this call,
 * and handed to its exporter, so a later change to `OTEL_*` cannot move it. Under
 * the test runtime a declaration withdrawn before initialization finishes still
 * drops its signal.
 *
 * @param exportEnabled `telemetry.otlpExportEnabled`; required so every caller
 *   decides whether the user's opt-out applies.
 */
export async function initTelemetryExport(exportEnabled: boolean): Promise<void> {
	if (initPromise) return initPromise;

	if (!exportEnabled || process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return;

	const testRuntime = isBunTestRuntime();
	const destinations = resolveDestinations(testRuntime);
	if (Object.values(destinations).every(destination => destination === undefined)) return;

	initPromise = (async () => {
		// Branch-only: the OTel SDK + OTLP exporter graph loads only when an endpoint is configured.
		const impl: OtlpExportModule = await import("./telemetry-export-otlp");
		// The environment may name another collector by now, so the exporters get the
		// destinations resolved above. A test may also have withdrawn its declaration
		// while the module loaded; checking again in the same synchronous step that
		// builds the exporters can drop a destination but never substitute one.
		const admitted = testRuntime ? keepDeclaredTestReceivers(destinations) : destinations;
		if (Object.values(admitted).every(destination => destination === undefined)) {
			// Nothing registered, so a later call resolves afresh, as when no signal had an endpoint.
			initPromise = undefined;
			return;
		}
		impl.registerProviders(admitted);
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

function resolveDestinations(testRuntime: boolean): TelemetryDestinations {
	const env = process.env;
	return {
		trace: signalDestination(
			"trace",
			env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
			env.OTEL_EXPORTER_OTLP_ENDPOINT,
			env.OTEL_TRACES_EXPORTER,
			env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL,
			testRuntime,
		),
		log: signalDestination(
			"log",
			env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
			env.OTEL_EXPORTER_OTLP_ENDPOINT,
			env.OTEL_LOGS_EXPORTER,
			env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL,
			testRuntime,
		),
		metric: signalDestination(
			"metric",
			env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
			env.OTEL_EXPORTER_OTLP_ENDPOINT,
			env.OTEL_METRICS_EXPORTER,
			env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL,
			testRuntime,
		),
	};
}

function signalDestination(
	signal: TelemetrySignal,
	signalEndpoint: string | undefined,
	genericEndpoint: string | undefined,
	exporterSelection: string | undefined,
	protocolSelection: string | undefined,
	testRuntime: boolean,
): string | undefined {
	if (exporterSelection) {
		let hasSelection = false;
		let hasOtlp = false;
		for (const entry of exporterSelection.split(",")) {
			const selection = entry.trim().toLowerCase();
			if (!selection) continue;
			hasSelection = true;
			if (selection === "none") return undefined;
			if (selection === "otlp") hasOtlp = true;
		}
		if (hasSelection && !hasOtlp) return undefined;
	}
	if (!(signalEndpoint ?? genericEndpoint)) return undefined;
	const destination = otlpExportUrl(signal, signalEndpoint, genericEndpoint);
	// Under test, every in-process `runRootCommand` would ship its spans, logs and
	// metrics to whatever collector the inherited `OTEL_*` endpoints name. Only a
	// receiver the test declared may be the target, and the check runs on the URL
	// the exporter is handed, not on the raw variable.
	if (testRuntime && !isDeclaredForTest(signal, destination)) return undefined;

	const protocol = protocolSelection?.trim().toLowerCase();
	if (protocol && protocol !== "http/protobuf") {
		logger.warn(`OTEL ${signal} export disabled: OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is unsupported`, {
			supported: "http/protobuf",
		});
		return undefined;
	}
	return destination;
}

/**
 * The URL `@opentelemetry/otlp-exporter-base` derives from the environment for a
 * signal: its own endpoint as given, else `v1/<signal>` appended beneath the
 * generic endpoint's path, else the exporter's default. Blank values count as unset
 * and an unparsable one is passed over, as the exporter does, so handing the
 * exporter this URL leaves every production destination where it was.
 */
function otlpExportUrl(
	signal: TelemetrySignal,
	signalEndpoint: string | undefined,
	genericEndpoint: string | undefined,
): string {
	const resourcePath = SIGNAL_RESOURCE_PATHS[signal];
	if (signalEndpoint?.trim() && URL.canParse(signalEndpoint)) return new URL(signalEndpoint).href;
	if (genericEndpoint?.trim() && URL.canParse(genericEndpoint)) {
		const joined = `${genericEndpoint.endsWith("/") ? genericEndpoint : `${genericEndpoint}/`}${resourcePath}`;
		if (URL.canParse(joined)) return new URL(joined).href;
	}
	return `http://localhost:4318/${resourcePath}`;
}

function keepDeclaredTestReceivers(destinations: TelemetryDestinations): TelemetryDestinations {
	const keep = (signal: TelemetrySignal): string | undefined => {
		const destination = destinations[signal];
		return destination !== undefined && isDeclaredForTest(signal, destination) ? destination : undefined;
	};
	return { trace: keep("trace"), log: keep("log"), metric: keep("metric") };
}

/**
 * Whether a test process declared the receiver at `destination`. An inherited
 * endpoint is the common case under test, not a misconfiguration, so declining it
 * logs at debug level only.
 */
function isDeclaredForTest(signal: TelemetrySignal, destination: string): boolean {
	if (testReceiverOrigins.has(new URL(destination).origin)) return true;
	logger.debug(`OTEL ${signal} export disabled: a test process exports only to a receiver it declared`, {
		endpoint: destination,
	});
	return false;
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
