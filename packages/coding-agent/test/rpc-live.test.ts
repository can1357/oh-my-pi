import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LiveSessionCallbacks, LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import { RpcLiveBridge, type RpcLiveSession } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import type { RpcLiveFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

class FakeLiveSession implements RpcLiveSession {
	muted = false;
	stopCalls = 0;
	readonly started = Promise.withResolvers<void>();
	#stopped: Promise<void> | undefined;
	constructor(readonly options: LiveSessionControllerOptions) {}

	get callbacks(): LiveSessionCallbacks {
		return this.options.callbacks;
	}

	start(): Promise<void> {
		this.callbacks.onPhase("connecting");
		return this.started.promise;
	}

	toggleMute(): void {
		this.muted = !this.muted;
	}

	stop(): Promise<void> {
		this.stopCalls += 1;
		this.#stopped ??= Promise.resolve().then(() => this.callbacks.onTerminal());
		return this.#stopped;
	}
}

function harness(levelsIntervalMs = 40) {
	const frames: RpcLiveFrame[] = [];
	const sessions: FakeLiveSession[] = [];
	const agentSession = { settings: Settings.isolated({ "live.voice": "sol" }) } as unknown as AgentSession;
	const bridge = new RpcLiveBridge(
		agentSession,
		frame => frames.push(frame),
		options => {
			const fake = new FakeLiveSession(options);
			sessions.push(fake);
			return fake;
		},
		levelsIntervalMs,
	);
	return { bridge, frames, sessions };
}

async function startedBridge(levelsIntervalMs?: number) {
	const h = harness(levelsIntervalMs);
	const starting = h.bridge.start();
	h.sessions[0]!.started.resolve();
	await starting;
	return { ...h, live: h.sessions[0]! };
}

describe("RpcLiveBridge", () => {
	test("start forwards options and callbacks as live frames; end is emitted once", async () => {
		const { bridge, frames, sessions } = harness();
		const starting = bridge.start({ voice: " cove ", instructions: "Hi {{firstName}}" });
		const live = sessions[0]!;
		expect(live.options.voice).toBe("cove");
		expect(live.options.instructions).toBe("Hi {{firstName}}");
		live.started.resolve();
		expect(await starting).toEqual({ voice: "cove" });

		live.callbacks.onTranscript(undefined);
		live.callbacks.onTranscript({ role: "assistant", turn: 2, text: "Sure", final: false });
		live.callbacks.onPhase("speaking");
		live.callbacks.onTerminal(new Error("socket closed"));
		live.callbacks.onTerminal();
		await bridge.stop();
		expect(frames).toEqual([
			{ type: "live_phase", phase: "connecting" },
			{ type: "live_transcript", role: "assistant", turn: 2, text: "Sure", final: false },
			{ type: "live_phase", phase: "speaking" },
			{ type: "live_end", error: "socket closed" },
		]);
		expect(bridge.active).toBe(false);
	});

	test("voice defaults to the live.voice setting", async () => {
		const { bridge, sessions } = harness();
		const starting = bridge.start();
		sessions[0]!.started.resolve();
		expect(await starting).toEqual({ voice: "sol" });
		expect(sessions[0]!.options.instructions).toBeUndefined();
	});

	test("a second start fails while connecting, active, or closing", async () => {
		const { bridge, sessions } = harness();
		const first = bridge.start();
		await expect(bridge.start()).rejects.toThrow("already active");
		sessions[0]!.started.resolve();
		await first;
		await expect(bridge.start()).rejects.toThrow("already active");
		const stopping = bridge.stop();
		await expect(bridge.start()).rejects.toThrow("already active");
		await stopping;
		const again = bridge.start();
		sessions[1]!.started.resolve();
		await again;
		expect(sessions).toHaveLength(2);
	});

	test("a failed start rejects and releases the slot", async () => {
		const { bridge, frames, sessions } = harness();
		const starting = bridge.start();
		sessions[0]!.started.reject(new Error("no auth"));
		await expect(starting).rejects.toThrow("no auth");
		expect(bridge.active).toBe(false);
		expect(frames.at(-1)).toEqual({ type: "live_end" });
	});

	test("mute sets or toggles and fails without a session", async () => {
		const { bridge, live } = await startedBridge();
		expect(bridge.setMuted()).toEqual({ muted: true });
		expect(bridge.setMuted(true)).toEqual({ muted: true });
		expect(bridge.setMuted()).toEqual({ muted: false });
		expect(bridge.setMuted(false)).toEqual({ muted: false });
		expect(live.muted).toBe(false);
		await bridge.stop();
		expect(() => bridge.setMuted(true)).toThrow("No live session is active");
		expect(() => harness().bridge.setMuted()).toThrow("No live session is active");
	});

	test("stop without a session is a no-op", async () => {
		const { bridge, frames } = harness();
		await bridge.stop();
		expect(frames).toEqual([]);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("levels are throttled: bursts coalesce and the latest value is delivered", async () => {
		vi.useFakeTimers();
		const { bridge, frames, live } = await startedBridge(40);
		const levels = () => frames.filter(frame => frame.type === "live_levels");
		live.callbacks.onLevels(0.1, 0);
		live.callbacks.onLevels(0.2, 0.1);
		live.callbacks.onLevels(0.3, 0.2);
		expect(levels()).toEqual([{ type: "live_levels", input: 0.1, output: 0 }]);
		vi.advanceTimersByTime(39);
		expect(levels()).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(levels()).toEqual([
			{ type: "live_levels", input: 0.1, output: 0 },
			{ type: "live_levels", input: 0.3, output: 0.2 },
		]);
		live.callbacks.onLevels(0.5, 0.5);
		await bridge.stop();
		// A pending value is flushed before live_end and nothing follows it.
		expect(frames.slice(-2)).toEqual([{ type: "live_levels", input: 0.5, output: 0.5 }, { type: "live_end" }]);
		live.callbacks.onLevels(0.9, 0.9);
		vi.advanceTimersByTime(100);
		expect(frames.at(-1)).toEqual({ type: "live_end" });
	});
});

describe("live commands over RPC", () => {
	test("start/mute/stop wire shapes; frames bypass set_event_filter; stdin end stops the session", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-live-"));
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "live-rpc-agent.ts")], {
			cwd: dir,
			env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_NO_TITLE: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = new Response(child.stderr).text();
		const lines = readLines(child.stdout, AbortSignal.timeout(30_000));
		const decoder = new TextDecoder();
		const seen: Record<string, unknown>[] = [];
		const receive = async (): Promise<Record<string, unknown> | undefined> => {
			const line = await lines.next();
			if (line.done) return undefined;
			const frame = JSON.parse(decoder.decode(line.value)) as Record<string, unknown>;
			seen.push(frame);
			return frame;
		};
		let id = 0;
		const command = async (fields: object): Promise<Record<string, unknown>> => {
			const requestId = String(++id);
			child.stdin.write(`${JSON.stringify({ ...fields, id: requestId })}\n`);
			await child.stdin.flush();
			for (;;) {
				const frame = await receive();
				if (!frame) throw new Error(await stderr);
				if (frame.type === "response" && frame.id === requestId) return frame;
			}
		};
		try {
			while ((await receive())?.type !== "ready") {}
			expect(await command({ type: "set_event_filter", events: ["agent_end"] })).toMatchObject({ success: true });
			expect(await command({ type: "live_mute" })).toMatchObject({
				type: "response",
				command: "live_mute",
				success: false,
				error: "No live session is active",
			});
			expect(await command({ type: "live_stop" })).toEqual({
				id: "3",
				type: "response",
				command: "live_stop",
				success: true,
			});
			expect(await command({ type: "live_start", instructions: "Hey {{firstName}}" })).toEqual({
				id: "4",
				type: "response",
				command: "live_start",
				success: true,
				data: { voice: "sol" },
			});
			expect(seen.filter(frame => String(frame.type).startsWith("live_"))).toEqual([
				{ type: "live_phase", phase: "connecting" },
				{ type: "live_transcript", role: "user", turn: 1, text: "hello", final: true },
				{ type: "live_phase", phase: "listening" },
			]);
			expect(await command({ type: "live_start" })).toMatchObject({
				command: "live_start",
				success: false,
				error: "A live session is already active",
			});
			expect(await command({ type: "live_mute" })).toMatchObject({ success: true, data: { muted: true } });
			expect(await command({ type: "live_mute", muted: false })).toMatchObject({ data: { muted: false } });

			await child.stdin.end();
			while (await receive()) {}
			expect(await child.exited).toBe(0);
			expect(seen.at(-1)).toEqual({ type: "live_end" });
			expect(await Bun.file(path.join(dir, "live-stopped.json")).json()).toEqual({
				voice: "sol",
				instructions: "Hey {{firstName}}",
			});
		} finally {
			child.kill();
			await child.exited;
			await stderr;
			await removeWithRetries(dir);
		}
	}, 60_000);
});
