import { notificationTitleAndBody, spawnNotifier } from "./notify";
import type { TerminalMultiplexerModule } from "./types";

const CMUX_SURFACE_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

export const cmuxMultiplexer = {
	id: "cmux",
	precedence: "session",
	// CMUX_SOCKET_PATH is a CLI socket override and can be set outside a CMUX terminal.
	sessionEnvKeys: ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_REMOTE_TRANSPORT"],
	ownsScreenGrid: true,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID || env.CMUX_REMOTE_TRANSPORT);
	},
	/**
	 * Workspace/socket state alone is not enough: only the injected surface UUID
	 * identifies the pane that should receive the notification. Without a valid
	 * surface, or without the binary, delivery falls through unchanged.
	 */
	notifier: {
		tier: "surface",
		send({ message, env }) {
			const surfaceId = env.CMUX_SURFACE_ID?.trim();
			if (!surfaceId || !CMUX_SURFACE_ID_PATTERN.test(surfaceId)) return false;
			const { title, body } = notificationTitleAndBody(message);
			return spawnNotifier(["cmux", "notify", "--surface", surfaceId, "--title", title, "--body", body]);
		},
	},
} as const satisfies TerminalMultiplexerModule;
