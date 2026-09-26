/**
 * Cross-process contract for the machine-global text-prediction daemon.
 *
 * One daemon per agent directory runs under the `text-predict` global daemon
 * broker (`omp ps --global text-predict`) and serves ghost-text word
 * completion to every omp process over newline-delimited JSON on a Unix socket
 * (a named pipe on Windows). Each request carries a numeric `id` echoed by its
 * response; responses may arrive out of order.
 */
import * as path from "node:path";
import type { PredictedWord } from "@oh-my-pi/pi-natives";
export { TEXT_PREDICT_WORKER_ARG } from "../cli/worker-selectors";

/** Global broker scope owning the daemon. */
export const TEXT_PREDICT_BROKER_SCOPE = "text-predict";

/** Environment key carrying the endpoint the daemon listens on. */
export const TEXT_PREDICT_SOCKET_ENV = "OMP_TEXT_PREDICT_SOCKET";

/** Environment key carrying the agent directory whose history and state the daemon serves. */
export const TEXT_PREDICT_AGENT_DIR_ENV = "OMP_TEXT_PREDICT_AGENT_DIR";

/** Broker readiness regex matched against {@link textPredictReadyBanner}. */
export const TEXT_PREDICT_READY_PATTERN = String.raw`omp text-predict listening on \S+`;

/** Engines the daemon can open (`TextPredictor` methods). */
export type TextPredictMethod = "ngram" | "smollm" | "apple";

/**
 * What a request asks for: one engine, or `auto`, which the daemon serves with
 * SmolLM once it has loaded and with ngram before that (weights still
 * downloading) or when SmolLM cannot load.
 */
export type TextPredictTarget = TextPredictMethod | "auto";

/** Banner printed on stdout once the daemon accepts connections. */
export function textPredictReadyBanner(endpoint: string): string {
	return `omp text-predict listening on ${endpoint}`;
}

/**
 * Daemon identity for one agent directory: the broker daemon name and its
 * endpoint inside the broker runtime dir. Different agent directories (profiles,
 * tests) get separate daemons because history and learned state are per agent dir.
 */
export function textPredictDaemon(runtimeDir: string, agentDir: string): { name: string; endpoint: string } {
	const key = Bun.hash.wyhash(path.resolve(agentDir)).toString(16).padStart(16, "0").slice(0, 12);
	const endpoint =
		process.platform === "win32"
			? `\\\\.\\pipe\\omp-text-predict-${Bun.hash.wyhash(runtimeDir).toString(16)}-${key}`
			: path.join(runtimeDir, `text-predict-${key}.sock`);
	return { name: `omp.text-predict.${key}`, endpoint };
}

/** Client → daemon request. */
export type TextPredictRequest =
	| { id: number; op: "ping" }
	| { id: number; op: "complete"; method: TextPredictTarget; before: string; prefix: string }
	| {
			id: number;
			op: "feedback";
			method: TextPredictTarget;
			before: string;
			prefix: string;
			suggestion: string;
			accepted: boolean;
	  }
	/** Ingest history rows newer than each open engine's cursor. */
	| { id: number; op: "sync" }
	/** Persist and exit (a client found a daemon from another omp version). */
	| { id: number; op: "shutdown" };

/** Daemon → client response. */
export type TextPredictResponse =
	| { id: number; ok: true; op: "ping"; version: string; pid: number; engines: TextPredictMethod[] }
	/** `engine` is the engine that answered (what `auto` resolved to). */
	| { id: number; ok: true; op: "complete"; engine: TextPredictMethod; suggestion: PredictedWord | null }
	| { id: number; ok: true; op: "feedback" | "shutdown" }
	| { id: number; ok: true; op: "sync"; ingested: number }
	| { id: number; ok: false; error: string };
