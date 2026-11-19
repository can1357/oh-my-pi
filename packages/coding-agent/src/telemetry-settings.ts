/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "./config/registry";

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
