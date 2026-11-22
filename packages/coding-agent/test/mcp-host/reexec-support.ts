/**
 * Forces the daemon of the current runtime dir to re-exec itself in place.
 *
 * The daemon re-execs when a client's hello presents a build newer than its
 * own. `DaemonClient` always sends this process's build, so the upgrade speaks
 * the wire protocol directly (hello line, then `{ id, op: "upgrade" }`) with a
 * newer build string and this checkout's entry as `exe`, which is exactly what
 * a newer install's client sends.
 */
import * as fs from "node:fs/promises";
import { daemonEndpoint, daemonTokenPath } from "@oh-my-pi/pi-coding-agent/daemon/paths";
import { DAEMON_PROTOCOL_VERSION, type DaemonHello } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { resolveCliEntryCmd } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import { IpcConnection } from "@oh-my-pi/pi-natives";

/** Newer than any build this checkout can report. */
const NEWER_BUILD = "999.0.0+1";
const UPGRADE_TIMEOUT_MS = 20_000;

interface UpgradeResponse {
	id?: string;
	ok?: boolean;
	result?: { reexec: boolean };
	error?: string;
}

/**
 * Ask the running daemon to upgrade to a newer build.
 *
 * @returns whether the daemon re-exec'd; when it did, the old image has
 * already dropped this connection, so every other client lost its own too.
 * @throws when the daemon refuses the hello or the upgrade, or neither
 * answers nor hangs up within the deadline.
 */
export async function forceDaemonReexec(): Promise<boolean> {
	const token = (await fs.readFile(daemonTokenPath(), "utf8")).trim();
	const conn = await IpcConnection.connect(daemonEndpoint(), { framing: "lines", timeoutMs: 2_000 });
	const id = crypto.randomUUID();
	const answered = Promise.withResolvers<boolean>();
	const closed = Promise.withResolvers<void>();
	let welcomed = false;
	conn.start(
		line => {
			const message = JSON.parse(line) as UpgradeResponse;
			if (!welcomed) {
				welcomed = true;
				if (message.error !== undefined) {
					answered.reject(new Error(message.error));
					return;
				}
				conn.send(JSON.stringify({ id, op: "upgrade" }));
				return;
			}
			if (message.id !== id) return;
			if (message.ok && message.result) answered.resolve(message.result.reexec);
			else answered.reject(new Error(message.error ?? "upgrade refused"));
		},
		() => {
			answered.reject(new Error("daemon hung up before answering the upgrade"));
			closed.resolve();
		},
	);
	const hello: DaemonHello = {
		v: DAEMON_PROTOCOL_VERSION,
		token,
		client: { pid: process.pid, build: NEWER_BUILD, exe: resolveCliEntryCmd() },
	};
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => deadline.reject(new Error(`daemon upgrade not settled after ${UPGRADE_TIMEOUT_MS}ms`)),
		UPGRADE_TIMEOUT_MS,
	);
	// The losing promises of the races below reject unobserved.
	answered.promise.catch(() => {});
	deadline.promise.catch(() => {});
	try {
		conn.send(JSON.stringify(hello));
		const reexec = await Promise.race([answered.promise, deadline.promise]);
		if (reexec) await Promise.race([closed.promise, deadline.promise]);
		return reexec;
	} finally {
		clearTimeout(timer);
		conn.destroy();
	}
}
