/**
 * Sandbox session state across subagent worker links.
 *
 * `sandbox/grants.ts` keeps session host and path grants and the blocked-host log per JS realm.
 * Main owns them: only main has an approver, so only main grants. A worker holds a replica of
 * main's session grants, seeded at boot and replaced by every (coalesced) change main pushes, so
 * its contained commands honor what the user allowed for the session. A worker's access requests
 * (`sandbox_request`) are decided by main's runtime for the same workspace, which asks main's
 * approver and grants there. Main posts the grant push before the answer on the same link, so the
 * worker's replica holds a session grant when its request returns (an `always` grant arrives
 * the same way through the settings mirror). Hosts the worker's own egress proxy refuses are
 * reported back and recorded in main's log, where `/sandbox status`, the panel and RPC
 * `sandbox_update` read them.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { forwardSandboxAccessRequests } from "../../sandbox/access";
import {
	onSandboxHostBlocked,
	onSandboxSessionGrantsChange,
	recordBlockedHost,
	replicateSandboxSessionGrants,
	type SandboxSessionGrants,
	sandboxSessionGrants,
} from "../../sandbox/grants";
import { SandboxRuntime } from "../../sandbox/runtime";
import type { SandboxAccessForwarder, SandboxAccessOutcome } from "../../sandbox/types";
import { RpcClosedError } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import { applyNewer, coalesce, ignoreSettle, PeerCleanups, type Sequenced } from "./support";

/** Boot globals of {@link sandboxThreadService}. */
export interface SandboxThreadGlobals {
	/** Subscribe `listener` to main's session grant changes until the worker exits; answers the current grants. */
	readonly watchGrants: (
		listener: (grants: Sequenced<SandboxSessionGrants>) => unknown,
	) => Sequenced<SandboxSessionGrants> | Promise<Sequenced<SandboxSessionGrants>>;
	/** Record a host the worker's egress proxy refused at `at` in main's blocked-host log. */
	readonly reportBlocked: (host: string, at: number) => unknown;
	/**
	 * Whether main answers access requests (see `SandboxRuntime.answersAccessRequests`) when the
	 * worker boots; only then does the worker forward them, and its sessions offer `sandbox_request`.
	 */
	readonly answersAccessRequests: boolean;
	/** Decide a worker realm's access request (target already resolved) with main's runtime for `workspace`. */
	readonly requestAccess: SandboxAccessForwarder;
}

const NAME = "sandbox";

const cleanups = new PeerCleanups(NAME);

/** Bumped on every main-side grant change (once per subscribed worker): only its order matters. */
let grantsSeq = 0;

function mainGlobals(peer: WorkerPeer): SandboxThreadGlobals {
	return {
		watchGrants: listener => {
			// One push per microtask, however many grants changed in between.
			// The worker may be exiting; its link rejects the push.
			const push = coalesce(() => ignoreSettle(listener({ seq: grantsSeq, value: sandboxSessionGrants() })));
			cleanups.track(
				peer.threadId,
				onSandboxSessionGrantsChange(() => {
					grantsSeq++;
					push();
				}),
			);
			return { seq: grantsSeq, value: sandboxSessionGrants() };
		},
		reportBlocked: (host, at) => recordBlockedHost(host, at),
		answersAccessRequests: SandboxRuntime.answersAccessRequests(),
		requestAccess: async (workspace, input, signal) =>
			(await SandboxRuntime.for(workspace)).requestAccess(input, signal),
	};
}

/** What a worker realm's access request returns once main can no longer answer. */
const LINK_CLOSED: SandboxAccessOutcome = {
	status: "refused",
	reason: "No one to ask: the main session this subagent reports to has ended.",
};

function isSandboxGlobals(value: unknown): value is SandboxThreadGlobals {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "watchGrants") === "function" &&
		typeof Reflect.get(value, "reportBlocked") === "function" &&
		typeof Reflect.get(value, "requestAccess") === "function" &&
		typeof Reflect.get(value, "answersAccessRequests") === "boolean"
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
	// A push handled before the answer is newer than the answer; `seq` drops the stale one.
	const apply = applyNewer(replicateSandboxSessionGrants);
	apply(await globals.watchGrants(apply));
	if (!globals.answersAccessRequests) return;
	forwardSandboxAccessRequests(async (workspace, input, signal) => {
		try {
			// `signal` crosses as a mirror: aborting it cancels main's dialog too.
			return await globals.requestAccess(workspace, input, signal);
		} catch (error) {
			if (error instanceof RpcClosedError) return LINK_CLOSED;
			throw error;
		}
	});
}

/** Session host/path grants (main → worker replica), access requests and proxy refusals (worker → main). */
export const sandboxThreadService: ThreadService = {
	name: NAME,
	globals: mainGlobals,
	onWorkerExit: peer => cleanups.release(peer.threadId),
	boot: bootWorker,
};
