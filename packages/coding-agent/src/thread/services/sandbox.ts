/**
 * Sandbox session state across subagent worker links.
 *
 * `sandbox/runtime.ts` keeps session host and path grants and the blocked-host log per JS realm.
 * Main owns them: only main has an approver, so only main grants. A worker holds a replica of
 * main's session grants, seeded at boot and replaced by every (coalesced) change main pushes, so
 * its contained commands honor what the user allowed for the session. Hosts the worker's own
 * egress proxy refuses are reported back and recorded in main's log, where `/sandbox status`,
 * the panel and RPC `sandbox_update` read them.
 */
import { logger } from "@oh-my-pi/pi-utils";
import {
	onSandboxHostBlocked,
	onSandboxSessionGrantsChange,
	recordBlockedHost,
	replicateSandboxSessionGrants,
	type SandboxSessionGrants,
	sandboxSessionGrants,
} from "../../sandbox/runtime";
import { RpcClosedError } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import { ignoreSettle, PeerCleanups } from "./support";

/** Main's session grants tagged with a sequence number; the worker drops ones not newer than the last. */
export interface SequencedSandboxGrants {
	readonly seq: number;
	readonly grants: SandboxSessionGrants;
}

/** Boot globals of {@link sandboxThreadService}. */
export interface SandboxThreadGlobals {
	/** Subscribe `listener` to main's session grant changes until the worker exits; answers the current grants. */
	readonly watchGrants: (
		listener: (grants: SequencedSandboxGrants) => unknown,
	) => SequencedSandboxGrants | Promise<SequencedSandboxGrants>;
	/** Record a host the worker's egress proxy refused at `at` in main's blocked-host log. */
	readonly reportBlocked: (host: string, at: number) => unknown;
}

const NAME = "sandbox";

const cleanups = new PeerCleanups(NAME);

/** Bumped on every main-side grant change (once per subscribed worker): only its order matters. */
let grantsSeq = 0;

function mainGlobals(peer: WorkerPeer): SandboxThreadGlobals {
	return {
		watchGrants: listener => {
			// One push per microtask, however many grants changed in between.
			let queued = false;
			cleanups.track(
				peer.threadId,
				onSandboxSessionGrantsChange(() => {
					grantsSeq++;
					if (queued) return;
					queued = true;
					queueMicrotask(() => {
						queued = false;
						// The worker may be exiting; its link rejects the push.
						ignoreSettle(listener({ seq: grantsSeq, grants: sandboxSessionGrants() }));
					});
				}),
			);
			return { seq: grantsSeq, grants: sandboxSessionGrants() };
		},
		reportBlocked: (host, at) => recordBlockedHost(host, at),
	};
}

function isSandboxGlobals(value: unknown): value is SandboxThreadGlobals {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "watchGrants") === "function" &&
		typeof Reflect.get(value, "reportBlocked") === "function"
	);
}

async function bootWorker(globals: unknown): Promise<void> {
	if (!isSandboxGlobals(globals)) throw new Error("sandbox thread service: malformed boot globals");
	onSandboxHostBlocked((host, at) => {
		Promise.resolve(globals.reportBlocked(host, at)).catch((error: unknown) => {
			if (!(error instanceof RpcClosedError)) {
				logger.warn("sandbox: reporting a blocked host to the main thread failed", { error: String(error) });
			}
		});
	});
	let last = -1;
	const apply = (update: SequencedSandboxGrants): void => {
		if (update.seq <= last) return;
		last = update.seq;
		replicateSandboxSessionGrants(update.grants);
	};
	// A push handled before the answer is newer than the answer; `seq` drops the stale one.
	apply(await globals.watchGrants(apply));
}

/** Session host/path grants (main → worker replica) and proxy refusals (worker → main log). */
export const sandboxThreadService: ThreadService = {
	name: NAME,
	globals: mainGlobals,
	onWorkerExit: peer => cleanups.release(peer.threadId),
	boot: bootWorker,
};
