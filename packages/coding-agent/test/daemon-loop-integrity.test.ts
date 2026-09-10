// Daemon event-loop integrity under production-shaped load.
//
// Contract (docs: omp-daemon-experiment/docs/daemon/12-event-loop-integrity.md):
// the daemon's ideology is to be BETTER than single-instance mode — one
// session's traffic must never be perceptible in another session's lane. These
// tests encode the "10 agents + 50 subagents" target deterministically:
// in-process DaemonServer, fake runtimes (no model calls), a CONTROL session
// heartbeating concurrently with the storm, and starvation detected two ways:
//   1. per-heartbeat round-trip latency percentiles (isolation), and
//   2. the largest wall-clock GAP between consecutive heartbeat completions
//      (a single long loop block shows up here even if later probes are fast).
//
// These assert scheduling isolation of the registry/server on one loop. They
// do NOT arm the hosted-TUI LoopWatchdog (fake runtimes host no InteractiveMode);
// live `ui.loop-blocked` phase attribution is verified against a real spawned
// daemon (`scripts/daemon-bench.ts --fairness` + log inspection) after cutover.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { summarizeLatencies } from "../scripts/daemon-bench";
import type { DaemonClient } from "../src/daemon/client";
import { DaemonServer } from "../src/daemon/server";
import type { DaemonSessionRuntime, DaemonSessionSnapshot } from "../src/daemon/session-runtime";
import type { AgentSessionEventListener } from "../src/session/agent-session";
import { RemoteSessionHandle } from "../src/session/session-handle";

// Generous ceilings that only trip on real starvation: the live incident
// class is seconds-per-heartbeat, not milliseconds.
const HEARTBEAT_P95_CEILING_MS = 1_000;
const HEARTBEAT_MAX_CEILING_MS = 5_000;
const HEARTBEAT_GAP_CEILING_MS = 5_000;

interface Harness {
	server: DaemonServer;
	emitters: Map<string, (event: unknown) => void>;
	newClient: () => DaemonClient;
	createSession: (client: DaemonClient, sessionId: string) => Promise<void>;
	dispose: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-integrity-"));
	const runtimeDir = path.join(root, "runtime");
	const cwd = await fs.realpath(root);
	const emitters = new Map<string, (event: unknown) => void>();
	const runtimeFactory = async ({
		cwd: sessionCwd,
		sessionId,
	}: {
		cwd: string;
		sessionId?: string;
	}): Promise<DaemonSessionRuntime> => {
		const id = sessionId ?? crypto.randomUUID();
		const listeners = new Set<AgentSessionEventListener>();
		let commandCount = 0;
		emitters.set(id, event => {
			for (const listener of listeners) listener(event as never);
		});
		const session: DaemonSessionRuntime["session"] = {
			sessionId: id,
			isStreaming: false,
			prompt: async () => true,
			abort: async () => undefined,
			dispose: async () => undefined,
			subscribe: (listener: AgentSessionEventListener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		};
		return {
			sessionId: id,
			cwd: sessionCwd,
			session,
			protectedJobCount: () => 0,
			snapshot: (): DaemonSessionSnapshot => ({
				state: {
					sessionId: id,
					thinkingLevel: undefined,
					isStreaming: false,
					fastModeEnabled: false,
					fastModeActive: false,
					tokensPerSecond: null,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "all",
					interruptMode: "immediate",
					autoCompactionEnabled: true,
					messageCount: commandCount,
					queuedMessageCount: 0,
					todoPhases: [],
				},
				cwd: sessionCwd,
				entries: [],
			}),
			command: async () => {
				commandCount++;
				return { accepted: true };
			},
			dispose: reason => session.dispose(reason === undefined ? undefined : { reason }),
			subscribe: session.subscribe,
		};
	};
	const server = new DaemonServer({ profile: "test", runtimeDir, token: "secret", runtimeFactory });
	await server.run();
	const clients: DaemonClient[] = [];
	const { DaemonClient: ClientCtor } = await import("../src/daemon/client");
	const newClient = (): DaemonClient => {
		const client = new ClientCtor({ profile: "test", runtimeDir, token: "secret" });
		clients.push(client);
		return client;
	};
	const createSession = async (client: DaemonClient, sessionId: string): Promise<void> => {
		await client.request("session_create", { sessionId, cwd });
	};
	return {
		server,
		emitters,
		newClient,
		createSession,
		dispose: async () => {
			for (const client of clients) client.close();
			await server.shutdown(true);
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

interface HeartbeatReport {
	latencies: number[];
	/** Largest wall-clock gap between consecutive heartbeat completions. */
	maxGapMs: number;
}

/**
 * Heartbeats while `stop` is pending. ONLY beats issued while the workload
 * was still running are recorded — post-storm samples would dilute the
 * starvation percentiles into a pass.
 */
async function heartbeatUntil(handle: RemoteSessionHandle, stop: Promise<unknown>): Promise<HeartbeatReport> {
	const latencies: number[] = [];
	let maxGapMs = 0;
	let last = performance.now();
	let done = false;
	const settled = stop.finally(() => {
		done = true;
	});
	let i = 0;
	while (!done) {
		const started = performance.now();
		await handle.prompt(`hb-${i++}`);
		const now = performance.now();
		// The beat overlapped the storm only if the storm had not settled
		// when it STARTED; a beat straddling the finish still counts.
		latencies.push(now - started);
		maxGapMs = Math.max(maxGapMs, now - last);
		last = now;
		// Model a real client cadence; also guarantees the loop yields.
		await Bun.sleep(5);
	}
	// Propagate a storm failure instead of swallowing it as a passing report.
	await settled;
	return { latencies, maxGapMs };
}
function assertHeartbeat(report: HeartbeatReport, label: string): void {
	const summary = summarizeLatencies(report.latencies);
	const profile =
		`${label}: n=${report.latencies.length} p50=${summary.p50Ms.toFixed(1)}ms ` +
		`p95=${summary.p95Ms.toFixed(1)}ms p99=${summary.p99Ms.toFixed(1)}ms ` +
		`max=${summary.maxMs.toFixed(1)}ms maxGap=${report.maxGapMs.toFixed(1)}ms`;
	expect(report.latencies.length, profile).toBeGreaterThan(10);
	expect(summary.p95Ms, profile).toBeLessThan(HEARTBEAT_P95_CEILING_MS);
	expect(summary.maxMs, profile).toBeLessThan(HEARTBEAT_MAX_CEILING_MS);
	expect(report.maxGapMs, profile).toBeLessThan(HEARTBEAT_GAP_CEILING_MS);
}

describe("daemon event-loop integrity", () => {
	test("control heartbeat never starves while 10 agents + 50 subagents storm the daemon", async () => {
		const harness = await startHarness();
		try {
			// 10 "agents": own client + interactive attachment each.
			const agents: { id: string; handle: RemoteSessionHandle; received: number }[] = [];
			for (let a = 0; a < 10; a++) {
				const client = harness.newClient();
				await client.connect();
				const id = `agent-${a}`;
				await harness.createSession(client, id);
				const handle = new RemoteSessionHandle(client, id);
				await handle.whenReady();
				const entry = { id, handle, received: 0 };
				handle.subscribe(() => {
					entry.received++;
				});
				agents.push(entry);
			}
			// 50 "subagents": sessions multiplexed over 5 clients, no attachment
			// (their events still hit split/append on the shared loop).
			const subagentIds: string[] = [];
			for (let c = 0; c < 5; c++) {
				const client = harness.newClient();
				await client.connect();
				for (let s = 0; s < 10; s++) {
					const id = `subagent-${c}-${s}`;
					await harness.createSession(client, id);
					subagentIds.push(id);
				}
			}
			// Control session: an independent client heartbeating throughout.
			const controlClient = harness.newClient();
			await controlClient.connect();
			await harness.createSession(controlClient, "control");
			const control = new RemoteSessionHandle(controlClient, "control");
			await control.whenReady();

			// terminal_output is the ONE event shape the registry splits into
			// 128K-unit chunks and encodes per chunk — the real large-frame hot
			// path (everything else is truncated to a small marker by
			// boundDaemonEvent before encoding).
			const agentPayload = "A".repeat(512 * 1024); // → 4 chunks per event
			const subagentPayload = "s".repeat(4 * 1024);
			const perAgent = 6;
			const agentChunks = 4;
			const perSubagent = 40;
			const storm = (async () => {
				for (let round = 0; round < perAgent; round++) {
					for (const agent of agents) {
						harness.emitters.get(agent.id)!({ type: "terminal_output", data: agentPayload });
						// Real events originate from awaited I/O; yield between them.
						await Bun.sleep(0);
					}
					for (let burst = 0; burst < perSubagent / perAgent; burst++) {
						for (const id of subagentIds) {
							harness.emitters.get(id)!({ type: "terminal_output", data: subagentPayload });
						}
						await Bun.sleep(0);
					}
				}
			})();

			const report = await heartbeatUntil(control, storm);
			assertHeartbeat(report, "control under 60-session storm");

			// Delivery: every agent attachment saw its full stream (no wedge).
			const deadline = Date.now() + 15_000;
			while (agents.some(agent => agent.received < perAgent * agentChunks) && Date.now() < deadline) {
				await Bun.sleep(10);
			}
			for (const agent of agents) {
				expect(agent.received, agent.id).toBeGreaterThanOrEqual(perAgent * agentChunks);
			}

			await control.dispose();
			for (const agent of agents) await agent.handle.dispose();
		} finally {
			await harness.dispose();
		}
	}, 60_000);

	test("a repeated multi-MB single event cannot open a starvation gap in a concurrent heartbeat", async () => {
		const harness = await startHarness();
		try {
			const heavyClient = harness.newClient();
			await heavyClient.connect();
			await harness.createSession(heavyClient, "heavy");
			const heavyHandle = new RemoteSessionHandle(heavyClient, "heavy");
			await heavyHandle.whenReady();
			let received = 0;
			let receivedChars = 0;
			heavyHandle.subscribe(event => {
				received++;
				const data = (event as { data?: unknown }).data;
				if (typeof data === "string") receivedChars += data.length;
			});

			const controlClient = harness.newClient();
			await controlClient.connect();
			await harness.createSession(controlClient, "control");
			const control = new RemoteSessionHandle(controlClient, "control");
			await control.whenReady();

			// The incident shape: single events large enough that ONE synchronous
			// split+append+encode pass is measurable — terminal_output splits an
			// 8MB payload into 64 × 128K-unit chunk frames, each encoded on the
			// shared loop. Each pass must stay far below the gap ceiling.
			const payload = "Z".repeat(8 * 1024 * 1024);
			const chunksPerEvent = 64;
			// Enough events, spaced widely enough, that >10 heartbeats sample
			// DURING the storm (the helper stops sampling when it settles).
			const events = 10;
			const emit = harness.emitters.get("heavy")!;
			const storm = (async () => {
				for (let i = 0; i < events; i++) {
					emit({ type: "terminal_output", data: payload });
					await Bun.sleep(30);
				}
			})();

			const report = await heartbeatUntil(control, storm);
			assertHeartbeat(report, "control vs 8MB events");

			const deadline = Date.now() + 15_000;
			while (received < events * chunksPerEvent && Date.now() < deadline) await Bun.sleep(10);
			expect(received).toBeGreaterThanOrEqual(events * chunksPerEvent);
			// Content integrity, not just chunk count: every emitted character
			// arrived exactly once across the split frames.
			expect(receivedChars).toBe(events * payload.length);

			await control.dispose();
			await heavyHandle.dispose();
		} finally {
			await harness.dispose();
		}
	}, 60_000);
});
