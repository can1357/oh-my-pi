import { parentPort } from "node:worker_threads";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import {
	createSentinelJudge,
	createSentinelViews,
	type LoopSentinelMessage,
	type LoopSentinelPong,
	readHeartbeat,
	readPhase,
} from "./loop-sentinel-protocol";

/**
 * Loop-sentinel worker entry (issue #5372). Runs on its own event loop, so it
 * keeps observing while the main thread is synchronously wedged. Each poll it
 * samples the shared heartbeat/phase and feeds the pure judge; actions become
 * log lines written from *this* thread — the wedged main thread never has to
 * yield for the wedge to become visible:
 *
 * - `ui.loop-wedged` on the rising edge and again at each doubling, with the
 *   mirrored loop phase and how long ago that phase was entered;
 * - `ui.loop-wedged-recovered` once the heartbeat resumes;
 * - `ui.loop-wedged-kill` followed by SIGKILL when the opt-in ceiling is armed.
 *   SIGKILL from a worker is the only reliable break: a wedged main loop never
 *   runs JS signal handlers, so SIGTERM is ignored (exactly what the issue
 *   reported), and the kill must bypass JS entirely. The kill is delayed one
 *   beat so the log sink can flush the line that explains the corpse.
 *
 * The logger appends to the same per-PID file as the main thread; during a
 * wedge the main thread is not writing, so contention is moot in exactly the
 * scenario this worker exists for.
 */

if (!parentPort) throw new Error("loop-sentinel-worker: missing parentPort");

const port = parentPort;
const inbox = consumeWorkerInbox();
let started = false;

const cpuNowMs = (): number => {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
};

const KILL_FLUSH_DELAY_MS = 250;

const handle = (message: unknown): void => {
	const request = message as LoopSentinelMessage;
	if (request.type === "ping") {
		const pong: LoopSentinelPong = { ok: true };
		port.postMessage(pong);
		return;
	}
	if (request.type !== "init" || started) return;
	started = true;
	const views = createSentinelViews(request.buffer);
	const judge = createSentinelJudge({ thresholdMs: request.thresholdMs, killAfterMs: request.killAfterMs });
	setInterval(() => {
		const phaseRead = readPhase(views);
		const action = judge.observe({
			nowMs: Date.now(),
			heartbeatMs: readHeartbeat(views),
			cpuMs: cpuNowMs(),
			phase: phaseRead?.phase,
			phaseAtMs: phaseRead?.phaseAtMs,
		});
		if (!action) return;
		if (action.kind === "report") {
			logger.warn("ui.loop-wedged", {
				blockedMs: action.blockedMs,
				cpuMs: action.cpuMs,
				phase: action.phase,
				...(action.phaseAgeMs !== undefined ? { phaseAgeMs: action.phaseAgeMs } : {}),
			});
		} else if (action.kind === "recovered") {
			logger.warn("ui.loop-wedged-recovered", { blockedMs: action.blockedMs });
		} else {
			logger.error("ui.loop-wedged-kill", {
				blockedMs: action.blockedMs,
				cpuMs: action.cpuMs,
				phase: action.phase,
				killAfterMs: request.killAfterMs,
			});
			setTimeout(() => process.kill(process.pid, "SIGKILL"), KILL_FLUSH_DELAY_MS);
		}
	}, request.checkIntervalMs);
};

if (inbox) inbox.bind(message => handle(message));
else port.on("message", message => handle(message));
