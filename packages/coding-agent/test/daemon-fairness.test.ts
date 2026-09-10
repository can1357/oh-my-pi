// Multi-session responsiveness/fairness catalogue for the shared daemon.
//
// The daemon hosts every session on ONE event loop: a heavy session (event
// floods, replay churn) must not starve an independent session's command
// round-trips. These tests encode bounded-latency contracts deterministically:
// in-process DaemonServer, fake runtimes, no model requests, no wall-clock
// assumptions beyond generous ceilings that only trip on real starvation
// (the live incident showed seconds-per-keystroke, not milliseconds).
//
// Live percentile measurement against a real spawned daemon lives in
// `scripts/daemon-bench.ts --fairness`.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { summarizeLatencies } from "../scripts/daemon-bench";
import { DaemonClient } from "../src/daemon/client";
import { DaemonServer } from "../src/daemon/server";
import type { DaemonSessionRuntime, DaemonSessionSnapshot } from "../src/daemon/session-runtime";
import type { AgentSessionEventListener } from "../src/session/agent-session";
import { RemoteSessionHandle } from "../src/session/session-handle";

// Generous ceilings: an unloaded local UDS round-trip is well under 5ms; the
// regression this guards against is multi-second starvation.
const PROBE_P95_CEILING_MS = 1_000;
const PROBE_MAX_CEILING_MS = 5_000;

interface Harness {
	root: string;
	server: DaemonServer;
	emitters: Map<string, (event: unknown) => void>;
	newClient: (recover?: () => void) => DaemonClient;
	createSession: (client: DaemonClient, sessionId: string) => Promise<void>;
	dispose: () => Promise<void>;
}

async function startHarness(hooks?: {
	/** Awaited inside the runtime factory before the session is installed. */
	beforeCreate?: (sessionId: string | undefined) => Promise<void>;
	/** Awaited inside every session command handler. */
	beforeCommand?: (sessionId: string) => Promise<void>;
}): Promise<Harness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-fairness-"));
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
		await hooks?.beforeCreate?.(sessionId);
		const id = sessionId ?? crypto.randomUUID();
		const listeners = new Set<AgentSessionEventListener>();
		const commands: string[] = [];
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
					messageCount: commands.length,
					queuedMessageCount: 0,
					todoPhases: [],
				},
				cwd: sessionCwd,
				entries: [],
			}),
			command: async command => {
				await hooks?.beforeCommand?.(id);
				commands.push(JSON.stringify(command));
				return { accepted: true };
			},
			dispose: reason => session.dispose(reason === undefined ? undefined : { reason }),
			subscribe: session.subscribe,
		};
	};
	const server = new DaemonServer({ profile: "test", runtimeDir, token: "secret", runtimeFactory });
	await server.run();
	const clients: DaemonClient[] = [];
	const newClient = (): DaemonClient => {
		const client = new DaemonClient({ profile: "test", runtimeDir, token: "secret" });
		clients.push(client);
		return client;
	};
	const createSession = async (client: DaemonClient, sessionId: string): Promise<void> => {
		await client.request("session_create", { sessionId, cwd });
	};
	return {
		root,
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

/** Sequential command probes against one handle; returns per-probe latency ms. */
async function probeLatencies(handle: RemoteSessionHandle, count: number): Promise<number[]> {
	const latencies: number[] = [];
	for (let i = 0; i < count; i++) {
		const started = performance.now();
		await handle.prompt(`probe-${i}`);
		latencies.push(performance.now() - started);
	}
	return latencies;
}

function assertBounded(latencies: readonly number[], label: string): void {
	const summary = summarizeLatencies(latencies);
	// The summary is part of the assertion message so a starvation regression
	// reports its own percentile profile.
	const profile = `${label}: p50=${summary.p50Ms.toFixed(1)}ms p95=${summary.p95Ms.toFixed(1)}ms p99=${summary.p99Ms.toFixed(1)}ms max=${summary.maxMs.toFixed(1)}ms`;
	expect(summary.p95Ms, profile).toBeLessThan(PROBE_P95_CEILING_MS);
	expect(summary.maxMs, profile).toBeLessThan(PROBE_MAX_CEILING_MS);
}

describe("daemon multi-session fairness", () => {
	test("victim command latency stays bounded while a heavy session floods events to its own attachment", async () => {
		const harness = await startHarness();
		try {
			const heavyClient = harness.newClient();
			await heavyClient.connect();
			await harness.createSession(heavyClient, "heavy");
			const heavyHandle = new RemoteSessionHandle(heavyClient, "heavy");
			await heavyHandle.whenReady();
			let received = 0;
			heavyHandle.subscribe(() => {
				received++;
			});

			const victimClient = harness.newClient();
			await victimClient.connect();
			await harness.createSession(victimClient, "victim");
			const victimHandle = new RemoteSessionHandle(victimClient, "victim");
			await victimHandle.whenReady();

			// 1000 × 32KB bounded events (~32MB) fanned out to the heavy
			// attachment while the victim runs 50 command round-trips.
			const emit = harness.emitters.get("heavy")!;
			const payload = "x".repeat(32 * 1024);
			const total = 1_000;
			let emitted = 0;
			const flood = (async () => {
				for (let burst = 0; burst < total / 50; burst++) {
					for (let i = 0; i < 50; i++) {
						emit({ type: "message_update", text: payload });
						emitted++;
					}
					// Yield so this loop models a chatty session, not a synchronous
					// monopoly of the loop (which no real runtime can produce either:
					// events originate from awaited I/O).
					await Bun.sleep(0);
				}
			})();

			const latencies = await probeLatencies(victimHandle, 50);
			await flood;
			assertBounded(latencies, "victim under event flood");
			expect(emitted).toBe(total);

			// The flood target itself must keep receiving events (no wedge).
			const deadline = Date.now() + 10_000;
			while (received < total && Date.now() < deadline) await Bun.sleep(10);
			expect(received).toBeGreaterThanOrEqual(total);

			await victimHandle.dispose();
			await heavyHandle.dispose();
		} finally {
			await harness.dispose();
		}
	}, 30_000);

	test("victim command latency stays bounded while another client churns attach/replay on a large event log", async () => {
		const harness = await startHarness();
		try {
			const heavyClient = harness.newClient();
			await heavyClient.connect();
			await harness.createSession(heavyClient, "log-heavy");
			// Build a retained event log while nobody is attached: these events
			// are replayed on every subsequent attach.
			const emit = harness.emitters.get("log-heavy")!;
			const payload = "y".repeat(16 * 1024);
			for (let i = 0; i < 400; i++) emit({ type: "message_update", text: payload, seqHint: i });

			const victimClient = harness.newClient();
			await victimClient.connect();
			await harness.createSession(victimClient, "victim");
			const victimHandle = new RemoteSessionHandle(victimClient, "victim");
			await victimHandle.whenReady();

			// Attach/replay churn: 15 sequential full replays (~6.4MB each).
			const churn = (async () => {
				for (let i = 0; i < 15; i++) {
					const churnHandle = new RemoteSessionHandle(heavyClient, "log-heavy", {
						attachmentId: `churn-${i}`,
					});
					await churnHandle.whenReady();
					await churnHandle.dispose();
				}
			})();

			const latencies = await probeLatencies(victimHandle, 50);
			await churn;
			assertBounded(latencies, "victim under replay churn");
			await victimHandle.dispose();
		} finally {
			await harness.dispose();
		}
	}, 30_000);

	test("server_status and session_list stay bounded with sixteen attached sessions", async () => {
		const harness = await startHarness();
		try {
			const client = harness.newClient();
			await client.connect();
			const handles: RemoteSessionHandle[] = [];
			for (let i = 0; i < 16; i++) {
				await harness.createSession(client, `s${i}`);
				const handle = new RemoteSessionHandle(client, `s${i}`, { attachmentId: `a${i}` });
				await handle.whenReady();
				handles.push(handle);
			}
			const latencies: number[] = [];
			for (let i = 0; i < 25; i++) {
				const started = performance.now();
				await client.request("server_status");
				await client.request("session_list");
				latencies.push(performance.now() - started);
			}
			assertBounded(latencies, "status+list with 16 sessions");
			for (const handle of handles) await handle.dispose();
		} finally {
			await harness.dispose();
		}
	}, 30_000);

	test("ten instances with ten agents and twenty subagents stream and command concurrently without freezing", async () => {
		// The scale contract: 10 client processes (instances), each hosting one
		// agent session plus two subagent sessions — 30 concurrently attached
		// streaming sessions on ONE daemon. Every session streams events AND
		// serves command round-trips at the same time. The whole run must
		// complete quickly; a wedged stream or starved command hangs the test
		// and trips the deadline instead of silently degrading.
		const INSTANCES = 10;
		const SUBAGENTS_PER_INSTANCE = 2;
		const EVENTS_PER_SESSION = 100;
		const PROMPTS_PER_SESSION = 10;
		const WALL_CLOCK_CEILING_MS = 25_000;
		const harness = await startHarness();
		try {
			const lanes: Array<{
				sessionId: string;
				handle: RemoteSessionHandle;
				received: () => number;
			}> = [];
			for (let instance = 0; instance < INSTANCES; instance++) {
				const client = harness.newClient();
				await client.connect();
				const sessionIds = [
					`agent-${instance}`,
					...Array.from({ length: SUBAGENTS_PER_INSTANCE }, (_, i) => `agent-${instance}-sub-${i}`),
				];
				for (const sessionId of sessionIds) {
					await harness.createSession(client, sessionId);
					const handle = new RemoteSessionHandle(client, sessionId, { attachmentId: `att-${sessionId}` });
					await handle.whenReady();
					let count = 0;
					handle.subscribe(() => {
						count++;
					});
					lanes.push({ sessionId, handle, received: () => count });
				}
			}
			expect(lanes).toHaveLength(INSTANCES * (1 + SUBAGENTS_PER_INSTANCE));

			const payload = "s".repeat(8 * 1024);
			const started = performance.now();
			const allLatencies: number[] = [];
			await Promise.all(
				lanes.flatMap(lane => {
					const emit = harness.emitters.get(lane.sessionId)!;
					const stream = (async () => {
						for (let i = 0; i < EVENTS_PER_SESSION; i++) {
							emit({ type: "message_update", text: payload, index: i });
							if (i % 20 === 19) await Bun.sleep(0);
						}
					})();
					const commands = (async () => {
						const latencies = await probeLatencies(lane.handle, PROMPTS_PER_SESSION);
						allLatencies.push(...latencies);
					})();
					return [stream, commands];
				}),
			);
			const commandWall = performance.now() - started;

			// Streaming must fully deliver on every lane — a frozen subscription
			// here is exactly the "attached but dead" incident shape.
			const deadline = Date.now() + 15_000;
			while (lanes.some(lane => lane.received() < EVENTS_PER_SESSION) && Date.now() < deadline) await Bun.sleep(10);
			for (const lane of lanes) {
				expect(lane.received(), `stream delivery for ${lane.sessionId}`).toBeGreaterThanOrEqual(EVENTS_PER_SESSION);
			}

			expect(allLatencies).toHaveLength(lanes.length * PROMPTS_PER_SESSION);
			assertBounded(allLatencies, "30 concurrent streaming sessions");
			const wallMs = performance.now() - started;
			expect(commandWall, `command phase took ${commandWall.toFixed(0)}ms`).toBeLessThan(WALL_CLOCK_CEILING_MS);
			expect(wallMs, `full run took ${wallMs.toFixed(0)}ms`).toBeLessThan(WALL_CLOCK_CEILING_MS + 15_000);

			for (const lane of lanes) await lane.handle.dispose();
		} finally {
			await harness.dispose();
		}
	}, 60_000);
});

// Request dispatch isolation: the daemon used to serialize EVERY protocol
// request from EVERY connection through one global promise chain, so one slow
// awaited task (a session_create doing network I/O during runtime init, a
// long-running command) stalled ping/attach/commands for EVERY instance —
// observed live as "all instances frozen behind the first session's first web
// request". Lifecycle ops now serialize per session id only; commands and
// reads run independently.
describe("daemon request dispatch isolation", () => {
	test("a slow session_create never stalls another session's requests", async () => {
		const slowGate = Promise.withResolvers<void>();
		const slowEntered = Promise.withResolvers<void>();
		const harness = await startHarness({
			beforeCreate: async sessionId => {
				if (sessionId === "slow") {
					slowEntered.resolve();
					await slowGate.promise;
				}
			},
		});
		try {
			const client = harness.newClient();
			await client.connect();
			// Kick off the slow create; its runtime factory is parked on the gate.
			const slowCreate = client.request("session_create", { sessionId: "slow", cwd: harness.root });
			slowCreate.catch(() => undefined);
			await slowEntered.promise;

			// Every other operation must complete while "slow" is still parked:
			// a second session's full lifecycle + command + server reads.
			const other = harness.newClient();
			await other.connect();
			await harness.createSession(other, "fast");
			const handle = new RemoteSessionHandle(other, "fast", { attachmentId: "fast-att" });
			await handle.whenReady();
			await handle.prompt("while-slow-pending");
			await other.request("server_status");
			await other.request("session_list");
			await handle.dispose();

			slowGate.resolve();
			await slowCreate;
		} finally {
			await harness.dispose();
		}
	}, 20_000);

	test("a slow session command never stalls another session's commands", async () => {
		const gate = Promise.withResolvers<void>();
		let gated = true;
		const harness = await startHarness({
			beforeCommand: async sessionId => {
				if (sessionId === "busy" && gated) await gate.promise;
			},
		});
		try {
			const client = harness.newClient();
			await client.connect();
			await harness.createSession(client, "busy");
			await harness.createSession(client, "free");
			const busy = new RemoteSessionHandle(client, "busy", { attachmentId: "busy-att" });
			const free = new RemoteSessionHandle(client, "free", { attachmentId: "free-att" });
			await busy.whenReady();
			await free.whenReady();

			const parked = busy.prompt("long-running");
			parked.catch(() => undefined);
			await Bun.sleep(10);
			// The other session's command and server reads proceed immediately.
			await free.prompt("independent");
			await client.request("server_status");

			gated = false;
			gate.resolve();
			await parked;
			await busy.dispose();
			await free.dispose();
		} finally {
			await harness.dispose();
		}
	}, 20_000);

	test("concurrent id-less creates run their runtime factories concurrently", async () => {
		let started = 0;
		const gate = Promise.withResolvers<void>();
		const harness = await startHarness({
			beforeCreate: async sessionId => {
				if (sessionId === undefined) {
					started++;
					await gate.promise;
				}
			},
		});
		try {
			const client = harness.newClient();
			await client.connect();
			const first = client.request("session_create", { cwd: harness.root });
			const second = client.request("session_create", { cwd: harness.root });
			first.catch(() => undefined);
			second.catch(() => undefined);
			// BOTH factories must be in flight before either resolves — a
			// global (or shared-key) queue would hold the second at 1.
			const deadline = Date.now() + 5_000;
			while (started < 2 && Date.now() < deadline) await Bun.sleep(5);
			expect(started).toBe(2);
			gate.resolve();
			await Promise.all([first, second]);
		} finally {
			await harness.dispose();
		}
	}, 20_000);

	test("a racing duplicate named create is rejected without building a second runtime", async () => {
		const gate = Promise.withResolvers<void>();
		let factoryRuns = 0;
		const harness = await startHarness({
			beforeCreate: async sessionId => {
				if (sessionId === "dup") {
					factoryRuns++;
					await gate.promise;
				}
			},
		});
		try {
			const client = harness.newClient();
			await client.connect();
			const winner = client.request("session_create", { sessionId: "dup", cwd: harness.root });
			const loser = client.request("session_create", { sessionId: "dup", cwd: harness.root });
			winner.catch(() => undefined);
			await Bun.sleep(10);
			gate.resolve();
			await winner;
			// Same-id creates serialize: the second sees the installed session
			// and fails session_busy WITHOUT running the factory again.
			await expect(loser).rejects.toThrow(/session_busy/);
			expect(factoryRuns).toBe(1);
		} finally {
			await harness.dispose();
		}
	}, 20_000);

	test("a command queued behind a close never reaches the disposed runtime", async () => {
		const gate = Promise.withResolvers<void>();
		const parkedEntered = Promise.withResolvers<void>();
		let gated = true;
		const harness = await startHarness({
			beforeCommand: async sessionId => {
				if (sessionId === "closing" && gated) {
					parkedEntered.resolve();
					await gate.promise;
				}
			},
		});
		try {
			const client = harness.newClient();
			await client.connect();
			await harness.createSession(client, "closing");
			const handle = new RemoteSessionHandle(client, "closing", { attachmentId: "c-att" });
			await handle.whenReady();
			// Park one command on the record queue, then queue a close and a
			// second command behind it.
			const parked = handle.prompt("parked");
			parked.catch(() => undefined);
			await parkedEntered.promise;
			const closing = client.request("session_close", { sessionId: "closing" });
			closing.catch(() => undefined);
			// Let the keyed close op enqueue #closeRecord on the record queue
			// (one macrotask flushes its microtask hop) before the late command.
			await Bun.sleep(0);
			await Bun.sleep(0);
			const late = handle.prompt("after-close");
			late.catch(() => undefined);
			await Bun.sleep(0);
			gated = false;
			gate.resolve();
			await parked;
			await closing;
			// The late command must fail cleanly — never run against the
			// disposed runtime.
			await expect(late).rejects.toThrow(/not_found|closed|disconnected|detached/);
		} finally {
			await harness.dispose();
		}
	}, 20_000);
});
