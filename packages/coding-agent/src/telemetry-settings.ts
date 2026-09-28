/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "./config/registry";
import type { Settings } from "./config/settings";
import type { TelemetryHeadersConfig } from "./telemetry-export";

/** Whether OMP may register process-global OTLP exporters. */
export const cfgTelemetryOtlpExportEnabled = register({
	id: "telemetry.otlpExportEnabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "providers",
		group: "Privacy",
		label: "OTLP Telemetry Export",
		description:
			"Allow OMP to export traces, logs, and metrics using OTEL_* endpoints. Changes take effect on the next launch.",
	},
});

const EMPTY_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Every `telemetry.otlpHeaders` value must be a string: the config resolver
 * calls `.startsWith("!")` on it, and one non-string would otherwise take every
 * other header down with it at export time.
 *
 * @throws Error naming every header whose value is not a string.
 */
export function validateTelemetryOtlpHeaders(value: unknown): void {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("telemetry.otlpHeaders must be an object of header name to string value");
	}
	const invalid = Object.entries(value)
		.filter(([, header]) => typeof header !== "string")
		.map(([name]) => name);
	if (invalid.length > 0) throw new Error(`telemetry.otlpHeaders values must be strings: ${invalid.join(", ")}`);
}

/**
 * Request headers layered over `OTEL_EXPORTER_OTLP*_HEADERS` on every OTLP
 * export. Values follow the models.yml / MCP contract: a literal, an `$ENV`
 * name, or `!command` whose stdout is the value.
 */
export const cfgTelemetryOtlpHeaders = register({
	id: "telemetry.otlpHeaders",
	type: "record",
	default: EMPTY_HEADERS,
	credential: true,
	validate: validateTelemetryOtlpHeaders,
});

/** How long one `!command` header value is reused before the command runs again. */
export const cfgTelemetryOtlpHeadersCacheSeconds = register({
	id: "telemetry.otlpHeadersCacheSeconds",
	type: "number",
	default: 60,
	ui: {
		tab: "providers",
		group: "Privacy",
		label: "OTLP Headers Cache (seconds)",
		description:
			"Reuse a `!command` value from telemetry.otlpHeaders for this long; 0 runs the command on every export request.",
	},
});

/** `telemetry.otlpHeaders` as {@link initTelemetryExport} takes it; `undefined` when no header is configured. */
export function telemetryHeadersConfig(settings: Settings): TelemetryHeadersConfig | undefined {
	const headers = cfgTelemetryOtlpHeaders.get(settings);
	if (Object.keys(headers).length === 0) return undefined;
	return { headers, commandTtlMs: Math.max(0, cfgTelemetryOtlpHeadersCacheSeconds.get(settings)) * 1000 };
}
