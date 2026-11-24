/**
 * Linux desktop notifications over D-Bus, for terminals whose only in-band
 * notification is a bare BEL.
 *
 * VTE-family terminals (Ptyxis, GNOME Terminal, Tilix, Terminator), Alacritty
 * and bare xterm surface no toast for BEL, OSC 9, OSC 99 or OSC 777. The
 * freedesktop `org.freedesktop.Notifications` service reaches them on Wayland
 * and X11 alike: `notify-send` (libnotify) when installed, else `gdbus call`.
 * Delivery is fire-and-forget; a missing binary or failed spawn is silent.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import type { Env } from "./mux/detect";
import type { TerminalNotification } from "./notify";

/** Application name shown as the notification source. */
const APP_NAME = "omp";
const EXPIRE_MS = "5000";

/** A delivery binary that fans a notification out to D-Bus. */
export interface DesktopNotifier {
	readonly kind: "notify-send" | "gdbus";
	readonly path: string;
}

/**
 * Whether the process can reach a freedesktop notification daemon: Linux with
 * a session bus address, or the systemd user bus socket at `$XDG_RUNTIME_DIR/bus`.
 */
export function hasLinuxDesktopSession(
	platform: NodeJS.Platform,
	env: Env,
	fileExists: (file: string) => boolean = fs.existsSync,
): boolean {
	if (platform !== "linux") return false;
	if (env.DBUS_SESSION_BUS_ADDRESS) return true;
	const runtimeDir = env.XDG_RUNTIME_DIR;
	return Boolean(runtimeDir && fileExists(path.posix.join(runtimeDir, "bus")));
}

/**
 * Whether a bell-only notification should also go out as a D-Bus toast: a
 * Linux desktop session is reachable and `PI_NO_DESKTOP_NOTIFY=1` is not set.
 */
export function shouldDeliverDesktopNotification(env: Env, platform: NodeJS.Platform = process.platform): boolean {
	return env.PI_NO_DESKTOP_NOTIFY !== "1" && hasLinuxDesktopSession(platform, env);
}

let cachedNotifier: DesktopNotifier | null | undefined;

/** Forget the resolved notifier (tests). */
export function resetDesktopNotifierCache(): void {
	cachedNotifier = undefined;
}

/** `notify-send` from `PATH`, else `gdbus`, else null; resolved once per process. */
export function resolveDesktopNotifier(): DesktopNotifier | null {
	if (cachedNotifier !== undefined) return cachedNotifier;
	const notifySend = $which("notify-send");
	if (notifySend) {
		cachedNotifier = { kind: "notify-send", path: notifySend };
		return cachedNotifier;
	}
	const gdbus = $which("gdbus");
	cachedNotifier = gdbus ? { kind: "gdbus", path: gdbus } : null;
	return cachedNotifier;
}

const URGENCY_BYTE = { low: 0, normal: 1, critical: 2 } as const;

/**
 * The argv delivering `message` through `notifier`. `gdbus` calls the
 * freedesktop `Notify(s u s s s as a{sv} i)` method with the urgency as a hint
 * byte, so the daemon classifies the toast as `notify-send --urgency` would.
 */
export function buildDesktopNotifyCommand(notifier: DesktopNotifier, message: string | TerminalNotification): string[] {
	const title = typeof message === "string" ? APP_NAME : message.title?.trim() || APP_NAME;
	const body = typeof message === "string" ? message : (message.body ?? "");
	const requested = typeof message === "string" ? undefined : message.urgency;
	const urgency = requested === "critical" || requested === "low" ? requested : "normal";
	if (notifier.kind === "notify-send") {
		return [notifier.path, "--app-name", APP_NAME, `--urgency=${urgency}`, `--expire-time=${EXPIRE_MS}`, title, body];
	}
	return [
		notifier.path,
		"call",
		"--session",
		"--dest",
		"org.freedesktop.Notifications",
		"--object-path",
		"/org/freedesktop/Notifications",
		"--method",
		"org.freedesktop.Notifications.Notify",
		APP_NAME,
		"0",
		"",
		title,
		body,
		"[]",
		`{"urgency": <byte ${URGENCY_BYTE[urgency]}>}`,
		EXPIRE_MS,
	];
}

/**
 * Spawn the notifier detached and unreferenced (a stalled D-Bus activation
 * must never delay process exit); never throws.
 */
export function sendDesktopNotification(message: string | TerminalNotification): void {
	const notifier = resolveDesktopNotifier();
	if (!notifier) return;
	try {
		Bun.spawn({
			cmd: buildDesktopNotifyCommand(notifier, message),
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		}).unref();
	} catch {
		// Best-effort: a failed spawn is silent.
	}
}
