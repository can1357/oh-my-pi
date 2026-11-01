import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CostEstimatorContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	allowTelemetryReceiverForTests,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { estimateProviderCost } from "@oh-my-pi/pi-coding-agent/telemetry-export-otlp";
import { cfgTelemetryOtlpExportEnabled } from "@oh-my-pi/pi-coding-agent/telemetry-settings";
import { TempDir } from "@oh-my-pi/pi-utils";

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

/**
 * Environment for a probe subprocess, with a home and agent dir of its own. The probe
 * loads `@oh-my-pi/pi-utils`, which fills every unset variable from `~/.env`,
 * `~/.omp/.env` and the agent dir's `.env`, so a kill-switch removed above would come
 * back from the developer's own dotenv files and silence the signal the probe expects.
 * The probe is marked as a test child, as `ci-test-ts` marks it, so a local run takes
 * the same export gate as CI does instead of passing for a production process.
 */
function probeEnv(home: TempDir): Record<string, string | undefined> {
	return {
		...process.env,
		HOME: home.path(),
		USERPROFILE: home.path(),
		PI_CODING_AGENT_DIR: path.join(home.path(), ".omp", "agent"),
		PI_TEST_RUNTIME: "1",
	};
}

describe("initTelemetryExport gating", () => {
	it("stays disabled when no OTLP endpoint is configured", async () => {
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("never exports from a test process to a collector off this machine", async () => {
		// What a developer's shell or `~/.omp/agent/.env` sets: an in-process
		// `runRootCommand` would otherwise register real exporters aimed at it.
		const collectors = {
			OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.invalid",
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://10.0.0.1:4318/v1/logs",
			OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://localhost.example.invalid:4318/v1/metrics",
		};
		Object.assign(process.env, collectors);
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
		// Nor can a test declare one of them as a receiver of its own.
		for (const endpoint of Object.values(collectors)) {
			expect(() => allowTelemetryReceiverForTests(endpoint)).toThrow("must be on loopback");
		}
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
		// Declared as the test's own receiver, so only the protocol can decline it.
		using _receiver = allowTelemetryReceiverForTests("http://localhost:4317");
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
		using home = TempDir.createSync("@omp-otel-probe-home-");
		const proc = Bun.spawn([process.execPath, probe], {
			env: probeEnv(home),
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
		using home = TempDir.createSync("@omp-otel-probe-home-");
		const results = await Promise.all(
			probes.map(async ([name, relativePath]) => {
				const probe = fileURLToPath(new URL(relativePath, import.meta.url));
				const proc = Bun.spawn([process.execPath, probe], {
					// Bun otherwise inherits the process's original native environment,
					// including external OTEL kill-switches removed in beforeEach.
					env: probeEnv(home),
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

describe("initTelemetryExport with an inherited loopback collector", () => {
	/**
	 * Run the inherited-collector probe with `OTEL_EXPORTER_OTLP_ENDPOINT` naming a
	 * loopback collector this test serves, a stand-in for a developer's own collector,
	 * at `collectorPath` under its origin. Reports what the probe observed and the path
	 * of every request the collector got.
	 */
	async function runInheritedCollectorProbe(options: { testChild: boolean; mode?: string; collectorPath?: string }) {
		const collected = new Set<string>();
		const collector = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				await req.arrayBuffer();
				collected.add(new URL(req.url).pathname);
				return new Response('{"partialSuccess":{}}', {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});
		using home = TempDir.createSync("@omp-otel-probe-home-");
		try {
			const probe = fileURLToPath(new URL("./otel-inherited-probe.ts", import.meta.url));
			const proc = Bun.spawn([process.execPath, probe, ...(options.mode ? [options.mode] : [])], {
				env: {
					...probeEnv(home),
					// The probe is no test entrypoint, so without the marker it runs as production.
					PI_TEST_RUNTIME: options.testChild ? "1" : undefined,
					OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}${options.collectorPath ?? ""}`,
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			});
			const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			const line = output.split("\n").find(entry => entry.startsWith("PROBE: "));
			return {
				exitCode,
				observed: line && JSON.parse(line.slice("PROBE: ".length)),
				collected: [...collected].sort(),
			};
		} finally {
			await collector.stop(true);
		}
	}

	it("exports nothing to it from a test process that declared no receiver", async () => {
		expect(await runInheritedCollectorProbe({ testChild: true })).toEqual({
			exitCode: 0,
			observed: { testRuntime: true, enabled: false, ownReceived: [] },
			collected: [],
		});
	}, 20_000);

	it("exports every signal to it from a production process", async () => {
		expect(await runInheritedCollectorProbe({ testChild: false })).toEqual({
			exitCode: 0,
			observed: { testRuntime: false, enabled: true, ownReceived: [] },
			collected: ["/v1/logs", "/v1/metrics", "/v1/traces"],
		});
	}, 20_000);

	it("exports each signal under the path of a generic endpoint, as the OTLP exporter resolves it", async () => {
		// The bootstrap hands each exporter its URL instead of letting it read the
		// environment, so the bootstrap must append `v1/<signal>` beneath the endpoint's
		// own path the way the OTLP exporter does.
		expect(await runInheritedCollectorProbe({ testChild: false, collectorPath: "/otlp" })).toEqual({
			exitCode: 0,
			observed: { testRuntime: false, enabled: true, ownReceived: [] },
			collected: ["/otlp/v1/logs", "/otlp/v1/metrics", "/otlp/v1/traces"],
		});
	}, 20_000);

	it("exports from a test process only to the receiver it declared", async () => {
		// Traces go to the probe's own receiver; logs and metrics still name the collector.
		expect(await runInheritedCollectorProbe({ testChild: true, mode: "own-receiver" })).toEqual({
			exitCode: 0,
			observed: { testRuntime: true, enabled: true, ownReceived: ["/v1/traces"] },
			collected: [],
		});
	}, 20_000);

	it("exports to the receiver it validated when the endpoint changes during initialization", async () => {
		// The environment names the inherited collector for traces by the time the
		// exporter is built; the declared receiver was the one validated.
		expect(await runInheritedCollectorProbe({ testChild: true, mode: "endpoint-changed-mid-init" })).toEqual({
			exitCode: 0,
			observed: { testRuntime: true, enabled: true, ownReceived: ["/v1/traces"] },
			collected: [],
		});
	}, 20_000);

	it("exports nothing anywhere when the declaration is withdrawn during initialization", async () => {
		// The probe's receiver stays up, so an export to it would show here too.
		expect(await runInheritedCollectorProbe({ testChild: true, mode: "declaration-withdrawn-mid-init" })).toEqual({
			exitCode: 0,
			observed: { testRuntime: true, enabled: false, ownReceived: [] },
			collected: [],
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
