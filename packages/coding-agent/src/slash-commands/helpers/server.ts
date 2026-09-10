import { type DaemonConnectionSnapshot, formatDaemonServerStatus } from "../../daemon/status";
import { sanitizeStatusText } from "../../modes/shared";

export type ServerCommand = "status" | "sessions" | "reconnect" | "stop";

export interface ServerCommandCallbacks {
	snapshot: DaemonConnectionSnapshot;
	output: (text: string) => Promise<void> | void;
	sessions?: () => Promise<string> | string;
	reconnect?: () => Promise<void> | void;
	stop?: () =>
		| Promise<{ shutdown?: boolean; blockers?: string[] } | undefined>
		| { shutdown?: boolean; blockers?: string[] }
		| undefined;
}

/** Parse `/server` arguments; extra words are rejected rather than ignored. */
export function parseServerCommand(args: string): ServerCommand | null {
	const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (parts.length > 1) return null;
	const command = parts[0] ?? "status";
	return command === "status" || command === "sessions" || command === "reconnect" || command === "stop"
		? command
		: null;
}

/** Dispatch a server operation through injected callbacks and immutable state. */
export async function handleServerCommand(args: string, callbacks: ServerCommandCallbacks): Promise<void> {
	const command = parseServerCommand(args);
	if (!command) {
		await callbacks.output("Usage: /server [status|sessions|reconnect|stop]");
		return;
	}
	if (command === "status") {
		await callbacks.output(formatDaemonServerStatus(callbacks.snapshot));
		return;
	}
	if (command === "sessions") {
		if (!callbacks.sessions) {
			await callbacks.output("server sessions unavailable");
			return;
		}
		const sessions = await callbacks.sessions();
		await callbacks.output(
			sessions
				.split(/\r?\n/)
				.map(line => sanitizeStatusText(line))
				.join("\n"),
		);
		return;
	}
	if (command === "reconnect") {
		if (!callbacks.reconnect) {
			await callbacks.output("server reconnect unavailable");
			return;
		}
		await callbacks.reconnect();
		await callbacks.output("server reconnect requested");
		return;
	}
	if (!callbacks.stop) {
		await callbacks.output("server stop unavailable");
		return;
	}
	const result = await callbacks.stop();
	if (result && result.shutdown === false) {
		const blockers = Array.isArray(result.blockers) ? result.blockers.map(String).join(", ") : "unknown blockers";
		await callbacks.output(`server stop blocked: ${sanitizeStatusText(blockers)}`);
		return;
	}
	await callbacks.output("server stop requested");
}
