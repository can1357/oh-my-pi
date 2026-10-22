import * as path from "node:path";
import { $env, getAgentDir } from "@oh-my-pi/pi-utils";

/** Overrides the mailbox root (tests, smoke runs). */
export const MAILBOX_DIR_ENV = "OMP_MAILBOX_DIR";

/** Set on an RPC host spawned to resume a session headless to deliver one message: the mail id. */
export const MAILBOX_HEADLESS_ENV = "OMP_MAILBOX_HEADLESS";

/** `0` turns delivery off in this process: its sessions only announce that they are open. */
export const MAILBOX_ENV = "OMP_MAILBOX";

export function mailboxRoot(): string {
	return $env[MAILBOX_DIR_ENV] || path.join(getAgentDir(), "mailbox");
}

/** Session ids come from files and argv: anything but a plain token is hashed so it cannot name a path. */
export function safeSessionKey(sessionId: string): string {
	return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
		? sessionId
		: `h-${Bun.hash.wyhash(sessionId).toString(16).padStart(16, "0")}`;
}

export function mailDir(sessionId: string): string {
	return path.join(mailboxRoot(), "mail", safeSessionKey(sessionId));
}

/** Held by the one process (and session manager) that consumes a session's mail. */
export function consumerLockPath(sessionId: string): string {
	return path.join(mailDir(sessionId), "consumer");
}

export function presenceDir(): string {
	return path.join(mailboxRoot(), "presence");
}
