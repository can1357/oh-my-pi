/**
 * Per-realm sandbox session state: hosts, paths and exec targets allowed for the rest of the realm,
 * the proxy refusal log, the attribution of refusals to the contained calls that made them, and the
 * hooks the sandbox thread service replicates them through.
 *
 * Module state lives per JS realm. Subagents on worker threads replicate the main thread's session
 * grants, report their proxy refusals to it and forward their access requests to its approver
 * through the sandbox thread service (`thread/services/sandbox.ts`); `always` grants reach them
 * through settings.
 */
import type { Settings } from "../config/settings";
import { hostMatches } from "./policy";
import { cfgSandboxAllowedHosts } from "./settings";
import type { SandboxHostApprover } from "./types";

let hostApprover: SandboxHostApprover | undefined;
/** Hosts allowed for the rest of this realm (`session` approvals and `always` grants). */
export const sessionGrants = new Set<string>();
/** Proxy refusals: host → time of its latest refusal, least recent first; the newest {@link BLOCKED_LOG_LIMIT}. */
export const blockedLog = new Map<string, number>();
/** Distinct refused hosts {@link blockedLog} keeps: every result and panel refresh scans it. */
const BLOCKED_LOG_LIMIT = 256;
/** Exact paths granted for the rest of this realm, realpath'd; a write grant also reads. */
export const sessionPathGrants = { write: new Set<string>(), read: new Set<string>() };
/** The write grants that named a file when granted: a missing one is not recreated (as a directory). */
export const sessionWriteFiles = new Set<string>();
/** Exec targets (verbatim) granted for the rest of this realm: omp may perform them on the host. */
export const sessionExecGrants = new Set<string>();
/** Bumped on every session path grant change: part of each runtime's cached fingerprint. */
let pathRevision = 0;
/** Live runtimes of this realm, notified on every grant change and refusal. */
export const liveRuntimes = new Set<{ notify(): void }>();
/** Observers of this realm's session grant set (the sandbox thread service). */
const grantListeners = new Set<() => void>();
/** Observers of this realm's proxy refusals (the sandbox thread service). */
const blockedListeners = new Set<(host: string, at: number) => void>();

/**
 * Refusals of this realm, oldest first, with the calls they were attributed to (`undefined`: not
 * attributed, as every refusal a worker realm reports). The newest {@link REFUSAL_LIMIT}.
 */
const refusals: { host: string; at: number; owners: readonly EgressCall[] | undefined }[] = [];
const REFUSAL_LIMIT = 1024;
/** Time of the newest refusal dropped from {@link refusals}: a window reaching back to it is incomplete. */
let refusalFloor = Number.NEGATIVE_INFINITY;
/** Live calls by their proxy credential (`user:password`). */
const callsByCredential = new Map<string, EgressCall>();
/** Live calls by the proxy listener ids they watch. */
const callsByListener = new Map<string, Set<EgressCall>>();
/** User name of the proxy credentials a call hands its commands. */
const EGRESS_CALL_USER = "omp";

/**
 * One contained call (a bash command, an eval cell run) whose own proxy refusals are attributed to
 * it, not by time: the requests that carry its credentials (its commands' proxy URL) and the
 * requests that arrive on a listener it watches (contained spawns opened with that listener id)
 * while it is live. {@link end} it when the call settles; later refusals are no longer its.
 */
export class EgressCall {
	/**
	 * The password of the proxy credentials (user `omp`) the call's commands send. A secret: never
	 * logged, shown or put in a result. Attribution by credential is best-effort: contained processes
	 * running at the same time under the same sandbox host may read each other's environment and
	 * send another call's credential, which can only add hosts to that call's report (the proxy's
	 * decisions never read it). Only listener ports are enforced by the kernel.
	 */
	readonly token: string;
	readonly #credential: string;
	readonly #listeners: readonly string[];
	readonly #hosts = new Set<string>();
	#ended = false;

	constructor(watch: readonly string[] = []) {
		this.token = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("hex");
		this.#credential = `${EGRESS_CALL_USER}:${this.token}`;
		this.#listeners = [...watch];
		callsByCredential.set(this.#credential, this);
		for (const id of this.#listeners) {
			let calls = callsByListener.get(id);
			if (!calls) {
				calls = new Set();
				callsByListener.set(id, calls);
			}
			calls.add(this);
		}
	}

	/** User name of the proxy credentials, paired with {@link token}. */
	get user(): string {
		return EGRESS_CALL_USER;
	}

	/** Hosts refused to this call's own requests that are still refused, most recently refused last (the newest {@link BLOCKED_LOG_LIMIT}). */
	hosts(): string[] {
		return [...this.#hosts].filter(host => blockedLog.has(host));
	}

	/** Stops attributing refusals to this call. Idempotent. */
	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		callsByCredential.delete(this.#credential);
		for (const id of this.#listeners) {
			const calls = callsByListener.get(id);
			calls?.delete(this);
			if (calls?.size === 0) callsByListener.delete(id);
		}
	}

	/** @internal */
	attribute(host: string): void {
		// Most recent last, bounded like the refusal log a report is filtered against.
		this.#hosts.delete(host);
		this.#hosts.add(host);
		if (this.#hosts.size > BLOCKED_LOG_LIMIT) this.#hosts.delete(this.#hosts.values().next().value as string);
	}
}

/**
 * The live calls a refused request belongs to: the call whose credential it carried, and the calls
 * watching the listener it arrived on. `undefined` when it carried no live call's credential and
 * arrived on no watched listener.
 */
export function egressOwners(origin: { listener?: string; credential?: string }): EgressCall[] | undefined {
	const owners = new Set<EgressCall>();
	const byCredential = origin.credential === undefined ? undefined : callsByCredential.get(origin.credential);
	if (byCredential) owners.add(byCredential);
	if (origin.listener !== undefined) for (const call of callsByListener.get(origin.listener) ?? []) owners.add(call);
	return owners.size > 0 ? [...owners] : undefined;
}

/**
 * Hosts refused since `since` that may belong to `call`: every refusal not attributed to a call,
 * and those attributed to `call`. A host whose every refusal in the window was attributed to other
 * calls is left out; when the window reaches past the refusals kept, nothing is left out.
 */
export function blockedHostsSince(since: number, call?: EgressCall): string[] {
	const hosts: string[] = [];
	for (const [host, at] of blockedLog) if (at >= since) hosts.push(host);
	if (hosts.length === 0 || since <= refusalFloor) return hosts;
	const mine = new Set<string>();
	const others = new Set<string>();
	for (const refusal of refusals) {
		if (refusal.at < since) continue;
		if (refusal.owners === undefined || (call !== undefined && refusal.owners.includes(call))) mine.add(refusal.host);
		else others.add(refusal.host);
	}
	return hosts.filter(host => mine.has(host) || !others.has(host));
}

/** Session host, path and exec grants of a realm, as a worker realm replicates them. @internal */
export interface SandboxSessionGrants {
	readonly hosts: readonly string[];
	readonly write: readonly string[];
	/** The {@link write} grants that named a file when granted. */
	readonly writeFiles: readonly string[];
	readonly read: readonly string[];
	readonly exec: readonly string[];
}

export function setHostApprover(approver: SandboxHostApprover | undefined): void {
	hostApprover = approver;
}

export function pathGrantRevision(): number {
	return pathRevision;
}

export function notifyAll(): void {
	for (const runtime of liveRuntimes) runtime.notify();
}

/** After any change to {@link sessionGrants}, {@link sessionPathGrants} or {@link sessionExecGrants}. */
export function grantsChanged(): void {
	notifyAll();
	for (const listener of Array.from(grantListeners)) listener();
}

/** After any change to {@link sessionPathGrants}: invalidates every runtime's cached config and fingerprint. */
export function pathGrantsChanged(): void {
	pathRevision++;
	grantsChanged();
}

/** This realm's session grants. @internal */
export function sandboxSessionGrants(): SandboxSessionGrants {
	return {
		hosts: [...sessionGrants],
		write: [...sessionPathGrants.write],
		writeFiles: [...sessionWriteFiles],
		read: [...sessionPathGrants.read],
		exec: [...sessionExecGrants],
	};
}

/** Runs `listener` after every change to this realm's session grants; returns its unsubscribe. @internal */
export function onSandboxSessionGrantsChange(listener: () => void): () => void {
	grantListeners.add(listener);
	return () => {
		grantListeners.delete(listener);
	};
}

/** Replaces this realm's session grants with `grants` (a worker realm's replica of main's). @internal */
export function replicateSandboxSessionGrants(grants: SandboxSessionGrants): void {
	sessionGrants.clear();
	for (const host of grants.hosts) {
		sessionGrants.add(host);
		blockedLog.delete(host);
	}
	for (const kind of ["write", "read"] as const) {
		sessionPathGrants[kind].clear();
		for (const grant of grants[kind]) sessionPathGrants[kind].add(grant);
	}
	sessionWriteFiles.clear();
	for (const grant of grants.writeFiles) sessionWriteFiles.add(grant);
	sessionExecGrants.clear();
	for (const target of grants.exec) sessionExecGrants.add(target);
	// Like a local path grant: invalidates every runtime's cached config and fingerprint.
	pathGrantsChanged();
}

/**
 * Records a proxy refusal of `host` at `at` (this realm's own, or one a worker realm reported),
 * attributed to `owners` ({@link egressOwners}), which each list it among their own hosts. @internal
 */
export function recordBlockedHost(host: string, at: number = Date.now(), owners?: readonly EgressCall[]): void {
	blockedLog.delete(host);
	blockedLog.set(host, at);
	if (blockedLog.size > BLOCKED_LOG_LIMIT) blockedLog.delete(blockedLog.keys().next().value as string);
	for (const owner of owners ?? []) owner.attribute(host);
	refusals.push({ host, at, owners });
	// Worker realms report late with their own times: the floor never moves back.
	if (refusals.length > REFUSAL_LIMIT) refusalFloor = Math.max(refusalFloor, refusals.shift()!.at);
	notifyAll();
	for (const listener of Array.from(blockedListeners)) listener(host, at);
}

/** Runs `listener` after every refusal recorded in this realm; returns its unsubscribe. @internal */
export function onSandboxHostBlocked(listener: (host: string, at: number) => void): () => void {
	blockedListeners.add(listener);
	return () => {
		blockedListeners.delete(listener);
	};
}

/**
 * Allows `host` for this realm; `always` also appends it to the global `sandbox.network.allowedHosts`.
 * The allowlist write goes first: a refused write leaves the session grants and blocked log untouched.
 */
export function grantHostIn(settings: Settings, host: string, scope: "session" | "always"): void {
	// A member write to the global layer only: copying entries of other layers (project, `--config`
	// overlay, runtime) into global config would loosen it.
	if (scope === "always") cfgSandboxAllowedHosts.setMember(settings, host, { member: true });
	sessionGrants.add(host);
	// A grant clears the record; a host the proxy still refuses (resolves to loopback) shows up again.
	blockedLog.delete(host);
	grantsChanged();
}

/** Allows omp to perform the exec action `target` (verbatim) on the host for the rest of this realm. */
export function grantExecIn(target: string): void {
	sessionExecGrants.add(target);
	grantsChanged();
}

/** `settings` receives an `always` approval: the settings of the runtime the asking process runs under. */
export async function decideHost(settings: Settings, host: string, port: number): Promise<boolean> {
	if (hostMatches(host, [...sessionGrants])) return true;
	if (!hostApprover) return false;
	const answer = await hostApprover(host, port);
	switch (answer) {
		case "once":
			return true;
		case "session":
		case "always":
			grantHostIn(settings, host, answer);
			return true;
		case "deny":
			return false;
	}
}

/** Clears this realm's session grants, refusal log and thread-service listeners (not the host approver). */
export function resetGrantsForTest(): void {
	sessionGrants.clear();
	blockedLog.clear();
	sessionPathGrants.write.clear();
	sessionPathGrants.read.clear();
	sessionWriteFiles.clear();
	pathRevision++;
	sessionExecGrants.clear();
	grantListeners.clear();
	blockedListeners.clear();
	refusals.length = 0;
	refusalFloor = Number.NEGATIVE_INFINITY;
	// `end()` deletes the entry being visited, which a Map iteration tolerates.
	for (const call of callsByCredential.values()) call.end();
}
