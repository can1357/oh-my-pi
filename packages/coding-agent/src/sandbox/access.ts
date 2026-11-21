/**
 * Sandbox access requests: who answers them in this realm (an installed approver, or main's from a
 * worker realm), the one-dialog-at-a-time queue, and identical requests sharing one dialog.
 */
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Setting } from "../config/registry";
import type { Settings } from "../config/settings";
import { canonicalHost } from "./policy";
import { cfgSandboxAllowedHosts, cfgSandboxAllowRead, cfgSandboxAllowWrite } from "./settings";
import type {
	SandboxAccessApprover,
	SandboxAccessForwarder,
	SandboxAccessInput,
	SandboxAccessKind,
	SandboxAccessOutcome,
	SandboxAccessPromptHost,
	SandboxAccessRequest,
	SandboxListKind,
} from "./types";

/**
 * The consequence of granting `target`, computed by omp (never by the agent), for every approval UI.
 * `protectedPath`: a write target omp runs git in or loads project config from, outside the sandbox.
 */
export function sandboxAccessEffect(kind: SandboxAccessKind, target: string, protectedPath = false): string {
	switch (kind) {
		case "write": {
			const effect = `Contained commands will be able to create, change and delete files under ${target}.`;
			return protectedPath
				? `${effect} Warning: omp runs git or loads project config from this path outside the sandbox; a contained command that writes it can run code on your machine.`
				: effect;
		}
		case "read":
			return `Contained commands will be able to read files under ${target}.`;
		case "host":
			return `Contained commands will be able to connect to ${target} on any port.`;
		case "exec":
			return `omp will perform ${target} on your machine outside the sandbox, with your full permissions, for the rest of this session.`;
	}
}

/**
 * A path, host or exec target the agent may not have: invalid, a filesystem root, protected, or a
 * locked list.
 */
export class SandboxAccessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxAccessError";
	}
}

let accessApprover: SandboxAccessApprover | undefined;
/** The host that installs an access approver in this process, declared before any session exists. */
let accessPromptHost: SandboxAccessPromptHost | undefined;
/** A worker realm's route to the main realm's access requests (the sandbox thread service). */
let accessForwarder: SandboxAccessForwarder | undefined;
/** A dialog being asked or queued, shared by identical requests; aborts once every waiter gave up. */
interface PendingAccess {
	answer: Promise<SandboxAccessOutcome>;
	controller: AbortController;
	waiters: number;
}
/** Access requests waiting for an answer, by kind and target; identical requests share one. */
const pendingAccess = new Map<string, PendingAccess>();
/** Tail of the one-dialog-at-a-time queue. */
let accessQueue: Promise<unknown> = Promise.resolve();

/** Line breaks and terminal control characters, which no access target may contain. */
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** The list setting an `always` answer appends to, per access kind; `exec` has none (session only). */
export const ACCESS_LISTS = {
	write: cfgSandboxAllowWrite,
	read: cfgSandboxAllowRead,
	host: cfgSandboxAllowedHosts,
} as const satisfies Record<SandboxListKind, Setting<string[]>>;

export function setAccessApprover(approver: SandboxAccessApprover | undefined): void {
	accessApprover = approver;
}

export function setAccessPromptHost(host: SandboxAccessPromptHost | undefined): void {
	accessPromptHost = host;
}

/** Whether a prompt host is declared, an approver installed, or main's approver reachable. */
export function answersAccessRequests(): boolean {
	return accessPromptHost !== undefined || accessApprover !== undefined || accessForwarder !== undefined;
}

/**
 * Routes this realm's access requests that no local approver answers to `forwarder` (a worker
 * realm's link to main, which owns the grants); `undefined` removes the route. @internal
 */
export function forwardSandboxAccessRequests(forwarder: SandboxAccessForwarder | undefined): void {
	accessForwarder = forwarder;
}

/** Clears pending dialogs, the queue, the declared prompt host and the forwarding route (not the approver). */
export function resetAccessForTest(): void {
	pendingAccess.clear();
	accessQueue = Promise.resolve();
	accessPromptHost = undefined;
	accessForwarder = undefined;
}

/**
 * Canonical hostname of an access request ({@link canonicalHost}): a bare name (IDNA to punycode)
 * or IPv4 literal only.
 * @throws SandboxAccessError for control characters, wildcards, schemes, ports, paths or anything
 * not a hostname.
 */
export function canonicalAccessHost(raw: string): string {
	if (CONTROL_CHARACTERS.test(raw)) {
		throw new SandboxAccessError("Invalid target: it contains control characters or line breaks.");
	}
	const trimmed = raw.trim();
	if (!trimmed || /[\s*/:@?#[\]]/.test(trimmed)) {
		throw new SandboxAccessError(
			`"${raw}" is not a hostname: give the exact host, without scheme, port or wildcard.`,
		);
	}
	const host = canonicalHost(trimmed);
	if (host === undefined) throw new SandboxAccessError(`"${raw}" is not a valid hostname.`);
	return host;
}

/**
 * Whether a global write to `list` would not take effect: a layer above global config sets it,
 * or project config narrows it (project lists only keep entries the operator layers also hold).
 */
export function listLocked(list: Setting<string[]>, settings: Settings): boolean {
	const provenance = list.provenance(settings);
	return provenance === "env" || provenance === "runtime" || provenance === "overlay" || provenance === "project";
}

/**
 * Asks about `input` (its target resolved, its intent trimmed, not yet allowed) for the runtime of
 * `workspace`: through this realm's approver, queued behind the dialog being asked and shared with
 * identical requests, or forwarded to main from a worker realm. `ask` shows the dialog and applies
 * the answer. Rejects with `signal`'s reason when it aborts first; other callers sharing the dialog
 * are unaffected, and a queued request every caller abandoned never reaches the approver.
 */
export async function routeAccessRequest(
	workspace: string,
	settings: Settings,
	input: Omit<SandboxAccessInput, "cwd"> & { effect: string },
	ask: (
		approver: SandboxAccessApprover,
		request: SandboxAccessRequest,
		signal: AbortSignal,
	) => Promise<SandboxAccessOutcome>,
	signal?: AbortSignal,
): Promise<SandboxAccessOutcome> {
	const approver = accessApprover;
	if (!approver) {
		const forward = accessForwarder;
		// A worker realm: main asks and grants; the grant reaches this realm's replica.
		// Main computes its own effect from its own policy and ignores this one.
		if (forward) return await untilAborted(signal, () => forward(workspace, input, signal));
		return {
			status: "refused",
			reason:
				accessPromptHost === "rpc"
					? "No one to ask: the RPC host has not enabled access prompts (set_sandbox_access_prompts)."
					: "No one to ask: access requests need an interactive approver.",
		};
	}
	const key = `${input.kind}\0${input.target}`;
	let pending = pendingAccess.get(key);
	if (!pending) {
		const request: SandboxAccessRequest = {
			kind: input.kind,
			target: input.target,
			intent: input.intent,
			command: input.command?.trim() || undefined,
			alternative: input.alternative?.trim() || undefined,
			workspace,
			effect: input.effect,
			canAlways: input.kind !== "exec" && !listLocked(ACCESS_LISTS[input.kind], settings),
		};
		// The dialog's own signal aborts once every caller waiting on it has given up.
		const controller = new AbortController();
		// One dialog at a time per realm: queue behind whatever is being asked.
		const answer = accessQueue.then(() => ask(approver, request, controller.signal));
		accessQueue = answer.catch(() => undefined);
		const entry: PendingAccess = { answer, controller, waiters: 0 };
		pending = entry;
		pendingAccess.set(key, entry);
		void answer
			.finally(() => {
				if (pendingAccess.get(key) === entry) pendingAccess.delete(key);
			})
			.catch(() => undefined);
	}
	pending.waiters++;
	try {
		return await untilAborted(signal, () => pending.answer);
	} finally {
		if (--pending.waiters === 0) {
			pending.controller.abort(signal?.reason);
			// A later identical request must open its own dialog, not join this abandoned one.
			if (pendingAccess.get(key) === pending) pendingAccess.delete(key);
		}
	}
}
