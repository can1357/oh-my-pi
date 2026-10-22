import * as path from "node:path";
import { $env, getAgentDir } from "@oh-my-pi/pi-utils";
import { safeSessionKey } from "../session/session-storage";

/** Overrides the mailbox root (tests, smoke runs). */
export const MAILBOX_DIR_ENV = "OMP_MAILBOX_DIR";

/** Set on an RPC host spawned to resume a session headless to deliver one message: the mail id. */
export const MAILBOX_HEADLESS_ENV = "OMP_MAILBOX_HEADLESS";

/** `0` turns delivery off in this process: its sessions only announce that they are open. */
export const MAILBOX_ENV = "OMP_MAILBOX";

export function mailboxRoot(): string {
	return $env[MAILBOX_DIR_ENV] || path.join(getAgentDir(), "mailbox");
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
