/**
 * Per-realm sandbox session state: hosts, paths and exec targets allowed for the rest of the realm,
 * the proxy refusal log, and the hooks the sandbox thread service replicates them through.
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

/** Session host, path and exec grants of a realm, as a worker realm replicates them. @internal */
export interface SandboxSessionGrants {
	readonly hosts: readonly string[];
	readonly write: readonly string[];
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
	sessionExecGrants.clear();
	for (const target of grants.exec) sessionExecGrants.add(target);
	// Like a local path grant: invalidates every runtime's cached config and fingerprint.
	pathGrantsChanged();
}

/** Records a proxy refusal of `host` at `at` (this realm's own, or one a worker realm reported). @internal */
export function recordBlockedHost(host: string, at: number = Date.now()): void {
	blockedLog.delete(host);
	blockedLog.set(host, at);
	if (blockedLog.size > BLOCKED_LOG_LIMIT) blockedLog.delete(blockedLog.keys().next().value as string);
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

/** Allows `host` for this realm; `always` also appends it to the global `sandbox.network.allowedHosts`. */
export function grantHostIn(settings: Settings, host: string, scope: "session" | "always"): void {
	sessionGrants.add(host);
	// A grant clears the record; a host the proxy still refuses (resolves to loopback) shows up again.
	blockedLog.delete(host);
	// A member write to the global layer only: copying entries of other layers (project, `--config`
	// overlay, runtime) into global config would loosen it.
	if (scope === "always") cfgSandboxAllowedHosts.setMember(settings, host, { member: true });
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
	pathRevision++;
	sessionExecGrants.clear();
	grantListeners.clear();
	blockedListeners.clear();
}
