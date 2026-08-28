import { invoke } from "@tauri-apps/api/core";
import type { RpcBridge } from "./bridge";

/** How long a throwaway process gets to boot, switch session and answer. */
const ONESHOT_TIMEOUT_MS = 60_000;

/**
 * Who may speak for a session right now.
 *
 * Three states, because two of them used to be one. A missing bridge meant both
 * "nothing is running, the throwaway below is safe" and "something is running and
 * this webview cannot reach it", and every caller read it as the first — which is
 * how a rename from Settings put a second agent on a live jsonl. The dangerous
 * state is now spelled out, and it has no value that can be mistaken for the safe
 * one.
 */
export type SessionProcess =
	/** Nothing has this session open. */
	| { kind: "none" }
	/** A mounted view holds the handle; its process does the work. */
	| { kind: "mounted"; bridge: RpcBridge }
	/** A sidecar owns the session and nothing in this webview can talk to it. */
	| { kind: "detached" };

/**
 * Why a detached session refuses — in the menu's `disabled` and in the banner.
 * One string, so the greyed entry and the failure cannot disagree.
 */
export const SESSION_DETACHED = "Open this session first — its process has the file open";

/**
 * Run one command against a session that nobody has open.
 *
 * Two rules, and both were paid for.
 *
 * **Never against a live session.** A second process on a session another
 * sidecar has open means two agents appending to one jsonl — measured once with
 * `lsof`, two `bun` processes on the same inode, both `w`. Callers resolve the
 * open tab first (`findOpenTab`) and use its bridge; this path is only for a
 * session with no process.
 *
 * **Never through the pool.** The pool is three live sidecars with LRU
 * eviction, so borrowing a slot to rename something could evict a session that
 * is mid-turn and cost it the turn. A child that is never registered evicts
 * nothing; it answers and dies.
 */
export async function oneshot<T>(cwd: string, sessionPath: string, command: Record<string, unknown>): Promise<T> {
	const switchId = `oneshot-switch-${crypto.randomUUID()}`;
	const runId = `oneshot-run-${crypto.randomUUID()}`;

	const replies = await invoke<string[]>("agent_oneshot", {
		// `null`, not `""`. An empty string is a path to `Command::current_dir`,
		// not "no directory": the child chdirs to "" and the spawn dies with
		// ENOENT. Sessions written before omp recorded a working directory list
		// one (they are the `UNGROUPED` bucket in projects/discover.ts), so
		// renaming any of those failed with a filesystem error.
		cwd: cwd || null,
		lines: [
			// `sessionPath`, not `path`. The server reads `command.sessionPath`
			// (rpc-types.ts declares it); sending `path` made it `undefined`, so the
			// throwaway never switched and every rename landed on the empty session
			// it had just created for itself — reporting success either way.
			JSON.stringify({ id: switchId, type: "switch_session", sessionPath }),
			JSON.stringify({ ...command, id: runId }),
		],
		// Both, in this order. Waiting only on the second is what let a switch
		// that never happened through.
		expectIds: [switchId, runId],
		timeoutMs: ONESHOT_TIMEOUT_MS,
	});

	return readOneshotReplies<T>(replies);
}

/** As much of a reply frame as this file has to read. */
interface OneshotReply {
	success?: boolean;
	error?: string;
	data?: unknown;
}

/**
 * Refuse the command's answer unless the switch that preceded it worked.
 *
 * A switch that did not happen leaves the throwaway on the fresh empty session
 * it booted with, and the command that follows then answers `success: true` for
 * work that landed nowhere. Two ordinary server behaviours reach that state
 * without ever failing: an extension's `session_before_switch` handler
 * cancelling, and `switchSession` refusing a cwd change because rpc-mode calls
 * it with no `onCwdChange`. Both come back as `success: true` carrying
 * `data.cancelled`, so reading `success` alone is exactly the check that missed
 * them.
 *
 * Positional, not correlated: the relay fills one slot per id in the order the
 * caller listed them, so `replies[0]` is the switch.
 */
export function readOneshotReplies<T>(replies: readonly string[]): T {
	if (replies.length !== 2) throw new Error(`the session answered ${replies.length} of 2 commands`);
	const [switched, answer] = replies.map(reply => JSON.parse(reply) as OneshotReply);
	if (switched.success === false) throw new Error(switched.error ?? "could not open that session");
	if ((switched.data as { cancelled?: boolean } | undefined)?.cancelled) {
		throw new Error("the session refused to open, so nothing was changed");
	}
	if (answer.success === false) throw new Error(answer.error ?? "the session refused the command");
	return answer.data as T;
}

/** Rename, wherever the session happens to live. */
export async function renameSession(
	target: { process: SessionProcess; cwd: string; sessionPath: string },
	name: string,
): Promise<void> {
	switch (target.process.kind) {
		case "mounted":
			return target.process.bridge.setSessionName(name);
		case "detached":
			throw new Error(SESSION_DETACHED);
		case "none":
			await oneshot(target.cwd, target.sessionPath, { type: "set_session_name", name });
	}
}

/** Export, wherever the session happens to live. Answers with the file written. */
export async function exportSession(
	target: { process: SessionProcess; cwd: string; sessionPath: string },
	outputPath: string,
): Promise<string> {
	switch (target.process.kind) {
		case "mounted":
			return target.process.bridge.exportHtml(outputPath);
		case "detached":
			// That the export itself only reads is beside the point: the throwaway
			// gets there through `switch_session`, which loads the jsonl into a
			// second live agent.
			throw new Error(SESSION_DETACHED);
		case "none": {
			const data = await oneshot<{ path: string }>(target.cwd, target.sessionPath, {
				type: "export_html",
				outputPath,
			});
			return data?.path ?? outputPath;
		}
	}
}
