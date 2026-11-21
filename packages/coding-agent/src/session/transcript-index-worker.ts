/**
 * Transcript index worker thread: runs {@link syncTranscriptIndex} off its
 * host's event loop. Spawned by {@link TranscriptIndexer} through the CLI
 * host's `__omp_worker_transcript_index` selector, or loaded directly outside
 * a CLI host.
 */
import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { syncTranscriptIndex, type TranscriptSyncResult } from "./transcript-index";

/** The store a sync updates and the sessions it reads; explicit, since a daemon-hosted worker serves every profile. */
export interface TranscriptSyncTarget {
	dbPath: string;
	sessionsRoot: string;
}

export type TranscriptIndexWorkerInbound =
	| { type: "ping" }
	| { type: "sync"; id: number; target: TranscriptSyncTarget };

export type TranscriptIndexWorkerOutbound =
	| { type: "pong" }
	| { type: "synced"; id: number; result: TranscriptSyncResult }
	| { type: "error"; id: number; error: string };

if (!parentPort) throw new Error("transcript index worker: missing parentPort");

const port = parentPort;

function send(message: TranscriptIndexWorkerOutbound): void {
	port.postMessage(message);
}

function handle(data: unknown): void {
	const message = data as TranscriptIndexWorkerInbound;
	switch (message.type) {
		case "ping":
			send({ type: "pong" });
			return;
		case "sync":
			syncTranscriptIndex(message.target).then(
				result => send({ type: "synced", id: message.id, result }),
				error =>
					send({ type: "error", id: message.id, error: error instanceof Error ? error.message : String(error) }),
			);
			return;
	}
}

const inbox = consumeWorkerInbox();
if (inbox) inbox.bind(handle);
else port.on("message", handle);
