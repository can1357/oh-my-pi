import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import type { CostEstimatorContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTelemetryExport, isTelemetryExportEnabled } from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { estimateProviderCost } from "@oh-my-pi/pi-coding-agent/telemetry-export-otlp";
import { cfgTelemetryOtlpExportEnabled } from "@oh-my-pi/pi-coding-agent/telemetry-settings";

/**
 * Gating contract for the OTLP export bootstrap. These cases all short-circuit
 * before a provider is registered, so they never mutate the module singleton
 * and are order-independent. Transport-path probes run in subprocesses so any
 * registered global provider can't leak into the test runner.
 */
const OTEL_KEYS = [
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
	"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
	"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
	"OTEL_SDK_DISABLED",
	"OTEL_TRACES_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_METRICS_EXPORTER",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(OTEL_KEYS.map(k => [k, process.env[k]]));
	for (const k of OTEL_KEYS) delete process.env[k];
});

afterEach(() => {
	for (const k of OTEL_KEYS) {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("initTelemetryExport gating", () => {
	it("stays disabled when no OTLP endpoint is configured", async () => {
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("keeps OTLP export disabled when the user opts out despite configured endpoints", async () => {
		process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://localhost:4318/v1/traces";
		const settings = Settings.isolated({ "telemetry.otlpExportEnabled": false });
		await initTelemetryExport(cfgTelemetryOtlpExportEnabled.get(settings));
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("stays disabled when OTEL_SDK_DISABLED=true even with an endpoint", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_SDK_DISABLED = "true";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("stays disabled when OTEL_TRACES_EXPORTER=none and only the traces endpoint is set", async () => {
		process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_TRACES_EXPORTER = "none";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("declines unsupported OTLP protocols instead of misrouting spans", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4317";
		process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);

		process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("honors the kill-switches case-insensitively per the OTEL env contract", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_SDK_DISABLED = "TRUE";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);

		delete process.env.OTEL_SDK_DISABLED;
		process.env.OTEL_TRACES_EXPORTER = "otlp,None";
		process.env.OTEL_LOGS_EXPORTER = "none";
		process.env.OTEL_METRICS_EXPORTER = "none";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("stays disabled when every signal exporter is set to none", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_TRACES_EXPORTER = "none";
		process.env.OTEL_LOGS_EXPORTER = "none";
		process.env.OTEL_METRICS_EXPORTER = "none";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
	});
});

describe("initTelemetryExport exporter selection", () => {
	it("does not send OTLP when console is explicitly selected for every signal", async () => {
		const probe = fileURLToPath(new URL("./otel-non-otlp-probe.ts", import.meta.url));
		const proc = Bun.spawn([process.execPath, probe], {
			env: { ...process.env },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const output = new Response(proc.stdout).text();
		const exitCode = await proc.exited;

		expect({ exitCode, output: (await output).trim() }).toEqual({
			exitCode: 0,
			output: "PROBE: NO_EXPORT",
		});
	}, 10_000);
});

describe("initTelemetryExport signals export path", () => {
	it("exports every OTLP/proto signal and merged resource attributes", async () => {
		// Positive initialization registers process-global providers, so each
		// scenario still runs in its own process. Starting the independent probes
		// together avoids serially paying three Bun startup and exporter-flush waits.
		const probes = [
			["traces", "./otel-export-probe.ts"],
			["logs and metrics", "./otel-signals-probe.ts"],
			["resource attributes", "./otel-resource-probe.ts"],
		] as const;
		const results = await Promise.all(
			probes.map(async ([name, relativePath]) => {
				const probe = fileURLToPath(new URL(relativePath, import.meta.url));
				const proc = Bun.spawn([process.execPath, probe], {
					// Bun otherwise inherits the process's original native environment,
					// including external OTEL kill-switches removed in beforeEach.
					env: { ...process.env },
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				});
				return [name, await proc.exited] as const;
			}),
		);

		expect(Object.fromEntries(results)).toEqual({
			traces: 0,
			"logs and metrics": 0,
			"resource attributes": 0,
		});
	}, 20_000);
});

describe("estimateProviderCost", () => {
	// A Codex subscription request: OTel labels the provider `openai`, and the
	// response may name a served model rather than the requested one.
	const context: CostEstimatorContext = {
		provider: "openai",
		providerId: "openai-codex",
		model: "served-model",
		modelId: "requested-model",
		serviceTier: undefined,
		usage: {
			inputTokens: 1_500,
			outputTokens: 500,
			totalTokens: 2_000,
			cachedInputTokens: 400,
			cacheWriteTokens: 100,
			reasoningOutputTokens: 0,
		},
		usageCost: { input: 0.2, output: 0.8, cacheRead: 0.04, cacheWrite: 0.06, total: 1.1 },
	};

	it("reports the request's computed cost when the requested model has known pricing", () => {
		const result = estimateProviderCost(
			context,
			(providerId, modelId) => providerId === "openai-codex" && modelId === "requested-model",
		);

		expect(result).toEqual({ usd: 1.1, inputUsd: 0.2, outputUsd: 0.8 });
	});
	it("preserves a provider-reported charge while distinguishing unpriced zero from a free priced request", () => {
		const providerReported: CostEstimatorContext = {
			...context,
			usageCost: { input: 0.42, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.42 },
		};
		expect(estimateProviderCost(providerReported, () => false)).toEqual({
			usd: 0.42,
			inputUsd: 0.42,
			outputUsd: 0,
		});

		const unpricedZero: CostEstimatorContext = {
			...context,
			usageCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		expect(estimateProviderCost(unpricedZero, () => false)).toEqual({ unavailable: "model_price_unavailable" });
		expect(estimateProviderCost(unpricedZero, () => true)).toEqual({
			usd: 0,
			inputUsd: 0,
			outputUsd: 0,
		});
	});
});
