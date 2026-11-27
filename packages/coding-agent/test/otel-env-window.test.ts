import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * OTEL_* values from OMP's own `.env` files stay out of `process.env`; the
 * OpenTelemetry SDK only sees them inside `withOmpOtelEnv` while it constructs
 * its exporters. The exporter case is the guard for that one SDK assumption: a
 * dependency bump that moves env reads from construction to export time makes it
 * fail instead of silently exporting to the default endpoint without auth.
 */
const probePath = path.join(import.meta.dir, "otel-env-window-probe.ts");
const tempDirs: string[] = [];

// Every variable `dirs.ts` consults to pick the profile, agent dir or config/state roots. A probe child
// must not inherit any of them from the developer's shell (e.g. OMP_PROFILE beats PI_PROFILE, and a
// named profile ignores PI_CODING_AGENT_DIR), or it would read a different agent dir than its fixture.
const DIR_RESOLUTION_ENV_RESET = {
	OMP_PROFILE: undefined,
	PI_PROFILE: undefined,
	PI_CONFIG_DIR: undefined,
	XDG_DATA_HOME: undefined,
	XDG_STATE_HOME: undefined,
	XDG_CACHE_HOME: undefined,
};

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
}, 30_000);

interface ReceivedRequest {
	path: string;
	headers: Record<string, string>;
	body: string;
}

type ProbeMode = "gate" | "exporter" | "init" | "init-log-none" | "init-disabled";

async function runProbe(mode: ProbeMode, extraAgentEnv: string[] = []) {
	const requests: ReceivedRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			requests.push({
				path: new URL(req.url).pathname,
				headers: Object.fromEntries(req.headers),
				body: Buffer.from(await req.arrayBuffer()).toString("latin1"),
			});
			return new Response('{"partialSuccess":{}}', { headers: { "content-type": "application/json" } });
		},
	});
	try {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-otel-window-"));
		tempDirs.push(home);
		const agentDir = path.join(home, "agent");
		const cwd = path.join(home, "project");
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(
			path.join(agentDir, ".env"),
			mode === "gate"
				? "PLAIN_PROBE=1"
				: [
						`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:${server.port}/agent-file/v1/traces`,
						"OTEL_EXPORTER_OTLP_TRACES_HEADERS=x-omp-probe=from-agent-file-traces",
						"OTEL_TRACES_EXPORTER=otlp",
						`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:${server.port}/agent-file/v1/logs`,
						"OTEL_EXPORTER_OTLP_LOGS_HEADERS=x-omp-probe=from-agent-file-logs",
						"OTEL_LOGS_EXPORTER=otlp",
						`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:${server.port}/agent-file/v1/metrics`,
						"OTEL_EXPORTER_OTLP_METRICS_HEADERS=x-omp-probe=from-agent-file-metrics",
						"OTEL_METRICS_EXPORTER=otlp",
						...extraAgentEnv,
					].join("\n"),
		);
		const proc = Bun.spawn([process.execPath, probePath, mode], {
			cwd,
			env: {
				// Drop every inherited OTEL_* name, not a fixed list: a developer's shell may export
				// others (OTEL_LOG_LEVEL, OTEL_PROPAGATORS, ...) that would change what the probe sees.
				...Object.fromEntries(
					Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("OTEL_")),
				),
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: agentDir,
				...DIR_RESOLUTION_ENV_RESET,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const line = stdout.split("\n").find(entry => entry.startsWith("PROBE: "));
		if (!line) throw new Error(`probe printed no result: ${stdout}${stderr}`);
		return { result: JSON.parse(line.slice("PROBE: ".length)) as Record<string, string[] | boolean>, requests };
	} finally {
		await server.stop(true);
	}
}

function requestsTo(requests: ReceivedRequest[], signalPath: string): ReceivedRequest[] {
	return requests.filter(request => request.path === `/agent-file/v1/${signalPath}`);
}

describe("OMP-owned OTEL_* and the OpenTelemetry SDK", () => {
	it("stays disabled when no OTLP endpoint is configured anywhere", async () => {
		// Runs in a clean HOME/agent dir: the in-process private map is seeded from the developer's real .env files.
		const { result } = await runProbe("gate");
		expect(result.enabled).toBe(false);
	}, 20_000);

	it("an exporter built inside withOmpOtelEnv exports with the agent .env endpoint and headers", async () => {
		const { result, requests } = await runProbe("exporter");
		expect(result.afterWindow).toEqual([]);
		expect(requests).toHaveLength(1);
		expect(requests[0].path).toBe("/agent-file/v1/traces");
		expect(requests[0].headers["x-omp-probe"]).toBe("from-agent-file-traces");
	}, 20_000);

	it("initTelemetryExport exports traces, logs and metrics from the agent .env without leaving OTEL_* in process.env", async () => {
		const { result, requests } = await runProbe("init", [
			"OTEL_RESOURCE_ATTRIBUTES=user.email=probe%40example.test",
			"OTEL_SERVICE_NAME=otel-env-window-probe",
		]);
		expect(result.afterInit).toEqual([]);
		// Nothing may reach a default endpoint; every request carries its own signal's agent-file path.
		expect(requests.every(request => request.path.startsWith("/agent-file/v1/"))).toBe(true);
		for (const signal of ["traces", "logs", "metrics"]) {
			const signalRequests = requestsTo(requests, signal);
			expect(signalRequests.length, signal).toBeGreaterThan(0);
			for (const request of signalRequests) {
				expect(request.headers["x-omp-probe"], signal).toBe(`from-agent-file-${signal}`);
				expect(request.body, signal).toContain("user.email");
				expect(request.body, signal).toContain("probe@example.test");
				expect(request.body, signal).toContain("otel-env-window-probe");
			}
		}
		expect(requestsTo(requests, "logs").some(request => request.body.includes("probe-log-record-7731"))).toBe(true);
		expect(requestsTo(requests, "metrics").some(request => request.body.includes("probe.counter"))).toBe(true);
	}, 30_000);

	it("honors OTEL_LOG_LEVEL=none from the agent .env", async () => {
		const { requests } = await runProbe("init-log-none", ["OTEL_LOG_LEVEL=none"]);
		expect(requestsTo(requests, "traces").length).toBeGreaterThan(0);
		expect(requestsTo(requests, "logs")).toEqual([]);
	}, 30_000);

	it("honors OTEL_LOGS_EXPORTER=none and OTEL_METRICS_EXPORTER=none from the agent .env", async () => {
		const { requests } = await runProbe("init", ["OTEL_LOGS_EXPORTER=none", "OTEL_METRICS_EXPORTER=none"]);
		expect(requestsTo(requests, "traces").length).toBeGreaterThan(0);
		expect(requestsTo(requests, "logs")).toEqual([]);
		expect(requestsTo(requests, "metrics")).toEqual([]);
	}, 30_000);

	it("honors OTEL_TRACES_EXPORTER=none from the agent .env", async () => {
		const { requests } = await runProbe("init", ["OTEL_TRACES_EXPORTER=none"]);
		expect(requestsTo(requests, "traces")).toEqual([]);
		expect(requestsTo(requests, "logs").length).toBeGreaterThan(0);
	}, 30_000);

	it("honors OTEL_SDK_DISABLED=true from the agent .env", async () => {
		const { requests } = await runProbe("init-disabled", ["OTEL_SDK_DISABLED=true"]);
		expect(requests).toEqual([]);
	}, 30_000);
});
