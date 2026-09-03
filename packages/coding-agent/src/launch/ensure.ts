/**
 * Quiet daemon-broker ensure helpers shared by broker-owned singleton daemons
 * (shared Chromium, browser relay, LSP mux). Each treats broker/daemon errors
 * as "absent" so ensure loops can retry or adopt a cross-process race winner
 * instead of failing the caller.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { throwIfAborted } from "../tools/tool-errors";
import type { DaemonBrokerClient } from "./client";
import type { DaemonSnapshot } from "./protocol";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

/** Snapshot a broker daemon, treating "unknown daemon" and broker errors as absent. */
export async function describeQuietly(
	client: DaemonBrokerClient,
	name: string,
	label: string,
	signal?: AbortSignal,
): Promise<DaemonSnapshot | undefined> {
	try {
		const result = await client.request({ op: "describe", name }, signal);
		return result.op === "describe" ? result.daemon : undefined;
	} catch (error) {
		throwIfAborted(signal);
		logger.debug(`${label} describe failed`, {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/** Block until the daemon reports ready; undefined on timeout or pre-ready exit. */
export async function waitReady(
	client: DaemonBrokerClient,
	name: string,
	label: string,
	signal?: AbortSignal,
	timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
): Promise<DaemonSnapshot | undefined> {
	try {
		const result = await client.request({ op: "wait", name, for: "ready", timeoutMs }, signal);
		if (result.op !== "wait" || result.timedOut) return undefined;
		return result.daemon;
	} catch (error) {
		throwIfAborted(signal);
		logger.debug(`${label} ready wait failed`, {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/** Best-effort stop before replacing a wedged or endpoint-less daemon. */
export async function stopQuietly(
	client: DaemonBrokerClient,
	name: string,
	label: string,
	signal?: AbortSignal,
): Promise<void> {
	try {
		await client.request({ op: "stop", name, timeoutMs: STOP_TIMEOUT_MS }, signal);
	} catch (error) {
		throwIfAborted(signal);
		logger.debug(`${label} stop failed`, {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
