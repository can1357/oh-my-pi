import type { TerminalNotification } from "../terminal-capabilities";

/** Title for out-of-band multiplexer notifications that carry none of their own. */
export const DEFAULT_NOTIFICATION_TITLE = "omp";

/** Title and body for an out-of-band multiplexer notification (cmux, Herdr). */
export function notificationTitleAndBody(message: string | TerminalNotification): { title: string; body: string } {
	if (typeof message === "string") return { title: DEFAULT_NOTIFICATION_TITLE, body: message };
	return { title: message.title?.trim() || DEFAULT_NOTIFICATION_TITLE, body: message.body ?? "" };
}

/**
 * Start a notifier CLI without waiting for or pinning it. Returns false when
 * the binary cannot be spawned, which leaves delivery to the terminal fallback.
 */
export function spawnNotifier(cmd: string[]): boolean {
	try {
		const child = Bun.spawn({ cmd, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		child.unref();
	} catch {
		return false;
	}
	return true;
}
