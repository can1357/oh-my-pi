import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { sanitizeStatusText } from "../modes/shared";

/** Profile identity shared by the daemon connection and its UI. */
export type DaemonProfile = string | null;

export interface DaemonShard {
	readonly profile: DaemonProfile;
}

/**
 * Immutable, transport-agnostic state consumed by all daemon UI surfaces.
 * Connection code owns transitions; presentation code only renders this value.
 */
export type DaemonConnectionSnapshot =
	| Readonly<{ state: "direct" }>
	| Readonly<{ state: "starting" | "connecting" | "reconnecting"; shard: DaemonShard; attempt?: number }>
	| Readonly<{
			state: "connected";
			shard: DaemonShard;
			readonly daemonId?: string;
			readonly sessionId?: string;
			serverVersion: string;
			protocolVersion: number;
			sessionCount: number;
			readonly attachmentCount?: number;
			readonly protectedJobCount?: number;
			readonly uptimeMs?: number;
			readonly activeSessionCount?: number;
			readonly idleSessionCount?: number;
			readonly pid?: number;
			readonly socketPath?: string;
	  }>
	| Readonly<{
			state: "incompatible";
			shard: DaemonShard;
			clientVersion: string;
			serverVersion: string;
	  }>
	| Readonly<{ state: "unavailable"; shard: DaemonShard }>;

function clean(value: unknown): string {
	return sanitizeStatusText(String(value ?? ""));
}

function profileName(profile: DaemonProfile): string {
	if (profile === null) return "none";
	return clean(profile).trim() || "none";
}

function shortId(value: string | undefined): string | undefined {
	const normalized = clean(value).trim();
	return normalized.length > 0 ? normalized.slice(0, 8) : undefined;
}

function count(value: number | undefined): string {
	return typeof value === "number" && Number.isFinite(value) ? String(Math.max(0, Math.trunc(value))) : "?";
}

/** Render the fixed-height startup status area beneath model/provider. */
export function formatDaemonWelcomeStatus(snapshot: DaemonConnectionSnapshot, width: number): string[] {
	const maxWidth = Math.max(1, Math.trunc(width));
	let rows: [string, string];
	switch (snapshot.state) {
		case "direct":
			rows = ["○ direct mode", ""];
			break;
		case "starting":
		case "connecting":
			rows = [`◌ server ${snapshot.state}…`, ""];
			break;
		case "connected": {
			const daemonId = shortId(snapshot.daemonId);
			const sessionId = shortId(snapshot.sessionId);
			const scope = profileName(snapshot.shard.profile);
			rows = [
				`● daemon${daemonId ? ` ${daemonId}` : ""} · v${clean(snapshot.serverVersion)}`,
				sessionId ? `   ${sessionId} · ${scope}` : `  profile ${scope}`,
			];
			break;
		}
		case "reconnecting":
			rows = [`↻ server reconnecting · attempt ${count(snapshot.attempt)}`, ""];
			break;
		case "incompatible":
			rows = [`■ server incompatible · v${clean(snapshot.serverVersion)}`, ""];
			break;
		case "unavailable":
			rows = ["× server unavailable", ""];
			break;
	}
	return rows.map(row => truncateToWidth(row, maxWidth));
}

/** Render the detailed `/server` diagnostic view from the same snapshot. */
export function formatDaemonServerStatus(snapshot: DaemonConnectionSnapshot): string {
	if (snapshot.state === "direct") return "server direct mode";
	const lines = [`server ${snapshot.state}`];
	if ("shard" in snapshot) {
		lines.push(`profile: ${profileName(snapshot.shard.profile)}`);
	}
	if (snapshot.state === "connected") {
		if (snapshot.daemonId !== undefined) lines.push(`daemon id: ${clean(snapshot.daemonId)}`);
		if (snapshot.sessionId !== undefined) lines.push(`session id: ${clean(snapshot.sessionId)}`);
		lines.push(`server version: ${clean(snapshot.serverVersion)}`);
		lines.push(`protocol version: ${count(snapshot.protocolVersion)}`);
		lines.push(`sessions: ${count(snapshot.sessionCount)}`);
		if (snapshot.activeSessionCount !== undefined)
			lines.push(`active sessions: ${count(snapshot.activeSessionCount)}`);
		if (snapshot.idleSessionCount !== undefined) lines.push(`idle sessions: ${count(snapshot.idleSessionCount)}`);
		if (snapshot.attachmentCount !== undefined) lines.push(`attachments: ${count(snapshot.attachmentCount)}`);
		if (snapshot.protectedJobCount !== undefined) lines.push(`protected jobs: ${count(snapshot.protectedJobCount)}`);
		if (snapshot.uptimeMs !== undefined) lines.push(`uptime: ${count(snapshot.uptimeMs)}ms`);
		if (snapshot.pid !== undefined) lines.push(`pid: ${count(snapshot.pid)}`);
		if (snapshot.socketPath !== undefined) lines.push(`socket: ${clean(snapshot.socketPath)}`);
	} else if (snapshot.state === "incompatible") {
		lines.push(`client version: ${clean(snapshot.clientVersion)}`);
		lines.push(`server version: ${clean(snapshot.serverVersion)}`);
	} else if (snapshot.state === "reconnecting") {
		lines.push(`attempt: ${count(snapshot.attempt)}`);
	}
	return lines.join("\n");
}
