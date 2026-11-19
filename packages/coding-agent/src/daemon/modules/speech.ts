/**
 * Daemon `speech` module: one warm STT or TTS worker process per
 * `stt:<device>:<dtype>` / `tts:<device>:<dtype>` key, shared by every omp
 * session. The worker speaks the frame protocol of `speech-frames.ts` on
 * stdin/stdout; this module multiplexes client tunnels onto it by namespacing
 * request and stream ids per tunnel, routes replies and audio back to the
 * originating tunnel, and cancels a tunnel's streams when it closes.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { DaemonModule, ManagedChild, ModuleTunnel, ModuleUnit } from "../module";
import type { UnitPolicy } from "../protocol";
import {
	encodeFrame,
	FrameDecoder,
	FrameWriter,
	SPEECH_MODULE_KIND,
	type SpeechFrame,
	type SpeechUnitParams,
} from "./speech-frames";

const SPEECH_POLICY: UnitPolicy = {
	hold: "leases",
	idleMs: 15 * 60_000,
	onIdle: "stop",
	restart: "no",
	survive: "none",
};

/** Client messages that open a correlated request. */
const REQUEST_TYPES: Record<string, true> = { ping: true, transcribe: true, download: true, synthesize: true };
/** Client messages that open a streaming session. */
const STREAM_START_TYPES: Record<string, true> = { stream_start: true, "stream-start": true };
/** Client messages that tear a session down; the worker answers nothing afterwards. */
const STREAM_CANCEL_TYPES: Record<string, true> = { stream_cancel: true, "stream-cancel": true };
/** Worker messages that settle a request or session. */
const TERMINAL_TYPES: Record<string, true> = {
	transcription: true,
	downloaded: true,
	error: true,
	pong: true,
	stream_done: true,
	audio: true,
	"stream-done": true,
};

const MAX_STDERR_LINE = 64 * 1024;

interface TunnelState {
	seq: number;
	tunnel: ModuleTunnel;
	writer: FrameWriter;
	/** Worker-side ids of this tunnel's open requests and sessions. */
	ids: Set<string>;
}

interface Route {
	tunnel: TunnelState;
	clientId: string;
	stream: boolean;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	for (const key in record) if (typeof record[key] !== "string") return false;
	return true;
}

function parseParams(params: unknown): SpeechUnitParams {
	const value = params as Partial<SpeechUnitParams> | undefined;
	if (
		!value ||
		!Array.isArray(value.command) ||
		value.command.length === 0 ||
		!value.command.every(part => typeof part === "string") ||
		typeof value.cwd !== "string" ||
		!isStringRecord(value.env)
	) {
		throw new Error("speech: open requires { command, cwd, env } params");
	}
	return value as SpeechUnitParams;
}

class SpeechUnit implements ModuleUnit {
	readonly label: string;
	readonly ready = Promise.resolve();
	readonly exited: Promise<{ exitCode?: number; reason?: string }>;
	#key: string;
	#child: ManagedChild;
	#childWriter: FrameWriter;
	#cancelType: string;
	#routes = new Map<string, Route>();
	#tunnels = new Set<TunnelState>();
	#nextTunnel = 0;
	#stopReason: string | undefined;
	#gone = false;

	constructor(child: ManagedChild, key: string) {
		this.#key = key;
		this.#child = child;
		this.label = `speech ${key}`;
		this.#cancelType = key.startsWith("tts:") ? "stream-cancel" : "stream_cancel";
		this.#childWriter = new FrameWriter({ send: data => child.write(data), drained: () => child.drained() });

		const decoder = new FrameDecoder();
		child.onStdout(chunk => {
			try {
				decoder.push(chunk, frame => this.#fromWorker(frame));
			} catch (error) {
				logger.error("speech: malformed worker output; stopping worker", {
					key,
					error: error instanceof Error ? error.message : String(error),
				});
				void this.stop("malformed worker output");
			}
		});
		let stderrTail = "";
		const stderrDecoder = new TextDecoder();
		child.onStderr(chunk => {
			stderrTail += stderrDecoder.decode(chunk, { stream: true });
			let newline = stderrTail.indexOf("\n");
			while (newline !== -1) {
				this.#logLine(stderrTail.slice(0, newline));
				stderrTail = stderrTail.slice(newline + 1);
				newline = stderrTail.indexOf("\n");
			}
			if (stderrTail.length > MAX_STDERR_LINE) {
				this.#logLine(stderrTail);
				stderrTail = "";
			}
		});

		this.exited = child.exited.then(exit => {
			this.#gone = true;
			this.#childWriter.close();
			this.#routes.clear();
			// Closing the tunnels is the failure signal: clients fail every request and stream on it.
			for (const state of Array.from(this.#tunnels)) state.tunnel.close();
			this.#tunnels.clear();
			const reason =
				this.#stopReason ??
				(exit.signal !== undefined ? `worker killed by signal ${exit.signal}` : `worker exited ${exit.exitCode}`);
			return { exitCode: exit.exitCode, reason };
		});
	}

	pids(): number[] {
		return [this.#child.pid];
	}

	busy(): boolean {
		return this.#routes.size > 0;
	}

	attach(tunnel: ModuleTunnel): void {
		if (this.#gone) {
			tunnel.close();
			return;
		}
		const state: TunnelState = { seq: ++this.#nextTunnel, tunnel, writer: new FrameWriter(tunnel), ids: new Set() };
		this.#tunnels.add(state);
		const decoder = new FrameDecoder();
		tunnel.start(
			chunk => {
				try {
					decoder.push(chunk, frame => this.#fromClient(state, frame));
				} catch (error) {
					logger.warn("speech: malformed client frame; closing tunnel", {
						key: this.#key,
						error: error instanceof Error ? error.message : String(error),
					});
					tunnel.close();
				}
			},
			() => this.#tunnelClosed(state),
		);
	}

	async stop(reason: string): Promise<void> {
		this.#stopReason ??= reason;
		this.#child.kill("SIGKILL");
		await this.exited;
	}

	#fromClient(state: TunnelState, frame: SpeechFrame): void {
		const { type, id } = frame.header;
		if (typeof type !== "string" || typeof id !== "string" || this.#gone) return;
		const workerId = `${state.seq}:${id}`;
		if (STREAM_CANCEL_TYPES[type] === true) {
			if (!this.#dropRoute(workerId)) return;
		} else if (REQUEST_TYPES[type] === true || STREAM_START_TYPES[type] === true) {
			this.#routes.set(workerId, { tunnel: state, clientId: id, stream: STREAM_START_TYPES[type] === true });
			state.ids.add(workerId);
		} else if (!this.#routes.has(workerId)) {
			// Audio/push/stop for a session that already ended.
			return;
		}
		this.#childWriter.write(encodeFrame({ ...frame.header, id: workerId }, frame.payload));
	}

	#fromWorker(frame: SpeechFrame): void {
		const { type, id } = frame.header;
		if (typeof id !== "string") return;
		const route = this.#routes.get(id);
		if (!route) return;
		if (typeof type === "string" && TERMINAL_TYPES[type] === true) this.#dropRoute(id);
		route.tunnel.writer.write(encodeFrame({ ...frame.header, id: route.clientId }, frame.payload));
	}

	#dropRoute(workerId: string): boolean {
		const route = this.#routes.get(workerId);
		if (!route) return false;
		this.#routes.delete(workerId);
		route.tunnel.ids.delete(workerId);
		return true;
	}

	/**
	 * Cancel the tunnel's streams and forget its requests: nobody reads their
	 * answers, and a request the worker never answers must not keep the unit
	 * busy forever. The worker's late replies find no route and are dropped.
	 */
	#tunnelClosed(state: TunnelState): void {
		this.#tunnels.delete(state);
		state.writer.close();
		for (const workerId of state.ids) {
			const route = this.#routes.get(workerId);
			if (!route) continue;
			this.#routes.delete(workerId);
			if (route.stream && !this.#gone) {
				this.#childWriter.write(encodeFrame({ type: this.#cancelType, id: workerId }));
			}
		}
		state.ids.clear();
	}

	#logLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		if (trimmed.startsWith("{")) {
			try {
				const log = JSON.parse(trimmed) as { type?: unknown; level?: unknown; msg?: unknown; meta?: unknown };
				if (log.type === "log" && typeof log.msg === "string") {
					const meta = { key: this.#key, ...(log.meta as Record<string, unknown> | undefined) };
					if (log.level === "error") logger.error(log.msg, meta);
					else if (log.level === "warn") logger.warn(log.msg, meta);
					else logger.debug(log.msg, meta);
					return;
				}
			} catch {
				// Not a structured log line.
			}
		}
		logger.debug("speech: worker stderr", { key: this.#key, line: trimmed });
	}
}

/** Warm STT/TTS workers shared across sessions. */
export const speechModule: DaemonModule = {
	kind: SPEECH_MODULE_KIND,
	version: 1,
	policy: () => ({ ...SPEECH_POLICY }),
	open(context, request) {
		const params = parseParams(request.params);
		const [application, ...args] = params.command;
		const child = context.spawn({ application: application!, args, env: params.env, cwd: params.cwd });
		return new SpeechUnit(child, request.key);
	},
};
